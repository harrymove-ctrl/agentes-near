import path from "node:path";
import { commandParts, ruleMatches } from "./machine-protocol";
import { type OutboundCode, outboundUrlProblem } from "./outbound-url";

/**
 * Deterministic command policy for computer turns (ADR 0029, ADR 0053 §3). No
 * model: plain parsing of the call Claude Code (or Codex) wants to make. The
 * runner's permission prompt, Codex's command approvals and the server's
 * `permission_prompt` all decide with these functions, so every brain follows
 * the same rules.
 *
 * - `deniedInMissions` / `deniedMessage`: the deny list (merges, deploys,
 *   rollbacks, publishing, `gh api`, printed tokens), matched on normalized
 *   arguments (`gh -R`, `git -C/-c`): refused at once with the kind it is,
 *   never asked.
 * - `loneMerge`: the one merge the computer may run without a person, for a
 *   repository the agent's owner chose (`mergeRepos`).
 * - `gitPushes` / `heldPush` / `approvalNeeded`: where each push goes, read
 *   with git on the computer (the remote's default branch, the protected
 *   ones, the agent's own): a push to the default branch, a force push to
 *   someone else's branch or a deletion waits for a person; any other push is
 *   ordinary work. Through our git proxy the server decides those instead,
 *   so they never run from here and the refusal says where to go
 *   (`delete_branches`, a pull request). Every path that runs a command on
 *   the computer (the brain's own commands, `run_code`, skill scripts,
 *   background tasks) asks `approvalNeeded` first.
 * - `secretRead`: a call that reads keys, tokens or env files, with any read
 *   tool (Read, Glob, Grep, a shell command): refused at once too. Only calls
 *   that reach a prompt are seen: Claude Code's own reads meet the same list
 *   as deny rules (`SECRET_READ_DENY_RULES`); Codex runs the commands it deems
 *   safe (`cat`, `grep`…) without asking, so there secrets are kept from
 *   leaving rather than from being read (ADR 0053 §3).
 * - `readOnlyCall`: harmless reads (listing and reading files anywhere but
 *   secrets, read-only git, GET/HEAD fetches that save only into the
 *   mission folder; in the `plan` profile no fetch and no write at all). The
 *   runner's prompt tool allows these at once, with no card and nothing posted.
 * - `forbiddenReason`: what code never lets the judge approve (sudo, deletes
 *   and writes outside the mission folder, system services, uploads, remote
 *   shells, global installs, inline code, anything it can't read plainly).
 *   The judge only classifies what is left; the deny list stays first and hard.
 * - `localVerdict`: the part the computer decides by itself (the rest goes to
 *   the server, which may ask a person).
 *
 * Anything this can't parse with certainty is "not read-only" (a card).
 */

/**
 * The permission profile of a computer turn (ADR 0053 §3). `plan`: reads only
 * (no edits, read-only shell, no web, no fetches). `work`: edits in its folders,
 * and commands by this policy (a person for the rest).
 */
export type CommandProfile = "plan" | "work";

export interface CommandScope {
  /** Where the task runs (relative paths resolve here). */
  cwd: string;
  /** The mission folder and the task's own folder: writes are allowed inside. */
  folders: string[];
  /** The person's home, for `~`. */
  home?: string;
  /** The runner's own home wherever it is (`AGENTES_RUNNER_HOME`): its accounts, tokens and settings are secrets. */
  runnerHome?: string;
}

type Word = { text: string; op?: undefined } | { text: string; op: "pipe" | "list" | "redirect" | "input" };

/**
 * Shell words with quotes removed and operators split out. `null` when the
 * line uses anything we don't follow: command substitution, process
 * substitution, variables, globs into hidden expansions, heredocs, `&` jobs.
 */
export function shellWords(line: string): Word[] | null {
  const out: Word[] = [];
  let cur = "";
  let has = false;
  const push = () => {
    if (has) out.push({ text: cur });
    cur = "";
    has = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += line.slice(i + 1, end);
      has = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j] as string;
        if (d === "$" || d === "`") return null;
        if (d === "\\" && j + 1 < line.length) {
          j++;
          cur += line[j];
        } else cur += d;
      }
      if (j >= line.length) return null;
      has = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= line.length) return null;
      cur += line[i + 1];
      has = true;
      i++;
      continue;
    }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") return null;
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "\n" || c === ";") {
      push();
      out.push({ text: ";", op: "list" });
      continue;
    }
    if (c === "|") {
      push();
      if (line[i + 1] === "|") {
        out.push({ text: "||", op: "list" });
        i++;
      } else if (line[i + 1] === "&") return null;
      else out.push({ text: "|", op: "pipe" });
      continue;
    }
    if (c === "&") {
      if (line[i + 1] === "&") {
        push();
        out.push({ text: "&&", op: "list" });
        i++;
        continue;
      }
      if (line[i + 1] === ">") {
        push();
        const append = line[i + 2] === ">";
        out.push({ text: append ? "&>>" : "&>", op: "redirect" });
        i += append ? 2 : 1;
        continue;
      }
      // `2>&1`: the fd duplication, harmless.
      if (cur === "" && out.at(-1)?.op === "redirect" && /^\d$/.test(line[i + 1] ?? "")) {
        out.push({ text: `&${line[i + 1]}` });
        i++;
        continue;
      }
      return null; // a background job
    }
    if (c === ">" || c === "<") {
      if (c === "<" && line[i + 1] === "<") return null; // heredoc / herestring
      // `2>`: the digit before belongs to the operator.
      const fd = /^\d$/.test(cur) ? cur : "";
      if (!fd) push();
      else {
        cur = "";
        has = false;
      }
      if (c === ">") {
        const append = line[i + 1] === ">";
        out.push({ text: `${fd}${append ? ">>" : ">"}`, op: "redirect" });
        if (append) i++;
      } else out.push({ text: "<", op: "input" });
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return out;
}

interface Simple {
  argv: string[];
  /** Files written by `>`/`>>` (not `/dev/null`, not `2>&1`). */
  writes: string[];
  /** Files read by `<`. */
  reads: string[];
  /** Its input is the output of the command before it (`… | sh`). */
  piped?: true;
}

/** The simple commands of a line (pipelines and lists split), or null when it can't be followed. */
export function simpleCommands(line: string): Simple[] | null {
  const words = shellWords(line);
  if (!words) return null;
  const out: Simple[] = [];
  let cur: Simple = { argv: [], writes: [], reads: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.op === "pipe" || w.op === "list") {
      if (cur.argv.length === 0) return null;
      out.push(cur);
      cur = { argv: [], writes: [], reads: [], ...(w.op === "pipe" ? { piped: true as const } : {}) };
      continue;
    }
    if (w.op === "redirect" || w.op === "input") {
      const target = words[i + 1];
      if (!target || target.op) return null;
      i++;
      if (w.op === "input") cur.reads.push(target.text);
      else if (/^&\d$/.test(target.text)) continue;
      else if (target.text !== "/dev/null") cur.writes.push(target.text);
      continue;
    }
    cur.argv.push(w.text);
  }
  if (cur.argv.length === 0) return out.length ? null : [];
  out.push(cur);
  // `FOO=1 cmd`: an env assignment in front; keep it simple and refuse.
  if (out.some((s) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(s.argv[0] ?? ""))) return null;
  return out;
}

const TMP = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];

