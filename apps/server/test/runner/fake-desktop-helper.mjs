// A fake desktop helper for desktop tests: speaks desktop-helper.py's JSON lines with canned data.
// Arguments: a log file and a state file (the runner gives a helper its own environment, not the test's).
// It appends `{ start: { env, cwd, argv } }` once (`argv`: what follows those two) and `{ request }` for
// each line to the log.
// The state file (read again for each request) is the desktop:
//   { snapshot, boxes: { "<bus> <path>": box | null }, windows, hello, apps, jpeg (what a capture holds),
//     crash: "<op>" (exits instead of answering), fail: { "<op>": { code, error } }, garbage: "<op>",
//     typing: true (an `input` goes on until SIGUSR1 stops it, as the real one's keys do) }
// Boxes and windows the state doesn't give come from the snapshot.
import { appendFileSync, readFileSync } from "node:fs";

const [logFile, stateFile] = process.argv.slice(2);
const log = (entry) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
log({ start: { env: process.env, cwd: process.cwd(), argv: process.argv.slice(4) } });

const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let typing = null;
process.on("SIGUSR1", () => {
  log({ signal: "SIGUSR1" });
  if (typing !== null) out({ id: typing, ok: false, code: "stopped", error: "a person took control" });
  typing = null;
});

function answer(req, s) {
  const snap = s.snapshot;
  switch (req.op) {
    case "hello":
      return {
        screen: snap.screen,
        a11y: true,
        damage: true,
        python: "3.13.5",
        xdotool: true,
        scrot: true,
        missing: [],
        ...s.hello,
      };
    case "snapshot":
      return { ...snap, ms: 3 };
    case "extents": {
      const boxes = {};
      for (const [bus, path] of req.nodes) {
        const key = `${bus} ${path}`;
        const node = snap.apps.find((a) => a.bus === bus)?.nodes?.find((n) => n.path === path);
        boxes[key] = s.boxes && key in s.boxes ? s.boxes[key] : (node?.box ?? null);
      }
      return { boxes, windows: s.windows ?? snap.windows };
    }
    case "input":
      return { ms: 7, ...(req.settle ? { settled: true, changed: true } : {}) };
    case "capture": {
      const [width, height] = req.region ? [req.region.width, req.region.height] : snap.screen;
      const jpeg = Buffer.from(s.jpeg ?? "not really a jpeg").toString("base64");
      return { jpeg, width, height, region: req.region ?? null };
    }
    case "apps":
      return s.apps ?? [{ id: "thunar.desktop", name: "File Manager", generic: "File Manager", keywords: [] }];
    default:
      return null;
  }
}

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let nl = buffered.indexOf("\n");
  while (nl >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    nl = buffered.indexOf("\n");
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    log({ request: req });
    const s = state();
    if (s.crash === req.op) process.exit(3);
    if (s.garbage === req.op) {
      process.stdout.write("this is not json\n");
      continue;
    }
    if (s.typing && req.op === "input") {
      typing = req.id;
      continue;
    }
    const failure = s.fail?.[req.op];
    if (failure) out({ id: req.id, ok: false, code: failure.code, error: failure.error });
    else out({ id: req.id, ok: true, data: answer(req, s) });
  }
});
process.stdin.on("end", () => process.exit(0));
