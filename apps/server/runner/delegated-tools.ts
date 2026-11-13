import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { closeSync, createReadStream, existsSync, openSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ASK_AFTER_TASK,
  ASK_IN_CHAT,
  type CommandProfile,
  type CommandScope,
  inBrowserProfile,
  insideFolders,
  localVerdict,
  PLAN_MESSAGE,
  SECRET_READ_DENY_RULES,
  simpleCommands,
} from "@agenteschat/adapters/command-policy";
import {
  type AgentScope,
  allowedBy,
  type McpToolInfo,
  ruleMatches,
  type ToolNotice,
} from "@agenteschat/adapters/machine-protocol";
import { exitCodeOf, formatBytes, killTree, runCommand } from "./exec";
import { isExecutable, resolveCommand } from "./executors";
import { touchesGitInternals } from "./git-guard";
import { fileLines } from "./lines";
import {
  claudePermissionSettings,
  type DelegatedSurface,
  type McpContent,
  type McpTaskInfo,
  type McpToolResult,
  permissionPrompt,
  shellArg,
  type ToolCaller,
} from "./mcp";
import { isInside, realOrNearest } from "./paths";
import type { Spawn } from "./scope-gate";
import { holdsSecretFile } from "./secrets";

/**
 * Claude Code's own tools, served by the agent's worker, for a sign-in shared by several agents. The CLI holding the
 * sign-in runs with none of its tools that touch files or run code, as a user no agent code runs as; these take their
 * place on the `agentes` bridge, so each call runs as the agent's own user, in its mount view, network and slice. Only
 * a turn with the delegated profile gets them (`McpTaskInfo.delegated`).
 *
 * Names, parameters, limits and answers copy Claude Code's, read from its 2.1.3xx binary: the model knows those
 * tools and is trained on what they say. Every call meets what the native tools met: the turn's settings rules
 * (`claudePermissionSettings`) that Claude Code would check, then our prompt tool (`permissionPrompt`).
 *
 * A command's output goes straight to a file, never through this process: a call moved to the background keeps
 * running with nothing to hand over, a dev server outlives the turn and the CLI, and output past the inline limit is
 * already where `Read` can page it.
 */

export const BASH_DEFAULT_TIMEOUT_MS = 2 * 60_000;
export const BASH_MAX_TIMEOUT_MS = 10 * 60_000;
/**
 * What a call's result may carry. Claude Code 2.1.308 keeps an MCP tool's result inline up to 50,000 characters; past
 * that it saves the result to a file in the sign-in's store, which no tool here can read.
 */
export const DELEGATED_RESULT_TOKENS = 12_000;
const CHARS_PER_TOKEN = 4;
export const DELEGATED_RESULT_CHARS = DELEGATED_RESULT_TOKENS * CHARS_PER_TOKEN;
/** A command's output past this comes back as a preview and the file holding it. */
const INLINE_OUTPUT_BYTES = 30_000;
const PREVIEW_BYTES = 2048;
const READ_MAX_BYTES = 256 * 1024;
const READ_DEFAULT_LINES = 2000;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const NOTEBOOK_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MAX_PAGES = 20;
const GLOB_MAX_FILES = 100;
const GREP_DEFAULT_LIMIT = 250;
const RG_TIMEOUT_SECONDS = 60;
const PDF_TIMEOUT_SECONDS = 120;
/** A background shell writing past this is stopped, as Claude Code stops one. */
const SHELL_OUTPUT_MAX_BYTES = 5 * 1024 ** 3;
const SHELL_WATCH_MS = 5000;
const STOP_GRACE_MS = 1000;
const BACKGROUND_MAX_MS = 24 * 3600_000;
const READS_KEPT = 1000;
const SESSIONS_KEPT = 64;

const NOT_READ = "File has not been read yet. Read it first before writing to it.";
const MODIFIED =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
const PARTLY_READ =
  "You read only part of this file, so a Write could lose the rest. To change part of it, use Edit. To replace it whole, Read all of it first.";
const CANCELED = "Command was aborted before completion";
const NO_RIPGREP = "ripgrep is not on this computer. Use Bash with find or grep instead.";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const VCS_FOLDERS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
/** What a search skips besides the agent's own secret files: the turn's rules can't refuse a folder-wide Grep. */
const GREP_SECRET_GLOBS = [
  ...SECRET_READ_DENY_RULES.flatMap((r) => /^Read\((\*\*\/.+)\)$/.exec(r)?.[1] ?? []),
  "**/.agentes/browser/**",
];

/** Runs `$1`, then leaves where it ended up in the file `$2`; both out of the command's own `$@`. */
const SHELL_SCRIPT = `__agentes_command=$1 __agentes_cwd=$2; set --; eval "$__agentes_command"; __agentes_status=$?; pwd -P >| "$__agentes_cwd" 2>/dev/null; exit "$__agentes_status"`;
/** Claude Code's bundled ripgrep answers to this name. */
const RG_IN_CLAUDE = 'exec -a rg "$0" "$@"';

type Tool = McpToolInfo & { annotations?: { readOnlyHint: true } };

const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });
const boolean = (description: string) => ({ type: "boolean", description });
/** Listed up front like Claude Code's own: behind ToolSearch the model would have to find its shell first. */
const listed = (tool: McpToolInfo, readOnly = false): Tool & { _meta: Record<string, unknown> } => ({
  ...tool,
  ...(readOnly ? { annotations: { readOnlyHint: true as const } } : {}),
  _meta: { "anthropic/alwaysLoad": true },
});

