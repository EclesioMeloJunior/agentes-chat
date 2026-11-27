/**
 * The WhatsApp sidecar's HTTP side (ADR 0260): a few routes over `Sessions`, one WhatsApp session per workspace, named
 * by the workspace's id. Only the app calls it, with `WHATSAPP_API_KEY` as a bearer token when one is set; it answers
 * JSON and never logs a message's words, a phone number or a group's name.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GroupRead } from "./inbox.ts";

/** Where a session stands: `off` none started, `starting` connecting, `qr` waiting for a scan, `open`, `closed`. */
export type SessionState = "off" | "starting" | "qr" | "open" | "closed";

export interface SessionView {
  state: SessionState;
  /** The QR to scan as a PNG data URL, only while `state` is `qr`. */
  qr: string | null;
  /** When that QR stops working (ISO), only with `qr`. */
  qrExpiresAt: string | null;
  /** The linked phone, once paired. */
  account: { phone: string } | null;
  /** Why it closed, a short word (`connect_failed`, `replaced`…); null otherwise. */
  reason: string | null;
}

/** A group the linked phone is in. */
export interface GroupView {
  /** Its address, `120363…@g.us`: what a send's `to` and a read take. */
  id: string;
  name: string;
  /** How many are in it, when WhatsApp says. */
  size: number | null;
  /** Only its admins may send. */
  adminsOnly: boolean;
}

export interface Sessions {
  view(id: string): SessionView;
  /** Starts the session (pairing or resuming), or leaves it as it is when it already runs. */
  start(id: string): Promise<SessionView>;
  /**
   * `to`: the number's digits with the country code, or a group's address (`GROUP_ID`). Throws `NotConnectedError`
   * unless the session is open.
   */
  send(id: string, to: string, text: string, picture?: Picture): Promise<{ id: string }>;
  /** The groups the linked phone is in. Throws `NotConnectedError` unless the session is open. */
  groups(id: string): Promise<GroupView[]>;
  /** What a group said lately (`inbox.ts`). Throws `NotConnectedError` when the session was never started. */
  readGroup(id: string, group: string, after: string | null, limit: number): Promise<GroupRead>;
  /** Unlinks the device and forgets the session's keys. */
  logout(id: string): Promise<void>;
}

/** A picture to send, the words beside it as its caption (ADR 0260, pictures). */
export interface Picture {
  bytes: Uint8Array;
  mimetype: "image/jpeg" | "image/png";
}

export class NotConnectedError extends Error {
  constructor() {
    super("not connected");
    this.name = "NotConnectedError";
  }
}

/** A workspace's id, or any name of the same shape: never a path. */
export const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A number with its country code, digits only: E.164 allows 15. */
export const PHONE = /^[1-9][0-9]{7,14}$/;
/** A group's address: the creator's number and a time in older groups, one long number in newer ones. */
export const GROUP_ID = /^[0-9]{5,30}(-[0-9]{5,15})?@g\.us$/;
/** A read's cursor, as `inbox.ts` makes it. */
const CURSOR = /^[0-9a-f]{1,16}\.[0-9]{1,15}$/;
/** WhatsApp takes 65,536 characters; a message an agent writes stays well under. */
export const TEXT_MAX = 4096;
/** WhatsApp takes a picture up to 16 MB but recompresses anything big: 5 MB keeps a phone's photo whole. */
export const PICTURE_MAX = 5 * 1024 * 1024;
/** A picture's bytes travel as base64, a third larger, beside its words. */
const BODY_MAX = 8 * 1024 * 1024;

/** A send's `image`, `{ data: base64, mimetype }`, checked by its first bytes; null when it is not a JPEG or PNG. */
export function pictureOf(raw: unknown): Picture | null {
  if (!raw || typeof raw !== "object") return null;
  const { data, mimetype } = raw as { data?: unknown; mimetype?: unknown };
  if (typeof data !== "string" || (mimetype !== "image/jpeg" && mimetype !== "image/png")) return null;
  if (data.length === 0 || data.length > Math.ceil(PICTURE_MAX / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    return null;
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.length === 0 || bytes.length > PICTURE_MAX) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mimetype === "image/jpeg" ? !jpeg : !png) return null;
  return { bytes, mimetype };
}