function resolveIn(scope: CommandScope, p: string) {
  const home = scope.home ?? "";
  const expanded = p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  if (expanded.startsWith("~")) return null; // `~other`
  return path.resolve(scope.cwd, expanded);
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Inside the mission folder (or the task's own). */
export function insideFolders(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  return r !== null && scope.folders.some((f) => under(r, path.resolve(f)));
}

const insideOrTmp = (scope: CommandScope, p: string) => {
  const r = resolveIn(scope, p);
  return r !== null && (insideFolders(scope, p) || TMP.some((t) => under(r, t)));
};

/**
 * System mode: where each agent's worker keeps its own secrets, git credentials and task journal
 * (`<this>/<the agent's user>`). The agent's commands run as that user too, so only these rules keep its
 * model from reading them.
 */
export const AGENT_WORKER_HOMES = "/var/lib/agentes-runner-agents";

/**
 * System mode's runner home (`install.sh --system`), and the state of the server's own computer
 * (`agentes-runner host`): every organization's machine token is in it.
 */
export const SYSTEM_RUNNER_HOME = "/var/lib/agentes-runner";

/**
 * In the person's home only: the native install (the app, its `.env`, its database). An agent's own folder has a
 * `.agentes` of its own: its mission's files, which it reads, and its browser's profile, which it never does.
 */
const HOME_SECRET_DIRS = [".agentes"] as const;

/**
 * The agent browser's profile, in the agent's folder: its Chrome keeps the agent's logins there (cookies that
 * Chrome on Linux encrypts with a key anyone can read, so a copy is a working login elsewhere). Only the runner
 * and that Chrome use it.
 */
export const AGENT_BROWSER_PROFILE = ".agentes/browser";

/** Whether a path (either separator) is an agent browser's profile or inside one, whoever's folder it is in. */
export const inBrowserProfile = (p: string) => /(^|[\\/])\.agentes[\\/]browser([\\/]|$)/i.test(p);

/**
 * Folders that hold keys and tokens, anywhere (the runner's own home and its agents' workers' too): nothing
 * under them is read. One list for the server's checks (`SECRET_PATH`) and Claude Code's own rules
 * (`SECRET_READ_DENY_RULES`).
 */
const SECRET_DIRS = [
  AGENT_BROWSER_PROFILE,
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".gcloud",
  ".password-store",
  "Keychains",
  ".agentes-runner",
  path.basename(AGENT_WORKER_HOMES),
  SYSTEM_RUNNER_HOME.slice(1),
  ".config/gh",
  ".config/gcloud",
] as const;
/**
 * Files that hold tokens, anywhere (a project's `.npmrc` or service account too; Claude Code's own sign-in;
 * beside the server's `.env`, the token of the server's own computer).
 */
const SECRET_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  "credentials",
  "credentials.json",
  ".credentials.json",
  "mcp-token",
  "host-computer-token",
] as const;
/**
 * Sign-ins by a name too common to refuse everywhere: Codex's own, and what an account folder
 * (`accounts/<kind>/<id>`) holds (Codex's sign-in, a coding plan's key, a Claude token root keeps).
 */
const SECRET_SIGN_IN_FILES = [
  ".codex/auth.json",
  "accounts/*/*/auth.json",
  "accounts/*/*/provider.json",
  "accounts/*/*/token.json",
] as const;
/** Env files with values in them; `.env.example` and the like hold none (`SECRET_PATH` refuses every other `.env.*`). */
const SECRET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.*.local",
  ".env.production",
  ".env.prod",
  ".env.prd",
  ".env.development",
  ".env.dev",
  ".env.staging",
  ".env.stage",
  ".env.preview",
  ".env.test",
  ".env.ci",
  ".env.qa",
  ".env.uat",
  ".env.backup",
  ".env.bak",
  ".env.old",
] as const;
/** Keys and certificates, by name. */
const SECRET_KEY_FILES = ["*.pem", "*.key", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Secrets a read never gets: keys, tokens, env files (not their `.env.example`
 * and the like, which hold none), the runner's own home.
 */
const SECRET_PATH = new RegExp(
  `(^|/)(${SECRET_DIRS.map(escapeRe).join("|")})(/|$)|^~/(${HOME_SECRET_DIRS.map(escapeRe).join("|")})(/|$)|(^|/)(${SECRET_FILES.map(escapeRe).join("|")}|\\.env(\\.(?!(example|sample|template|dist|defaults)$)[\\w.-]+)?|id_[a-z0-9]+(\\.pub)?|.*\\.pem|.*\\.key)$|(^|/)(${SECRET_SIGN_IN_FILES.map((f) => escapeRe(f).replaceAll("\\*", "[^/]+")).join("|")})$`,
  "i",
);

/** Whether a path, as written or relative to a folder, is one of those. */
export const isSecretRead = (p: string) => SECRET_PATH.test(p);

function secretPath(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  const home = scope.home;
  return (
    r === null ||
    SECRET_PATH.test(r) ||
    SECRET_PATH.test(p) ||
    (home !== undefined && HOME_SECRET_DIRS.some((d) => under(r, path.join(home, d)))) ||
    (scope.runnerHome !== undefined && under(r, path.resolve(scope.runnerHome)))
  );
}

/** A command that names the variables pointing at an account's sign-in, or holding a plan's key or a Claude token. */
const SECRET_VARIABLE =
  /\$\{?(CLAUDE_CONFIG_DIR|CODEX_HOME|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\b/;

/** A word of a line that can't be parsed plainly, without the quotes and substitution marks around it (`$(cat`, `x)`). */
const bareWord = (w: string) => w.replace(/^[$('"`{]+|[)'"`};]+$/g, "");

/**
 * A path or pattern names a secret (resolved in the scope when there is one, if it can leave the folder it
 * runs in; a bare one is tested as written).
 */
const namesSecret = (p: string, scope?: CommandScope) =>
  SECRET_PATH.test(p) ||
  (scope !== undefined && (p.startsWith("/") || p.startsWith("~") || p.includes("..")) && secretPath(scope, p));

/** Claude Code's own tools that read files, and the arguments that say where (Grep's `pattern` is a search, not a path). */
const FILE_READ_TOOLS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  Glob: ["pattern", "path"],
  Grep: ["path", "glob"],
  LS: ["path"],
  NotebookRead: ["notebook_path"],
};

/**
 * A call that reads a secret (keys, tokens, env files, the runner's own home),
 * with any tool that reads: Read, Glob, Grep (by path, glob or pattern) and
 * shell commands (any word naming one, or a file read with `<`). Refused at
 * once on every path (ADR 0053 §3); a person never sees it as a card.
 */
export function secretRead(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope?: CommandScope,
): boolean {
  const i = input ?? {};
  const keys = Object.hasOwn(FILE_READ_TOOLS, toolName) ? FILE_READ_TOOLS[toolName] : undefined;
  if (keys) return keys.some((k) => typeof i[k] === "string" && namesSecret(i[k] as string, scope));
  if (toolName !== "Bash") return false;
  const command = typeof i.command === "string" ? i.command : "";
  if (SECRET_VARIABLE.test(command)) return true;
  const cmds = simpleCommands(command);
  if (cmds) {
    return cmds.some(
      (s) => s.argv.slice(1).some((a) => namesSecret(a, scope)) || s.reads.some((r) => namesSecret(r, scope)),
    );
  }
  // Not plainly readable: any word that names a secret.
  return commandParts(command).some((part) =>
    part
      .split(" ")
      .slice(1)
      .some((w) => namesSecret(bareWord(w), scope)),
  );
}

/** Commands that only read, whatever their arguments (minus the options that write or run). */
const READ_ANY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "stat",
  "wc",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "sw_vers",
  "uname",
  "system_profiler",
  "fc-list",
  "mdls",
  "pwd",
  "grep",
  "egrep",
  "fgrep",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "echo",
  "printf",
  "true",
  "uniq",
  "cut",
  "nl",
  "column",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "otool",
  "lipo",
  "whoami",
  "id",
  "date",
]);
/** Options that make an otherwise read-only command write or run something. */
const WRITE_FLAGS: Record<string, RegExp> = {
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  rg: /^(--pre|--pre-glob)/,
  file: /^-C$|^--compile/,
  identify: /^[-+]write$/,
};
const READ_WITH_FLAGS = new Set(["sort", "tree", "rg", "file", "identify"]);

const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const SIPS_READ = new Set(["-g", "--getProperty", "-1", "--oneLine"]);
/** exiftool options that write (and any `-TAG=value` assignment). */
const EXIF_WRITE =
  /^-(o|out|w|W|tagsFromFile|geotag|geosync|overwrite_original|overwrite_original_in_place|delete_original!?|restore_original|srcfile|@|k|P|config)$|^-.*=/;

const GIT_SAFE_BRANCH = new Set([
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--contains",
  "--merged",
  "--no-merged",
  "--no-color",
  "--color",
]);

/** Read-only git anywhere: status, log, diff, show, branch (listing), remote -v, rev-parse, ls-files. */
function readOnlyGit(argv: string[]) {
  let i = 1;
  // `git -C <path>` and `--no-pager` in front; `-c` (config) could run anything.
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") i++;
    else if (a === "--no-pager") continue;
    else break;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (rest.some((a) => /^--(output|ext-diff|textconv|exec)/.test(a) || a === "-c")) return false;
  switch (sub) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "rev-parse":
    case "ls-files":
    case "shortlog":
    case "describe":
    case "blame":
      return true;
    case "branch": {
      if (rest.length === 0) return true;
      // Listing only: a bare name would create a branch.
      if (rest[0] === "--list" || rest[0] === "-l")
        return rest.slice(1).every((a) => GIT_SAFE_BRANCH.has(a) || !a.startsWith("-"));
      return rest.every((a) => GIT_SAFE_BRANCH.has(a));
    }
    case "remote":
      return (
        rest.length === 0 ||
        (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ||
        (rest[0] === "get-url" && rest.length <= 3)
      );
    default:
      return false;
  }
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** curl options that take a value (the next word, or glued: `-oout.txt`, `--output=x`). */
const CURL_ARG = new Set("A b c C D e E H m o r u U w x X y Y z".split(" "));
const CURL_ARG_LONG = new Set([
  "user-agent",
  "cookie",
  "cookie-jar",
  "continue-at",
  "dump-header",
  "referer",
  "cert",
  "header",
  "max-time",
  "connect-timeout",
  "output",
  "output-dir",
  "range",
  "user",
  "proxy-user",
  "write-out",
  "proxy",
  "request",
  "retry",
  "retry-delay",
  "retry-max-time",
  "speed-time",
  "speed-limit",
  "time-cond",
  "max-redirs",
  "max-filesize",
  "cacert",
  "resolve",
  "connect-to",
  "interface",
  "limit-rate",
  "trace",
  "trace-ascii",
  "stderr",
  "etag-save",
  "etag-compare",
  "hsts",
  "alt-svc",
  "url",
]);
/** Never auto-allowed: sending data, reading a config of options, FTP commands. */
const CURL_SENDS = /^(d|F|T|K|Q|t|P)$/;
const CURL_SENDS_LONG = /^(data.*|form.*|upload-file|json|config|quote|telnet-option|ftp-port|mail-.*|upload.*)$/;
const CURL_WRITES = new Set([
  "o",
  "D",
  "c",
  "output",
  "output-dir",
  "dump-header",
  "cookie-jar",
  "trace",
  "trace-ascii",
  "stderr",
  "etag-save",
  "hsts",
  "alt-svc",
]);

function readOnlyCurl(argv: string[], scope: CommandScope) {
  let urls = 0;
  const value = (name: string, v: string) => {
    if (name === "X" || name === "request") return /^(GET|HEAD)$/i.test(v);
    if (name === "w" || name === "write-out") return !/%output\{|%\{stderr/.test(v);
    if (name === "url") return HTTP_URL.test(v) && ++urls > 0;
    if (CURL_WRITES.has(name)) return insideFolders(scope, v);
    return true;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [rawName, glued] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const name = rawName.replace(/^no-/, "");
      if (CURL_SENDS_LONG.test(name)) return false;
      if (CURL_ARG_LONG.has(name)) {
        const v = glued ?? argv[++i];
        if (v === undefined || !value(name, v)) return false;
      }
      if (name === "remote-name" || name === "remote-name-all") {
        if (!insideFolders(scope, ".")) return false;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (CURL_SENDS.test(c)) return false;
        if (c === "O" || c === "J") {
          if (!insideFolders(scope, ".")) return false;
          continue;
        }
        if (CURL_ARG.has(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined || !value(c, v)) return false;
          break;
        }
      }
      continue;
    }
    if (!HTTP_URL.test(a)) return false;
    urls++;
  }
  return urls > 0;
}

const WGET_ARG_LONG = new Set([
  "output-document",
  "directory-prefix",
  "output-file",
  "append-output",
  "user-agent",
  "header",
  "timeout",
  "tries",
  "wait",
  "level",
  "user",
  "password",
  "method",
  "referer",
  "input-file",
  "accept",
  "reject",
]);
const WGET_ARG = new Set("O P o a U t T w l i A R e".split(" "));
const WGET_SENDS = /^(post-data|post-file|body-data|body-file|execute|use-askpass|config)$/;
const WGET_WRITES = new Set([
  "O",
  "P",
  "o",
  "a",
  "output-document",
  "directory-prefix",
  "output-file",
  "append-output",
]);

function readOnlyWget(argv: string[], scope: CommandScope) {
  let urls = 0;
  // Without -O / -P it saves into the current folder.
  let savesHere = true;
  const value = (name: string, v: string) => {
    if (name === "method") return /^(GET|HEAD)$/i.test(v);
    if (name === "e") return false;
    if (WGET_WRITES.has(name)) {
      if (name === "O" || name === "output-document" || name === "P" || name === "directory-prefix") savesHere = false;
      return v === "-" || v === "/dev/null" || insideFolders(scope, v);
    }
    return true;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [name, glued] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (WGET_SENDS.test(name)) return false;
      if (WGET_ARG_LONG.has(name)) {
        const v = glued ?? argv[++i];
        if (v === undefined || !value(name, v)) return false;
      }
      if (name === "spider") savesHere = false;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (WGET_ARG.has(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined || !value(c, v)) return false;
          break;
        }
      }
      continue;
    }
    if (!HTTP_URL.test(a)) return false;
    urls++;
  }
  return urls > 0 && (!savesHere || insideFolders(scope, "."));
}

/** Options of `git clone/fetch/pull` that could run a program or read another config: never without a person. */
const GIT_FETCH_UNSAFE =
  /^(-c|-u|--config|--upload-pack|--receive-pack|--template|--separate-git-dir|--exec|--reference|--server-option|-o)(=|$)/;

/**
 * `git clone <https url> [dir]`, `git fetch` and `git pull` that only bring
 * code into the agent's (or mission's) folders: allowed without a person (ADR
 * 0024 addendum). In the agent's checkouts the remote is our git proxy (its
 * credential, its repositories); the deny list still stops pushes to the
 * default branch, force pushes and merges of pull requests.
 */
function fetchIntoFolders(argv: string[], scope: CommandScope) {
  let i = 1;
  let where = ".";
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") {
      const dir = argv[++i];
      if (!dir) return false;
      where = where === "." ? dir : path.join(where, dir);
    } else if (a === "--no-pager") continue;
    else break;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (rest.some((a) => GIT_FETCH_UNSAFE.test(a))) return false;
  // Remotes and refspecs only: no local paths, no `ext::`/`file:` transports.
  const plain = rest.filter((a) => !a.startsWith("-"));
  const local = (a: string) => a.includes("::") || /^(file:|\/|~|\.\.?(\/|$))/.test(a);
  const base = resolveIn(scope, where);
  if (base === null) return false;
  const at = { ...scope, cwd: base };
  switch (sub) {
    case "fetch":
    case "pull":
      return plain.every((a) => !local(a)) && insideFolders(scope, where);
    case "clone": {
      const [url, dir, ...extra] = plain;
      if (!url || extra.length > 0 || !/^https:\/\/[^/\s@]+\/\S+$/.test(url)) return false;
      const name =
        dir ??
        url
          .replace(/\/+$/, "")
          .replace(/\.git$/, "")
          .split("/")
          .at(-1) ??
        "";
      return Boolean(name) && insideFolders(at, name);
    }
    default:
      return false;
  }
}

/**
 * gh's subcommands that only print what GitHub has, by group (`gh status` and `gh search …` alone are reads too).
 * Writes, `gh api` (its own deny rule), `gh auth` (the token), extensions and aliases are none of these.
 */
const GH_READS: Record<string, ReadonlySet<string>> = {
  pr: new Set(["view", "diff", "checks", "list", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list", "watch"]),
  workflow: new Set(["view", "list"]),
  repo: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  project: new Set(["view", "list", "item-list", "field-list"]),
  label: new Set(["list"]),
  gist: new Set(["view", "list"]),
};

/** Read-only gh (`gh pr view 12 --json title`, `gh run list -R a/b`): never `--web`, which opens a browser. */
function readOnlyGh(argv: string[]) {
  const words = ghWords(argv.slice(1));
  // `--web=true` and `-cw` too.
  if (words.some((a) => /^--web(=|$)|^-[a-zA-Z]*w/.test(a))) return false;
  // gh's own jq reads the environment (`$ENV`, `env`), where keys live.
  if (words.some((a) => /^(-q|--jq)/.test(a)) && words.some((a) => /env/i.test(a))) return false;
  const [group = "", sub = ""] = words;
  if (group === "status" || group === "search") return true;
  return GH_READS[group]?.has(sub) === true;
}

function readOnlySimple(s: Simple, scope: CommandScope, plan = false): boolean {
  const [cmd, ...args] = s.argv;
  if (!cmd) return false;
  // A plan turn writes nothing, not even into its own folder.
  if (plan && s.writes.length > 0) return false;
  if (s.writes.some((w) => !insideFolders(scope, w))) return false;
  if (s.reads.some((r) => secretPath(scope, r))) return false;
  // Nothing that reads a secret, wherever it is named.
  if (args.some((a) => !a.startsWith("-") && namesSecret(a, scope))) return false;
  if (READ_ANY.has(cmd)) return true;
  if (READ_WITH_FLAGS.has(cmd)) return !args.some((a) => (WRITE_FLAGS[cmd] as RegExp).test(a));
  switch (cmd) {
    case "find":
      return !args.some((a) => FIND_ACTIONS.test(a));
    case "sips":
      return (
        args.some((a) => a === "-g" || a === "--getProperty") &&
        args.every((a) => !a.startsWith("-") || SIPS_READ.has(a))
      );
    case "exiftool":
      return !args.some((a) => EXIF_WRITE.test(a));
    case "git":
      // A plan turn fetches nothing (a clone or a pull writes into the folder).
      return readOnlyGit(s.argv) || (!plan && fetchIntoFolders(s.argv, scope));
    // Like read-only git, a plan turn may read GitHub too: what a plan needs (the issue, the pull request, its checks).
    case "gh":
      return readOnlyGh(s.argv);
    // No web in a plan turn, not even a GET.
    case "curl":
      return !plan && readOnlyCurl(s.argv, scope);
    case "wget":
      return !plan && readOnlyWget(s.argv, scope);
    // What the computer has and which agents use it: reads /proc, the cgroup tree and /etc only. The full path is
    // system mode's, root's (`SYSTEM_LAUNCHER`).
    case "agentes-runner":
    case "/usr/local/bin/agentes-runner":
      return args.length === 1 && args[0] === "computer";
    default:
      return false;
  }
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * A call that only reads (or, in a `work` turn, fetches into the mission
 * folder): allowed at once, no card. Every part of a pipeline or list must be
 * read-only, so `curl … | sh` or `ls | xargs rm` never pass. Never a secret.
 */
export function readOnlyCall(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
  profile: CommandProfile = "work",
) {
  const i = input ?? {};
  if (READ_TOOLS.has(toolName)) return !secretRead(toolName, i, scope);
  if (toolName !== "Bash") return false;
  const command = typeof i.command === "string" ? i.command : "";
  if (!command.trim() || command.length > 2000) return false;
  const cmds = simpleCommands(command);
  return Boolean(cmds && cmds.length > 0 && cmds.every((s) => readOnlySimple(s, scope, profile === "plan")));
}

/**
 * What a person approves first, by kind, with the words a refusal names it by (ADR 0053 §3, amended
 * 2026-10-30). Never judged and never run alone: Claude Code checks deny before asking, and the runner's
 * prompt tool, its commands and background tasks, and the server refuse a match at once. Pushes aren't
 * here: where one goes depends on the repository, so the computer reads it with git (`gitPushes`).
 */
const SENSITIVE_KINDS: ReadonlyArray<{ what: string; rules: readonly string[] }> = [
  {
    what: "This is a merge",
    rules: ["Bash(git merge)", "Bash(git merge *)", "Bash(git -C * merge *)", "Bash(gh pr merge *)"],
  },
  {
    what: "This is a deploy",
    rules: [
      "Bash(vercel deploy *)",
      "Bash(vercel --prod*)",
      "Bash(vercel * --prod*)",
      "Bash(npx vercel *)",
      "Bash(railway up*)",
      "Bash(railway deploy*)",
      "Bash(npx railway *)",
      "Bash(fly deploy*)",
      "Bash(flyctl deploy*)",
      "Bash(netlify deploy *)",
      "Bash(npx netlify *)",
      "Bash(eas submit *)",
      "Bash(eas update *)",
      "Bash(npx eas *)",
      "Bash(npx eas-cli *)",
      "Bash(kubectl apply *)",
      "Bash(helm install *)",
      "Bash(helm upgrade *)",
      "Bash(terraform apply *)",
    ],
  },
  {
    what: "This is a rollout or a rollback",
    rules: ["Bash(kubectl rollout *)", "Bash(helm rollback *)", "Bash(vercel rollback*)"],
  },
  {
    what: "This removes infrastructure",
    rules: ["Bash(kubectl delete *)", "Bash(helm uninstall *)", "Bash(terraform destroy *)"],
  },
  {
    what: "This publishes a package, an image or a release",
    rules: [
      "Bash(docker push*)",
      "Bash(gh release create*)",
      // `bun publish` and friends; `yarn npm publish` is Yarn 2+.
      "Bash(npm publish*)",
      "Bash(pnpm publish*)",
      "Bash(yarn publish*)",
      "Bash(yarn npm publish*)",
      "Bash(bun publish*)",
      "Bash(cargo publish*)",
      "Bash(gem push*)",
      "Bash(twine upload*)",
    ],
  },
  {
    what: "This calls the GitHub API directly, which can merge, delete or change settings",
    rules: ["Bash(gh api *)"],
  },
];

/** The person's GitHub token, printed: refused like any secret, never asked. */
const TOKEN_RULES: readonly string[] = [
  "Bash(gh auth token*)",
  "Bash(gh auth status *--show-token*)",
  "Bash(gh auth status *-t*)",
];

/** The deny list as Claude Code reads it (`--settings`): every kind above and the token rules. */
export const MISSION_DENY_RULES: readonly string[] = [...SENSITIVE_KINDS.flatMap((k) => k.rules), ...TOKEN_RULES];

/**
 * Every push, for Claude Code's `ask` rules, which outrank allow rules (the owner's own and a project's too): a
 * push reaches our prompt tool, where the computer reads where it goes, also with global options, a path to git,
 * a wrapper or a shell around it (`git --no-pager push`, `/usr/bin/git push`, `env git push`, `sh -c 'git push'`).
 * A command that only mentions one (`grep 'git push'`) asks too, and the prompt tool allows it if it only reads.
 */
export const PUSH_ASK_RULES: readonly string[] = [
  "Bash(git push)",
  "Bash(git push *)",
  "Bash(*git push*)",
  "Bash(*git -* push*)",
];

/**
 * Code given inline to an interpreter (`node -e`, `python3 -c`, `perl -ne`…):
 * never allowed by a settings rule such as `Bash(node *)`, whatever else a
 * profile allows (Claude Code checks deny rules first). Our own check is
 * `inlineCode`, which also catches the spellings these patterns can't.
 */
export const INLINE_CODE_DENY_RULES: readonly string[] = [
  ...["node", "nodejs", "bun"].flatMap((i) =>
    ["-e", "--eval", "-p", "--print"].flatMap((f) => [`Bash(${i} ${f}*)`, `Bash(${i} * ${f} *)`]),
  ),
  ...["python", "python2", "python3"].flatMap((i) => [`Bash(${i} -c*)`, `Bash(${i} * -c *)`]),
  ...["ruby", "perl"].flatMap((i) => [`Bash(${i} -e*)`, `Bash(${i} * -e *)`, `Bash(${i} -*e *)`]),
  "Bash(perl -E*)",
  "Bash(deno eval*)",
  "Bash(php -r*)",
];

/**
 * Credential stores in the person's home (and the system-mode workers' own), named
 * in a shell command: refused by Claude Code itself even where a settings rule
 * allows the command (`Bash(cat *)` in a mission). Our own check is `secretRead`,
 * which covers more.
 */
export const SECRET_BASH_DENY_RULES: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".agentes-runner",
  path.basename(AGENT_WORKER_HOMES),
  SYSTEM_RUNNER_HOME.slice(1),
  ".git-credentials",
  ".netrc",
  ".pgpass",
  "Library/Keychains",
]
  .flatMap((p) => [`Bash(*~/${p}*)`, `Bash(*/${p}/*)`])
  .concat(HOME_SECRET_DIRS.map((p) => `Bash(*~/${p}*)`))
  // Named from the agent's own folder too, where its commands run.
  .concat(`Bash(*${AGENT_BROWSER_PROFILE}*)`);

/**
 * The same secrets for Claude Code's own read tools (Read, and best effort Glob and Grep), from the
 * lists `SECRET_PATH` is built from: in the home folder and anywhere under the turn's folder. Its rules
 * can't say "every `.env.*` but the example", so the env files are the usual names.
 */
export const SECRET_READ_DENY_RULES: readonly string[] = [
  ...SECRET_DIRS.flatMap((p) => [`Read(~/${p}/**)`, `Read(**/${p}/**)`]),
  ...HOME_SECRET_DIRS.map((p) => `Read(~/${p}/**)`),
  "Read(~/Library/Keychains/**)",
  ...[...SECRET_FILES, ...SECRET_ENV_FILES, ...SECRET_KEY_FILES, ...SECRET_SIGN_IN_FILES].flatMap((p) => [
    `Read(~/${p})`,
    `Read(**/${p})`,
  ]),
];

/** Global options of git before its subcommand that take a value (`git -C <dir> push`, `git -c k=v push`). */
const GIT_GLOBAL_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--attr-source",
]);
/** The same options glued to their value (`--git-dir=<path>`). */
const GIT_GLOBAL_GLUED = /^--(git-dir|work-tree|namespace|exec-path|config-env|attr-source)=/;
const GIT_GLOBAL_FLAG =
  /^(--no-pager|-p|--paginate|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice|--no-lazy-fetch)$/;
/** gh options that pick another repository or host, anywhere in the command. */
const GH_VALUE = new Set(["-R", "--repo", "--hostname"]);
/**
 * gh's words without those options, in each form gh takes (`-R a/b`, `--repo=a/b`, `-Ra/b`): `gh pr -Ra/b merge 1`
 * is a merge.
 */
function ghWords(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (GH_VALUE.has(a)) i++;
    else if (!/^--(repo|hostname)=|^-R./.test(a)) out.push(a);
  }
  return out;
}
/** Wrappers that run the next word as the command (`nice -n 5 git push …`, `env -u X git push …`). */
const WRAPPERS = new Set(["command", "builtin", "nice", "nohup", "time", "env", "caffeinate"]);
/** Wrapper options that take the next word. */
const WRAPPER_VALUE = new Set(["-n", "-u", "-C", "-S", "-P", "-w", "-t"]);

const baseName = (word: string) => word.split("/").pop() ?? word;

/** The words with their wrappers (and the wrappers' options and env assignments) left out. */
function unwrapped(words: string[]): string[] {
  let argv = words.filter(Boolean);
  while (argv.length > 1 && WRAPPERS.has(baseName(argv[0] as string))) {
    argv = argv.slice(1);
    while (argv.length > 1 && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] as string)) {
      const opt = argv[0] as string;
      argv = argv.slice(WRAPPER_VALUE.has(opt) && argv.length > 2 ? 2 : 1);
    }
  }
  return argv;
}

