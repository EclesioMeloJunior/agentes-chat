import { expect, test } from "bun:test";
import { createHttpWhatsApp, readGroupRead, readGroups, WhatsAppError } from "../src/whatsapp";

// The WhatsApp service's groups and reads (ADR 0261 addendum of 2026-11-27): kept to their shapes, and the calls the
// server makes for them.

const G = "120363025246125486@g.us";

test("groups: only real group addresses, names cut and trimmed, sizes as counts", () => {
  expect(
    readGroups({
      groups: [
        { id: G, name: "  Garimpei Casa ", size: 812, adminsOnly: true },
        { id: "5511999999999@s.whatsapp.net", name: "a person" },
        { id: "123@newsletter", name: "a channel" },
        { id: "5511988887777-1600000000@g.us", name: "", size: -3 },
        "junk",
      ],
    }),
  ).toEqual([
    { id: G, name: "Garimpei Casa", size: 812, adminsOnly: true },
    { id: "5511988887777-1600000000@g.us", name: "5511988887777-1600000000@g.us", size: null, adminsOnly: false },
  ]);
  expect(readGroups({ groups: "no" })).toEqual([]);
  expect(readGroups(null)).toEqual([]);
});

test("a read: known kinds only, numbers only as digits, a cursor only of its shape", () => {
  const read = readGroupRead({
    entries: [
      { kind: "message", at: "2026-11-27T12:00:00.000Z", from: { name: "Ana", phone: "5511977776666" }, text: "oi" },
      { kind: "joined", at: "nope", from: { name: "Bruno", phone: "+55 11" }, text: "" },
      { kind: "deleted", at: "2026-11-27T12:00:00.000Z", text: "x" },
    ],
    cursor: "<script>",
    more: "yes",
    since: "2026-11-24T00:00:00.000Z",
  });
  expect(read.entries).toHaveLength(2);
  expect(read.entries[0]).toEqual({
    kind: "message",
    at: "2026-11-27T12:00:00.000Z",
    from: { name: "Ana", phone: "5511977776666" },
    fromMe: false,
    text: "oi",
  });
  expect(read.entries[1]?.from).toEqual({ name: "Bruno", phone: null });
  expect(Number.isNaN(Date.parse(read.entries[1]?.at ?? ""))).toBe(false);
  expect(read.cursor).toBe("");
  expect(read.more).toBe(false);
  expect(read.since).toBe("2026-11-24T00:00:00.000Z");
});

test("the HTTP gateway: a group's path, the cursor in the query only when it is one, a non-group refused", async () => {
  const urls: string[] = [];
  const wa = createHttpWhatsApp({
    url: "http://whatsapp:8080/",
    apiKey: "k",
    fetch: (async (url: string) => {
      urls.push(url);
      return Response.json(url.endsWith("/groups") ? { groups: [{ id: G, name: "Casa" }] } : { entries: [] });
    }) as unknown as typeof fetch,
  });
  expect(await wa.groups("org-1")).toEqual([{ id: G, name: "Casa", size: null, adminsOnly: false }]);
  await wa.readGroup("org-1", G, "0a1b2c3d.17");
  await wa.readGroup("org-1", G, "../../x");
  expect(urls).toEqual([
    "http://whatsapp:8080/v1/sessions/org-1/groups",
    `http://whatsapp:8080/v1/sessions/org-1/groups/${encodeURIComponent(G)}/messages?after=0a1b2c3d.17`,
    `http://whatsapp:8080/v1/sessions/org-1/groups/${encodeURIComponent(G)}/messages`,
  ]);
  await expect(wa.readGroup("org-1", "5511999999999@s.whatsapp.net")).rejects.toBeInstanceOf(WhatsAppError);
  expect(urls).toHaveLength(3);
});

test("a picture goes as base64 beside its caption, a text alone without it", async () => {
  const bodies: unknown[] = [];
  const wa = createHttpWhatsApp({
    url: "http://whatsapp:8080",
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  expect(await wa.send("org-1", G, "a casa", { bytes, contentType: "image/jpeg" })).toEqual({ id: "m1" });
  await wa.send("org-1", "5511999999999", "oi");
  expect(bodies).toEqual([
    { to: G, text: "a casa", image: { data: "/9j/4A==", mimetype: "image/jpeg" } },
    { to: "5511999999999", text: "oi" },
  ]);
});
