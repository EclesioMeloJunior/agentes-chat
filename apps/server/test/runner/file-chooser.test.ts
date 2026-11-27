import { expect, test } from "bun:test";
import { CHOOSER_PAGES, type ChooserSocket, catchFileChooser, giveFiles } from "../../runner/file-chooser";

/** A Chrome page's DevTools socket: answers every call, and opens the file picker when told to. */
class FakePage implements ChooserSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private readonly refuse: string[] = [],
  ) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    const { id, method, params } = JSON.parse(data);
    this.calls.push({ method, params });
    const answer = this.refuse.includes(method) ? { id, error: { message: `${method} refused` } } : { id, result: {} };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(answer) }));
  }

  /** The page asks for files (a click on its "Add photo" button). */
  pick(backendNodeId: number, mode = "selectSingle") {
    this.onmessage?.({ data: JSON.stringify({ method: "Page.fileChooserOpened", params: { backendNodeId, mode } }) });
  }

  close() {
    this.closed = true;
  }
}

function chrome(targets: unknown[], refuse: string[] = []) {
  const pages: FakePage[] = [];
  return {
    pages,
    deps: {
      port: 9222,
      quickMs: 1000,
      fetch: async (url: string) => {
        expect(url).toBe("http://127.0.0.1:9222/json/list");
        return new Response(JSON.stringify(targets));
      },
      connect: (url: string) => {
        const p = new FakePage(url, refuse);
        pages.push(p);
        return p;
      },
    },
  };
}

test("the picker is caught on every page, and the files go into the field it asked them for", async () => {
  const c = chrome([
    { id: "TAB1", type: "page" },
    { id: "SW", type: "service_worker" },
    { id: "TAB2", type: "page" },
  ]);
  const picker = await catchFileChooser(c.deps);
  expect(picker.pages).toBe(2);
  expect(c.pages.map((p) => p.url)).toEqual([
    "ws://127.0.0.1:9222/devtools/page/TAB1",
    "ws://127.0.0.1:9222/devtools/page/TAB2",
  ]);
  for (const p of c.pages) {
    expect(p.calls.map((x) => x.method)).toEqual(["Page.enable", "Page.setInterceptFileChooserDialog"]);
    expect(p.calls[1]?.params).toEqual({ enabled: true });
  }

  const waiting = picker.chosen(1000);
  c.pages[1]?.pick(42);
  const field = await waiting;
  if (!field) throw new Error("no field");
  expect(field?.backendNodeId).toBe(42);
  expect(await giveFiles(field, ["C:\\agentes\\marcal\\video.mp4"], 1000)).toBeNull();
  expect(c.pages[1]?.calls.at(-1)).toEqual({
    method: "DOM.setFileInputFiles",
    params: { files: ["C:\\agentes\\marcal\\video.mp4"], backendNodeId: 42 },
  });
  // The other page got nothing.
  expect(c.pages[0]?.calls).toHaveLength(2);

  picker.close();
  expect(c.pages.every((p) => p.closed)).toBe(true);
});

test("no picker opened: nothing chosen once the wait is over, or when stopped", async () => {
  const c = chrome([{ id: "TAB1", type: "page" }]);
  const picker = await catchFileChooser(c.deps);
  expect(await picker.chosen(10)).toBeNull();
  const stop = new AbortController();
  const stopped = picker.chosen(5000, stop.signal);
  stop.abort();
  expect(await stopped).toBeNull();
  picker.close();
});

test("a field of one file takes one; Chrome's refusal is said", async () => {
  const c = chrome([{ id: "TAB1", type: "page" }], ["DOM.setFileInputFiles"]);
  const picker = await catchFileChooser(c.deps);
  const waiting = picker.chosen(1000);
  c.pages[0]?.pick(7);
  const field = await waiting;
  if (!field) throw new Error("no field");
  expect(await giveFiles(field, ["a.png", "b.png"], 1000)).toBe("This field takes one file: send them one at a time");
  expect(await giveFiles(field, [], 1000)).toBe("No file to send");
  expect(await giveFiles(field, ["a.png"], 1000)).toBe("The browser said: DOM.setFileInputFiles refused");
  picker.close();
});

test("pages that refuse interception, odd target ids and Chrome unreachable leave nothing listening", async () => {
  const refused = await catchFileChooser(
    chrome([{ id: "TAB1", type: "page" }], ["Page.setInterceptFileChooserDialog"]).deps,
  );
  expect(refused.pages).toBe(0);
  refused.close();

  const odd = chrome([{ id: "../browser", type: "page" }]);
  expect((await catchFileChooser(odd.deps)).pages).toBe(0);
  expect(odd.pages).toHaveLength(0);

  const down = chrome([]);
  down.deps.fetch = async () => {
    throw new Error("connection refused");
  };
  expect((await catchFileChooser(down.deps)).pages).toBe(0);
});

test("at most CHOOSER_PAGES pages listen", async () => {
  const c = chrome(Array.from({ length: CHOOSER_PAGES + 3 }, (_, i) => ({ id: `T${i}`, type: "page" })));
  const picker = await catchFileChooser(c.deps);
  expect(picker.pages).toBe(CHOOSER_PAGES);
  picker.close();
});