/**
 * One command as the deny list reads it: its program by name (not path),
 * wrappers dropped, git's global options and gh's repository options left
 * out, and `refs/heads/<branch>` read as the branch, so `git -c x=y -C /w push
 * origin refs/heads/main` reads `git push origin main` and `gh -R a/b pr merge 1`
 * reads `gh pr merge 1`.
 */
export function normalizedCommand(words: string[]): string {
  const [first = "", ...rest] = unwrapped(words);
  const cmd = baseName(first);
  const out = [cmd];
  if (cmd === "git") {
    let i = 0;
    for (; i < rest.length; i++) {
      const a = rest[i] as string;
      if (GIT_GLOBAL_VALUE.has(a)) i++;
      else if (GIT_GLOBAL_GLUED.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
      else break;
    }
    out.push(...rest.slice(i).map((a) => a.replace(/^(\+?)refs\/heads\//, "$1").replace(/:refs\/heads\//, ":")));
  } else if (cmd === "gh") out.push(...ghWords(rest));
  else out.push(...rest);
  return out.join(" ");
}

/** The words of each part of a command (quotes dropped), for matching and showing only: never to run anything. */
export function commandWords(command: string): string[][] {
  const cmds = simpleCommands(command);
  if (cmds) return cmds.map((s) => s.argv);
  return commandParts(command).map((part) => part.split(" ").map(bareWord));
}

/**
 * Why a call is on the deny list, as the refusal tells the agent (`how`: what it can do to ask a person);
 * null when it isn't. The rules match the command as written and each part normalized
 * (`normalizedCommand`), so options in front can't slip past them.
 */
export function deniedMessage(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  how: string = ASK_IN_CHAT,
): string | null {
  const command = typeof input?.command === "string" ? input.command : "";
  const calls = [
    input,
    ...(toolName === "Bash" ? commandWords(command).map((words) => ({ command: normalizedCommand(words) })) : []),
  ];
  const hit = (rules: readonly string[]) => calls.some((c) => rules.some((rule) => ruleMatches(rule, toolName, c)));
  if (hit(TOKEN_RULES)) return SECRET_MESSAGE;
  const kind = SENSITIVE_KINDS.find((k) => hit(k.rules));
  return kind ? approvalMessage(kind.what, how) : null;
}

/** On the deny list: refused at once, never shown to anyone, never judged. */
export const deniedInMissions = (toolName: string, input: Record<string, unknown> | null | undefined) =>
  deniedMessage(toolName, input) !== null;

// ── Merges an agent may do on its own ────────────────────────────────────────

/** A merge the computer may run without a person (`loneMerge`). `dir`: where it runs, from the command's folder. */
export interface LoneMerge {
  dir: string;
  /** `owner/name` as the command names it; null: the folder's remotes say. */
  repo: string | null;
  /** `gh pr merge`'s pull request. */
  pr: number | null;
  /** `git merge`'s branch. */
  ref: string | null;
}

/** What a merge the agent may do on its own touched, for its receipt: `pr` for a pull request, else `ref`. */
export type MergeDone = Pick<LoneMerge, "pr" | "ref"> & { repo: string };

const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * `owner/name` of a GitHub repository as a command or a remote writes it (`owner/name`, a github.com URL or its ssh
 * form, our git proxy's URL), or null for anything else, another host included.
 */
export function githubRepo(value: string): string | null {
  const proxied = /\/api\/git\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(.+)$/i.exec(value.trim())?.[1];
  const repo = (proxied ?? value.trim())
    .replace(/^(https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]/i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return GITHUB_REPO.test(repo) ? repo : null;
}

/** gh's options that take a value, and those that don't, of what `loneMerge` lets through. */
const GH_MERGE_VALUE = new Set(["--subject", "-t", "--body", "-b", "--match-head-commit"]);
const GH_MERGE_FLAG = new Set(["--squash", "-s", "--merge", "-m", "--rebase", "-r"]);
const GIT_MERGE_VALUE = new Set(["-m", "--message"]);
const GIT_MERGE_FLAG = new Set(["--no-ff", "--ff", "--ff-only", "--squash", "--no-edit"]);

/**
 * The plain words among these options, read as the program does (an option's value is its value, whatever it looks
 * like), or null at any other option. `named`: where gh's `-R` goes; without it `-R` is one of those others.
 */
function plainWords(
  args: readonly string[],
  flags: ReadonlySet<string>,
  values: ReadonlySet<string>,
  named?: string[],
): string[] | null {
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const glued = named && /^--repo=(.*)$|^-R(.+)$/.exec(a);
    if (named && (a === "-R" || a === "--repo")) named.push(args[++i] ?? "");
    else if (glued) named.push(glued[1] ?? glued[2] ?? "");
    else if (values.has(a)) i++;
    else if (!a.startsWith("-")) plain.push(a);
    else if (!flags.has(a) && !values.has(a.split("=")[0] as string)) return null;
  }
  return plain;
}

const into = (dir: string, to: string) => (path.isAbsolute(to) ? to : path.join(dir, to));

function ghMerge(rest: readonly string[]): Pick<LoneMerge, "repo" | "pr"> | null {
  const named: string[] = [];
  const words = plainWords(rest, GH_MERGE_FLAG, GH_MERGE_VALUE, named);
  if (words?.length !== 3 || words[0] !== "pr" || words[1] !== "merge" || named.length > 1) return null;
  const url = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(words[2] as string);
  const number = url?.[2] ?? /^\d+$/.exec(words[2] as string)?.[0];
  if (!number) return null;
  const given = [...named, ...(url?.[1] ? [url[1]] : [])].map(githubRepo);
  if (given.some((r) => r === null)) return null;
  // gh goes by the URL; two names that differ leave which repository unknown.
  if (given[1] && given[0]?.toLowerCase() !== given[1].toLowerCase()) return null;
  return { repo: given[0] ?? null, pr: Number(number) };
}

function gitMerge(rest: readonly string[]): { dir: string; ref: string } | null {
  const at = rest[0] === "-C" ? (rest[1] ?? "") : null;
  const words = plainWords(at === null ? rest : rest.slice(2), GIT_MERGE_FLAG, GIT_MERGE_VALUE);
  if (words?.length !== 2 || words[0] !== "merge" || at === "") return null;
  return { dir: at ?? ".", ref: words[1] as string };
}

/**
 * A command or shell script that is one merge and nothing else, the shape the computer may run on its own for a
 * repository the agent was allowed (`mergeRepos`): `gh pr merge <number or URL> [-R owner/name]` or `git merge
 * <branch>` with only the options above, after at most `set -e` lines and a `cd` joined by `&&` (a `cd` that fails
 * must stop the merge). Anything else, or anything this can't follow, is null and waits for a person: `--admin`,
 * `--delete-branch` (agents don't delete branches), `--auto` (nothing merged yet to report), a path to the program,
 * a wrapper, a pipe, a redirection, two merges (one exit code can't say which ran), a word over several lines or
 * opening with `#` (the words here are the shell's only without those: dropping a comment line can move a closing
 * quote, and the shell drops `#5 -R a/b`, so that `gh pr merge --squash #5 -R a/b` merges the folder's own branch).
 */
export function loneMerge(text: string): LoneMerge | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .join("\n");
  const words = shellWords(lines);
  const cmds = simpleCommands(lines);
  const last = cmds?.at(-1);
  if (!words || !cmds || !last || cmds.some((s) => s.piped || s.writes.length > 0 || s.reads.length > 0)) return null;
  if (cmds.some((s) => s.argv.some((w) => w.includes("\n") || w.startsWith("#")))) return null;
  if (words.some((w) => w.op === "list" && w.text === "||")) return null;
  let dir = ".";
  for (const { argv } of cmds.slice(0, -1)) {
    if (argv[0] === "cd" && argv.length === 2 && !/^[~-]/.test(argv[1] as string)) {
      dir = into(dir, argv[1] as string);
    } else if (!/^set( -[eux]+| -[eux]*o pipefail)+$/.test(argv.join(" "))) return null;
  }
  if (dir !== "." && words.some((w) => w.op === "list" && w.text !== "&&")) return null;
  const [program, ...rest] = last.argv;
  if (program === "gh") {
    const merge = ghMerge(rest);
    return merge && { dir, ref: null, ...merge };
  }
  const merge = program === "git" ? gitMerge(rest) : null;
  return merge && { repo: null, pr: null, ref: merge.ref, dir: into(dir, merge.dir) };
}

// ── Pushes: where each one goes, read with git on the computer ───────────────

/** One ref a push updates: a branch, `HEAD` (the branch checked out), or null (a bare push: the branch's push target). */
export interface PushRef {
  branch: string | null;
  force: boolean;
  delete: boolean;
}

/** One `git push` of a command, as written. A dry run is none: it changes nothing. */
export interface GitPush {
  /** Where it runs, from the `cd` and `git -C` before it: relative to the command's folder, or absolute. Null: git can't tell (`--git-dir`, `cd ~`). */
  dir: string | null;
  /** The remote or URL it names; null: the branch's own push remote. */
  remote: string | null;
  refs: PushRef[];
  /** `--all`, `--branches` or a wildcard refspec: every branch, the default one too. */
  every: boolean;
  /** `--mirror`: it also overwrites and deletes branches. */
  mirror: boolean;
  /** `--prune`: it deletes the remote branches that aren't here. */
  prune: boolean;
}

/** A line that runs git push somehow, read or not. */
const PUSH_MENTION = /\bgit\b.*\bpush\b/;

/** `cd`'s folder from `dir` (null: git can't tell where that is from here). */
function cdTo(dir: string | null, to: string | undefined) {
  if (to === undefined || to === "-" || to.startsWith("~")) return null;
  if (path.isAbsolute(to)) return to;
  return dir === null ? null : path.join(dir, to);
}

/** A push refspec's destination: a branch, `HEAD`, null (git can't tell), or `skip` (a tag or another kind of ref). */
function pushDestination(dst: string): string | null | "skip" {
  if (dst === "HEAD" || dst === "@") return "HEAD";
  if (dst === "") return null;
  // `heads/<branch>` is git's short form of `refs/heads/<branch>`.
  const head = /^(refs\/)?heads\//.exec(dst)?.[0];
  if (head) return dst.slice(head.length) || null;
  if (dst.startsWith("refs/")) return "skip";
  return dst;
}

/** A push written in a way git may read differently from this: where it goes is unknown. */
const UNREADABLE = "unreadable";
/** A git command that changes the branch checked out: a later bare push or `HEAD` can't be read from git before it runs. */
const MOVES_HEAD = "moves-head";

const movesHead = (sub: string, rest: readonly string[]) =>
  sub === "switch" ||
  // `git checkout -- <file>` only restores files.
  (sub === "checkout" && !rest.includes("--")) ||
  (sub === "branch" && rest.some((a) => /^(-m|-M|--move)$/.test(a))) ||
  (sub === "symbolic-ref" && rest.filter((a) => !a.startsWith("-")).length >= 2);

type PushFlag = "force" | "lease" | "delete" | "dry" | "every" | "mirror" | "prune" | "tags";
/**
 * `git push`'s options (git 2.50) and what each sets here: `repo`, `value` (takes one, the next word unless
 * glued with `=`), `none` (nothing that changes where it goes). Any other spelling, an abbreviation
 * included, is one git may read as anything.
 */
const PUSH_LONG = new Map<string, PushFlag | "repo" | "value" | "none">([
  ["force", "force"],
  ["force-with-lease", "lease"],
  ["delete", "delete"],
  ["dry-run", "dry"],
  // Prints its usage: pushes nothing.
  ["help", "dry"],
  ["all", "every"],
  ["branches", "every"],
  ["mirror", "mirror"],
  ["prune", "prune"],
  ["tags", "tags"],
  ["repo", "repo"],
  ["push-option", "value"],
  ["receive-pack", "value"],
  ["exec", "value"],
  ["recurse-submodules", "value"],
  ...[
    "force-if-includes",
    "set-upstream",
    "follow-tags",
    "atomic",
    "porcelain",
    "progress",
    "thin",
    "verbose",
    "quiet",
    "verify",
    "no-verify",
    "signed",
    "ipv4",
    "ipv6",
  ].map((o): [string, "none"] => [o, "none"]),
]);
const PUSH_SHORT = new Map<string, PushFlag | "value" | "none">([
  ["f", "force"],
  ["d", "delete"],
  ["n", "dry"],
  ["h", "dry"],
  ["o", "value"],
  ...["u", "v", "q", "4", "6"].map((o): [string, "none"] => [o, "none"]),
]);

/** Inline config that changes where a push goes (`push.default`, `remote.<name>.push`, `url.<base>.pushInsteadOf`). */
const PUSH_CONFIG = /^(push|remote|branch|url)\./;
/** git subcommands that run other commands (`git submodule foreach 'git push …'`, `rebase --exec`, `bisect run`). */
const GIT_RUNS_COMMANDS = new Set(["submodule", "rebase", "bisect"]);

/**
 * `git … push …` from its `git` word: where it goes as written; null when it isn't a push or is a dry run;
 * `UNREADABLE` when git may read it otherwise (an option this doesn't know, inline config or an alias);
 * `MOVES_HEAD` for a command that changes the branch checked out.
 */
function parsePush(
  argv: readonly string[],
  dir: string | null,
): GitPush | null | typeof UNREADABLE | typeof MOVES_HEAD {
  let i = 1;
  let where = dir;
  let redirected = false;
  const aliases: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") where = cdTo(where, argv[++i]);
    else if (a === "--git-dir" || a === "--work-tree") {
      i++;
      where = null;
    } else if (/^--(git-dir|work-tree)=/.test(a)) where = null;
    else if (a === "-c" || a === "--config-env" || a.startsWith("--config-env=")) {
      const setting = a.startsWith("--config-env=") ? a.slice("--config-env=".length) : (argv[++i] ?? "");
      const key = (setting.split("=")[0] ?? "").toLowerCase();
      // An include can set anything, an alias too.
      if (/^include(if)?\./.test(key)) return UNREADABLE;
      if (key.startsWith("alias.")) aliases.push(key.slice("alias.".length));
      else if (PUSH_CONFIG.test(key)) redirected = true;
    } else if (GIT_GLOBAL_VALUE.has(a)) i++;
    else if (GIT_GLOBAL_GLUED.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
    // A global option this doesn't know may take the next word: what follows can't be read.
    else if (a.startsWith("-")) return argv.includes("push") ? UNREADABLE : null;
    else break;
  }
  const sub = argv[i];
  if (sub === undefined) return null;
  if (aliases.includes(sub.toLowerCase())) return UNREADABLE;
  if (GIT_RUNS_COMMANDS.has(sub)) return PUSH_MENTION.test(argv.slice(i + 1).join(" ")) ? UNREADABLE : null;
  if (movesHead(sub, argv.slice(i + 1))) return MOVES_HEAD;
  if (sub !== "push") return null;
  if (redirected) return UNREADABLE;
  const set: Record<PushFlag, boolean> = {
    force: false,
    lease: false,
    delete: false,
    dry: false,
    every: false,
    mirror: false,
    prune: false,
    tags: false,
  };
  let repo: string | null = null;
  const words: string[] = [];
  // Every option is read, the last one winning as in git (`--dry-run --no-dry-run` pushes).
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j] as string;
    if (a === "--" || a === "--end-of-options") {
      words.push(...argv.slice(j + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      // `--no-<option>` undoes it (`--no-verify` is an option of its own).
      const negated = !PUSH_LONG.has(name) && name.startsWith("no-");
      const what = PUSH_LONG.get(negated ? name.slice(3) : name);
      if (what === undefined) return UNREADABLE;
      if (what === "repo" || what === "value") {
        const value = negated ? null : eq < 0 ? (argv[++j] ?? null) : a.slice(eq + 1);
        if (what === "repo") repo = value;
      } else if (what !== "none") set[what] = !negated;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const what = PUSH_SHORT.get(a[k] as string);
        if (what === undefined) return UNREADABLE;
        if (what === "value") {
          if (k === a.length - 1) j++;
          break;
        }
        if (what !== "none") set[what] = true;
      }
      continue;
    }
    words.push(a);
  }
  if (set.dry) return null;
  const [remote = repo, ...specs] = words;
  const force = set.force || set.lease || set.mirror;
  const push: GitPush = {
    dir: where,
    remote,
    refs: [],
    every: set.every || set.mirror,
    mirror: set.mirror,
    prune: set.prune,
  };
  for (let k = 0; k < specs.length; k++) {
    const spec = specs[k] as string;
    if (spec === "tag") {
      k++;
      continue;
    }
    const plus = spec.startsWith("+");
    const bare = plus ? spec.slice(1) : spec;
    const colon = bare.indexOf(":");
    const dst = colon < 0 ? bare : bare.slice(colon + 1);
    // A wildcard, or `:` alone: every branch (both sides have), the default one too.
    if (dst.includes("*") || bare === ":") {
      push.every = true;
      continue;
    }
    const branch = pushDestination(dst);
    if (branch === "skip") continue;
    push.refs.push({ branch, force: force || plus, delete: set.delete || (colon === 0 && dst !== "") });
  }
  // No refspec: the branch's own push target (`--tags` alone pushes tags only).
  if (specs.length === 0 && !push.every && !set.tags) push.refs.push({ branch: null, force, delete: set.delete });
  return push;
}

/** Shells whose `-c` script is read like lines of its own (`bash -lc 'cd app && git push origin fix'`). */
const SHELL_NAMES = /^(sh|bash|zsh|dash|ksh)$/;
/** Shell keywords and programs that run the rest of their words as a command, as written: a `git` word among them starts it. */
const PASS_THROUGH = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "exec",
  "timeout",
  "sudo",
  "doas",
]);
/** Programs that only read or print: words naming git push there run nothing. */
const printsOnly = (cmd: string) => READ_ANY.has(cmd) || READ_WITH_FLAGS.has(cmd) || cmd === "gh";
/** A command that runs text its words don't show: piped into an interpreter (`… | sh`), or built by `xargs`. */
const runsText = (cmd: string, words: readonly string[], piped: boolean) =>
  cmd === "xargs" ||
  (piped &&
    /^(sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|bun|deno|ruby|perl|php)$/.test(cmd) &&
    words.slice(1).every((w) => w.startsWith("-")));

/**
 * The pushes a command or a shell script makes, line by line (`cd` and `git -C` followed, wrappers skipped, a
 * shell's `-c` script read too); null when a push can't be read plainly (`$(…)`, variables, heredocs, an
 * option git may read otherwise, another program that runs it: `xargs`, `eval`, `sudo sh -c`, `… | sh`; a
 * bare push or `HEAD` after a checkout in the same command): where it goes is unknown.
 */
export function gitPushes(script: string): GitPush[] | null {
  const read = { pushes: [] as GitPush[], moved: false };
  return readPushes(script, "", read) ? read.pushes : null;
}

/** `gitPushes` for a script that starts in `from`, into `read` (a shell's `-c` script shares it); false: unreadable. */
function readPushes(script: string, from: string | null, read: { pushes: GitPush[]; moved: boolean }): boolean {
  let dir = from;
  for (const line of script.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const cmds = simpleCommands(line);
    if (!cmds) {
      if (PUSH_MENTION.test(line)) return false;
      continue;
    }
    for (const { argv, piped } of cmds) {
      const words = unwrapped(argv);
      const cmd = baseName(words[0] ?? "");
      if (cmd === "cd") {
        dir = cdTo(dir, words[1]);
        continue;
      }
      if (SHELL_NAMES.test(cmd) && /^-[a-z]*c[a-z]*$/.test(words[1] ?? "") && words[2] !== undefined) {
        if (!readPushes(words[2], dir, read)) return false;
        continue;
      }
      const at = cmd === "git" ? 0 : PASS_THROUGH.has(cmd) ? words.findIndex((w) => baseName(w) === "git") : -1;
      if (at >= 0) {
        const push = parsePush(words.slice(at), dir);
        if (push === UNREADABLE) return false;
        if (push === MOVES_HEAD) read.moved = true;
        else if (push && (push.refs.length > 0 || push.every || push.prune)) {
          if (read.moved && push.refs.some((r) => r.branch === null || r.branch === "HEAD")) return false;
          read.pushes.push(push);
        }
        continue;
      }
      if (!PUSH_MENTION.test(line)) continue;
      if (runsText(cmd, words, piped === true) || (!printsOnly(cmd) && PUSH_MENTION.test(words.join(" "))))
        return false;
    }
  }
  return true;
}

/** What git says about the repository a push runs in; each read only when a decision needs it. */
export interface RepoFacts {
  /** The branch checked out; null when detached or unknown. */
  current(): Promise<string | null>;
  /** Where a bare push goes (`@{push}`): its remote (null: the default one) and branch; null when git can't tell. */
  pushTarget(): Promise<{ remote: string | null; branch: string | null } | null>;
  /** The remote's default branch: `refs/remotes/<remote>/HEAD`, else the remote's own `HEAD`; null when unknown. */
  defaultBranch(remote: string): Promise<string | null>;
  /** The branches the repository marks protected (`git config agentes.protectedBranch`, `*` matches anything). */
  protectedBranches(): Promise<readonly string[]>;
  /** Every push URL of the remote (or of a URL as git rewrites it) is our git proxy's; false when unknown. */
  viaProxy(remote: string): Promise<boolean>;
}

/** Our git proxy (ADR 0024): `…/api/git/<org>/<connection>/<owner>/<repo>.git`. */
const PROXY_URL = /^https?:\/\/[^\s?#]*\/api\/git\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//i;
export const isProxyUrl = (url: string) => PROXY_URL.test(url.trim());

/** The remote a push goes to: the one it names, else the branch's push remote, else origin. */
export const pushRemote = async (push: Pick<GitPush, "remote">, facts: RepoFacts) =>
  push.remote ?? (await facts.pushTarget())?.remote ?? "origin";

/**
 * Why a command waits for a person, and what the agent can do instead. `never`: it goes through our git proxy,
 * which refuses it whoever approves, so it never runs from here: `what` is the whole refusal, pointing where to go.
 */
export interface Held {
  what: string;
  instead?: string;
  never?: true;
}

/** What a command needs before it runs here: a person's approval (`message` says how to ask), or never (`never`). */
export interface Hold {
  message: string;
  never: boolean;
}

const globMatches = (pattern: string, s: string) =>
  new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`).test(s);

/**
 * Whether one push waits for a person (ADR 0053 §3, amended 2026-10-30): a push to the agent's own branches
 * (`own`, under its `agentes/<handle>/` prefix: nobody else's) or to any other branch but the default and
 * the protected ones is ordinary work; a push to the default or a protected branch, a force push to a branch
 * that isn't its own, deleting a remote branch, `--all`, `--mirror` and `--prune` wait. When git can't tell
 * where a push goes or which branch is the default, it waits too.
 */
export async function heldPush(push: GitPush, facts: RepoFacts, own: readonly string[]): Promise<Held | null> {
  const instead = `Or push to a branch of your own${own[0] ? ` (${own[0]}…)` : ""} and open a pull request.`;
  let remote = push.remote;
  /** The hold, or through our git proxy (which refuses it whoever approves) the refusal pointing where to go. */
  const hold = async (what: string, otherwise: string | undefined, never: string): Promise<Held> =>
    (await facts.viaProxy(await pushRemote({ remote }, facts)))
      ? { what: `${what}: ${never}`, never: true }
      : { what, ...(otherwise ? { instead: otherwise } : {}) };
  const toPullRequest = `our git proxy never lets it through. Push to a branch of your own${own[0] ? ` (${own[0]}…)` : ""} and open a pull request; merging asks a person. ${NO_TERMINAL_COMMANDS}`;
  if (push.mirror)
    return hold("This is a mirror push: it can overwrite and delete any branch", undefined, toPullRequest);
  if (push.every) return hold("This push updates every branch, the default one too", instead, toPullRequest);
  if (push.prune)
    return hold("This push deletes the remote branches that aren't here (--prune)", undefined, toPullRequest);
  for (const ref of push.refs) {
    let branch = ref.branch;
    if (branch === "HEAD") branch = await facts.current();
    else if (branch === null) {
      const target = await facts.pushTarget();
      branch = target?.branch ?? null;
      remote ??= target?.remote ?? null;
    }
    if (branch === null) return { what: "git can't tell which branch this push goes to", instead };
    if (ref.delete) return hold(`This deletes the remote branch ${branch}`, undefined, DELETE_BRANCHES_POINTER);
    if (own.some((prefix) => prefix && branch.startsWith(prefix))) continue;
    if ((await facts.protectedBranches()).some((p) => globMatches(p, branch))) {
      return hold(`This push goes to the protected branch ${branch}`, instead, toPullRequest);
    }
    const main = await facts.defaultBranch(remote ?? "origin");
    if (main === null) {
      return { what: "git can't tell this repository's default branch, so this push may go to it", instead };
    }
    if (branch === main) return hold(`This push goes to the default branch ${main}`, instead, toPullRequest);
    if (ref.force) {
      return hold(
        `This is a force push to ${branch}, a branch others may share`,
        "Or push without force, after bringing in what changed there (git pull --rebase).",
        `our git proxy never lets it through. Push without force, after bringing in what changed there (git pull --rebase). ${NO_TERMINAL_COMMANDS}`,
      );
    }
  }
  return null;
}

/** The first word of each deny rule (`gh`, `vercel`, `kubectl`…): where a command starts inside code. */
const COMMAND_HEADS = new Set(MISSION_DENY_RULES.map((r) => /^Bash\(([^\s*)]+)/.exec(r)?.[1] ?? "").filter(Boolean));

/**
 * The commands code in another language spells out (Python, Node), line by line: quotes, brackets and
 * commas read as spaces, from each command's first word (`subprocess.run(["gh", "pr", "merge"])` reads
 * `gh pr merge`).
 */
function commandsInCode(code: string): string[] {
  return code.split("\n").flatMap((line) => {
    const words = line
      .replace(/["'`,()[\]{};]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    return words.flatMap((w, k) => (COMMAND_HEADS.has(w) ? [words.slice(k).join(" ")] : []));
  });
}

