import { afterEach, expect, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import path from "node:path";
import {
  BROWSER_SOCKET,
  closeBrowser,
  type DesktopNote,
  noteArgs,
  runDesktopBrowser,
  serveBrowser,
} from "../../runner/desktop-browser";
import { RunnerError } from "../../runner/errors";
import { removeDirs, socketAnswer, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";

function socketIn() {
  const dir = tempDir("dbs-");
  dirs.push(dir);
  return path.join(dir, BROWSER_SOCKET);
}

async function serve(socket: string, open: (installing: () => void) => Promise<void>) {
  const server = await serveBrowser(socket, open);
  servers.push(server);
  return server;
}

/** The notes the launcher showed, and which it closed. */
function notes() {
  const shown: { kind: "wait" | "error"; text: string; closed: boolean }[] = [];
  const note: DesktopNote = (kind, text) => {
    const n = { kind, text, closed: false };
    shown.push(n);
    return {
      close: () => {
        n.closed = true;
      },
    };
  };
  return { shown, note };
}

test.if(posix)(
  "a click: the runner opens the agent's browser, and the launcher shows nothing when it's quick",
  async () => {
    const socket = socketIn();
    let opened = 0;
    await serve(socket, async () => {
      opened++;
    });
    const n = notes();
    expect(await runDesktopBrowser(socket, { note: n.note })).toBe(0);
    expect(opened).toBe(1);
    expect(n.shown).toEqual([]);
  },
);

test.if(posix)(
  "a click that starts Chrome: the note says it is opening within a third of a second, and stays until the runner answers",
  async () => {
    const socket = socketIn();
    // The runner answers once Chrome's window is on the desktop, seconds after a click that starts it.
    await serve(socket, () => new Promise((r) => setTimeout(r, 700)));
    const n = notes();
    const run = runDesktopBrowser(socket, { note: n.note });
    await new Promise((r) => setTimeout(r, 450));
    expect(n.shown).toEqual([{ kind: "wait", text: "Opening the browser…", closed: false }]);
    expect(await run).toBe(0);
    expect(n.shown).toEqual([{ kind: "wait", text: "Opening the browser…", closed: true }]);
  },
);

test.if(posix)("agent-browser downloading first: a wait note, closed once the browser is open", async () => {
  const socket = socketIn();
  let release = () => {};
  await serve(socket, async (installing) => {
    installing();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  const n = notes();
  const run = runDesktopBrowser(socket, { note: n.note });
  while (n.shown.length === 0) await new Promise((r) => setTimeout(r, 5));
  expect(n.shown).toEqual([
    {
      kind: "wait",
      text: "Getting the browser ready…\nThe first time takes about a minute. It opens by itself.",
      closed: false,
    },
  ]);
  release();
  expect(await run).toBe(0);
  expect(n.shown).toEqual([expect.objectContaining({ kind: "wait", closed: true })]);
});

test.if(posix)(
  "a click that takes a moment: a note says the browser is opening, then that it installs once the runner says so",
  async () => {
    const socket = socketIn();
    let installing = () => {};
    let release = () => {};
    await serve(socket, async (said) => {
      installing = said;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const n = notes();
    const run = runDesktopBrowser(socket, { note: n.note, quietMs: 20 });
    await waitFor(() => n.shown.length === 1);
    expect(n.shown).toEqual([{ kind: "wait", text: "Opening the browser…", closed: false }]);
    installing();
    await waitFor(() => n.shown.length === 2);
    expect(n.shown).toEqual([
      { kind: "wait", text: "Opening the browser…", closed: true },
      {
        kind: "wait",
        text: "Getting the browser ready…\nThe first time takes about a minute. It opens by itself.",
        closed: false,
      },
    ]);
    release();
    expect(await run).toBe(0);
    expect(n.shown.every((x) => x.closed)).toBe(true);
  },
);

test.if(posix)("a browser that can't open: why, in plain words, in a note that stays until it is read", async () => {
  const why = async (err: unknown) => {
    const socket = socketIn();
    await serve(socket, async () => {
      throw err;
    });
    const n = notes();
    expect(await runDesktopBrowser(socket, { note: n.note })).toBe(1);
    expect(n.shown).toHaveLength(1);
    expect(n.shown[0]?.kind).toBe("error");
    return n.shown[0]?.text;
  };
  // The runner's own words stay in its log: the person reads what the code means.
  expect(await why(new RunnerError("not_allowed", "The browser on the agent's desktop needs switches on"))).toBe(
    "The browser didn't open.\nThe browser is turned off on this computer.",
  );
  expect(await why(new RunnerError("paused", "This computer is paused. Open the browser again once it resumes."))).toBe(
    "The browser didn't open.\nThis computer is paused. Open the browser again once it resumes.",
  );
  expect(await why(new RunnerError("desktop_busy", "This computer is short of memory for the agent's browser"))).toBe(
    "The browser didn't open.\nThis computer is short of memory right now. Try again in a few minutes.",
  );
  expect(await why(new RunnerError("browser_unavailable", "This computer already has 4 agent browsers open"))).toBe(
    "The browser didn't open.\nThe browser can't run on this computer right now. Try again in a few minutes.",
  );
  for (const err of [
    new RunnerError("internal", "The agent's worker isn't connected right now. Try again."),
    new RunnerError("desktop_unavailable", "The agent's desktop stopped. Try again."),
    new Error("spawn EACCES"),
  ]) {
    expect(await why(err)).toBe("The browser didn't open.\nSomething went wrong. Try again in a minute.");
  }
  // Nobody listening (the runner restarting), or one that takes too long: its wait closes, the reason stays.
  const nobody = notes();
  expect(await runDesktopBrowser(path.join(path.dirname(socketIn()), "none.sock"), { note: nobody.note })).toBe(1);
  expect(nobody.shown[0]?.text).toBe(
    "The browser didn't open.\nagentes.chat isn't running on this computer right now. Try again in a minute.",
  );
  const slow = socketIn();
  await serve(slow, () => new Promise(() => {}));
  const late = notes();
  expect(await runDesktopBrowser(slow, { note: late.note, quietMs: 10, timeoutMs: 100 })).toBe(1);
  expect(late.shown).toEqual([
    { kind: "wait", text: "Opening the browser…", closed: true },
    { kind: "error", text: "The browser didn't open.\nIt is taking too long. Try again in a minute.", closed: false },
  ]);
});

test.if(posix)("only `open` opens: anything else is dropped unanswered, and the runner hears nothing", async () => {
  const socket = socketIn();
  let opened = 0;
  await serve(socket, async () => {
    opened++;
  });
  expect(await socketAnswer(socket, "open https://elsewhere.example\n")).toBe("");
  expect(await socketAnswer(socket, "--remote-debugging-address=0.0.0.0\n")).toBe("");
  expect(await socketAnswer(socket, "OPEN\n")).toBe("");
  expect(opened).toBe(0);
  expect(await socketAnswer(socket, "open\n")).toBe("ok\n");
  expect(opened).toBe(1);
});

test.if(posix)(
  "two clicks at once: one browser; the second is told it is busy, and its launcher shows nothing",
  async () => {
    const socket = socketIn();
    let opened = 0;
    let release = () => {};
    await serve(socket, async (installing) => {
      opened++;
      installing();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const first = socketAnswer(socket, "open\n");
    await waitFor(() => opened === 1);
    expect(await socketAnswer(socket, "open\n")).toBe("busy\n");
    const n = notes();
    expect(await runDesktopBrowser(socket, { note: n.note })).toBe(0);
    expect(n.shown).toEqual([]);
    release();
    expect(await first).toBe("installing\nok\n");
    expect(opened).toBe(1);
    // The next click is a new one.
    const third = socketAnswer(socket, "open\n");
    await waitFor(() => opened === 2);
    release();
    expect(await third).toBe("installing\nok\n");
  },
);

test.if(posix)(
  "the socket holds a few connections at once: more are closed, and it serves again once they go",
  async () => {
    const socket = socketIn();
    const server = await serve(socket, async () => {});
    let accepted = 0;
    (server as unknown as EventEmitter).on("connection", () => accepted++);
    const held = Array.from({ length: 4 }, () => createConnection(socket).on("error", () => undefined));
    await waitFor(() => accepted === 4);
    expect(await socketAnswer(socket, "open\n")).toBe("");
    for (const conn of held) conn.destroy();
    let answer = "";
    for (let tries = 0; answer !== "ok\n" && tries < 100; tries++) {
      if (tries > 0) await new Promise((r) => setTimeout(r, 10));
      answer = await socketAnswer(socket, "open\n");
    }
    expect(answer).toBe("ok\n");
  },
);

test.if(posix)("the socket: its folder's group may write to it, nobody else; closed, it is gone", async () => {
  const socket = socketIn();
  const server = await serve(socket, async () => {});
  const st = statSync(socket);
  expect(st.isSocket()).toBe(true);
  expect(st.mode & 0o777).toBe(0o660);
  expect(st.gid).toBe(statSync(path.dirname(socket)).gid);
  // A file left from an earlier runner is replaced.
  servers.splice(servers.indexOf(server), 1);
  closeBrowser(server, socket);
  expect(existsSync(socket)).toBe(false);
  await serve(socket, async () => {});
  expect(await socketAnswer(socket, "open\n")).toBe("ok\n");
});

test("the note: a small terminal window, its text wrapped and indented with a row free above and below, no cursor", () => {
  const head = (wmClass: string, icon: string) => [
    "--disable-server",
    `--class=${wmClass}`,
    "--title=Browser",
    `--icon=${icon}`,
    "--hide-menubar",
    "--hide-toolbar",
    "--hide-scrollbar",
  ];
  const show = "printf '\\033[?25l\\n'; printf '%s\\n' \"$1\" | fold -s -w 56 | sed 's/^/  /';";
  // The wait has Browser's icon and a class of its own: with Browser's, docklike would show it on Browser, and a
  // second click there would hide it instead of reaching the runner (told `busy`).
  expect(noteArgs("wait", "Opening the browser…")).toEqual([
    ...head("agentes-wait", "applications-internet"),
    "--geometry=60x3",
    "-x",
    "/bin/sh",
    "-c",
    `${show} exec sleep 960`,
    "sh",
    "Opening the browser…",
  ]);
  expect(
    noteArgs("wait", "Getting the browser ready…\nThe first time takes about a minute. It opens by itself."),
  ).toContain("--geometry=60x4");
  // Why it didn't open has a class of its own: a click on Browser tries again instead of bringing it up. A line
  // longer than the text's 56 columns takes two rows.
  const why = "The browser didn't open.\nThis computer is paused. Open the browser again once it resumes.";
  expect(noteArgs("error", why)).toEqual([
    ...head("agentes-note", "dialog-warning"),
    "--geometry=60x7",
    "-x",
    "/bin/sh",
    "-c",
    `${show} printf '\\n  %s' 'Press Enter to close.'; read -r _`,
    "sh",
    why,
  ]);
});
