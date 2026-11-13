/**
 * The browser eval's harness (ADR 0054): the real browser layer (`browser/surface.ts`, `screen/*`)
 * and the real Jev, driving `agent-browser` on this computer the way the runner does, with a
 * simulated server↔runner round trip. Test pages are local (`pages/`, Acme), served on 127.0.0.1.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserLink, BrowserReply } from "../../src/browser/surface";
import { createJevJudge, type Judge } from "../../src/judge";
import type { ScreenImage } from "../../src/screen";

const PAGES = path.join(import.meta.dir, "pages");
const OUT = path.join(import.meta.dir, "..", "out");

/** `agent-browser`: `AGENT_BROWSER_BIN`, the desktop app's sidecar, or the runner's download. */
export function agentBrowserBin(): string {
  const candidates = [
    process.env.AGENT_BROWSER_BIN,
    "/Applications/agentes.chat.app/Contents/MacOS/agent-browser",
    path.join(os.homedir(), ".agentes-runner", "bin", "agent-browser"),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("agent-browser not found: set AGENT_BROWSER_BIN (and run `agent-browser install` once).");
  return found;
}

const FLAGS = [
  "--session",
  "eval",
  "--namespace",
  "agentes-eval",
  "--json",
  "--content-boundaries",
  "--max-output",
  "50000",
  "--idle-timeout",
  "15m",
];

export function requireKey(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing (put it in .env; the eval calls the real service).`);
  return v;
}

export function servePages() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      const file = path.join(PAGES, p === "/" ? "login.html" : p.slice(1));
      if (!file.startsWith(PAGES) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export interface Meter {
  commands: { command: string; ms: number; ok: boolean }[];
  roundTrips: number;
}
export const newMeter = (): Meter => ({ commands: [], roundTrips: 0 });

export interface CliAnswer {
  ms: number;
  success: boolean;
  data: unknown;
  error?: string;
}

/** One `agent-browser` command in its own process, JSON out (as the runner runs it). */
export async function cli(args: string[]): Promise<CliAnswer> {
  const t0 = performance.now();
  const p = Bun.spawn([agentBrowserBin(), ...FLAGS, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const ms = performance.now() - t0;
  const text = out.trim();
  for (const candidate of [text, text.split("\n").at(-1) ?? ""]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate) as { success?: unknown; data?: unknown; error?: unknown };
      if (typeof v.success === "boolean") {
        return {
          ms,
          success: v.success,
          data: v.data ?? null,
          ...(typeof v.error === "string" ? { error: v.error } : {}),
        };
      }
    } catch {
      // not JSON
    }
  }
  const why = (err.trim() || text).split("\n").find((l) => l.trim()) ?? `agent-browser exited with ${code}`;
  return { ms, success: false, data: null, error: why.slice(0, 2000) };
}

const STALE = /stale|unknown ref|ref\b.*\b(not found|no longer|invalid)|no element (for|matches) ref/i;
/** What the server turns a page-level failure into (`browserErrorText`). */
export function errorText(error: string) {
  if (STALE.test(error)) {
    return `stale_ref: ${error}\nThe page changed since you read it, so that number no longer points at anything. Read the page again (browser_read) and use a number from the new reading, or name the element in words.`;
  }
  return `The browser said: ${error}`;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1] as number;
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number),
        width: ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number),
      };
    }
    i += 2 + length;
  }
  return null;
}

/** `browser.capture` as the runner does it: an annotated JPEG, its size, the page's size and the marks. */
export async function capture(meter?: Meter): Promise<ScreenImage | null> {
  const file = path.join(os.tmpdir(), `agentes-eval-${randomUUID()}.jpg`);
  try {
    const t0 = performance.now();
    const shot = await cli([
      "screenshot",
      file,
      "--annotate",
      "--screenshot-format",
      "jpeg",
      "--screenshot-quality",
      "70",
    ]);
    if (!shot.success) throw new Error(shot.error);
    const bytes = new Uint8Array(readFileSync(file));
    const size = jpegSize(bytes);
    if (!size) return null;
    const sized = await cli(["eval", "[innerWidth, innerHeight]"]);
    const inner = (sized.data as { result?: unknown } | null)?.result;
    const viewport =
      Array.isArray(inner) && typeof inner[0] === "number" && typeof inner[1] === "number"
        ? { width: inner[0], height: inner[1] }
        : size;
    meter?.commands.push({ command: "capture", ms: Math.round(performance.now() - t0), ok: true });
    const annotations = (shot.data as { annotations?: unknown[] } | null)?.annotations ?? [];
    const marks = annotations.flatMap((a) => {
      const m = a as { ref?: string; number?: number; role?: string; name?: string; box?: Record<string, number> };
      if (!m.ref || !m.box) return [];
      return [
        {
          ref: m.ref.replace(/^@/, ""),
          number: m.number ?? 0,
          role: m.role ?? "",
          ...(m.name ? { name: m.name } : {}),
          box: { x: m.box.x ?? 0, y: m.box.y ?? 0, width: m.box.width ?? 0, height: m.box.height ?? 0 },
        },
      ];
    });
    return { data: Buffer.from(bytes).toString("base64"), width: size.width, height: size.height, viewport, marks };
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The agent's browser as the server sees it. `fast`: a runner on protocol 17 (one round trip per
 * batch); else one round trip per command (protocol 12). `rttMs`: the server↔runner trip.
 */
export function cliLink(options: { rttMs: number; fast: boolean; meter: Meter; vision?: boolean }): BrowserLink {
  const trip = async () => {
    options.meter.roundTrips++;
    if (options.rttMs > 0) await Bun.sleep(options.rttMs);
  };
  const run = async (c: { command: string; args: string[] }): Promise<BrowserReply> => {
    const r = await cli([c.command, ...c.args]);
    options.meter.commands.push({ command: c.command, ms: Math.round(r.ms), ok: r.success });
    return r.success ? { ok: true, data: r.data } : { ok: false, text: errorText(r.error || "the command failed") };
  };
  return {
    async act(c) {
      await trip();
      return run(c);
    },
    async batch(commands) {
      if (options.fast) await trip();
      const out: BrowserReply[] = [];
      for (const c of commands) {
        if (!options.fast) await trip();
        const r = await run(c);
        out.push(r);
        if (!r.ok && !c.tolerate) break;
      }
      return out;
    },
    async capture() {
      if (!options.fast || !options.vision) return null;
      await trip();
      return capture(options.meter);
    },
  };
}

export interface JudgeLog {
  calls: { kind: string; ms: number; ok: boolean; images: boolean }[];
  usage: { inputTokens: number; costNanoUsd: number; model: string }[];
}
export const newJudgeLog = (): JudgeLog => ({ calls: [], usage: [] });

/** The real Jev judge with production timeouts, every call timed and its usage kept. */
export function jevJudge(log: JudgeLog): Judge {
  const jev = createJevJudge({
    key: requireKey("TYPESAFE_API_KEY"),
    gateway: {
      async recordExternalUsage(u) {
        log.usage.push({ inputTokens: u.inputTokens, costNanoUsd: u.costNanoUsd, model: u.model });
        return null as never;
      },
    },
    timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 2000),
    visionModel: process.env.JEV_VISION_MODEL ?? "jev-preview",
  });
  return {
    name: "jev",
    async ask(request) {
      const t0 = performance.now();
      let ok = false;
      try {
        const out = await jev.ask(request);
        ok = true;
        return out;
      } finally {
        log.calls.push({
          kind: request.kind,
          ms: Math.round(performance.now() - t0),
          ok,
          images: Object.keys(request.images ?? {}).length > 0,
        });
      }
    },
  };
}

export const p50 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length > 0 ? (s[Math.floor((s.length - 1) / 2)] as number) : 0;
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Writes the report to `eval/out/<name>-<time>.json` (ignored by git) and returns its path. */
export async function writeReport(name: string, report: unknown) {
  const file = path.join(OUT, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