/**
 * Why a command, a shell script or code (`code`: another language) waits for a person, as the refusal
 * tells the agent (`how`: what it can do to ask), or null: a push our git proxy would refuse never runs (it
 * outranks the rest, so no approval lets the command through), then the deny list's kinds, then every push it
 * makes (`heldPush`, with `facts` for the folder each runs in). A push the policy can't read waits.
 */
export async function approvalNeeded(
  text: string,
  how: string,
  opts: { code?: boolean; own?: readonly string[]; facts: (dir: string | null) => RepoFacts },
): Promise<Hold | null> {
  const own = opts.own ?? [];
  const pushes = opts.code ? (PUSH_MENTION.test(text) ? null : []) : gitPushes(text);
  let first: Held | null = null;
  for (const push of pushes ?? []) {
    const held = await heldPush(push, opts.facts(push.dir), own);
    if (held?.never) return { message: held.what, never: true };
    first ??= held;
  }
  for (const command of opts.code ? commandsInCode(text) : [text]) {
    const denied = deniedMessage("Bash", { command }, how);
    if (denied) return { message: denied, never: false };
  }
  if (pushes === null) {
    const message = approvalMessage(
      "This runs git push in a way the computer can't read, so where it goes is unknown",
      how,
      "Or run the push as a plain command of its own (git push origin <branch>).",
    );
    return { message, never: false };
  }
  return first ? { message: approvalMessage(first.what, how, first.instead), never: false } : null;
}

