/**
 * WhatsApp for agents (ADR 0260) behind one interface: the core asks a service of its own (deploy/whatsapp, on
 * zapo-js) about a workspace's session, its QR, a send (to a number or a group), its groups, what a group said lately
 * and a logout. Each workspace is one session, named by its id. Off unless `WHATSAPP_URL` is set.
 */

export type WhatsAppState = "off" | "starting" | "qr" | "open" | "closed";

export interface WhatsAppSession {
  state: WhatsAppState;
  /** The QR to scan, a PNG data URL, while `state` is `qr`. */
  qr: string | null;
  qrExpiresAt: string | null;
  /** The linked phone's number (digits), once paired. */
  phone: string | null;
  /** Why it closed, a short word; null otherwise. */
  reason: string | null;
}

/** A group the workspace's phone is in. */
export interface WhatsAppGroup {
  /** Its address (`120363…@g.us`, `WHATSAPP_GROUP_ID`). */
  id: string;
  name: string;
  size: number | null;
  /** Only its admins may send. */
  adminsOnly: boolean;
}

/** A message in a group, or someone joining or leaving it. */
export interface WhatsAppGroupEntry {
  kind: "message" | "joined" | "left";
  /** ISO time. */
  at: string;
  from: { name: string | null; phone: string | null };
  fromMe: boolean;
  text: string;
}

export interface WhatsAppGroupRead {
  entries: WhatsAppGroupEntry[];
  /** Pass it back as `after` to read only what came next. */
  cursor: string;
  more: boolean;
  /** Since when the service holds what the group said (it keeps a short window in memory). */
  since: string;
}

/** A picture to send (ADR 0260, pictures): the service takes a JPEG or PNG up to `WHATSAPP_PICTURE_MAX`. */
export interface WhatsAppPicture {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png";
}

export const WHATSAPP_PICTURE_MAX = 5 * 1024 * 1024;

export interface WhatsAppGateway {
  session(orgId: string): Promise<WhatsAppSession>;
  /** Starts pairing (a QR follows) or resumes a paired session. */
  start(orgId: string): Promise<WhatsAppSession>;
  /** `to`: digits with the country code, or a group's address. With `picture`, `text` is its caption and may be empty. */
  send(orgId: string, to: string, text: string, picture?: WhatsAppPicture): Promise<{ id: string }>;
  /** The groups the workspace's phone is in. */
  groups(orgId: string): Promise<WhatsAppGroup[]>;
  /** Without `after` the latest entries, with it what came next. */
  readGroup(orgId: string, groupId: string, after?: string | null): Promise<WhatsAppGroupRead>;
  logout(orgId: string): Promise<void>;
}

/** A group's address: older groups' are the creator's number and a time, newer ones' one long number. */
export const WHATSAPP_GROUP_ID = /^[0-9]{5,30}(-[0-9]{5,15})?@g\.us$/;