const BASH_TOOL = listed({
  name: "Bash",
  description: `Runs a bash command in this session's shell and returns its output. The working directory carries over between calls; shell state doesn't. Default timeout ${BASH_DEFAULT_TIMEOUT_MS} ms, at most ${BASH_MAX_TIMEOUT_MS} ms: a command still running then moves to the background. Prefer Read, Edit, Write, Glob and Grep for files.`,
  inputSchema: schema(
    {
      command: string("The command to execute"),
      timeout: number(`Optional timeout in milliseconds (max ${BASH_MAX_TIMEOUT_MS} for a foreground command)`),
      description: string("Clear, concise description of what this command does"),
      run_in_background: boolean(
        "Set to true to run this command in the background. With it, `timeout` limits how long it may run there.",
      ),
    },
    ["command"],
  ),
});
const TASK_OUTPUT_TOOL = listed(
  {
    name: "TaskOutput",
    description:
      "Gets what a background command printed so far and its status. Waits for it to finish unless block is false.",
    inputSchema: schema(
      {
        task_id: string("The task ID to get output from"),
        block: boolean("Whether to wait for completion. Defaults to true."),
        timeout: number("Max wait time in milliseconds. Defaults to 30000."),
      },
      ["task_id"],
    ),
  },
  true,
);
const TASK_STOP_TOOL = listed({
  name: "TaskStop",
  description: "Stops a running background command by its ID.",
  inputSchema: schema(
    {
      task_id: string("The ID of the background task to stop"),
      shell_id: string("Deprecated: use task_id instead"),
    },
    [],
  ),
});
const READ_TOOL = listed(
  {
    name: "Read",
    description: `Reads a file: text with line numbers (\`cat -n\` style, up to ${READ_DEFAULT_LINES} lines unless told otherwise), images, PDFs (as page images) and Jupyter notebooks. file_path must be absolute.`,
    inputSchema: schema(
      {
        file_path: string("The absolute path to the file to read"),
        offset: number("The line number to start reading from. Only provide if the file is too large to read at once"),
        limit: number("The number of lines to read. Only provide if the file is too large to read at once."),
        pages: string(
          `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES} pages per request.`,
        ),
      },
      ["file_path"],
    ),
  },
  true,
);
const EDIT_TOOL = listed({
  name: "Edit",
  description:
    "Replaces exact text in a file. Read the file first. Fails if old_string isn't unique, unless replace_all is set. An empty old_string creates a new file.",
  inputSchema: schema(
    {
      file_path: string("The absolute path to the file to modify"),
      old_string: string("The text to replace"),
      new_string: string("The text to replace it with (must be different from old_string)"),
      replace_all: boolean("Replace all occurrences of old_string (default false)"),
    },
    ["file_path", "old_string", "new_string"],
  ),
});
const WRITE_TOOL = listed({
  name: "Write",
  description:
    "Writes a file, replacing what's there. An existing file must be read whole first. Use Edit to change part of one.",
  inputSchema: schema(
    {
      file_path: string("The absolute path to the file to write (must be absolute, not relative)"),
      content: string("The content to write to the file"),
    },
    ["file_path", "content"],
  ),
});
const GLOB_TOOL = listed(
  {
    name: "Glob",
    description: `Finds files by glob pattern ("**/*.ts"), at most ${GLOB_MAX_FILES}, the most recently changed last.`,
    inputSchema: schema(
      {
        pattern: string("The glob pattern to match files against"),
        path: string("The directory to search in. Omit it for the current working directory."),
      },
      ["pattern"],
    ),
  },
  true,
);
const GREP_TOOL = listed(
  {
    name: "Grep",
    description: "Searches file contents with ripgrep. Prefer it to grep or rg through Bash.",
    inputSchema: schema(
      {
        pattern: string("The regular expression pattern to search for in file contents"),
        path: string("File or directory to search in (rg PATH). Defaults to current working directory."),
        glob: string('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            'Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".',
        },
        "-B": number("Number of lines to show before each match. Requires output_mode: content."),
        "-A": number("Number of lines to show after each match. Requires output_mode: content."),
        "-C": number("Alias for context."),
        context: number("Number of lines to show before and after each match. Requires output_mode: content."),
        "-n": boolean("Show line numbers in output. Requires output_mode: content. Defaults to true."),
        "-i": boolean("Case insensitive search"),
        type: string("File type to search (rg --type). Common types: js, py, rust, go, java, etc."),
        head_limit: number(
          `Limit output to the first N lines or entries. Defaults to ${GREP_DEFAULT_LIMIT}; 0 means no limit.`,
        ),
        offset: number("Skip first N lines/entries before applying head_limit. Defaults to 0."),
        multiline: boolean("Enable multiline mode where . matches newlines and patterns can span lines."),
      },
      ["pattern"],
    ),
  },
  true,
);

/** A `work` turn's tools. */
export const DELEGATED_TOOLS: readonly McpToolInfo[] = [
  BASH_TOOL,
  TASK_OUTPUT_TOOL,
  TASK_STOP_TOOL,
  READ_TOOL,
  EDIT_TOOL,
  WRITE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
];
/** A `plan` turn's: no edits; its Bash is what `localVerdict` calls a read. */
export const PLAN_DELEGATED_TOOLS: readonly McpToolInfo[] = DELEGATED_TOOLS.filter(
  (t) => t !== EDIT_TOOL && t !== WRITE_TOOL,
);

export type { ToolNotice };
export type ShellStatus = ToolNotice["status"];

/** What a delegated CLI's tools may do, from root (`bridge.token`). */
export interface DelegatedScope {
  /** Claude Code's session: the cwd, what was read and the background shells carry over a restarted CLI. */
  session: string;
  cwd: string;
  /** The agent's folder and the folders granted to it: edits there need nobody. */
  folder: string;
  grants?: readonly string[];
  profile: CommandProfile;
  /** The agent's own branch prefixes: a push there needs nobody. */
  branches?: readonly string[];
  /** What a person allowed for the whole mission. */
  allow?: readonly string[];
  runnerHome?: string;
  /** A `chat` turn: none of these tools, only the server's. */
  chat?: boolean;
  /** A background task's CLI: a mission's, or one outside a mission (`local`), as `claudeMcpConfig`'s `task`. */
  task?: "mission" | "local";
  /** The CLI's stdin closes after its prompt, so no notice can reach it. */
  oneShot?: boolean;
}

/** `agentSecrets`' answer: what commands get, and what no result may show. */
type Secrets = {
  env: Record<string, string>;
  files: string[];
  hold: number;
  redact: (text: string) => string;
} | null;

export interface DelegatedToolsOptions {
  secrets: () => Promise<Secrets>;
  /** `tool.notice`, to root. */
  onNotice?: (notice: ToolNotice) => void;
  /** A background task's call was refused with nobody to approve it: its task lists it when it ends. */
  onDenied?: (session: string, tool: string, input: Record<string, unknown>) => void;
  /** How commands start: through the agent's cli scope in system mode (`spawnGated`). */
  spawn?: Spawn;
  /** Where command output is kept: never under the runner's home, which no tool may read. */
  root?: string;
  /** ripgrep's argv. Default: `rg` on the PATH, else the one inside the `claude` binary. */
  rg?: string[];
  pdftoppm?: string;
  /** Tests. */
  maxShellOutputBytes?: number;
  shellWatchMs?: number;
  log?: (line: string) => void;
}

interface Shell {
  id: string;
  summary: string;
  file: string;
  child: ChildProcess;
  /** Started by a plan turn: all a plan turn may stop. */
  plan: boolean;
  status: ShellStatus;
  exitCode?: number;
  background: boolean;
  stopped: boolean;
  overflowed: boolean;
  done: Promise<void>;
}

interface Call {
  abort: AbortController;
  /** A foreground command's: answer now, keep it running. */
  detach?: () => void;
}

interface Session {
  scope: DelegatedScope;
  cwd: string;
  dir: string;
  rules: { allow: string[]; ask: string[]; deny: string[] };
  reads: Map<string, { mtimeMs: number; partial: boolean }>;
  shells: Map<string, Shell>;
  calls: Map<string | number, Call>;
  used: number;
}

interface Run {
  s: Session;
  args: Record<string, unknown>;
  ask: ToolCaller;
  id: string | number;
  call: Call;
  secrets: Secrets;
}

const result = (text: string, isError = false): McpToolResult => ({ content: [{ type: "text", text }], isError });
const fail = (text: string) => result(text, true);