/** Interpreters and the options that run code given on the command line. */
const INLINE_CODE: Array<[RegExp, RegExp]> = [
  [/^(node|nodejs|bun)$/, /^(-e|--eval|-p|--print|-pe|-ep)$|^--(eval|print)=/],
  // `-c` ends a cluster of python's flags (`-Bc`), or carries the code glued (`-cprint(1)`).
  [/^python[\d.]*$/, /^-[a-zA-Z]*c/],
  [/^ruby$/, /^-[a-zA-Z]*e/],
  [/^perl$/, /^-[a-zA-Z0-9]*[eE]/],
  [/^php$/, /^-r/],
];

/** Code given inline to an interpreter (`node -e`, `python3 -c`, `perl -ne`, `deno eval`): never auto-allowed. */
export function inlineCode(argv: readonly string[]): boolean {
  const [first = "", ...args] = unwrapped([...argv]);
  const base = baseName(first);
  if (base === "deno") return args.find((a) => !a.startsWith("-")) === "eval";
  const rule = INLINE_CODE.find(([name]) => name.test(base));
  if (!rule) return false;
  // Options before the script: the first plain word is the script, and what follows it is its own.
  for (const a of args) {
    if (!a.startsWith("-")) return false;
    if (rule[1].test(a)) return true;
  }
  return false;
}

