import type { JudgeReach } from "../judge";

/**
 * What the screen's tools tell an agent about targets, finds and checks, by what
 * judges for its workspace now (ADR 0054, addendum of 2026-11-27). A tool that
 * says "name it in words" where nothing matches words costs the agent a failed
 * step before it reaches for the number, on every plan. So the words follow
 * the server:
 *
 * - `calibrated` (Jev): targets in plain words, conditions and finds in words;
 * - `model` (the workspace's small model only): conditions and finds in words,
 *   targets by number or by name, since only a calibrated judge picks one;
 * - `none`: targets by number or by name, and a find, a wait and an `expect`
 *   are words looked for on the screen as written.
 *
 * The texts of the first are the ones these tools always had.
 */
export interface ScreenWording {
  /** A target may be a description (`the green button`): a calibrated judge picks it. */
  described: boolean;
  /** The `target` of a step or of a tool. */
  target: string;
  /** In the plan tool's description: how its targets, its `expect` and its `find` are written. */
  plan: string;
  /** A step's `until`, `find` and `expect`. */
  until: string;
  find: string;
  expect: string;
  /** In the read tool's description: acting on what was read, and `find`. */
  read: string;
  /** The read tool's `find`. */
  readFind: string;
}

export interface BrowserWording extends ScreenWording {
  /** In `browser_wait`'s description: what `until` takes. */
  wait: string;
  /** `browser_wait`'s `until`. */
  waitUntil: string;
}

const NOT_DESCRIBED = (noun: string) =>
  `A description (\`the green button\`, \`the first result\`) isn't matched on this server: read the ${noun} and give the number.`;

const BROWSER_NAMES = {
  described: false,
  target: `What to act on: the element's number from the page (\`e7\`), or its name exactly as the page writes it, alone or with its kind or where it is (\`Sign in\`, \`the Email field\`, \`Export in the Reports toolbar\`). ${NOT_DESCRIBED("page")} For something that can't be undone (pay, delete, send), give its number.`,
  planTargets:
    "Name each target by its number from the page, or by its name exactly as the page writes it (`the Email field`, `Export`): it is found on the page as it is at that step, even on pages the plan reaches on its way. A description (`the first result`, `the blue button`) isn't matched on this server: where you don't know a page's names, end the plan with a `read` and go on from the numbers it gives.",
  readTargets: "Act on an element by its number (`e7`) or by its name exactly as the page writes it.",
} as const;

export function browserWording(reach: JudgeReach): BrowserWording {
  const judged = {
    until: "`wait`: until this is true on the page, in words (`the export finished`).",
    find: "`read`: what to get from the page (`the order total`, `the status message`): only the lines that answer it.",
    expect:
      "After this step the page should show this (`the cart has 2 items`, `signed in`). It is checked; the plan stops there when it isn't true.",
    readFind: "What you're looking for (`the order total`, `whether the export finished`): only those lines.",
    wait: "`until` takes a condition in words (`the export finished`, `the payment shows as approved`), checked each time the page changes.",
    waitUntil: "Wait until this is true on the page, in words.",
  };
  const planChecks =
    "Give `expect` on steps whose result matters (`signed in`, `the order is confirmed`): it's checked, and the plan stops at the first step that fails or doesn't show what you expected, telling you why and what's on the page then, so you can go on from there. To report what the page says at the end, finish with a `read` step and `find` (`the status message`).";
  const readFind =
    "To get one thing from a long page (a total, a status, an error), say it in `find`: you get just the lines that answer it.";
  if (reach === "calibrated") {
    return {
      described: true,
      target:
        "What to act on: the element's number from the page (`e7`) or plain words (`the Sign in button`, `the Email field`, `Edit in the row for invoice 42`). For something that can't be undone (pay, delete, send), give its number.",
      plan: `You don't need to have seen a page to plan on it: name each target in words (\`the Email field\`, \`Export\`) and it is found on the page as it is at that step, even pages the plan reaches on its way. ${planChecks}`,
      read: `Act on an element by its number (\`e7\`) or name it in words. ${readFind}`,
      ...judged,
    };
  }
  if (reach === "model") {
    return {
      described: false,
      target: BROWSER_NAMES.target,
      plan: `${BROWSER_NAMES.planTargets} ${planChecks}`,
      read: `${BROWSER_NAMES.readTargets} ${readFind}`,
      ...judged,
    };
  }
  return {
    described: false,
    target: BROWSER_NAMES.target,
    plan: `${BROWSER_NAMES.planTargets} Give \`expect\` on steps whose result matters, as the words the page will then show, written as it writes them (\`Order confirmed\`, \`Welcome back\`): the plan stops at the first step that fails or doesn't show them, telling you why and what's on the page then, so you can go on from there. Nothing weighs a condition in words on this server: leave \`expect\` out where you can't tell the exact words. To report what the page says at the end, finish with a \`read\` step; its \`find\` takes words to look for (\`total\`, \`status\`) and gives the lines that have them.`,
    until:
      "`wait`: until the page shows these words, written as it writes them (`Export finished`). A condition in words isn't weighed on this server.",
    find: "`read`: words to look for on the page (`total`, `order status`): the lines that have them, or the page when none does.",
    expect:
      "After this step the page should show these words, written as it writes them (`2 items`, `Signed in as`). It is checked; the plan stops there when they don't show.",
    read: `${BROWSER_NAMES.readTargets} To get one thing from a long page (a total, a status, an error), give words to look for in \`find\`: you get the lines that have them.`,
    readFind: "Words to look for (`total`, `export`): the lines that have them, or the page when none does.",
    wait: "`until` takes the words the page will show, written as it writes them (`Export finished`), looked for each time the page changes. A condition in words isn't weighed on this server.",
    waitUntil: "Wait until the page shows these words, written as it writes them.",
  };
}