const needString = (args: Record<string, unknown>, key: string) => {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`${key} is required`);
  return v;
};
const optionalString = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === "string" && args[key] ? (args[key] as string) : undefined;
/** Models send numbers as strings too, and Claude Code takes them. */
const optionalNumber = (args: Record<string, unknown>, key: string) => {
  const v = typeof args[key] === "string" ? Number(args[key]) : args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const flag = (args: Record<string, unknown>, key: string) => args[key] === true || args[key] === "true";

const errno = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;
const statOrNull = (file: string) =>
  stat(file).catch((err: unknown) => {
    if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") return null;
    throw err;
  });

const plainQuotes = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The file's spelling of `old`: models write straight quotes where the file has curly ones. */
function fileSpelling(content: string, old: string) {
  if (content.includes(old)) return old;
  const at = plainQuotes(content).indexOf(plainQuotes(old));
  return at < 0 ? null : content.slice(at, at + old.length);
}

/** Straight quotes in `text` as `open` or `close`, by what comes before each. */
const curled = (text: string, straight: RegExp, open: string, close: string) =>
  text.replace(straight, (_, at: number) => (at === 0 || /[\s([{—–]/.test(text[at - 1] as string) ? open : close));

/** `next` in the style of the text it replaces, when that text's quotes were curly. */
function sameQuotes(old: string, actual: string, next: string) {
  if (old === actual) return next;
  const doubled = /[“”]/.test(actual) ? curled(next, /"/g, "“", "”") : next;
  return /[‘’]/.test(actual) ? curled(doubled, /'/g, "‘", "’") : doubled;
}

/** A notebook's source or a stream's text: a string or a list of lines. */
const joined = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");

/** A notebook as Claude Code shows it: each cell tagged with its id, then its outputs, images as images. */
function notebookContent(raw: string): McpContent[] {
  const book = JSON.parse(raw) as {
    cells?: Record<string, unknown>[];
    metadata?: { language_info?: { name?: string } };
  };
  if (!Array.isArray(book.cells)) throw new Error("The notebook has no cells.");
  const language = book.metadata?.language_info?.name ?? "python";
  const out: McpContent[] = [];
  const add = (text: string) => {
    const last = out.at(-1);
    if (last?.type === "text") last.text += `\n${text}`;
    else out.push({ type: "text", text });
  };
  book.cells.forEach((cell, i) => {
    const id = typeof cell.id === "string" ? cell.id : `cell-${i}`;
    const code = cell.cell_type === "code";
    const tags = code
      ? language === "python"
        ? ""
        : `<language>${language}</language>`
      : `<cell_type>${String(cell.cell_type)}</cell_type>`;
    add(`<cell id="${id}">${tags}${joined(cell.source)}</cell id="${id}">`);
    for (const output of (code && Array.isArray(cell.outputs) ? cell.outputs : []) as Record<string, unknown>[]) {
      const data = (output.data ?? {}) as Record<string, unknown>;
      const text =
        output.output_type === "stream"
          ? joined(output.text)
          : output.output_type === "error"
            ? `${String(output.ename)}: ${String(output.evalue)}\n${joined(output.traceback)}`
            : joined(data["text/plain"]);
      if (text) add(text);
      for (const mimeType of ["image/png", "image/jpeg"]) {
        const image = data[mimeType];
        if (typeof image === "string") out.push({ type: "image", data: image.replace(/\s/g, ""), mimeType });
      }
    }
  });
  return out;
}

/** `"3"` or `"1-5"`, or null. */
function pageRange(pages: string) {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(pages);
  if (!m) return null;
  const first = Number(m[1]);
  const last = m[2] === undefined ? first : Number(m[2]);
  return first >= 1 && last >= first ? { first, last } : null;
}

/** `glob` split as rg takes it: by spaces and commas outside braces. */
const grepGlobs = (glob: string) => glob.match(/(?:[^\s,{]|\{[^}]*\})+/g) ?? [];

const relativeTo = (cwd: string, file: string) => {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
};
const bareDot = (line: string) => line.replace(/^\.\//, "");
/** rg exits 2 on any path it couldn't read, whatever it found elsewhere: only with nothing found is that a failure. */
const rgFailed = (out: { exitCode: number; stdout: string }) =>
  out.exitCode > 1 && !(out.exitCode === 2 && out.stdout.trim());
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const taskContext = (task: DelegatedScope["task"]) => ({
  ...(task ? { task: true } : {}),
  ...(task === "local" ? { local: true } : {}),
});

/** One worker's delegated tools: its sessions and their background shells. */
export class DelegatedTools {
  private readonly sessions = new Map<string, Session>();
  private readonly root: string;
  private readonly spawn: Spawn;
  private notices: Promise<void> = Promise.resolve();
  private rgCommand: string[] | null = null;
  private readonly handlers: Record<string, (r: Run) => Promise<McpToolResult>> = {
    Bash: (r) => this.bash(r),
    TaskOutput: (r) => this.taskOutput(r),
    TaskStop: (r) => this.taskStop(r),
    Read: (r) => this.read(r),
    Edit: (r) => this.edit(r),
    Write: (r) => this.write(r),
    Glob: (r) => this.glob(r),
    Grep: (r) => this.grep(r),
  };

  constructor(private readonly opts: DelegatedToolsOptions) {
    this.root = opts.root ?? path.join(os.tmpdir(), `agentes-shells-${process.getuid?.() ?? "user"}`);
    this.spawn = opts.spawn ?? nodeSpawn;
  }

  /** What the bridge serves for a delegated CLI. */
  surface(scope: DelegatedScope): DelegatedSurface {
    const s = this.sessionOf(scope);
    return {
      tools: scope.chat ? [] : scope.profile === "plan" ? PLAN_DELEGATED_TOOLS : DELEGATED_TOOLS,
      scope: this.commandScope(s),
      profile: scope.profile,
      ...(scope.branches?.length ? { branches: scope.branches } : {}),
      ...taskContext(scope.task),
      call: (name, args, ctx) => this.call(s, name, args, ctx),
      cancel: (id) => this.stopCalls(s, id),
    };
  }

  /** `turn.cancel`: the session's running calls end, their process groups with them; its background shells stay. */
  cancel(session: string) {
    const s = this.sessions.get(session);
    if (s) this.stopCalls(s);
  }

  /** `turn.detach`: the session's running commands answer now and go on in the background. */
  detach(session: string) {
    for (const call of this.sessions.get(session)?.calls.values() ?? []) call.detach?.();
  }

  /** A task's CLI ended: nothing is left to stop its session's shells or to hear of them, so they end with it. */
  endSession(session: string) {
    const s = this.sessions.get(session);
    if (!s) return;
    this.sessions.delete(session);
    this.stopCalls(s);
    for (const shell of s.shells.values()) {
      shell.background = false;
      this.stop(shell);
    }
    rmSync(s.dir, { recursive: true, force: true });
  }

  /** The worker stops: what runs here stops with it. */
  close() {
    for (const s of this.sessions.values()) {
      for (const call of s.calls.values()) call.abort.abort();
      for (const shell of s.shells.values()) if (shell.status === "running") this.stop(shell);
    }
    this.sessions.clear();
    rmSync(this.root, { recursive: true, force: true });
  }

  private sessionOf(scope: DelegatedScope): Session {
    const held = this.sessions.get(scope.session);
    const { allow, ask, deny } = claudePermissionSettings(
      scope.profile === "plan" ? "plan" : "work",
      [...(scope.allow ?? [])],
      undefined,
      { promptReads: true, ...(scope.runnerHome ? { runnerHome: scope.runnerHome } : {}) },
    ).permissions as Session["rules"];
    if (held) {
      if (held.scope.cwd !== scope.cwd) held.cwd = scope.cwd;
      held.scope = scope;
      held.rules = { allow, ask, deny };
      held.used = Date.now();
      return held;
    }
    const s: Session = {
      scope,
      cwd: scope.cwd,
      dir: path.join(this.root, randomBytes(8).toString("hex")),
      rules: { allow, ask, deny },
      reads: new Map(),
      shells: new Map(),
      calls: new Map(),
      used: Date.now(),
    };
    this.sessions.set(scope.session, s);
    this.evict();
    return s;
  }

  /** The longest unused session with nothing running goes, its output files with it. */
  private evict() {
    if (this.sessions.size <= SESSIONS_KEPT) return;
    const idle = [...this.sessions.entries()]
      .filter(([, s]) => s.calls.size === 0 && ![...s.shells.values()].some((h) => h.status === "running"))
      .sort(([, a], [, b]) => a.used - b.used)[0];
    if (!idle) return;
    this.sessions.delete(idle[0]);
    rmSync(idle[1].dir, { recursive: true, force: true });
  }

  private commandScope(s: Session): CommandScope {
    const { scope } = s;
    return {
      cwd: s.cwd,
      folders: [...new Set([scope.cwd, scope.folder, ...(scope.grants ?? [])])],
      ...(process.env.HOME ? { home: process.env.HOME } : {}),
      ...(scope.runnerHome ? { runnerHome: scope.runnerHome } : {}),
    };
  }

  private stopCalls(s: Session, id?: string | number) {
    if (id !== undefined) s.calls.get(id)?.abort.abort();
    else for (const call of s.calls.values()) call.abort.abort();
  }

  private async call(
    s: Session,
    name: string,
    args: Record<string, unknown>,
    ctx: { id: string | number; ask: ToolCaller },
  ): Promise<McpToolResult> {
    const handler = Object.hasOwn(this.handlers, name) ? this.handlers[name] : undefined;
    if (!handler) return fail(`Unknown tool: ${name}`);
    s.used = Date.now();
    const call: Call = { abort: new AbortController() };
    s.calls.set(ctx.id, call);
    let secrets: Secrets = null;
    try {
      secrets = await this.opts.secrets();
      return this.finished(await handler({ s, args, ask: ctx.ask, id: ctx.id, call, secrets }), secrets);
    } catch (err) {
      return this.finished(fail(err instanceof Error ? err.message : String(err)), secrets);
    } finally {
      s.calls.delete(ctx.id);
    }
  }

  /** Every text a result carries, redacted, then cut to what the CLI takes inline. */
  private finished(out: McpToolResult, secrets: Secrets): McpToolResult {
    const room = DELEGATED_RESULT_CHARS;
    const content = out.content.map((c) => {
      if (c.type !== "text") return c;
      const text = secrets ? secrets.redact(c.text) : c.text;
      if (text.length <= room) return { ...c, text };
      return {
        ...c,
        text: `${text.slice(0, room)}\n\n[Cut here: ask for less, with offset, limit or a narrower search.]`,
      };
    });
    return { ...out, content };
  }

  /** A person or the CLI gave up: a pending prompt ends now, whatever it would have said. */
  private abortable<T>(call: Call, work: Promise<T>): Promise<T> {
    const { signal } = call.abort;
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(new Error("The call was canceled."));
      if (signal.aborted) stop();
      signal.addEventListener("abort", stop, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }

  /**
   * What Claude Code and our prompt tool would have said, in their order: what the computer refuses by itself, the
   * turn's deny rules, then its allow rules and `acceptEdits` (never for what the `ask` rules keep for a person),
   * then the prompt. Null when the call may go on.
   */
  private async gate(r: Run, tool: string, input: Record<string, unknown>): Promise<string | null> {
    const { s } = r;
    const scope = this.commandScope(s);
    const { profile } = s.scope;
    const verdict = localVerdict(tool, input, scope, profile, s.scope.task ? ASK_AFTER_TASK : ASK_IN_CHAT);
    const refuse = (message: string) => {
      if (s.scope.task) this.opts.onDenied?.(s.scope.session, tool, input);
      return message;
    };
    if (verdict?.behavior === "deny") return refuse(verdict.message);
    if (s.rules.deny.some((rule) => ruleMatches(rule, tool, input))) {
      return refuse(`Permission to use ${tool} has been denied.`);
    }
    const held = s.rules.ask.some((rule) => ruleMatches(rule, tool, input));
    if (verdict?.behavior === "allow" || (!held && this.allowedHere(s, scope, tool, input))) return null;
    // Canceled, it stops asking too: a prompt polls for as long as a person may take.
    const ask: ToolCaller = async (name, args) =>
      r.call.abort.signal.aborted ? { ok: false, error: "canceled" } : r.ask(name, args);
    const answer = await this.abortable(
      r.call,
      permissionPrompt({ tool_name: tool, input, tool_use_id: `delegated-${String(r.id)}` }, ask, {
        scope,
        profile,
        ...(s.scope.branches?.length ? { branches: s.scope.branches } : {}),
        ...taskContext(s.scope.task),
      }),
    );
    return answer.behavior === "allow" ? null : refuse(answer.message);
  }

  /** An allow rule for each part of a command it can follow, or an edit inside the turn's folders. */
  private allowedHere(s: Session, scope: CommandScope, tool: string, input: Record<string, unknown>) {
    if (tool === "Edit" || tool === "Write") {
      return s.scope.profile === "work" && insideFolders(scope, String(input.file_path));
    }
    if (tool !== "Bash") return false;
    const parts = simpleCommands(String(input.command));
    return (
      parts?.every((part) => part.writes.every((file) => insideFolders(scope, file))) === true &&
      allowedBy(s.rules.allow, tool, input)
    );
  }

  private absolute(s: Session, given: string) {
    const home = process.env.HOME ?? "";
    const expanded = given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
    return path.resolve(s.cwd, expanded);
  }

  // ── Bash ───────────────────────────────────────────────────────────────────

  private async bash(r: Run): Promise<McpToolResult> {
    const command = needString(r.args, "command");
    const description = optionalString(r.args, "description");
    const refused = await this.gate(r, "Bash", { command, ...(description ? { description } : {}) });
    if (refused) return fail(refused);
    const shell = await this.start(r, command, description);
    const timeout = optionalNumber(r.args, "timeout");
    if (flag(r.args, "run_in_background")) {
      this.toBackground(r.s, shell, false);
      if (timeout) {
        setTimeout(() => this.stop(shell), Math.min(Math.max(timeout, 1), BACKGROUND_MAX_MS)).unref();
      }
      const after = r.s.scope.oneShot ? "Check on it with TaskOutput." : "You will be notified when it completes.";
      return result(
        `Command running in background with ID: ${shell.id}. Output is being written to: ${shell.file}. ${after}`,
      );
    }
    const limit = Math.min(Math.max(timeout ?? BASH_DEFAULT_TIMEOUT_MS, 1), BASH_MAX_TIMEOUT_MS);
    const { signal } = r.call.abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ending = await new Promise<"done" | "timeout" | "detach" | "abort">((resolve) => {
      void shell.done.then(() => resolve("done"));
      timer = setTimeout(() => resolve("timeout"), limit);
      r.call.detach = () => resolve("detach");
      signal.addEventListener("abort", () => resolve("abort"), { once: true });
      if (signal.aborted) resolve("abort");
    });
    clearTimeout(timer);
    delete r.call.detach;
    if (ending === "abort") {
      this.stop(shell);
      await shell.done;
      r.s.shells.delete(shell.id);
      await rm(shell.file, { force: true });
      return fail(CANCELED);
    }
    if (shell.status === "running") {
      this.toBackground(r.s, shell, true);
      const opening =
        ending === "detach"
          ? `Command was moved to the background (ID: ${shell.id}) so that a message that arrived while it was running can reach you; it was not interrupted.`
          : `Command did not complete within its ${Math.max(1, Math.round(limit / 1000))}s timeout and was moved to the background (ID: ${shell.id}).`;
      return result(
        `${opening} Output is being written to: ${shell.file}. It is running now: do not start a second copy while it runs. If it is no longer needed, stop it with TaskStop. To check interim output, use Read on that file path.`,
      );
    }
    const note = await this.track(r.s, shell);
    const output = await this.shellOutput(shell, r.secrets);
    if (output.inline) await rm(shell.file, { force: true });
    r.s.shells.delete(shell.id);
    const killed = shell.overflowed ? `\nCommand killed: output file exceeded ${formatBytes(this.outputCap)}` : "";
    if (shell.exitCode === 0) return result(`${output.text || "(Bash completed with no output)"}${note}`);
    return fail(`Exit code ${shell.exitCode}\n${output.text}${killed}${note}`);
  }

  private get outputCap() {
    return this.opts.maxShellOutputBytes ?? SHELL_OUTPUT_MAX_BYTES;
  }

  /** Starts a command in its own process group, its output in a file of its own. */
  private async start(r: Run, command: string, description?: string): Promise<Shell> {
    const { s } = r;
    await mkdir(s.dir, { recursive: true, mode: 0o700 });
    const id = `b${randomBytes(4).toString("hex")}`;
    const file = path.join(s.dir, `${id}.output`);
    if (!existsSync(s.cwd)) s.cwd = s.scope.cwd;
    const fd = openSync(file, "a", 0o600);
    let child: ChildProcess;
    try {
      child = this.spawn(
        existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
        ["-c", SHELL_SCRIPT, "bash", command, `${file}.cwd`],
        {
          cwd: s.cwd,
          env: { ...process.env, ...r.secrets?.env },
          stdio: ["ignore", fd, fd],
          detached: true,
        },
      );
    } finally {
      closeSync(fd);
    }
    const shell: Shell = {
      id,
      summary: (description ?? command).slice(0, 200),
      file,
      child,
      plan: s.scope.profile === "plan",
      status: "running",
      background: false,
      stopped: false,
      overflowed: false,
      done: Promise.resolve(),
    };
    s.shells.set(id, shell);
    const watch = setInterval(() => {
      try {
        if (statSync(file).size <= this.outputCap) return;
      } catch {
        return;
      }
      shell.overflowed = true;
      this.stop(shell);
    }, this.opts.shellWatchMs ?? SHELL_WATCH_MS);
    watch.unref();
    shell.done = new Promise((resolve) => {
      const over = (code: number | null, signal: NodeJS.Signals | null) => {
        if (shell.status !== "running") return;
        clearInterval(watch);
        shell.exitCode = exitCodeOf(code, signal);
        shell.status = shell.stopped ? "killed" : shell.exitCode === 0 ? "completed" : "failed";
        if (shell.background) this.notice(s, shell);
        resolve();
      };
      // Through EventEmitter: some @types/node versions lose ChildProcess's event methods.
      const events = child as unknown as EventEmitter;
      events.on("error", (err: Error) => {
        this.opts.log?.(`delegated Bash: ${err.message}`);
        over(127, null);
      });
      events.on("exit", over);
    });
    return shell;
  }

  private stop(shell: Shell) {
    if (shell.status !== "running") return;
    shell.stopped = true;
    killTree(shell.child, "SIGTERM");
    // What it started may outlive it and ignore that: the group goes all the same.
    setTimeout(() => killTree(shell.child, "SIGKILL"), STOP_GRACE_MS).unref();
  }

  private toBackground(s: Session, shell: Shell, moved: boolean) {
    shell.background = true;
    this.notice(s, shell, moved);
  }

  private notice(s: Session, shell: Shell, moved = false) {
    const notice: ToolNotice = {
      session: s.scope.session,
      shellId: shell.id,
      status: shell.status,
      ...(shell.exitCode === undefined ? {} : { exitCode: shell.exitCode }),
      summary: shell.summary,
      outputFile: shell.file,
      ...(moved ? { moved } : {}),
    };
    // In order: root counts a shell from its start to its end.
    this.notices = this.notices
      .then(async () => {
        const secrets = await this.opts.secrets().catch(() => null);
        this.opts.onNotice?.({ ...notice, summary: secrets ? secrets.redact(notice.summary) : notice.summary });
      })
      .catch((err: unknown) => this.opts.log?.(`delegated notice: ${String(err)}`));
  }

  /** Where a finished command left the shell: the session's cwd from then on, or back at the start if it left the turn's folders. */
  private async track(s: Session, shell: Shell) {
    const file = `${shell.file}.cwd`;
    const next = (await readFile(file, "utf8").catch(() => "")).trim();
    await rm(file, { force: true });
    if (!path.isAbsolute(next) || next === s.cwd) return "";
    if (insideFolders(this.commandScope(s), next)) {
      s.cwd = next;
      return "";
    }
    s.cwd = s.scope.cwd;
    return `\nShell cwd was reset to ${s.cwd}`;
  }

  /** The start of `file`, read through the end of any value that starts within it, so redacting can catch it whole. */
  private async head(file: string, bytes: number) {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private async shellOutput(shell: Shell, secrets: Secrets) {
    const clean = (text: string) => (secrets ? secrets.redact(text) : text);
    const size = (await statOrNull(shell.file))?.size ?? 0;
    if (size <= INLINE_OUTPUT_BYTES) {
      return { inline: true, text: clean(await readFile(shell.file, "utf8").catch(() => "")).trimEnd() };
    }
    const preview = clean(await this.head(shell.file, PREVIEW_BYTES + (secrets?.hold ?? 0))).slice(0, PREVIEW_BYTES);
    return {
      inline: false,
      text: `Output too large (${formatBytes(size)}). Full output saved to: ${shell.file}\n\nPreview (first 2KB):\n${preview}\n...`,
    };
  }

  private async taskOutput(r: Run): Promise<McpToolResult> {
    const id = needString(r.args, "task_id");
    const shell = r.s.shells.get(id);
    if (!shell) return fail(`No task found with ID: ${id}`);
    const block = r.args.block === undefined || flag(r.args, "block");
    let ready = shell.status !== "running";
    if (block && !ready) {
      const wait = Math.min(Math.max(optionalNumber(r.args, "timeout") ?? 30_000, 0), BASH_MAX_TIMEOUT_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      ready = await this.abortable(
        r.call,
        Promise.race([
          shell.done.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), wait);
          }),
        ]),
      ).finally(() => clearTimeout(timer));
    }
    const output = await this.shellOutput(shell, r.secrets);
    const retrieval = ready ? "success" : block ? "timeout" : "not_ready";
    return result(
      [
        `<retrieval_status>${retrieval}</retrieval_status>`,
        `<task_id>${id}</task_id>`,
        "<task_type>local_bash</task_type>",
        `<status>${shell.status}</status>`,
        ...(shell.exitCode === undefined ? [] : [`<exit_code>${shell.exitCode}</exit_code>`]),
        `<output>\n${output.text}\n</output>`,
      ].join("\n\n"),
    );
  }

  private async taskStop(r: Run): Promise<McpToolResult> {
    const id = optionalString(r.args, "task_id") ?? optionalString(r.args, "shell_id");
    if (!id) return fail("Missing required parameter: task_id");
    const shell = r.s.shells.get(id);
    if (!shell) return fail(`No task found with ID: ${id}`);
    if (shell.status !== "running") return fail(`Task ${id} is not running (status: ${shell.status})`);
    if (r.s.scope.profile === "plan" && !shell.plan) return fail(PLAN_MESSAGE);
    this.stop(shell);
    await shell.done;
    return result(
      JSON.stringify({
        message: `Successfully stopped task: ${id} (${shell.summary})`,
        task_id: id,
        task_type: "local_bash",
        command: shell.summary,
      }),
    );
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  private noteRead(s: Session, file: string, mtimeMs: number, partial: boolean) {
    s.reads.delete(file);
    s.reads.set(file, { mtimeMs, partial });
    if (s.reads.size > READS_KEPT) s.reads.delete(s.reads.keys().next().value as string);
  }

  private async read(r: Run): Promise<McpToolResult> {
    const { s } = r;
    const abs = this.absolute(s, needString(r.args, "file_path"));
    // The target of a link, so a link in the agent's folder can't name a secret away.
    const real = await realOrNearest(abs);
    const refused = await this.gate(r, "Read", { file_path: real });
    if (refused) return fail(refused);
    if (inBrowserProfile(real)) return fail(`${abs} holds your browser's logins. It stays on this computer.`);
    if (await holdsSecretFile(s.scope.folder, r.secrets?.files ?? [], real)) {
      return fail(`${abs} holds a secret. It stays on this computer.`);
    }
    const st = await statOrNull(real);
    if (!st) return fail(`File does not exist. Note: your current working directory is ${s.cwd}.`);
    if (st.isDirectory()) return fail(`EISDIR: illegal operation on a directory, read '${abs}'`);
    if (!st.isFile()) return fail(`${abs} is not a regular file.`);
    const ext = path.extname(real).toLowerCase();
    const mimeType = Object.hasOwn(IMAGE_TYPES, ext) ? IMAGE_TYPES[ext] : undefined;
    if (mimeType) {
      if (st.size > IMAGE_MAX_BYTES) {
        return fail(`Image (${formatBytes(st.size)}) exceeds maximum allowed size (${formatBytes(IMAGE_MAX_BYTES)}).`);
      }
      return {
        content: [{ type: "image", data: (await readFile(real)).toString("base64"), mimeType }],
        isError: false,
      };
    }
    if (ext === ".pdf") return this.readPdf(r, abs, real, st.size);
    if (ext === ".ipynb") {
      if (st.size > NOTEBOOK_MAX_BYTES) {
        return fail(`Notebook content (${formatBytes(st.size)}) exceeds maximum allowed size. Use Bash with jq.`);
      }
      const content = notebookContent(await readFile(real, "utf8"));
      this.noteRead(s, real, st.mtimeMs, false);
      return { content, isError: false };
    }
    return this.readText(r, real, st);
  }

  private async readText(r: Run, real: string, st: { size: number; mtimeMs: number }): Promise<McpToolResult> {
    const offset = optionalNumber(r.args, "offset");
    const limit = optionalNumber(r.args, "limit");
    if (offset === undefined && limit === undefined && st.size > READ_MAX_BYTES) {
      return fail(
        `File content (${formatBytes(st.size)}) exceeds maximum allowed size (${formatBytes(READ_MAX_BYTES)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      );
    }
    if ((await this.head(real, 8192)).includes("\0")) {
      return fail(
        `This tool cannot read binary files. The file appears to be a binary ${path.extname(real).slice(1) || "unknown"} file. Use a shell command or script that can read the format.`,
      );
    }
    const first = Math.max(Math.floor(offset ?? 1), 1);
    const count = Math.max(Math.floor(limit ?? READ_DEFAULT_LINES), 1);
    const shown: string[] = [];
    let seen = 0;
    let chars = 0;
    let more = false;
    for await (const line of fileLines(createReadStream(real, { encoding: "utf8" }))) {
      seen++;
      if (seen < first) continue;
      if (seen >= first + count) {
        more = true;
        break;
      }
      shown.push(`${seen}\t${line}`);
      chars += line.length + 8;
      if (chars > DELEGATED_RESULT_CHARS) break;
    }
    if (chars > DELEGATED_RESULT_CHARS) {
      return fail(
        `File content (over ${DELEGATED_RESULT_TOKENS} tokens) exceeds maximum allowed tokens (${DELEGATED_RESULT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      );
    }
    this.noteRead(r.s, real, st.mtimeMs, first > 1 || more);
    if (seen === 0)
      return result("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
    if (shown.length === 0) {
      return result(
        `<system-reminder>Warning: the file exists but is shorter than the provided offset (${first}). The file has ${seen} lines.</system-reminder>`,
      );
    }
    return result(shown.join("\n"));
  }

  /**
   * A PDF as images of its pages. Claude Code keeps a PDF that comes through MCP in a file of its own (only images
   * reach the model inline), which here no tool could read, so `document` content isn't an option.
   */
  private async readPdf(r: Run, abs: string, real: string, size: number): Promise<McpToolResult> {
    const pages = optionalString(r.args, "pages");
    const range = pages ? pageRange(pages) : { first: 1, last: PDF_MAX_PAGES };
    if (!range) return fail(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3" or "10-20".`);
    if (range.last - range.first + 1 > PDF_MAX_PAGES) {
      return fail(`Too many pages: at most ${PDF_MAX_PAGES} per request.`);
    }
    await mkdir(r.s.dir, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(r.s.dir, "pdf-"));
    try {
      const out = await runCommand({
        command: [
          shellArg(this.opts.pdftoppm ?? "pdftoppm"),
          "-png",
          "-r",
          "100",
          "-f",
          String(range.first),
          "-l",
          String(range.last),
          shellArg(real),
          shellArg(path.join(dir, "page")),
        ].join(" "),
        cwd: dir,
        timeoutSeconds: PDF_TIMEOUT_SECONDS,
        signal: r.call.abort.signal,
      });
      if (out.exitCode === 127) return fail("pdftoppm is not on this computer. Use Bash to read this PDF.");
      if (out.exitCode !== 0) return fail(`The PDF could not be read: ${out.stderr.trim() || `exit ${out.exitCode}`}`);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
      const images: McpContent[] = await Promise.all(
        files.map(async (f) => ({
          type: "image" as const,
          data: (await readFile(path.join(dir, f))).toString("base64"),
          mimeType: "image/png",
        })),
      );
      const more = !pages && images.length === PDF_MAX_PAGES ? ` Use the pages parameter to read other pages.` : "";
      const text = `PDF pages extracted: ${images.length} page(s) from ${abs} (${formatBytes(size)}).${more}`;
      return { content: [{ type: "text", text }, ...images], isError: false };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** A repository's git dir is the runner's own git's settings: never written by a file tool (`git-guard.ts`). */
  private refuseGitDir(given: string, real: string) {
    if (touchesGitInternals(given, real)) {
      throw new Error(`${given} is inside a .git folder. Files there can't be written this way.`);
    }
  }

  private async store(s: Session, real: string, content: string, partial = false) {
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, content);
    this.noteRead(s, real, (await stat(real)).mtimeMs, partial);
  }

  private async edit(r: Run): Promise<McpToolResult> {
    const { s } = r;
    const given = needString(r.args, "file_path");
    const old = needString(r.args, "old_string");
    const next = needString(r.args, "new_string");
    const all = flag(r.args, "replace_all");
    const abs = this.absolute(s, given);
    const real = await realOrNearest(abs);
    if (old === next) return fail("No changes to make: old_string and new_string are exactly the same.");
    this.refuseGitDir(given, real);
    const refused = await this.gate(r, "Edit", {
      file_path: real,
      old_string: old,
      new_string: next,
      ...(all ? { replace_all: true } : {}),
    });
    if (refused) return fail(refused);
    const st = await statOrNull(real);
    if (!st) {
      if (old !== "") return fail(`File does not exist. Note: your current working directory is ${s.cwd}.`);
      await this.store(s, real, next);
      return result(`The file ${abs} has been updated successfully.`);
    }
    if (st.isDirectory()) return fail(`EISDIR: illegal operation on a directory, read '${abs}'`);
    // Before any read: a pipe would never answer, and a read takes no cancel.
    if (!st.isFile()) return fail(`${abs} is not a regular file.`);
    if (old === "") {
      if (st.size > READ_MAX_BYTES || (await readFile(real, "utf8")).trim() !== "") {
        return fail("Cannot create new file - file already exists.");
      }
      await this.store(s, real, next);
      return result(`The file ${abs} has been updated successfully.`);
    }
    if (real.endsWith(".ipynb")) return fail("File is a Jupyter Notebook. Use Write or Bash to change it.");
    const seen = s.reads.get(real);
    if (!seen) return fail(NOT_READ);
    if (st.mtimeMs > seen.mtimeMs) return fail(MODIFIED);
    const raw = await readFile(real, "utf8");
    // Read shows lines without their `\r`: what the model quotes matches once the file's line ends are set aside.
    const crlf = raw.includes("\r\n");
    const content = crlf ? raw.replaceAll("\r\n", "\n") : raw;
    const actual = fileSpelling(content, old);
    if (actual === null) return fail(`String to replace not found in file.\nString: ${old}`);
    const matches = content.split(actual).length - 1;
    if (matches > 1 && !all) {
      return fail(
        `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old}`,
      );
    }
    const replacement = sameQuotes(old, actual, next);
    const changed = all ? content.split(actual).join(replacement) : content.replace(actual, () => replacement);
    await this.store(s, real, crlf ? changed.replaceAll("\n", "\r\n") : changed, seen.partial);
    return result(
      all
        ? `The file ${abs} has been updated. All occurrences were successfully replaced.`
        : `The file ${abs} has been updated successfully.`,
    );
  }

  private async write(r: Run): Promise<McpToolResult> {
    const { s } = r;
    const given = needString(r.args, "file_path");
    const content = needString(r.args, "content");
    const abs = this.absolute(s, given);
    const real = await realOrNearest(abs);
    this.refuseGitDir(given, real);
    const refused = await this.gate(r, "Write", { file_path: real, content });
    if (refused) return fail(refused);
    const st = await statOrNull(real);
    if (st?.isDirectory()) return fail(`EISDIR: illegal operation on a directory, open '${abs}'`);
    if (st) {
      const seen = s.reads.get(real);
      if (!seen) return fail(NOT_READ);
      if (st.mtimeMs > seen.mtimeMs) return fail(MODIFIED);
      if (seen.partial) return fail(PARTLY_READ);
    }
    await this.store(s, real, content);
    return result(st ? `The file ${abs} has been updated successfully.` : `File created successfully at: ${abs}`);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /** `rg` on the PATH, else the one built into the `claude` binary, else `rg` (which then says it isn't there). */
  private rg() {
    if (this.opts.rg) return this.opts.rg;
    if (this.rgCommand) return this.rgCommand;
    // With a shared `bin/`, `resolveCommand` answers a path for what isn't there too.
    const onPath = resolveCommand("rg");
    const claude = resolveCommand("claude");
    this.rgCommand = isExecutable(onPath)
      ? [onPath]
      : isExecutable(claude)
        ? ["/bin/bash", "-c", RG_IN_CLAUDE, claude]
        : ["rg"];
    return this.rgCommand;
  }

  private runRg(r: Run, cwd: string, args: string[]) {
    return runCommand({
      command: [...this.rg(), ...args].map((a) => shellArg(a)).join(" "),
      cwd,
      timeoutSeconds: RG_TIMEOUT_SECONDS,
      signal: r.call.abort.signal,
    });
  }

  private async glob(r: Run): Promise<McpToolResult> {
    const { s } = r;
    const pattern = needString(r.args, "pattern");
    const given = optionalString(r.args, "path");
    const refused = await this.gate(r, "Glob", { pattern, ...(given ? { path: given } : {}) });
    if (refused) return fail(refused);
    let dir = given ? this.absolute(s, given) : s.cwd;
    let glob = pattern;
    if (path.isAbsolute(pattern)) {
      const wild = pattern.search(/[*?[{]/);
      dir = wild < 0 ? path.dirname(pattern) : path.dirname(pattern.slice(0, wild + 1));
      glob = path.relative(dir, pattern);
    }
    const st = await statOrNull(dir);
    if (!st) return fail(`Directory does not exist: ${dir}`);
    if (!st.isDirectory()) return fail(`Path is not a directory: ${dir}`);
    const out = await this.runRg(r, dir, [
      "--files",
      "--hidden",
      "--no-ignore",
      "--sort=modified",
      "--glob",
      glob,
      ...VCS_FOLDERS.flatMap((f) => ["--glob", `!${f}/`]),
      ".",
    ]);
    if (out.exitCode === 127) return fail(NO_RIPGREP);
    if (rgFailed(out)) return fail(out.stderr.trim() || `Exit code ${out.exitCode}`);
    const files = out.stdout
      .split("\n")
      .filter(Boolean)
      .map((f) => relativeTo(s.cwd, path.join(dir, bareDot(f))));
    if (files.length === 0) return result("No files found");
    const shown = files.slice(0, GLOB_MAX_FILES);
    return result(
      [
        ...shown,
        ...(files.length > shown.length
          ? ["(Results are truncated. Consider using a more specific path or pattern.)"]
          : []),
      ].join("\n"),
    );
  }

  private async grep(r: Run): Promise<McpToolResult> {
    const { s, args } = r;
    const pattern = needString(args, "pattern");
    const given = optionalString(args, "path");
    const glob = optionalString(args, "glob");
    // The target of a link, as for Read: rg searches a path it is given by name whatever its globs exclude.
    const target = await realOrNearest(given ? this.absolute(s, given) : s.cwd);
    const refused = await this.gate(r, "Grep", {
      pattern,
      ...(given ? { path: target } : {}),
      ...(glob ? { glob } : {}),
    });
    if (refused) return fail(refused);
    if (inBrowserProfile(target)) return fail(`${target} holds your browser's logins. It stays on this computer.`);
    const st = await statOrNull(target);
    if (!st) return fail(`Path does not exist: ${target}`);
    if (st.isFile() && (await holdsSecretFile(s.scope.folder, r.secrets?.files ?? [], target))) {
      return fail(`${target} holds a secret. It stays on this computer.`);
    }
    // A glob with a slash is rooted where rg runs, so it runs above all it searches. Out of the shell's folder that is
    // the target itself, and what it prints comes back as whole paths.
    const cwd = await realOrNearest(s.cwd);
    const within = isInside(cwd, target);
    const from = within ? cwd : st.isDirectory() ? target : path.dirname(target);
    const searched = !within ? (st.isDirectory() ? "." : path.basename(target)) : path.relative(cwd, target) || ".";
    const folder = await realOrNearest(s.scope.folder);
    const secretFiles = (r.secrets?.files ?? []).map((f) => path.resolve(folder, f)).filter((f) => isInside(from, f));
    const wanted = optionalString(args, "output_mode");
    const mode = wanted === "content" || wanted === "count" ? wanted : "files_with_matches";
    const content = mode === "content";
    const around = optionalNumber(args, "context") ?? optionalNumber(args, "-C");
    const before = optionalNumber(args, "-B");
    const after = optionalNumber(args, "-A");
    const type = optionalString(args, "type");
    const rgArgs = [
      "--hidden",
      "--max-columns",
      "500",
      ...(flag(args, "multiline") ? ["-U", "--multiline-dotall"] : []),
      ...(flag(args, "-i") ? ["-i"] : []),
      ...(mode === "files_with_matches" ? ["-l"] : mode === "count" ? ["-c", "-H"] : ["-H"]),
      ...(content && args["-n"] !== false ? ["-n"] : []),
      ...(content && around !== undefined ? ["-C", String(around)] : []),
      ...(content && around === undefined && before !== undefined ? ["-B", String(before)] : []),
      ...(content && around === undefined && after !== undefined ? ["-A", String(after)] : []),
      ...(type ? ["--type", type] : []),
      ...(glob ? grepGlobs(glob).flatMap((g) => ["--glob", g]) : []),
      // After the caller's: rg's last matching glob wins.
      ...VCS_FOLDERS.flatMap((f) => ["--glob", `!${f}/`]),
      ...GREP_SECRET_GLOBS.flatMap((g) => ["--glob", `!${g}`]),
      ...secretFiles.flatMap((f) => ["--glob", `!${path.relative(from, f)}`]),
      "-e",
      pattern,
      "--",
      searched,
    ];
    const out = await this.runRg(r, from, rgArgs);
    if (out.exitCode === 127) return fail(NO_RIPGREP);
    if (rgFailed(out)) return fail(out.stderr.trim() || `Exit code ${out.exitCode}`);
    const skip = Math.max(Math.floor(optionalNumber(args, "offset") ?? 0), 0);
    const asked = optionalNumber(args, "head_limit");
    const limit = asked === 0 ? Number.POSITIVE_INFINITY : Math.floor(asked ?? GREP_DEFAULT_LIMIT);
    const page = <T>(all: T[]) => {
      const kept = all.slice(skip, skip + limit);
      const cut = all.length - skip > limit;
      const parts = [...(cut ? [`limit: ${limit}`] : []), ...(skip ? [`offset: ${skip}`] : [])];
      return { kept, pagination: parts.join(", ") };
    };
    const lines = out.stdout
      .split("\n")
      .filter(Boolean)
      .map(bareDot)
      .map((line) => (within || line === "--" ? line : `${from}/${line}`));
    if (content) {
      const { kept, pagination } = page(lines);
      if (kept.length === 0) return result(skip && lines.length ? "No entries at this offset" : "No matches found");
      return result(`${kept.join("\n")}${pagination ? `\n\n[Showing results with pagination = ${pagination}]` : ""}`);
    }
    if (mode === "count") {
      const { kept, pagination } = page(lines);
      if (kept.length === 0) return result(skip && lines.length ? "No entries at this offset" : "No matches found");
      const total = kept.reduce((n, line) => n + (Number(line.slice(line.lastIndexOf(":") + 1)) || 0), 0);
      const summary = `Found ${total} total ${plural(total, "occurrence", "occurrences")} across ${kept.length} ${plural(kept.length, "file", "files")}.`;
      return result(`${kept.join("\n")}\n\n${summary}${pagination ? ` with pagination = ${pagination}` : ""}`);
    }
    if (lines.length === 0) return result("No files found");
    const times = await Promise.all(
      lines.map(async (f) => ({ f, at: (await statOrNull(path.resolve(s.cwd, f)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    const { kept, pagination } = page(times.sort((a, b) => b.at - a.at).map((t) => t.f));
    if (kept.length === 0) return result("No entries at this offset");
    return result(
      `Found ${kept.length} ${plural(kept.length, "file", "files")}${pagination ? ` ${pagination}` : ""}\n${kept.join("\n")}`,
    );
  }
}

/** Root's word on a delegated CLI (`bridge.token`), sent again for each turn with its run; a null `token` closes it. */
export interface DelegatedBridge {
  /** The id the CLI's relay dials with (`agentes-runner mcp --relay --task <id>`). */
  process: string;
  token: string | null;
  agent: AgentScope;
  session: string;
  cwd: string;
  profile: CommandProfile;
  branches?: string[];
  allow?: string[];
  /** The turn in progress and its server token: none between turns. */
  runId?: string;
  serverToken?: string;
  /** Where the worker listens for the relay: a folder only this agent and its sign-ins' users can enter. */
  socketPath?: string;
  /** A `chat` turn (`DelegatedScope.chat`). */
  chat?: true;
  /** `DelegatedScope.task`. */
  task?: "mission" | "local";
  /** `DelegatedScope.oneShot`. */
  oneShot?: true;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** A `bridge.token` frame's fields, or null when it isn't one. */
export function parseBridge(f: Record<string, unknown>): DelegatedBridge | null {
  const agent = f.agent as Partial<AgentScope> | undefined;
  const token = f.token === null || typeof f.token === "string" ? f.token : undefined;
  if (typeof f.process !== "string" || token === undefined) return null;
  if (typeof agent?.id !== "string" || typeof agent.handle !== "string") return null;
  if (typeof f.session !== "string" || typeof f.cwd !== "string" || !path.isAbsolute(f.cwd)) return null;
  const branches = strings(f.branches);
  const allow = strings(f.allow);
  return {
    process: f.process,
    token,
    agent: agent as AgentScope,
    session: f.session,
    cwd: f.cwd,
    profile: f.profile === "plan" ? "plan" : "work",
    ...(branches ? { branches } : {}),
    ...(allow ? { allow } : {}),
    ...(typeof f.runId === "string" ? { runId: f.runId } : {}),
    ...(typeof f.serverToken === "string" ? { serverToken: f.serverToken } : {}),
    ...(typeof f.socketPath === "string" && path.isAbsolute(f.socketPath) ? { socketPath: f.socketPath } : {}),
    ...(f.chat === true ? { chat: true as const } : {}),
    ...(f.task === "mission" || f.task === "local" ? { task: f.task } : {}),
    ...(f.oneShot === true ? { oneShot: true as const } : {}),
  };
}

/** The bridge's entry for a delegated CLI, with its tools on it: the only way they reach a tool list. */
export function delegatedTask(
  bridge: DelegatedBridge & { token: string },
  tools: DelegatedTools,
  where: { folder: string; grants: readonly string[]; runnerHome?: string; redact?: (text: string) => string },
): McpTaskInfo {
  const { folder, grants, runnerHome, redact } = where;
  return {
    token: bridge.token,
    missionId: "",
    running: bridge.runId !== undefined,
    ...(bridge.runId === undefined ? { idle: true } : { runId: bridge.runId }),
    cwd: bridge.cwd,
    folder,
    ...(bridge.serverToken ? { serverToken: bridge.serverToken } : {}),
    ...(redact ? { redact } : {}),
    delegated: tools.surface({
      session: bridge.session,
      cwd: bridge.cwd,
      folder,
      grants,
      profile: bridge.profile,
      ...(bridge.branches ? { branches: bridge.branches } : {}),
      ...(bridge.allow ? { allow: bridge.allow } : {}),
      ...(runnerHome ? { runnerHome } : {}),
      ...(bridge.chat ? { chat: true } : {}),
      ...(bridge.task ? { task: bridge.task } : {}),
      ...(bridge.oneShot ? { oneShot: true } : {}),
    }),
  };
}
