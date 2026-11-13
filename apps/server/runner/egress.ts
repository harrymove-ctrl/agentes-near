import { execFile } from "node:child_process";
import { isIP } from "node:net";
import type { MachineEgress } from "@agenteschat/adapters/machine-protocol";
import { type AgentUser, systemLauncher } from "./agent-users";

export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (!family || ip.includes("%")) return false;
  if (family === 6) {
    const value = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
    if (value.startsWith("::ffff:")) {
      const tail = value.slice(7);
      if (tail.includes(".")) return publicAddress(tail);
      const [hi, lo] = tail.split(":").map((n) => Number.parseInt(n, 16));
      if (hi === undefined || lo === undefined) return false;
      return publicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^[23]/.test(value);
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 198 && (b === 18 || b === 19)) &&
    !(a === 100 && b >= 64 && b <= 127)
  );
}

export function parseEgress(value: unknown): MachineEgress | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ip !== "string" || !publicAddress(v.ip)) return null;
  const country =
    typeof v.country === "string" && /^[A-Z]{2}$/.test(v.country) && v.country !== "XX" ? v.country : undefined;
  return { ip: v.ip, ...(country ? { country } : {}) };
}

/** The observation survives an occasional failed lookup, but never an extended outage. */
export class EgressObservation {
  private failed = 0;
  private value: MachineEgress | null = null;
  get current() {
    return this.value;
  }
  record(answer: unknown) {
    const parsed = parseEgress(answer);
    this.failed = parsed ? 0 : this.failed + 1;
    const next = parsed ?? (this.failed >= 3 ? { ip: null } : this.value);
    if (JSON.stringify(next) !== JSON.stringify(this.value)) this.value = next;
    return this.value;
  }
  reset() {
    this.failed = 0;
    this.value = null;
  }
  clear() {
    this.failed = 3;
    this.value = { ip: null };
  }
}

/** No machine credentials enter the agent process. Its route is the same route its programs use. */
export async function probeEgress(
  server: string,
  user?: AgentUser,
  get: typeof fetch = fetch,
  run: typeof execFile = execFile,
  systemd?: boolean,
): Promise<unknown> {
  const url = new URL(`${server.replace(/\/+$/, "")}/api/machines/ip`);
  if (!user) {
    const response = await get(url, { signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error("Address lookup failed");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty address lookup");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new Error("Address lookup too large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const launch = systemLauncher(user, systemd);
  const [file, ...args] = [
    ...launch.prefix,
    "/usr/bin/curl",
    "-q",
    "--noproxy",
    "*",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "10",
    "--max-filesize",
    "4096",
    url.href,
  ];
  return new Promise((resolve, reject) => {
    run(
      file as string,
      args,
      { env: { ...launch.env, AGENTES_NETWORK_OBSERVATION: "1" }, cwd: launch.home, timeout: 12_000, maxBuffer: 4096 },
      (error, stdout) => {
        if (error) return reject(new Error("Address lookup failed"));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid address lookup"));
        }
      },
    );
  });
}