/** `not_connected`: the workspace's phone isn't linked (or is offline). `refused`: a number or text it won't take. */
export class WhatsAppError extends Error {
  constructor(
    readonly reason: "not_connected" | "refused" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

const STATES: ReadonlySet<string> = new Set(["off", "starting", "qr", "open", "closed"]);
/** The only picture the service hands back; anything else is dropped, never shown. */
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const DIGITS = /^[0-9]{8,15}$/;
const REASON = /^[a-z_]{1,64}$/;
const CURSOR = /^[0-9a-f]{1,16}\.[0-9]{1,15}$/;
const ENTRY_KINDS: ReadonlySet<string> = new Set(["message", "joined", "left"]);
/** The longest group name and entry this side keeps, past the service's own limits. */
const NAME_MAX = 200;
const ENTRY_TEXT_MAX = 2_100;
const TIMEOUT_MS = 15_000;
const PICTURE_TIMEOUT_MS = 60_000;

/** What the service answered, kept to the shapes this side expects. */
export function readSession(body: unknown): WhatsAppSession {
  const b = (body ?? {}) as Record<string, unknown>;
  const state = typeof b.state === "string" && STATES.has(b.state) ? (b.state as WhatsAppState) : "off";
  const qr = state === "qr" && typeof b.qr === "string" && PNG_DATA_URL.test(b.qr) ? b.qr : null;
  const at = typeof b.qrExpiresAt === "string" && !Number.isNaN(Date.parse(b.qrExpiresAt)) ? b.qrExpiresAt : null;
  const account = (b.account ?? null) as { phone?: unknown } | null;
  const phone = typeof account?.phone === "string" && DIGITS.test(account.phone) ? account.phone : null;
  const reason = typeof b.reason === "string" && REASON.test(b.reason) ? b.reason : null;
  return { state, qr, qrExpiresAt: qr ? at : null, phone, reason: state === "closed" ? reason : null };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const isoOr = (v: unknown, or: string) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : or);
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The service's groups, kept to their shapes. */
export function readGroups(body: unknown): WhatsAppGroup[] {
  const list = record(body)?.groups;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): WhatsAppGroup[] => {
    const g = record(item);
    if (!g || typeof g.id !== "string" || !WHATSAPP_GROUP_ID.test(g.id)) return [];
    const size = typeof g.size === "number" && Number.isSafeInteger(g.size) && g.size >= 0 ? g.size : null;
    return [{ id: g.id, name: str(g.name, NAME_MAX).trim() || g.id, size, adminsOnly: g.adminsOnly === true }];
  });
}

/** What a group said, kept to its shapes. */
export function readGroupRead(body: unknown): WhatsAppGroupRead {
  const b = record(body) ?? {};
  const now = new Date().toISOString();
  const entries = (Array.isArray(b.entries) ? b.entries : []).flatMap((item): WhatsAppGroupEntry[] => {
    const e = record(item);
    if (!e || typeof e.kind !== "string" || !ENTRY_KINDS.has(e.kind)) return [];
    const from = record(e.from) ?? {};
    return [
      {
        kind: e.kind as WhatsAppGroupEntry["kind"],
        at: isoOr(e.at, now),
        from: {
          name: str(from.name, NAME_MAX).trim() || null,
          phone: typeof from.phone === "string" && DIGITS.test(from.phone) ? from.phone : null,
        },
        fromMe: e.fromMe === true,
        text: str(e.text, ENTRY_TEXT_MAX),
      },
    ];
  });
  return {
    entries,
    cursor: typeof b.cursor === "string" && CURSOR.test(b.cursor) ? b.cursor : "",
    more: b.more === true,
    since: isoOr(b.since, now),
  };
}

