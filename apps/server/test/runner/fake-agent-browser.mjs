// A fake `agent-browser` for browser tests: answers `--json` like the real one.
// Each run appends `{ args, stdin, cwd }` to $FAKE_AB_LOG (one JSON line). The page
// lives in $FAKE_AB_STATE: `{ open, url, attrs: { "@e3": { type } }, clickTo, tabTo, noHistory, port, delayMs }`.
// In a `batch`, `focus` focuses a ref and `eval` runs its script against that field as a page would see it
// (`attrs[ref]`: `tag`, `type`, `autocomplete`, `method` of its form, `submitMethod`: a submit button's
// `formmethod`; `frame`: `{ origin, ancestors }` when the session is inside a frame); a script may mark the field
// (`setAttribute`, kept in `marks` for this page only) and `fill [attr="value"]` finds it by that mark, or nothing
// (`navigateAfterCheck`: the page goes there right after a check marks a field, as a page that moved on would);
// `filled` keeps what each fill typed into. With `--bail` the batch stops at the first failure (ADR 0144).
// `get box <sel>` answers `boxes[sel]`; a script sees `viewport` as `window.innerWidth`/`innerHeight` and
// `hit` (`{ tag, type, box: [left, top, right, bottom], ref }`) at any `document.elementFromPoint`; a
// `mouse down` focuses that `ref`; `frames` (`[[width, height]]`) are the page's iframes.
// `typingMs`: a batch that presses keys or moves the pointer takes that long (a person can step in meanwhile).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (c) => {
    data += c;
  });
  process.stdin.on("end", () => resolve(data));
});
if (process.env.FAKE_AB_LOG)
  appendFileSync(process.env.FAKE_AB_LOG, `${JSON.stringify({ args: argv, stdin, cwd: process.cwd() })}\n`);

const VALUED = new Set([
  "--namespace",
  "--session",
  "--profile",
  "--config",
  "--max-output",
  "--idle-timeout",
  "--download-path",
  "--screenshot-dir",
  "--screenshot-format",
  "--screenshot-quality",
  "--executable-path",
  "--args",
  "--cdp",
  "--screenshot-format",
  "--screenshot-quality",
]);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++;
  else if (!argv[i].startsWith("--")) rest.push(argv[i]);
  else if (argv[i] === "--all") rest.push("--all");
}
const file = process.env.FAKE_AB_STATE;
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { open: false, url: "about:blank" };
const save = () => {
  if (!file) return;
  // Concurrent agents use separate fake processes: a reader must never see a truncated state document.
  const next = `${file}.${process.pid}.tmp`;
  writeFileSync(next, JSON.stringify(state));
  renameSync(next, file);
};
const out = (o) => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
  save();
};

/** A script run as the page would: its document's focused element, its frame's location, `window` and `top`. */
const pageEval = (script, focused) => {
  const field = focused ? (state.attrs?.[focused] ?? {}) : null;
  const frame = state.frame ?? {};
  let origin = "null";
  try {
    origin = new URL(state.url).origin;
  } catch {
    // not a page: an opaque origin
  }
  const submit = field?.submitMethod
    ? [{ tagName: "BUTTON", getAttribute: (name) => (name === "formmethod" ? field.submitMethod : null) }]
    : [];
  const el = field
    ? {
        tagName: field.tag ?? "INPUT",
        type: field.type ?? "text",
        select: () => {},
        getAttribute: (name) => (name === "autocomplete" ? (field.autocomplete ?? null) : null),
        setAttribute: (name, value) => {
          state.marks = { ...(state.marks ?? {}), [name]: { value: String(value), ref: focused, url: state.url } };
        },
        form:
          field.method === undefined && submit.length === 0
            ? null
            : { getAttribute: (name) => (name === "method" ? (field.method ?? null) : null), elements: submit },
      }
    : null;
  const marked = (selector) => {
    const m = /^\[([a-z-]+)="([^"]*)"\]$/.exec(selector);
    const mark = m ? state.marks?.[m[1]] : undefined;
    return m && mark && mark.value === m[2] && mark.url === state.url ? { name: m[1], mark } : null;
  };
  const hit = state.hit
    ? {
        tagName: state.hit.tag ?? "BUTTON",
        type: state.hit.type ?? "",
        isContentEditable: false,
        closest: () => null,
        getBoundingClientRect: () => {
          const [left, top, right, bottom] = state.hit.box;
          return { left, top, right, bottom };
        },
      }
    : null;
  const document = {
    activeElement: el,
    elementFromPoint: () => (state.hit?.ref && state.hit.ref === focused ? el : hit),
    querySelector: (selector) => {
      const found = marked(selector);
      return found ? { removeAttribute: (name) => delete state.marks[name] } : null;
    },
  };
  const win = state.viewport ? { innerWidth: state.viewport[0], innerHeight: state.viewport[1] } : {};
  const ancestors = frame.ancestors ?? [];
  const location = { origin: frame.origin ?? origin, ancestorOrigins: ancestors };
  const run = new Function("document", "location", "window", "top", `return ${script}`);
  return run(document, location, win, ancestors.length > 0 ? {} : win);
};