/** Any part of a shell call runs inline code. */
export const inlineCodeCall = (toolName: string, input: Record<string, unknown> | null | undefined) =>
  toolName === "Bash" && commandWords(typeof input?.command === "string" ? input.command : "").some(inlineCode);

/**
 * How an agent asks a person for a command it may not run alone: `run_code` with a `why` opens the approval
 * card in the chat, and the command runs once they approve.
 */
export const ASK_IN_CHAT =
  "To ask them, run the same command with run_code, with why set to your reason: it waits for their decision in the chat.";
/** The same for a call of ours the computer held (`run_code`, `run_skill_script`, `start_task`). */
export const ASK_AGAIN =
  "To ask them, make the same call again with why set to your reason: it waits for their decision in the chat.";
/** Inside a background task nobody is there to approve anything. */
export const ASK_AFTER_TASK = "Nobody can approve it inside a background task: stop and say so in your result.";

/** A refusal that names exactly why, what to do to ask a person, and what to do instead. */
export const approvalMessage = (what: string, how: string, instead?: string) =>
  `${what}: a person approves it first. ${how}${instead ? ` ${instead}` : ""}`;

/** Told to the agent when a call reads a secret. */
export const SECRET_MESSAGE =
  "Agents never read secrets (keys, tokens, credentials, .env files). Do the work without them; if a search pattern only looks like one, search another way.";
