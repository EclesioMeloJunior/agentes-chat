/**
 * WhatsApp sessions on zapo-js (ADR 0261): one `WaClient` per workspace, its keys in one SQLite file on the service's
 * volume. A session that paired is kept in `sessions.json` and resumed when the service starts; one that closes on its
 * own is reconnected with a growing pause; one unlinked from the phone forgets its keys and goes back to `off`. What
 * its groups say is kept in memory only, a short window per group (`inbox.ts`); private chats are never kept.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSqliteStore } from "@zapo-js/store-sqlite";
import QRCode from "qrcode";
import { ConsoleLogger, createStore, WaClient } from "zapo-js";
import {
  GROUP_ID,
  type GroupView,
  NotConnectedError,
  type SessionState,
  type Sessions,
  type SessionView,
} from "./http.ts";
import { createGroupInbox, phoneOf, textOf } from "./inbox.ts";

/** The pauses between reconnections of a paired session, the last one repeated. */
const RECONNECT_MS = [2_000, 5_000, 15_000, 60_000, 300_000];
/** How long a session's list of groups is reused before WhatsApp is asked again. */
const GROUPS_TTL_MS = 60_000;

interface Entry {
  client: WaClient;
  state: SessionState;
  qr: string | null;
  qrExpiresAt: string | null;
  phone: string | null;
  reason: string | null;
  /** Paired before (or now): a close is reconnected. */
  paired: boolean;
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set when the service closes it (a logout, a stop): no reconnection. */
  closing: boolean;
  groups: { at: number; list: GroupView[] } | null;
}

/** `5511999999999:12@s.whatsapp.net` → `5511999999999`. */
export const phoneOfJid = (jid: string | undefined | null) => (jid ? (jid.split(/[:@]/)[0] ?? null) : null);