export function createHttpWhatsApp(options: { url: string; apiKey?: string; fetch?: typeof fetch }): WhatsAppGateway {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const call = async (method: string, orgId: string, path = "", body?: unknown, timeoutMs = TIMEOUT_MS) => {
    let res: Response;
    try {
      res = await doFetch(`${base}/v1/sessions/${encodeURIComponent(orgId)}${path}`, {
        method,
        headers: {
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new WhatsAppError("unavailable", "The WhatsApp service didn't answer.");
    }
    if (res.status === 409) throw new WhatsAppError("not_connected", "WhatsApp isn't connected in this workspace.");
    if (res.status === 400) throw new WhatsAppError("refused", "WhatsApp refused that number, group or text.");
    if (!res.ok) throw new WhatsAppError("unavailable", `The WhatsApp service answered ${res.status}.`);
    return res.status === 204 ? null : ((await res.json()) as unknown);
  };
  return {
    session: async (orgId) => readSession(await call("GET", orgId)),
    start: async (orgId) => readSession(await call("POST", orgId, "/start")),
    send: async (orgId, to, text, picture) => {
      const body = picture
        ? { to, text, image: { data: Buffer.from(picture.bytes).toString("base64"), mimetype: picture.contentType } }
        : { to, text };
      // A picture is uploaded to WhatsApp's media servers before the message goes.
      const sent = (await call("POST", orgId, "/messages", body, picture ? PICTURE_TIMEOUT_MS : TIMEOUT_MS)) as {
        id?: unknown;
      } | null;
      return { id: typeof sent?.id === "string" ? sent.id.slice(0, 128) : "" };
    },
    groups: async (orgId) => readGroups(await call("GET", orgId, "/groups")),
    readGroup: async (orgId, groupId, after) => {
      if (!WHATSAPP_GROUP_ID.test(groupId)) throw new WhatsAppError("refused", "That is not a group's address.");
      const query = after && CURSOR.test(after) ? `?after=${encodeURIComponent(after)}` : "";
      return readGroupRead(await call("GET", orgId, `/groups/${encodeURIComponent(groupId)}/messages${query}`));
    },
    logout: async (orgId) => {
      await call("DELETE", orgId);
    },
  };
}

/**
 * For tests: a workspace is open once `link` is called; `sent` keeps what went out; `addGroup` puts its phone in a
 * group and `say` has someone write there.
 */
export function createFakeWhatsApp() {
  const linked = new Map<string, string>();
  const groupsOf = new Map<string, WhatsAppGroup[]>();
  const said = new Map<string, WhatsAppGroupEntry[]>();
  const notLinked = () => new WhatsAppError("not_connected", "WhatsApp isn't connected in this workspace.");
  const pairing = new Set<string>();
  const sent: { orgId: string; to: string; text: string; picture?: WhatsAppPicture }[] = [];
  const view = (orgId: string): WhatsAppSession => {
    const phone = linked.get(orgId);
    if (phone) return { state: "open", qr: null, qrExpiresAt: null, phone, reason: null };
    if (pairing.has(orgId))
      return { state: "qr", qr: "data:image/png;base64,AAAA", qrExpiresAt: null, phone: null, reason: null };
    return { state: "off", qr: null, qrExpiresAt: null, phone: null, reason: null };
  };
  const gateway: WhatsAppGateway = {
    session: async (orgId) => view(orgId),
    start: async (orgId) => {
      if (!linked.has(orgId)) pairing.add(orgId);
      return view(orgId);
    },
    send: async (orgId, to, text, picture) => {
      if (!linked.has(orgId)) throw new WhatsAppError("not_connected", "WhatsApp isn't connected in this workspace.");
      sent.push(picture ? { orgId, to, text, picture } : { orgId, to, text });
      return { id: `wa-${sent.length}` };
    },
    groups: async (orgId) => {
      if (!linked.has(orgId)) throw notLinked();
      return groupsOf.get(orgId) ?? [];
    },
    readGroup: async (orgId, groupId, after) => {
      if (!linked.has(orgId)) throw notLinked();
      const all = said.get(`${orgId} ${groupId}`) ?? [];
      const from = after ? Number(after.split(".")[1] ?? 0) : Math.max(0, all.length - 50);
      return { entries: all.slice(from), cursor: `fa.${all.length}`, more: false, since: "2026-01-01T00:00:00.000Z" };
    },
    logout: async (orgId) => {
      linked.delete(orgId);
      pairing.delete(orgId);
    },
  };
  return {
    gateway,
    sent,
    link: (orgId: string, phone = "5511999999999") => {
      pairing.delete(orgId);
      linked.set(orgId, phone);
    },
    addGroup: (orgId: string, group: WhatsAppGroup) => {
      groupsOf.set(orgId, [...(groupsOf.get(orgId) ?? []), group]);
    },
    say: (orgId: string, groupId: string, entry: Partial<WhatsAppGroupEntry> & { text: string }) => {
      const key = `${orgId} ${groupId}`;
      said.set(key, [
        ...(said.get(key) ?? []),
        { kind: "message", at: "2026-11-27T12:00:00.000Z", from: { name: null, phone: null }, fromMe: false, ...entry },
      ]);
    },
  };
}
