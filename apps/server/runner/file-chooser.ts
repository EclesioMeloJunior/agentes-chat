/**
 * An upload through the page's own file picker (`upload` on a button, not a file field). Sites such as Meta Business
 * Suite make their `<input type="file">` only when their "Add photo" button is clicked, and that click opens the
 * system's file dialog, which the agent can't see or drive. With Chrome's file chooser interception
 * (`Page.setInterceptFileChooserDialog`) no dialog opens: the page says which field asked for files
 * (`Page.fileChooserOpened`) and the files go straight into it (`DOM.setFileInputFiles`), as Playwright's file chooser
 * does. Interception is per DevTools connection, so it is on only while one of these is open, on Chrome's pages beside
 * `agent-browser`'s own connection.
 */

/** The subset of a WebSocket used here (a fake in tests). */
export interface ChooserSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ChooserDeps {
  /** Chrome's debugging port. */
  port: number;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  connect: (url: string) => ChooserSocket;
  /** How long a page's socket and each call on it may take. */
  quickMs: number;
}

/** What the page asked for: the field, on the page whose socket heard it. */
export interface ChosenField {
  backendNodeId: number;
  /** `selectSingle` or `selectMultiple`. */
  mode: string;
  page: PageSocket;
}

/** Chrome's pages listen at most this many at once: the agent's tabs are kept to a few (`BROWSER_TABS_KEPT`). */
export const CHOOSER_PAGES = 8;

/** A DevTools target id as Chrome makes them: anything else never goes into a socket's address. */
const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** One page's DevTools socket with its calls by id and the file chooser it heard of. */
export class PageSocket {
  private nextId = 1;
  private readonly waiting = new Map<number, (answer: Record<string, unknown> | null) => void>();
  open = false;

  constructor(
    private readonly socket: ChooserSocket,
    private readonly onChooser: (field: { backendNodeId: number; mode: string }) => void,
  ) {}

  /** Resolves true once the socket is open, false if it fails or closes first, or past `ms`. */
  ready(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const fail = () => {
        clearTimeout(timer);
        this.open = false;
        for (const done of [...this.waiting.values()]) done(null);
        this.waiting.clear();
        resolve(false);
      };
      const timer = setTimeout(fail, ms);
      (timer as { unref?: () => void }).unref?.();
      this.socket.onopen = () => {
        clearTimeout(timer);
        this.open = true;
        resolve(true);
      };
      this.socket.onerror = fail;
      this.socket.onclose = fail;
      this.socket.onmessage = (event) => this.heard(event.data);
    });
  }

  private heard(raw: unknown) {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (typeof m.id === "number") {
      this.waiting.get(m.id)?.(m);
      return;
    }
    if (m.method !== "Page.fileChooserOpened") return;
    const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;
    if (typeof params.backendNodeId !== "number") return;
    this.onChooser({
      backendNodeId: params.backendNodeId,
      mode: typeof params.mode === "string" ? params.mode : "selectSingle",
    });
  }

  /** Chrome's answer (`result` or `error`), null if none came in `ms` or the socket is down. */
  call(method: string, params: Record<string, unknown>, ms: number): Promise<Record<string, unknown> | null> {
    if (!this.open) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const done = (answer: Record<string, unknown> | null) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(answer);
      };
      const timer = setTimeout(() => done(null), ms);
      (timer as { unref?: () => void }).unref?.();
      this.waiting.set(id, done);
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        done(null);
      }
    });
  }

  close() {
    this.open = false;
    for (const done of [...this.waiting.values()]) done(null);
    this.waiting.clear();
    try {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

/** Interception on Chrome's pages, until `close`: `chosen` is the first field a page asked files for. */
export interface FileChooserCatch {
  /** How many pages listen. None: the picker can't be caught. */
  pages: number;
  chosen(ms: number, signal?: AbortSignal): Promise<ChosenField | null>;
  close(): void;
}

/** Turns interception on in each of Chrome's pages (most recently active first). */
export async function catchFileChooser(deps: ChooserDeps): Promise<FileChooserCatch> {
  let listed: unknown;
  try {
    const res = await deps.fetch(`http://127.0.0.1:${deps.port}/json/list`, {
      redirect: "error",
      signal: AbortSignal.timeout(deps.quickMs),
    });
    listed = await res.json();
  } catch {
    listed = [];
  }
  const ids = (Array.isArray(listed) ? listed : [])
    .filter(
      (t): t is { id: string } =>
        typeof t === "object" && t !== null && t.type === "page" && typeof t.id === "string" && TARGET_ID.test(t.id),
    )
    .slice(0, CHOOSER_PAGES)
    .map((t) => t.id);

  let found: ChosenField | null = null;
  const waiters = new Set<(field: ChosenField) => void>();
  const sockets: PageSocket[] = [];
  const listening = await Promise.all(
    ids.map(async (id) => {
      let page: PageSocket;
      try {
        page = new PageSocket(deps.connect(`ws://127.0.0.1:${deps.port}/devtools/page/${id}`), (field) => {
          if (found) return;
          found = { ...field, page };
          for (const w of waiters) w(found);
          waiters.clear();
        });
      } catch {
        return false;
      }
      sockets.push(page);
      if (!(await page.ready(deps.quickMs))) return false;
      // The page's events reach a connection only once it enabled them.
      if ((await page.call("Page.enable", {}, deps.quickMs)) === null) return false;
      const on = await page.call("Page.setInterceptFileChooserDialog", { enabled: true }, deps.quickMs);
      return on !== null && on.error === undefined;
    }),
  );

  return {
    pages: listening.filter(Boolean).length,
    chosen(ms, signal) {
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const done = (field: ChosenField | null) => {
          clearTimeout(timer);
          waiters.delete(done);
          signal?.removeEventListener("abort", stop);
          resolve(field);
        };
        const stop = () => done(null);
        const timer = setTimeout(stop, ms);
        (timer as { unref?: () => void }).unref?.();
        if (signal?.aborted) return done(null);
        signal?.addEventListener("abort", stop, { once: true });
        waiters.add(done);
      });
    },
    close() {
      // Closing the connection ends its interception: the next picker opens as it always did.
      for (const s of sockets) s.close();
      waiters.clear();
    },
  };
}

/** The files into the field the page asked for; null when they went in, else what went wrong. */
export async function giveFiles(field: ChosenField, files: string[], ms: number): Promise<string | null> {
  if (files.length === 0) return "No file to send";
  if (files.length > 1 && field.mode !== "selectMultiple") return "This field takes one file: send them one at a time";
  const r = await field.page.call("DOM.setFileInputFiles", { files, backendNodeId: field.backendNodeId }, ms);
  if (!r) return "The browser didn't answer";
  if (r.error !== undefined) {
    const e = r.error as { message?: unknown };
    return `The browser said: ${typeof e?.message === "string" ? e.message : "it couldn't take the files"}`;
  }
  return null;
}