export async function createZapoSessions(dataDir: string): Promise<Sessions & { resume(): Promise<void> }> {
  const sqlite = createSqliteStore({ path: join(dataDir, "state.sqlite") });
  const store = createStore({
    backends: { sqlite },
    providers: {
      auth: "sqlite",
      signal: "sqlite",
      preKey: "sqlite",
      session: "sqlite",
      identity: "sqlite",
      senderKey: "sqlite",
      appState: "sqlite",
      privacyToken: "sqlite",
      // Nobody's messages, chats or contacts are kept on disk: groups' recent messages stay in memory (`inbox.ts`).
      messages: "none",
      threads: "none",
      contacts: "none",
    },
  });
  const logger = new ConsoleLogger("warn");
  const entries = new Map<string, Entry>();
  const inbox = createGroupInbox();
  const when = (seconds: number | undefined) =>
    new Date(seconds && Number.isFinite(seconds) ? seconds * 1000 : Date.now()).toISOString();
  const knownFile = join(dataDir, "sessions.json");

  const readKnown = async (): Promise<string[]> => {
    try {
      const list = JSON.parse(await readFile(knownFile, "utf8"));
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const writeKnown = async (change: (list: Set<string>) => void) => {
    const list = new Set(await readKnown());
    change(list);
    await writeFile(`${knownFile}.tmp`, JSON.stringify([...list]));
    await rename(`${knownFile}.tmp`, knownFile);
  };

  const viewOf = (e: Entry | undefined): SessionView =>
    e
      ? {
          state: e.state,
          qr: e.state === "qr" ? e.qr : null,
          qrExpiresAt: e.state === "qr" ? e.qrExpiresAt : null,
          account: e.phone ? { phone: e.phone } : null,
          reason: e.state === "closed" ? e.reason : null,
        }
      : { state: "off", qr: null, qrExpiresAt: null, account: null, reason: null };

  const connect = (id: string, e: Entry) => {
    e.state = "starting";
    e.client.connect().catch((error: unknown) => {
      e.state = "closed";
      e.reason = "connect_failed";
      console.error("whatsapp sidecar: connect failed", error instanceof Error ? error.name : "unknown");
      if (e.paired) retry(id, e);
    });
  };

  const retry = (id: string, e: Entry) => {
    if (e.closing || e.timer) return;
    const wait = RECONNECT_MS[Math.min(e.tries, RECONNECT_MS.length - 1)] ?? 300_000;
    e.tries++;
    e.timer = setTimeout(() => {
      e.timer = null;
      if (entries.get(id) === e && !e.closing) connect(id, e);
    }, wait);
  };

  const forget = async (id: string, e: Entry) => {
    e.closing = true;
    if (e.timer) clearTimeout(e.timer);
    if (entries.get(id) === e) entries.delete(id);
    inbox.drop(id);
    await writeKnown((list) => list.delete(id));
  };

  const open = (id: string, paired: boolean): Entry => {
    const client = new WaClient(
      {
        store,
        sessionId: id,
        // A link in an agent's message is sent as text: the service fetches no page for its preview.
        linkPreview: { enabled: false },
      },
      logger,
    );
    const e: Entry = {
      client,
      state: "starting",
      qr: null,
      qrExpiresAt: null,
      phone: phoneOfJid(client.getCredentials()?.meJid),
      reason: null,
      paired,
      tries: 0,
      timer: null,
      closing: false,
      groups: null,
    };
    client.on("message", (event) => {
      const group = event.key?.remoteJid;
      if (!event.key?.isGroup || !group || !GROUP_ID.test(group)) return;
      const text = textOf(event.message);
      if (text === null) return;
      inbox.add(id, group, {
        kind: "message",
        at: when(event.timestampSeconds),
        from: {
          name: event.key.fromMe ? null : event.pushName?.trim() || null,
          phone: phoneOf(event.key.participantAlt) ?? phoneOf(event.key.participant),
        },
        fromMe: event.key.fromMe,
        text,
      });
    });
    // What this service sent to a group (an agent's message) reads beside the rest.
    client.on("message_send", (event) => {
      if (!GROUP_ID.test(event.to)) return;
      const text = textOf(event.message);
      if (text === null) return;
      inbox.add(id, event.to, {
        kind: "message",
        at: when(undefined),
        from: { name: null, phone: e.phone },
        fromMe: true,
        text,
      });
    });
    client.on("group", (event) => {
      const group = event.groupJid;
      if (!group || !GROUP_ID.test(group) || (event.action !== "add" && event.action !== "remove")) return;
      e.groups = null;
      for (const person of event.participants ?? [])
        inbox.add(id, group, {
          kind: event.action === "add" ? "joined" : "left",
          at: when(event.timestampSeconds),
          from: { name: person.displayName?.trim() || null, phone: phoneOf(person.phoneJid) ?? phoneOf(person.jid) },
          fromMe: false,
          text: "",
        });
    });
    client.on("auth_qr", ({ qr, ttlMs }) => {
      void QRCode.toDataURL(qr, { margin: 1, width: 264, errorCorrectionLevel: "M" }).then((png) => {
        if (entries.get(id) !== e) return;
        e.qr = png;
        e.qrExpiresAt = new Date(Date.now() + ttlMs).toISOString();
        e.state = "qr";
      });
    });
    client.on("auth_paired", ({ credentials }) => {
      e.phone = phoneOfJid(credentials.meJid);
      e.paired = true;
      e.qr = null;
      e.state = "starting";
      void writeKnown((list) => list.add(id));
    });
    client.on("connection", (event) => {
      if (event.status === "open") {
        e.state = "open";
        e.qr = null;
        e.reason = null;
        e.tries = 0;
        e.phone = phoneOfJid(client.getCredentials()?.meJid) ?? e.phone;
        return;
      }
      if (event.isLogout) {
        // Unlinked from the phone (or by `logout`): zapo clears the keys; the session starts over with a new QR.
        void forget(id, e);
        return;
      }
      e.state = "closed";
      e.reason = event.reason;
      if (!e.closing && e.paired) retry(id, e);
    });
    entries.set(id, e);
    return e;
  };

  return {
    view: (id) => viewOf(entries.get(id)),

    async start(id) {
      const running = entries.get(id);
      if (running && running.state !== "closed") return viewOf(running);
      if (running) {
        // Closed for good (a QR nobody scanned, a refused connect): a new client, so pairing starts over.
        running.closing = true;
        if (running.timer) clearTimeout(running.timer);
        entries.delete(id);
        await running.client.disconnect().catch(() => {});
      }
      connect(id, open(id, (await readKnown()).includes(id)));
      return viewOf(entries.get(id));
    },

    async send(id, to, text, picture) {
      const e = entries.get(id);
      if (e?.state !== "open") throw new NotConnectedError();
      const content = picture
        ? { type: "image" as const, media: picture.bytes, mimetype: picture.mimetype, caption: text || undefined }
        : text;
      const sent = await e.client.message.send(GROUP_ID.test(to) ? to : `${to}@s.whatsapp.net`, content);
      return { id: sent.id };
    },

    async groups(id) {
      const e = entries.get(id);
      if (e?.state !== "open") throw new NotConnectedError();
      if (e.groups && Date.now() - e.groups.at < GROUPS_TTL_MS) return e.groups.list;
      const all = await e.client.group.queryAllGroups();
      const list = all
        .filter((g) => GROUP_ID.test(g.jid) && !g.isParentGroup)
        .map((g) => ({
          id: g.jid,
          name: g.subject.trim().slice(0, 200),
          size: g.size ?? (g.participants.length || null),
          adminsOnly: g.announce,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      e.groups = { at: Date.now(), list };
      return list;
    },

    async readGroup(id, group, after, limit) {
      if (!entries.has(id)) throw new NotConnectedError();
      return inbox.read(id, group, after, limit);
    },

    async logout(id) {
      const e = entries.get(id);
      if (!e) {
        await writeKnown((list) => list.delete(id));
        return;
      }
      e.closing = true;
      if (e.state === "open") {
        // The phone's side lets go; the close that follows (`isLogout`) clears the keys.
        await e.client.logout().catch(() => {});
      }
      await e.client.disconnect().catch(() => {});
      await forget(id, e);
    },

    /** Resumes every session that paired before the service stopped. */
    async resume() {
      for (const id of await readKnown()) if (!entries.has(id)) connect(id, open(id, true));
    },
  };
}