/** `+55 (11) 99999-9999` → `5511999999999`; null when what is left is not a number with its country code. */
export function phoneDigits(raw: string): string | null {
  const digits = raw.replace(/[\s().+-]/g, "");
  return PHONE.test(digits) ? digits : null;
}

function sameKey(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) throw new Error("too_large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

/** The request handler: `apiKey` empty = no token asked (a network only the app reaches). */
export function createHandler(sessions: Sessions, apiKey: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://sidecar");
      if (req.method === "GET" && url.pathname === "/health") return reply(res, 200, { ok: true });
      if (apiKey) {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || !sameKey(auth.slice(7), apiKey))
          return reply(res, 401, { error: "unauthorized" });
      }
      const m = /^\/v1\/sessions\/([^/]+)(\/start|\/messages|\/groups|\/groups\/([^/]+)\/messages)?$/.exec(
        url.pathname,
      );
      if (!m) return reply(res, 404, { error: "not_found" });
      const id = decodeURIComponent(m[1] ?? "");
      if (!SESSION_ID.test(id)) return reply(res, 400, { error: "invalid_session" });
      const group = m[3] === undefined ? null : decodeURIComponent(m[3]);
      if (group !== null && !GROUP_ID.test(group)) return reply(res, 400, { error: "invalid_group" });
      const action = group === null ? (m[2] ?? "") : "/groups/messages";

      if (action === "" && req.method === "GET") return reply(res, 200, sessions.view(id));
      if (action === "" && req.method === "DELETE") {
        await sessions.logout(id);
        return reply(res, 204);
      }
      if (action === "/start" && req.method === "POST") return reply(res, 200, await sessions.start(id));
      if (action === "/messages" && req.method === "POST") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          return reply(res, 400, { error: "invalid_body" });
        }
        const { to, text, image } = (body ?? {}) as { to?: unknown; text?: unknown; image?: unknown };
        const target = typeof to === "string" ? (GROUP_ID.test(to) ? to : phoneDigits(to)) : null;
        if (!target) return reply(res, 400, { error: "invalid_number" });
        const picture = image == null ? null : pictureOf(image);
        if (image != null && !picture) return reply(res, 400, { error: "invalid_image" });
        // A picture may go without a caption; a message alone needs words.
        const words = text ?? "";
        if (typeof words !== "string" || words.length > TEXT_MAX || (!picture && words.trim() === ""))
          return reply(res, 400, { error: "invalid_text" });
        try {
          return reply(res, 200, await sessions.send(id, target, words, picture ?? undefined));
        } catch (error) {
          if (error instanceof NotConnectedError) return reply(res, 409, { error: "not_connected" });
          throw error;
        }
      }
      if (action === "/groups" && req.method === "GET") {
        try {
          return reply(res, 200, { groups: await sessions.groups(id) });
        } catch (error) {
          if (error instanceof NotConnectedError) return reply(res, 409, { error: "not_connected" });
          throw error;
        }
      }
      if (action === "/groups/messages" && req.method === "GET" && group !== null) {
        const after = url.searchParams.get("after");
        if (after !== null && !CURSOR.test(after)) return reply(res, 400, { error: "invalid_cursor" });
        const limit = Number(url.searchParams.get("limit") ?? 50);
        try {
          return reply(res, 200, await sessions.readGroup(id, group, after, Number.isFinite(limit) ? limit : 50));
        } catch (error) {
          if (error instanceof NotConnectedError) return reply(res, 409, { error: "not_connected" });
          throw error;
        }
      }
      return reply(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      // The error's class only: a library's message may carry a number.
      console.error("whatsapp sidecar: request failed", error instanceof Error ? error.name : "unknown");
      if (!res.headersSent) reply(res, 502, { error: "failed" });
    }
  };
}