/** Told to the agent when a plan turn wants more than reading. */
export const PLAN_MESSAGE =
  "This turn may only read: no edits, no commands that change anything, no web. Report what you would do instead.";

/** The end of every refusal that names a way out: people decide in the chat, never at a terminal. */
export const NO_TERMINAL_COMMANDS = "Never give the person a terminal command to run.";
/**
 * A computer's `not_allowed` that is the command policy's `never` (a push our git proxy refuses): it already says
 * where to go instead, so it is shown as it is.
 */
export const policyRefusal = (message: string) => message.endsWith(NO_TERMINAL_COMMANDS);
/** Said to an agent deleting a branch with git, by the computer and by the git proxy. */
export const DELETE_BRANCHES_POINTER = `agents don't delete branches with git. Ask with delete_branches (repo, branches, why): a person approves them all on one card and they're deleted on GitHub. ${NO_TERMINAL_COMMANDS}`;
/** Said by the git proxy to an agent pushing, with no person's approval, to branches that aren't its own. */
export const otherBranchPointer = (branches: readonly string[], handle: string) =>
  `${branches.join(", ")} ${branches.length === 1 ? "isn't your branch" : "aren't your branches"} (yours: agentes/${handle}/…). To push there, ask with request_branch_push (repo, branch, why); once a person approves, push again. Or push to agentes/${handle}/<topic> and open a pull request. ${NO_TERMINAL_COMMANDS}`;