const DESKTOP_NAMES = {
  target: `What to act on: its number from the screen (\`e7\`), or its name exactly as the screen writes it, alone or with its kind or where it is (\`Save\`, \`the File menu\`, \`Documents in the file list\`). ${NOT_DESCRIBED("screen")} For something that can't be undone (delete, discard, overwrite), give its number.`,
  planTargets:
    "name each target by its number, or by its name exactly as the screen writes it (`the File menu`, `Save`), and it is found on the screen as it is at that step. A description (`the second icon`) isn't matched on this server: where you don't know the names, end the plan with a `read` and go on from the numbers it gives.",
  readTargets: "Act on an element by its number (`e7`) or by its name exactly as the screen writes it.",
} as const;

export function desktopWording(reach: JudgeReach): ScreenWording {
  const judged = {
    until: "`wait`: until this is true on the screen, in words (`the download finished`).",
    find: "`read`: what to get from the screen (`the command's output`, `the error message`): only the lines that answer it.",
    expect:
      "After this step the screen should show this (`a folder reports in Documents`, `the file is saved`). It is checked; the plan stops there when it isn't true.",
    readFind: "What you're looking for (`the last command's output`, `whether the export finished`).",
  };
  const planChecks =
    "Give `expect` on steps whose result matters: it's checked, and the plan stops at the first step that fails or doesn't show it, saying why and what's on the screen then.";
  const readFind =
    "To get one thing (a command's output, a status, an error), say it in `find`: you get just the lines that answer it.";
  if (reach === "calibrated") {
    return {
      described: true,
      target:
        "What to act on: its number from the screen (`e7`) or plain words (`the Save button`, `the File menu`, `Documents in the file list`). For something that can't be undone (delete, discard, overwrite), give its number.",
      plan: `name each target in words (\`the File menu\`, \`Save\`) or by its number, and it is found on the screen as it is at that step. ${planChecks}`,
      read: `Act on an element by its number (\`e7\`) or name it in words. ${readFind}`,
      ...judged,
    };
  }
  if (reach === "model") {
    return {
      described: false,
      target: DESKTOP_NAMES.target,
      plan: `${DESKTOP_NAMES.planTargets} ${planChecks}`,
      read: `${DESKTOP_NAMES.readTargets} ${readFind}`,
      ...judged,
    };
  }
  return {
    described: false,
    target: DESKTOP_NAMES.target,
    plan: `${DESKTOP_NAMES.planTargets} Give \`expect\` on steps whose result matters, as the words the screen will then show, written as it writes them (\`Saved\`, \`reports\`): the plan stops at the first step that fails or doesn't show them, saying why and what's on the screen then. Nothing weighs a condition in words on this server: leave \`expect\` out where you can't tell the exact words.`,
    until:
      "`wait`: until the screen shows these words, written as it writes them (`Download complete`). A condition in words isn't weighed on this server.",
    find: "`read`: words to look for on the screen (`error`, `total`): the lines that have them, or the screen when none does.",
    expect:
      "After this step the screen should show these words, written as it writes them (`Saved`, `reports`). It is checked; the plan stops there when they don't show.",
    read: `${DESKTOP_NAMES.readTargets} To get one thing (a command's output, a status, an error), give words to look for in \`find\`: you get the lines that have them.`,
    readFind: "Words to look for (`error`, `export`): the lines that have them, or the screen when none does.",
  };
}

/** The three ways a source words its tools, made once each on first use. */
export function byReach<T>(make: (reach: JudgeReach) => T): (reach: JudgeReach) => T {
  const made = new Map<JudgeReach, T>();
  return (reach) => {
    let set = made.get(reach);
    if (set === undefined) {
      set = make(reach);
      made.set(reach, set);
    }
    return set;
  };
}
