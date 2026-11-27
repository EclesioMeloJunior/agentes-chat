import { expect, test } from "bun:test";
import { createGroupInbox, phoneOf, textOf } from "./inbox.ts";

const G = "120363025246125486@g.us";
const said = (text: string, at = "2026-11-27T12:00:00.000Z") => ({
  kind: "message" as const,
  at,
  from: { name: "Ana", phone: "5511988887777" },
  fromMe: false,
  text,
});

test("the latest first time, then only what came after the cursor, oldest first", () => {
  const inbox = createGroupInbox();
  for (const n of [1, 2, 3]) inbox.add("org", G, said(`m${n}`));
  const first = inbox.read("org", G, null, 2);
  expect(first.entries.map((e) => e.text)).toEqual(["m2", "m3"]);
  expect(first.more).toBe(false);

  expect(inbox.read("org", G, first.cursor).entries).toEqual([]);
  for (const n of [4, 5, 6]) inbox.add("org", G, said(`m${n}`));
  const next = inbox.read("org", G, first.cursor, 2);
  expect(next.entries.map((e) => e.text)).toEqual(["m4", "m5"]);
  expect(next.more).toBe(true);
  const last = inbox.read("org", G, next.cursor, 2);
  expect(last.entries.map((e) => e.text)).toEqual(["m6"]);
  expect(last.more).toBe(false);
});

test("a cursor of an earlier start reads the whole window again", () => {
  const inbox = createGroupInbox();
  inbox.add("org", G, said("oi"));
  expect(inbox.read("org", G, "deadbeef.40").entries.map((e) => e.text)).toEqual(["oi"]);
});

test("a cursor taken before a group spoke still reads its first message", () => {
  const inbox = createGroupInbox();
  inbox.add("org", "111111111111111111@g.us", said("elsewhere"));
  const before = inbox.read("org", G, null);
  expect(before.entries).toEqual([]);
  inbox.add("org", G, said("first"));
  expect(inbox.read("org", G, before.cursor).entries.map((e) => e.text)).toEqual(["first"]);
});

test("sessions and groups are apart, and an unlinked session forgets its groups", () => {
  const inbox = createGroupInbox();
  inbox.add("a", G, said("for a"));
  expect(inbox.read("b", G, null).entries).toEqual([]);
  inbox.drop("a");
  expect(inbox.read("a", G, null).entries).toEqual([]);
});

test("kept to its limits: entries per group, their age, groups per session and words per entry", () => {
  let now = Date.parse("2026-11-27T12:00:00.000Z");
  const inbox = createGroupInbox({ perGroup: 3, groups: 2, maxAgeMs: 60_000, textMax: 5 }, () => now);
  for (const n of [1, 2, 3, 4]) inbox.add("org", G, said(`m${n}`, new Date(now).toISOString()));
  const read = inbox.read("org", G, null);
  expect(read.entries.map((e) => e.text)).toEqual(["m2", "m3", "m4"]);
  expect(read.since).toBe(new Date(now).toISOString());

  inbox.add("org", G, said("long words here", new Date(now).toISOString()));
  expect(inbox.read("org", G, null).entries.at(-1)?.text).toBe("long  […]");

  now += 120_000;
  expect(inbox.read("org", G, null).entries).toEqual([]);

  inbox.add("org", G, said("g", new Date(now).toISOString()));
  inbox.add("org", "222222222222222222@g.us", said("h", new Date(now).toISOString()));
  inbox.add("org", "333333333333333333@g.us", said("i", new Date(now).toISOString()));
  // The quietest group (G spoke first) made room.
  expect(inbox.read("org", G, null).entries).toEqual([]);
  expect(inbox.read("org", "333333333333333333@g.us", null).entries).toHaveLength(1);
});

test("textOf: words, captions with their kind, wrappers, and nothing for what people don't see", () => {
  expect(textOf({ conversation: " oi " })).toBe("oi");
  expect(textOf({ extendedTextMessage: { text: "veja https://x.y" } })).toBe("veja https://x.y");
  expect(textOf({ imageMessage: { caption: "promo" } })).toBe("[image] promo");
  expect(textOf({ stickerMessage: {} })).toBe("[sticker]");
  expect(textOf({ pollCreationMessageV3: { name: "Qual?" } })).toBe("[poll] Qual?");
  expect(textOf({ ephemeralMessage: { message: { conversation: "some" } } })).toBe("some");
  expect(textOf({ reactionMessage: { text: "👍" } })).toBeNull();
  expect(textOf({ protocolMessage: {} })).toBeNull();
  expect(textOf(null)).toBeNull();
});

test("phoneOf takes only a phone's address", () => {
  expect(phoneOf("5511988887777:3@s.whatsapp.net")).toBe("5511988887777");
  expect(phoneOf("123456789012345@lid")).toBeNull();
  expect(phoneOf(undefined)).toBeNull();
});
