/**
 * A page's own dialogs (`alert`, `confirm`, `prompt` and the browser's "Leave site?"), answered on the runner's
 * DevTools connection to the agent's Chrome (ADR 0040 §21). While one is open the page runs
 * nothing, so every command sent to it waits: measured on agent-browser 0.42 with `--cdp`, an `open` away from a page
 * with a `beforeunload` handler and an `alert` both left the browser unanswering until Chrome was closed, and nothing
 * told the agent why.
 *
 * - "Leave site?" is accepted at once: whoever navigates away asked to leave.
 * - An `alert` is accepted at once (there is nothing to choose) and its words are kept for the agent's next answer.
 * - A `confirm` or a `prompt` waits for the agent's own answer (`dialog accept|dismiss`). Unanswered after
 *   `PAGE_DIALOG_WAIT_MS` it is dismissed, as a person closing it would, so the browser never stays stopped, and the
 *   agent's next answer says so.
 *
 * Only a DevTools session that had `Page` enabled when the dialog opened may answer it, so the counter enables it on
 * every tab as it attaches.
 */

import type { BrowserDialogNote } from "@agenteschat/adapters/machine-protocol";

/** How long a `confirm` or a `prompt` waits for the agent before it is dismissed. */
export const PAGE_DIALOG_WAIT_MS = 60_000;
/** A dialog's words as kept and told: the page wrote them. */
const MESSAGE_CHARS = 500;
/** Told dialogs kept for the next answer: the latest ones. */
const NOTES_KEPT = 5;
/** How long Chrome has to say it took an answer. */
const ANSWER_ACK_MS = 3_000;

/** A `confirm` or `prompt` that waits for an answer. */
export interface OpenDialog {
  kind: "confirm" | "prompt";
  message: string;
  /** A `prompt`'s suggested text. */
  suggested?: string;
  /** The host of the page that asked ("" when it has none). */
  host: string;
  openedAt: number;
}

/** A dialog the runner closed itself, for the agent's next answer. */
export type DialogNote = BrowserDialogNote;

export interface PageDialogs {
  /** `Page.javascriptDialogOpening` on a tab's session. */
  opened(sessionId: string, params: Record<string, unknown>): void;
  /** `Page.javascriptDialogClosed` there, or the tab is gone. */
  closed(sessionId: string): void;
  /** The dialog that has waited longest, or null. */
  open(): OpenDialog | null;
  /** Answers the dialog that has waited longest. False when none waits or Chrome didn't take the answer. */
  answer(accept: boolean, text?: string): Promise<boolean>;
  /** The dialogs closed here since the last call. */
  take(): DialogNote[];
  /** How many dialogs opened so far. */
  seen(): number;
  /** Calls `listener` at each dialog that opens; the function returned ends that. */
  onOpen(listener: () => void): () => void;
  /** The connection is gone: nothing waits any more. */
  clear(): void;
}

type Send = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
  ack?: (failed: boolean) => void,
) => void;

const text = (v: unknown) => (typeof v === "string" ? v.slice(0, MESSAGE_CHARS) : "");

function hostOf(url: unknown): string {
  try {
    return typeof url === "string" ? new URL(url).host : "";
  } catch {
    return "";
  }
}

export function pageDialogs(
  send: Send,
  opts: { waitMs?: number; now?: () => number; log?: (line: string) => void } = {},
): PageDialogs {
  const waitMs = opts.waitMs ?? PAGE_DIALOG_WAIT_MS;
  const now = opts.now ?? Date.now;
  /** By the tab's session, in the order they opened. */
  const waiting = new Map<string, { dialog: OpenDialog; timer: ReturnType<typeof setTimeout> }>();
  let notes: DialogNote[] = [];
  const listeners = new Set<() => void>();
  let count = 0;
  const note = (n: DialogNote) => {
    notes = [...notes, n].slice(-NOTES_KEPT);
  };
  const forget = (sessionId: string) => {
    const w = waiting.get(sessionId);
    if (!w) return null;
    clearTimeout(w.timer);
    waiting.delete(sessionId);
    return w.dialog;
  };
  const handle = (sessionId: string, accept: boolean, promptText?: string) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ANSWER_ACK_MS);
      (timer as { unref?: () => void }).unref?.();
      send(
        "Page.handleJavaScriptDialog",
        { accept, ...(promptText !== undefined ? { promptText } : {}) },
        sessionId,
        (failed) => {
          clearTimeout(timer);
          resolve(!failed);
        },
      );
    });

  return {
    opened(sessionId, params) {
      count++;
      const kind = params.type;
      const message = text(params.message);
      const host = hostOf(params.url);
      if (kind === "confirm" || kind === "prompt") {
        forget(sessionId);
        const suggested = text(params.defaultPrompt);
        const dialog: OpenDialog = {
          kind,
          message,
          host,
          openedAt: now(),
          ...(kind === "prompt" && suggested ? { suggested } : {}),
        };
        const timer = setTimeout(() => {
          if (waiting.get(sessionId)?.dialog !== dialog) return;
          forget(sessionId);
          note({ kind, message, host, expired: true });
          opts.log?.(`a page's ${kind} got no answer in ${Math.round(waitMs / 1000)} s: dismissed`);
          void handle(sessionId, false);
        }, waitMs);
        (timer as { unref?: () => void }).unref?.();
        waiting.set(sessionId, { dialog, timer });
      } else {
        // An alert has one button, and leaving a page is what whoever navigates asked for.
        if (kind === "alert") note({ kind, message, host });
        void handle(sessionId, true);
      }
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // one listener's error never keeps the dialog from the others
        }
      }
    },
    closed(sessionId) {
      forget(sessionId);
    },
    open() {
      const first = waiting.values().next();
      return first.done ? null : first.value.dialog;
    },
    async answer(accept, promptText) {
      const first = waiting.keys().next();
      if (first.done) return false;
      const sessionId = first.value;
      const dialog = forget(sessionId);
      return handle(
        sessionId,
        accept,
        accept && dialog?.kind === "prompt" ? (promptText ?? dialog.suggested ?? "") : undefined,
      );
    },
    take() {
      const out = notes;
      notes = [];
      return out;
    },
    seen: () => count,
    onOpen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      for (const sessionId of [...waiting.keys()]) forget(sessionId);
      listeners.clear();
    },
  };
}

/** What a waiting dialog answers in place of a command: the page's question, in quotes as its own words. */
export function dialogAsks(d: OpenDialog): string {
  const from = d.host ? ` on ${d.host}` : "";
  const suggested = d.suggested ? ` It suggests the text "${d.suggested}".` : "";
  return `The page${from} opened a ${d.kind} box and waits for an answer: "${d.message}".${suggested}`;
}
