import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler, NotConnectedError, phoneDigits, type Sessions, type SessionView } from "./http.ts";

const GROUP = "120363025246125486@g.us";
const off: SessionView = { state: "off", qr: null, qrExpiresAt: null, account: null, reason: null };

function fakeSessions() {
  const open = new Set<string>();
  const sent: { id: string; to: string; text: string }[] = [];
  const reads: { id: string; group: string; after: string | null }[] = [];
  const sessions: Sessions = {
    view: (id) => (open.has(id) ? { ...off, state: "open", account: { phone: "5511999999999" } } : off),
    start: async (id) => ({ ...off, state: id === "pair" ? "qr" : "starting", qr: id === "pair" ? "data:x" : null }),
    send: async (id, to, text) => {
      if (!open.has(id)) throw new NotConnectedError();
      sent.push({ id, to, text });
      return { id: `m${sent.length}` };
    },
    logout: async (id) => {
      open.delete(id);
    },
    groups: async (id) => {
      if (!open.has(id)) throw new NotConnectedError();
      return [{ id: GROUP, name: "Garimpei Casa", size: 12, adminsOnly: false }];
    },
    readGroup: async (id, group, after) => {
      if (!open.has(id)) throw new NotConnectedError();
      reads.push({ id, group, after });
      return { entries: [], cursor: "ab.3", more: false, since: "2026-11-27T00:00:00.000Z" };
    },
  };
  return { sessions, open, sent, reads };
}

describe("whatsapp sidecar http", () => {
  const fake = fakeSessions();
  let server: Server;
  let base = "";
  const call = (path: string, init: RequestInit = {}, key = "secret") =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });

  beforeAll(async () => {
    server = createServer(createHandler(fake.sessions, "secret"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  test("health answers without the token, everything else asks for it", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await call("/v1/sessions/org-1", {}, "wrong")).status).toBe(401);
    expect((await fetch(`${base}/v1/sessions/org-1`)).status).toBe(401);
  });

  test("a session's state, and its QR once started", async () => {
    expect(await (await call("/v1/sessions/org-1")).json()).toEqual(off);
    const started = await (await call("/v1/sessions/pair/start", { method: "POST" })).json();
    expect(started).toMatchObject({ state: "qr", qr: "data:x" });
  });

  test("an id that isn't one is refused", async () => {
    expect((await call("/v1/sessions/..%2Fetc")).status).toBe(400);
  });

  test("sends only on an open session, to a number, with words", async () => {
    const post = (id: string, body: unknown) =>
      call(`/v1/sessions/${id}/messages`, { method: "POST", body: JSON.stringify(body) });
    expect((await post("org-1", { to: "+55 11 99999-9999", text: "oi" })).status).toBe(409);
    fake.open.add("org-1");
    const ok = await post("org-1", { to: "+55 (11) 99999-9999", text: "oi" });
    expect(ok.status).toBe(200);
    expect(fake.sent.at(-1)).toEqual({ id: "org-1", to: "5511999999999", text: "oi" });
    expect((await post("org-1", { to: "123", text: "oi" })).status).toBe(400);
    expect((await post("org-1", { to: "5511999999999", text: " " })).status).toBe(400);
    expect((await post("org-1", { to: "5511999999999", text: "x".repeat(5000) })).status).toBe(400);
  });

  test("sends to a group by its address, never to a name or another kind of address", async () => {
    fake.open.add("org-3");
    const post = (to: string) =>
      call("/v1/sessions/org-3/messages", { method: "POST", body: JSON.stringify({ to, text: "oi" }) });
    expect((await post(GROUP)).status).toBe(200);
    expect(fake.sent.at(-1)).toEqual({ id: "org-3", to: GROUP, text: "oi" });
    expect((await post("5511999999999-1600000000@g.us")).status).toBe(200);
    expect((await post("Garimpei Casa")).status).toBe(400);
    expect((await post("120363025246125486@newsletter")).status).toBe(400);
    expect((await post("5511999999999@s.whatsapp.net")).status).toBe(400);
  });

  test("lists the phone's groups and reads one, only while it is linked", async () => {
    expect((await call("/v1/sessions/org-4/groups")).status).toBe(409);
    fake.open.add("org-4");
    expect(await (await call("/v1/sessions/org-4/groups")).json()).toEqual({
      groups: [{ id: GROUP, name: "Garimpei Casa", size: 12, adminsOnly: false }],
    });
    const read = await call(`/v1/sessions/org-4/groups/${encodeURIComponent(GROUP)}/messages?after=ab.2`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ cursor: "ab.3", more: false });
    expect(fake.reads.at(-1)).toEqual({ id: "org-4", group: GROUP, after: "ab.2" });
    expect((await call("/v1/sessions/org-4/groups/not-a-group/messages")).status).toBe(400);
    expect((await call(`/v1/sessions/org-4/groups/${GROUP}/messages?after=x`)).status).toBe(400);
    expect((await call(`/v1/sessions/org-4/groups/${GROUP}/messages`, { method: "POST" })).status).toBe(405);
  });

  test("logout", async () => {
    fake.open.add("org-2");
    expect((await call("/v1/sessions/org-2", { method: "DELETE" })).status).toBe(204);
    expect(fake.open.has("org-2")).toBe(false);
  });
});

test("phoneDigits", () => {
  expect(phoneDigits("+1 (415) 555-0100")).toBe("14155550100");
  expect(phoneDigits("0011999")).toBeNull();
  expect(phoneDigits("55abc11999999999")).toBeNull();
});