/** The addresses a call opens: WebFetch's `url`, every http(s) argument of a curl or wget. */
function outboundUrls(toolName: string, input: Record<string, unknown> | null | undefined): string[] {
  if (toolName === "WebFetch") return typeof input?.url === "string" ? [input.url] : [];
  if (toolName !== "Bash" || typeof input?.command !== "string") return [];
  const urls: string[] = [];
  for (const s of simpleCommands(input.command) ?? []) {
    const base = (s.argv[0] ?? "").split("/").pop();
    if (base !== "curl" && base !== "wget") continue;
    for (const a of s.argv.slice(1)) {
      const v = a.replace(/^--url=/, "");
      if (/^https?:\/\//i.test(v)) urls.push(v);
    }
  }
  return urls;
}

/**
 * An address a call would open that carries a key (`outboundUrlProblem` without the run's reads, which only the
 * server knows): refused before anything allows the call. Length alone refuses nothing here: presigned download
 * links (S3 session tokens, GCS signatures) run past a thousand characters, and with no reads known nothing could
 * tell a person's link from a smuggling one.
 */
export function outboundCallProblem(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): { code: OutboundCode; message: string } | null {
  for (const url of outboundUrls(toolName, input)) {
    const problem = outboundUrlProblem(url);
    if (problem && problem.code !== "outbound.long") return problem;
  }
  return null;
}

/**
 * What the computer decides by itself, before anyone is asked: the deny list
 * and secrets are refused (`how`: what the refusal says to do to ask a
 * person), plain reads allowed; in a `plan` turn everything else is refused
 * too. Null: the server decides (`permission_prompt`: a mission's card, or
 * code's rules for a run). The runner's prompt tool for Claude Code and its
 * answers to Codex's command approvals both start here; pushes come next
 * there (`approvalNeeded`).
 */
export function localVerdict(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope | undefined,
  profile: CommandProfile,
  how: string = ASK_IN_CHAT,
): { behavior: "allow" } | { behavior: "deny"; message: string; code?: string } | null {
  const denied = deniedMessage(toolName, input, how);
  if (denied) return { behavior: "deny", message: denied };
  const outbound = outboundCallProblem(toolName, input);
  if (outbound) return { behavior: "deny", message: outbound.message, code: outbound.code };
  if (secretRead(toolName, input, scope)) return { behavior: "deny", message: SECRET_MESSAGE };
  if (scope && readOnlyCall(toolName, input, scope, profile)) return { behavior: "allow" };
  if (profile === "plan") return { behavior: "deny", message: PLAN_MESSAGE };
  return null;
}

// ── What the judge may never approve ──────────────────────────────────────────

const SYSTEM = new Set([
  "sudo",
  "doas",
  "su",
  "launchctl",
  "systemctl",
  "service",
  "shutdown",
  "reboot",
  "halt",
  "mkfs",
  "diskutil",
  "fdisk",
  "dd",
  "csrutil",
  "spctl",
  "defaults",
  "osascript",
  "crontab",
  "visudo",
  "passwd",
  "chsh",
  "nvram",
  "pmset",
  "kextload",
]);
const REMOTE = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "mosh"]);
const WRITERS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "tee",
  "touch",
  "mkdir",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "install",
  "unlink",
  "shred",
  "srm",
]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "eval", "exec", "source", ".", "xargs"]);
/** Claude Code's tools that write a file (Codex's file changes are asked as `Write`). */
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Why code refuses a call even when the judge would allow it (null: the
 * judge may decide). Secrets for every read tool; the rest applies to Bash.
 */
export function forbiddenReason(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
): string | null {
  if (secretRead(toolName, input, scope)) return "it touches secrets";
  // An edit asked for is outside what the turn may write by itself (its folders): only there, or /tmp.
  const edited = FILE_WRITE_TOOLS.has(toolName)
    ? [input?.file_path, input?.notebook_path].find((v): v is string => typeof v === "string")
    : undefined;
  if (edited !== undefined) {
    if (namesSecret(edited, scope)) return "it touches secrets";
    return insideOrTmp(scope, edited) ? null : "it changes files outside the mission folder";
  }
  if (toolName !== "Bash") return null;
  const command = typeof input?.command === "string" ? input.command : "";
  const cmds = simpleCommands(command);
  if (!cmds || cmds.length === 0) return "it can't be read plainly";
  for (const s of cmds) {
    const [cmd = "", ...args] = s.argv;
    const base = cmd.split("/").pop() ?? cmd;
    if (s.writes.some((w) => !insideOrTmp(scope, w))) return "it writes outside the mission folder";
    if (SYSTEM.has(base)) return "it changes the system";
    if (REMOTE.has(base)) return "it connects to another host";
    if (INTERPRETERS.has(base)) return "it runs other commands";
    if (inlineCode(s.argv)) return "it runs code given inline";
    if (WRITERS.has(base)) {
      const paths = args.filter((a) => !a.startsWith("-"));
      if (paths.some((p) => !insideOrTmp(scope, p))) return "it changes files outside the mission folder";
    }
    if (base === "curl" || base === "wget") {
      if (!readOnlySimple(s, scope)) return "it sends data or saves outside the mission folder";
    }
    if (/^(npm|pnpm|yarn|bun)$/.test(base) && args.some((a) => a === "-g" || a === "--global" || a === "global")) {
      return "it installs globally";
    }
    if (
      /^(pip|pip3|gem|cargo|go|brew)$/.test(base) &&
      (args.includes("--user") ||
        args.includes("-g") ||
        (base === "brew" && /^(install|uninstall|upgrade|remove|rm|tap)$/.test(args[0] ?? "")))
    ) {
      return "it installs globally";
    }
    if (base === "git" && args.includes("config") && args.includes("--global")) return "it changes the system";
    if (s.argv.some((a) => SECRET_PATH.test(a))) return "it touches secrets";
  }
  return null;
}

/**
 * What to do instead of a refused call, by `forbiddenReason`: the agent hears
 * why it was refused, so it changes the call instead of resending the same
 * one with another path (a heredoc refused three times in one run).
 */
const FORBIDDEN_HINTS: Record<string, string> = {
  "it can't be read plainly":
    "Commands are checked word by word, so heredocs (<<), $(…), backticks, variables, `FOO=1 cmd` and & jobs are never run here. Write or change files with the Edit and Write tools, then run plain commands one at a time.",
  "it writes outside the mission folder": "Write only inside your folder or /tmp.",
  "it changes files outside the mission folder": "Change files only inside your folder or /tmp.",
  "it runs other commands": "Run the commands themselves, one at a time, not through a shell, eval or xargs.",
  "it runs code given inline":
    "Code passed on the command line (node -e, python -c…) is never run without a person: write it to a file in your folder and run that file.",
  "it touches secrets": SECRET_MESSAGE,
};

export const forbiddenHint = (reason: string) => FORBIDDEN_HINTS[reason] ?? null;

/** `forbiddenReason`'s reasons as the code a refusal carries, so the apps say why in the person's words. */
const FORBIDDEN_CODES: Record<string, string> = {
  "it touches secrets": "secret",
  "it can't be read plainly": "unclear",
  "it writes outside the mission folder": "outside",
  "it changes files outside the mission folder": "outside",
  "it sends data or saves outside the mission folder": "upload",
  "it changes the system": "system",
  "it connects to another host": "remote",
  "it runs other commands": "shell",
  "it runs code given inline": "inline",
  "it installs globally": "global",
};

export const forbiddenCode = (reason: string) => FORBIDDEN_CODES[reason] ?? "rules";

// ── "Aprovar sempre" for a command: its kind ──────────────────────────────────

/** Interpreters whose first plain word is a script: alone, their kind would cover any code. */
const SCRIPT_RUNNERS = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|npx|bunx|pnpx|uvx|pipx)$/;
/** Kinds that run whatever script or package their next word names (`bun run ./x.ts`, `npm exec pkg`). */
const RUNS_ANY = /^(npm|pnpm|yarn|bun|deno|uv|poetry|pdm|go) (run|x|exec|dlx)$/;
/** Words of a kind that delete, publish, deploy, sign in or change settings and secrets: never approved for good. */
const NEVER_FOR_GOOD_WORD =
  /^(delete|del|destroy|remove|rm|drop|uninstall|purge|prune|clean|reset|restore|revert|rollback|merge|deploy|release|publish|unpublish|push|secret|secrets|variable|variables|ruleset|rerun|archive|unarchive|transfer|rename|apply|login|logout|auth|token|kill|approve|revoke|rotate|sudo|config|alias|ssh-key|gpg-key|deploy-key)$/;
/** Kinds that start workflows, change a repository's settings or approve pull requests (`gh pr review --approve`). */
const NEVER_FOR_GOOD_KIND = /^gh (workflow (run|enable|disable)|repo edit|pr review)(\s|$)/;
/** A subcommand word: lower case, no path, no value. */
const KIND_WORD = /^[a-z][a-z0-9_-]*$/;
/** The program and at most this many subcommands (`gh issue create`). */
const KIND_WORDS = 3;

/**
 * The kind "Aprovar sempre" keeps for one command on the agent's computer (ADR 0015, amended 2026-11-03): the program
 * and its subcommands, without arguments or values (`gh issue create --title x` → `gh issue create`, `npm test`), or
 * null when it is never offered: not exactly one plain command (a pipeline, a list, a redirection, a wrapper, a path to
 * the program, options before its subcommand), the deny list, a secret, inline code, a push, a script run by an
 * interpreter, anything that deletes, deploys, publishes, signs in or changes settings. gh's `-R`/`--repo` only pick a
 * repository and stay out of it.
 */
export function commandKind(command: string): string | null {
  const cmds = simpleCommands(command);
  const s = cmds?.length === 1 ? cmds[0] : undefined;
  if (!s || s.writes.length > 0 || s.reads.length > 0) return null;
  const [program = "", ...rest] = s.argv;
  if (!KIND_WORD.test(program) || WRAPPERS.has(program) || SHELL_NAMES.test(program) || PASS_THROUGH.has(program))
    return null;
  if (SYSTEM.has(program) || REMOTE.has(program) || INTERPRETERS.has(program) || WRITERS.has(program)) return null;
  const input = { command };
  if (deniedMessage("Bash", input) || secretRead("Bash", input) || inlineCode(s.argv)) return null;
  if (outboundCallProblem("Bash", input) || gitPushes(command)?.length !== 0) return null;
  // curl and wget only ask when they send or save: their kind would cover every upload.
  if (program === "curl" || program === "wget") return null;
  const args = program === "gh" ? ghWords(rest) : rest;
  if (args[0]?.startsWith("-")) return null;
  const words = [program];
  for (const a of args) {
    if (!KIND_WORD.test(a) || words.length > KIND_WORDS) break;
    words.push(a);
  }
  if (words.length === 1 && SCRIPT_RUNNERS.test(program)) return null;
  const kind = words.join(" ");
  if (RUNS_ANY.test(kind) || NEVER_FOR_GOOD_KIND.test(kind)) return null;
  // Every plain word, not just the kind's: options in between still pick the subcommand (`make X=1 deploy`,
  // `cargo +nightly publish`), and a word that only names something loses the button, never a card.
  if (args.some((w) => NEVER_FOR_GOOD_WORD.test(w))) return null;
  // Its kind alone only reads (`git branch`, `find`, `gh pr view`): what asked was an option (`-D`, `-delete`,
  // `--web`), which the kind would cover with any arguments.
  if (readOnlySimple({ argv: words, writes: [], reads: [] }, { cwd: "/nonexistent", folders: [] }, true)) return null;
  return kind;
}
