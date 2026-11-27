import { expect, test } from "bun:test";
import { dialogAsks, pageDialogs } from "../../runner/page-dialogs";

/** Chrome's end: what was sent, each answered as `chrome` says (taken by default). */
function setup(opts: { waitMs?: number; chrome?: "takes" | "refuses" } = {}) {
  const sent: { method: string; params: Record<string, unknown>; sessionId: string }[] = [];
  const logged: string[] = [];
  const dialogs = pageDialogs(
    (method, params, sessionId, ack) => {
      sent.push({ method, params, sessionId });
      queueMicrotask(() => ack?.(opts.chrome === "refuses"));
    },
    { ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}), now: () => 1_000, log: (l) => logged.push(l) },
  );
  const opening = (type: string, message: string, extra: Record<string, unknown> = {}) => ({
    type,
    message,
    url: "https://shop.example.com/cart?id=1",
    defaultPrompt: "",
    hasBrowserHandler: false,
    ...extra,
  });
  return { dialogs, sent, logged, opening };
}

test("leaving a page is accepted and never told; an alert is accepted and its words kept for the next answer", () => {
  const { dialogs, sent, opening } = setup();
  dialogs.opened("s1", opening("beforeunload", ""));
  dialogs.opened("s1", opening("alert", "Your session expired"));
  expect(sent).toEqual([
    { method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: "s1" },
    { method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: "s1" },
  ]);
  expect(dialogs.open()).toBeNull();
  expect(dialogs.seen()).toBe(2);
  expect(dialogs.take()).toEqual([{ kind: "alert", message: "Your session expired", host: "shop.example.com" }]);
  // Told once.
  expect(dialogs.take()).toEqual([]);
});

test("a confirm waits for the agent's answer, which goes to the tab that asked", async () => {
  const { dialogs, sent, opening } = setup();
  let heard = 0;
  const off = dialogs.onOpen(() => heard++);
  dialogs.opened("s1", opening("confirm", "Delete the cart?"));
  expect(heard).toBe(1);
  expect(sent).toEqual([]);
  const open = dialogs.open();
  expect(open).toEqual({ kind: "confirm", message: "Delete the cart?", host: "shop.example.com", openedAt: 1_000 });
  expect(open && dialogAsks(open)).toBe(
    'The page on shop.example.com opened a confirm box and waits for an answer: "Delete the cart?".',
  );
  expect(await dialogs.answer(true)).toBe(true);
  expect(sent).toEqual([{ method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: "s1" }]);
  expect(dialogs.open()).toBeNull();
  // Nothing waits: nothing is answered, and an answer the agent gave itself leaves no note.
  expect(await dialogs.answer(true)).toBe(false);
  expect(dialogs.take()).toEqual([]);
  off();
  dialogs.opened("s1", opening("confirm", "Again?"));
  expect(heard).toBe(1);
});

test("a prompt takes the agent's text, the page's suggestion without one, and none when dismissed", async () => {
  const { dialogs, sent, opening } = setup();
  const ask = () => dialogs.opened("s1", opening("prompt", "Coupon code?", { defaultPrompt: "WELCOME" }));
  ask();
  const open = dialogs.open();
  expect(open).toMatchObject({ kind: "prompt", suggested: "WELCOME" });
  expect(open && dialogAsks(open)).toBe(
    'The page on shop.example.com opened a prompt box and waits for an answer: "Coupon code?". It suggests the text "WELCOME".',
  );
  await dialogs.answer(true, "SPRING");
  ask();
  await dialogs.answer(true);
  ask();
  await dialogs.answer(false, "ignored");
  expect(sent.map((m) => m.params)).toEqual([
    { accept: true, promptText: "SPRING" },
    { accept: true, promptText: "WELCOME" },
    { accept: false },
  ]);
});

test("unanswered past its wait a confirm is dismissed, and the next answer says so", async () => {
  const { dialogs, sent, logged, opening } = setup({ waitMs: 20 });
  dialogs.opened("s1", opening("confirm", "Still there?", { url: "about:blank" }));
  expect(dialogs.open()).not.toBeNull();
  await Bun.sleep(60);
  expect(dialogs.open()).toBeNull();
  expect(sent).toEqual([{ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: "s1" }]);
  expect(dialogs.take()).toEqual([{ kind: "confirm", message: "Still there?", host: "", expired: true }]);
  expect(logged).toHaveLength(1);
  // One the agent answered in time is never dismissed afterwards.
  dialogs.opened("s1", opening("confirm", "Sure?"));
  await dialogs.answer(true);
  await Bun.sleep(60);
  expect(sent).toHaveLength(2);
  expect(dialogs.take()).toEqual([]);
});

test("the one that has waited longest is answered first; a closed tab or a lost connection takes its question", async () => {
  const { dialogs, sent, opening } = setup({ chrome: "refuses" });
  dialogs.opened("s1", opening("confirm", "First?"));
  dialogs.opened("s2", opening("confirm", "Second?"));
  expect(dialogs.open()?.message).toBe("First?");
  // Chrome refusing the answer (the box closed meanwhile) is said, not taken for an answer.
  expect(await dialogs.answer(true)).toBe(false);
  expect(sent.at(-1)?.sessionId).toBe("s1");
  expect(dialogs.open()?.message).toBe("Second?");
  dialogs.closed("s2");
  expect(dialogs.open()).toBeNull();
  dialogs.opened("s3", opening("prompt", "Name?"));
  dialogs.clear();
  expect(dialogs.open()).toBeNull();
});

test("a page's words are cut, and the latest few notes are kept", () => {
  const { dialogs, opening } = setup();
  dialogs.opened("s1", opening("alert", "x".repeat(2_000)));
  expect(dialogs.take()[0]?.message).toHaveLength(500);
  for (let i = 0; i < 8; i++) dialogs.opened("s1", opening("alert", `n${i}`));
  expect(dialogs.take().map((n) => n.message)).toEqual(["n3", "n4", "n5", "n6", "n7"]);
});
