/**
 * What the groups of a linked phone said lately (ADR 0262, addendum of 2026-11-27): a short window kept in memory
 * only, per session and per group, so an agent with `whatsapp:read` can read a group and a routine can watch one.
 * Nothing goes to disk, so a restart forgets it; private chats are never kept, only groups.
 */
import { randomBytes } from "node:crypto";

/** A message, or someone joining or leaving. */
export type EntryKind = "message" | "joined" | "left";

export interface GroupEntry {
  /** The cursor that reads everything after this one. */
  cursor: string;
  kind: EntryKind;
  /** When it happened (ISO). */
  at: string;
  /** Who wrote it, joined or left: the name they show and their number when WhatsApp gave it. */
  from: { name: string | null; phone: string | null };
  /** Sent from the linked phone itself (or by an agent through this service). */
  fromMe: boolean;
  /** The words, or what was sent instead (`[image]`); empty for a join or a leave. */
  text: string;
}

export interface GroupRead {
  entries: GroupEntry[];
  /** Pass it back as `after` to read only what came next. */
  cursor: string;
  /** More waits after these: read again with `cursor`. */
  more: boolean;
  /** Since when this window holds what was said (ISO): the service started then, or the oldest kept is older. */
  since: string;
}

export interface InboxLimits {
  /** Entries kept per group, the oldest dropped first. */
  perGroup: number;
  /** Groups kept per session, the quietest dropped first. */
  groups: number;
  /** Entries older than this are dropped. */
  maxAgeMs: number;
  /** One entry's words, cut past this. */
  textMax: number;
}

export const INBOX_LIMITS: InboxLimits = { perGroup: 300, groups: 100, maxAgeMs: 3 * 24 * 3_600_000, textMax: 2_000 };
/** The most one read returns. */
export const READ_MAX = 100;

interface Kept extends Omit<GroupEntry, "cursor"> {
  seq: number;
}

interface Group {
  list: Kept[];
  /** Set once something was dropped: the window starts at what is left. */
  since: string | null;
}

export function createGroupInbox(limits: InboxLimits = INBOX_LIMITS, now: () => number = Date.now) {
  /** Changes on every start, so a cursor of an earlier run reads the whole window again. */
  const boot = randomBytes(4).toString("hex");
  const startedAt = new Date(now()).toISOString();
  let seq = 0;
  const sessions = new Map<string, Map<string, Group>>();

  const cursorOf = (n: number) => `${boot}.${n}`;
  /** -1 without a cursor; 0 (everything kept) for one of an earlier run, or for what is not one. */
  const seqOf = (cursor: string | null | undefined): number => {
    if (!cursor) return -1;
    const [b, n] = cursor.split(".");
    const value = Number(n);
    return b === boot && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const prune = (group: Group) => {
    const oldest = now() - limits.maxAgeMs;
    let drop = Math.max(0, group.list.length - limits.perGroup);
    while (drop < group.list.length && Date.parse(group.list[drop]?.at ?? "") < oldest) drop++;
    if (drop === 0) return;
    group.list.splice(0, drop);
    group.since = group.list[0]?.at ?? new Date(now()).toISOString();
  };

  return {
    add(session: string, groupId: string, entry: Omit<GroupEntry, "cursor">) {
      let groups = sessions.get(session);
      if (!groups) {
        groups = new Map();
        sessions.set(session, groups);
      }
      let group = groups.get(groupId);
      if (!group) {
        if (groups.size >= limits.groups) {
          // The group that spoke last the longest ago makes room.
          let quietest: string | null = null;
          let quietestSeq = Number.POSITIVE_INFINITY;
          for (const [id, kept] of groups) {
            const last = kept.list.at(-1)?.seq ?? -1;
            if (last < quietestSeq) [quietest, quietestSeq] = [id, last];
          }
          if (quietest !== null) groups.delete(quietest);
        }
        group = { list: [], since: null };
        groups.set(groupId, group);
      }
      const text = entry.text.length > limits.textMax ? `${entry.text.slice(0, limits.textMax)} […]` : entry.text;
      group.list.push({ ...entry, text, seq: ++seq });
      prune(group);
    },

    /** Without `after`, the latest `limit`; with it, the next `limit` after it, oldest first. */
    read(session: string, groupId: string, after: string | null, limit = 50): GroupRead {
      const take = Math.max(1, Math.min(READ_MAX, Math.floor(limit) || 50));
      const group = sessions.get(session)?.get(groupId);
      if (group) prune(group);
      const list = group?.list ?? [];
      const from = seqOf(after);
      const newer = from < 0 ? list : list.filter((e) => e.seq > from);
      const page = from < 0 ? list.slice(-take) : newer.slice(0, take);
      const more = from >= 0 && newer.length > page.length;
      return {
        entries: page.map(({ seq: n, ...e }) => ({ ...e, cursor: cursorOf(n) })),
        // Past what this read returned; with nothing more waiting, past everything so far.
        cursor: cursorOf(more ? (page.at(-1)?.seq ?? seq) : seq),
        more,
        since: group?.since ?? startedAt,
      };
    },

    /** Forgets what a session's groups said (its phone was unlinked). */
    drop(session: string) {
      sessions.delete(session);
    },
  };
}

export type GroupInbox = ReturnType<typeof createGroupInbox>;

/** WhatsApp wraps a message in these (disappearing, view once, edited, a document with a caption): the inside counts. */
const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;

/** What stands for a message without words, by its kind. */
const KINDS: ReadonlyArray<readonly [string, string]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "location"],
  ["liveLocationMessage", "location"],
  ["contactMessage", "contact"],
  ["contactsArrayMessage", "contacts"],
  ["pollCreationMessage", "poll"],
  ["pollCreationMessageV2", "poll"],
  ["pollCreationMessageV3", "poll"],
];

type Loose = Record<string, unknown> | null | undefined;
const field = (o: Loose, key: string): Loose => {
  const v = o?.[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
};
const words = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * A message's words as a person reads them: the text, a caption with its kind (`[image] look at this`), a poll's
 * question, or the kind alone. Null for what is not a message people see (a reaction, a receipt, a key update).
 */
export function textOf(message: unknown, depth = 0): string | null {
  const m = message && typeof message === "object" ? (message as Record<string, unknown>) : null;
  if (!m || depth > 3) return null;
  for (const wrapper of WRAPPERS) {
    const inner = field(field(m, wrapper), "message");
    if (inner) return textOf(inner, depth + 1);
  }
  const plain = words(m.conversation) || words(field(m, "extendedTextMessage")?.text);
  if (plain) return plain;
  for (const [key, kind] of KINDS) {
    const part = field(m, key);
    if (!part) continue;
    const said = words(part.caption) || words(part.name) || words(part.displayName);
    return said ? `[${kind}] ${said}` : `[${kind}]`;
  }
  return null;
}

/** `5511999999999:12@s.whatsapp.net` → `5511999999999`; null for anything that is not a phone's address. */
export function phoneOf(jid: string | null | undefined): string | null {
  if (!jid?.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.split(/[:@]/)[0] ?? "";
  return /^[0-9]{8,15}$/.test(digits) ? digits : null;
}
