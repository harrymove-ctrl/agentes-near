import { expect, test } from "bun:test";
import { cliSpawn, winQuote } from "../../runner/executors";

/**
 * How a Windows program splits its command line back into argv (the C runtime's rules, as `claude.exe` and `node.exe`
 * read it): whitespace separates outside quotes; 2n backslashes before a quote are n and the quote opens or closes,
 * 2n+1 are n and a literal quote; `""` inside quotes is a literal quote; any other backslash is itself.
 */
function splitWindows(line: string): string[] {
  const out: string[] = [];
  let arg = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i + n] === "\\") n++;
      if (line[i + n] === '"') {
        arg += "\\".repeat(Math.floor(n / 2));
        if (n % 2) {
          arg += '"';
          i += n;
        } else i += n - 1;
      } else {
        arg += "\\".repeat(n);
        i += n - 1;
      }
      started = true;
    } else if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        arg += '"';
        i++;
      } else quoted = !quoted;
      started = true;
    } else if ((c === " " || c === "\t") && !quoted) {
      if (started) out.push(arg);
      arg = "";
      started = false;
    } else {
      arg += c;
      started = true;
    }
  }
  if (started) out.push(arg);
  return out;
}

test("each argument on cmd.exe's line comes back as it was: empty, with spaces, backslashes, quotes or & |", () => {
  const args = [
    "",
    "--setting-sources",
    "",
    "--tools",
    "Bash,Read,Edit",
    "C:\\Users\\Ana Silva\\.agentes\\system.md",
    "C:\\work\\project\\",
    'say "hi"',
    'a\\"b',
    "x & y | z",
  ];
  expect(splitWindows(args.map(winQuote).join(" "))).toEqual(args);
  expect(winQuote("")).toBe('""');
  expect(winQuote("C:\\dir\\")).toBe('"C:\\dir\\\\"');
});

test("on Windows a bare CLI starts through cmd.exe with every argument quoted; elsewhere as it is", () => {
  const args = ["-p", "--setting-sources", "", "--tools", "Bash,Read", "--add-dir", "C:\\Users\\Ana Silva\\work"];
  const win = cliSpawn(["claude"], args, undefined, "win32");
  expect(win.file).toBe(process.env.ComSpec || "cmd.exe");
  expect(win.windowsVerbatimArguments).toBe(true);
  expect(win.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  // `/s` drops the outer quotes; what's left is the program and its argv, the empty one still there.
  const line = win.args[3] ?? "";
  expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
  expect(splitWindows(line.slice(1, -1))).toEqual(["claude", ...args]);

  // A launcher and what it runs: no shell, argv as given.
  const launcher = cliSpawn(["C:\\agentes\\bun.exe", "C:\\agentes\\claude.js"], args, undefined, "win32");
  expect(launcher).toEqual({ file: "C:\\agentes\\bun.exe", args: ["C:\\agentes\\claude.js", ...args] });

  const posix = cliSpawn(["/usr/local/bin/claude"], args, undefined, "linux");
  expect(posix).toEqual({ file: "/usr/local/bin/claude", args });
});