/** The element a mark selector names on this page, or null (another page has none). */
const markedField = (selector) => {
  const m = /^\[([a-z-]+)="([^"]*)"\]$/.exec(selector);
  const mark = m ? state.marks?.[m[1]] : undefined;
  return m && mark && mark.value === m[2] && mark.url === state.url ? mark.ref : null;
};

// `delayMs`: every command takes that long (a page busy under it).
if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));

const [command, ...args] = rest;
switch (command) {
  case "open":
  case "goto":
    state.open = true;
    state.prev = state.url;
    // Like the real one: schemes kept (about:blank too), bare hosts get https.
    state.url = /^[a-z][a-z0-9+.-]*:/i.test(args[0]) ? args[0] : `https://${args[0]}`;
    out({ success: true, data: { url: state.url } });
    break;
  case "stream":
    out({ success: true, data: { enabled: true, port: state.port ?? 41234, connected: state.open === true } });
    break;
  case "get":
    if (args[0] === "url") out({ success: true, data: { url: state.url } });
    else if (args[0] === "attr") out({ success: true, data: { value: state.attrs?.[args[1]]?.[args[2]] ?? null } });
    else out({ success: false, error: "bad get" });
    break;
  case "snapshot":
    out({ success: true, data: { snapshot: '- button "Go" [ref=e1]' } });
    break;
  case "click":
    if (state.clickTo) {
      state.prev = state.url;
      state.url = state.clickTo;
    }
    out({ success: true, data: { clicked: args[0] } });
    break;
  case "back":
    // A new tab has no history: `back` leaves it where it is.
    if (!state.noHistory) state.url = state.prev ?? "about:blank";
    out({ success: true, data: {} });
    break;
  case "tab":
    // `tab <n>`: switch to a tab that is on `tabTo` (a link that opened a new tab).
    if (/^\d+$/.test(args[0] ?? "") && state.tabTo) state.url = state.tabTo;
    out({ success: true, data: {} });
    break;
  case "batch": {
    const list = JSON.parse(stdin || "[]");
    if (state.typingMs && list.some((c) => c[0] === "press" || c[1] === "move")) {
      await new Promise((resolve) => setTimeout(resolve, state.typingMs));
    }
    const bail = argv.includes("--bail");
    const results = [];
    let focused = state.focusedRef ?? null;
    for (const cmd of list) {
      let result = { command: cmd[0], success: true, result: {}, error: null };
      if (cmd[0] === "focus") focused = cmd[1];
      if (cmd[0] === "mouse" && cmd[1] === "down") focused = state.hit?.ref ?? null;
      if (cmd[0] === "get" && cmd[1] === "box") {
        const box = state.boxes?.[cmd[2]];
        result = box
          ? { command: cmd, success: true, result: box, error: null }
          : { command: cmd, success: false, result: null, error: `Element not found: ${cmd[2]}` };
      }
      if (cmd[0] === "eval") {
        const before = JSON.stringify(state.marks ?? {});
        try {
          result.result = { result: pageEval(cmd[1], focused) };
        } catch (err) {
          result = {
            command: cmd[0],
            success: false,
            result: null,
            error: `Evaluation failed: ${err?.message ?? err}`,
          };
        }
        // A page that moves on right after its field was marked: the new page has none of its marks.
        if (state.navigateAfterCheck && JSON.stringify(state.marks ?? {}) !== before) {
          state.url = state.navigateAfterCheck;
          state.navigateAfterCheck = undefined;
        }
      }
      if (cmd[0] === "fill" && typeof cmd[1] === "string" && cmd[1].startsWith("[")) {
        const ref = markedField(cmd[1]);
        if (ref) state.filled = [...(state.filled ?? []), { ref, url: state.url }];
        else result = { command: "fill", success: false, result: null, error: `Element not found: ${cmd[1]}` };
      }
      results.push(result);
      if (!result.success && bail) break;
    }
    out(results);
    if (results.some((r) => !r.success)) process.exitCode = 1;
    break;
  }
  case "close":
    state.open = false;
    out({ success: true, data: { closed: true } });
    break;
  case "screenshot": {
    // Like the real one: it writes the file and fails when its folder isn't there. A `.jpg`
    // is a real JPEG header (1280×800); `--annotate` numbers the page's one button.
    const annotate = argv.includes("--annotate");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0, 0, 0, 0]);
    try {
      writeFileSync(args[0], args[0].endsWith(".jpg") ? jpeg : "png");
      out({
        success: true,
        data: {
          path: args[0],
          ...(annotate
            ? {
                annotations: [
                  { ref: "e1", number: 1, role: "button", name: "Go", box: { x: 10, y: 20, width: 100, height: 40 } },
                ],
              }
            : {}),
        },
      });
    } catch {
      out({ success: false, data: null, error: `Failed to save screenshot to ${args[0]}: No such file or directory` });
    }
    break;
  }
  case "eval":
    // The page's size, or a settle check (true).
    out({
      success: true,
      data: { result: args.join(" ").includes("innerWidth") ? [1280, 800] : true, origin: state.url },
    });
    break;
  case "upload":
    out({ success: true, data: { files: args.slice(1) } });
    break;
  case "wait":
    out({ success: true, data: {} });
    break;
  default:
    out({ success: false, data: null, error: `unknown command ${command}` });
    process.exitCode = 1;
}
