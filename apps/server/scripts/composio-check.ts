/**
 * `bun run composio:check [--account ca_…] [--links]` (reads `.env`): what to look at before a service through
 * Composio ships (ADR 0107 §12). Never part of `bun test`: it talks to Composio with COMPOSIO_API_KEY.
 *
 * For each entry, read only: the toolkit's sign-in schemes and the scopes of Composio's own app
 * (`GET /toolkits/{slug}`), and whether each listed action exists at the pinned version, with its tags.
 * `--account ca_…`, a test account connected through the app, read only: its toolkit, status, `displayName` and the
 * scopes it was granted (Drive must have the full `https://www.googleapis.com/auth/drive`).
 * `--links` writes: two Connect Links for one throwaway user on Drive's auth config (a second one must work), each
 * opened with `state` appended; both pending accounts are deleted after.
 */
import { parseArgs } from "node:util";
import { createComposioClient } from "@agenteschat/adapters";
import { composioAuthConfigs, loadConfig } from "@agenteschat/config";
import { composioToolName, MCP_PRESETS } from "@agenteschat/engine";

const BASE = "https://backend.composio.dev/api/v3.1";
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: { account: { type: "string" }, links: { type: "boolean" } },
});
const config = loadConfig();
const apiKey = config.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error("Set COMPOSIO_API_KEY in .env");
  process.exit(1);
}
const client = createComposioClient({ apiKey, authConfigs: composioAuthConfigs(config) });

async function get(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-api-key": apiKey ?? "" } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Every value under a key that names scopes, wherever Composio puts it. */
function scopesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) scopesIn(v, out);
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (/scope/i.test(key)) {
        for (const s of Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [])
          if (typeof s === "string" && s) out.add(s);
      } else scopesIn(v, out);
    }
  }
  return out;
}

let missing = 0;
for (const preset of MCP_PRESETS) {
  const way = preset.composio;
  if (!way) continue;
  console.log(`\n${preset.label} (${way.toolkit}@${way.version}, ${way.auth})`);
  try {
    const toolkit = await get(`/toolkits/${encodeURIComponent(way.toolkit)}`);
    console.log("  sign-in:", JSON.stringify(toolkit.composio_managed_auth_schemes ?? toolkit.auth_schemes ?? null));
    const scopes = [...scopesIn(toolkit)];
    console.log(`  Composio's app scopes: ${scopes.length > 0 ? scopes.join(" ") : "(none listed)"}`);
  } catch (error) {
    console.log(`  toolkit: ${String(error)}`);
  }
  try {
    const tools = new Map((await client.listTools(way.toolkit, way.version)).map((t) => [t.slug, t]));
    for (const action of [...way.actions, ...(preset.account?.tool ? [preset.account.tool] : [])]) {
      const tool = tools.get(action);
      if (!tool) missing++;
      console.log(
        `  ${tool ? "ok     " : "MISSING"} ${action} → ${composioToolName(way, action)}${tool ? ` [${tool.tags.join(", ")}]` : ""}`,
      );
    }
  } catch (error) {
    console.log(`  tools: ${String(error)}`);
  }
}

if (args.account) {
  const account = await get(`/connected_accounts/${encodeURIComponent(args.account)}`);
  const state = (account.state ?? {}) as { val?: Record<string, unknown> };
  console.log(`\nAccount ${args.account}`);
  console.log("  toolkit:", JSON.stringify((account.toolkit as { slug?: string } | undefined)?.slug ?? null));
  console.log("  status:", JSON.stringify(account.status ?? null));
  console.log("  displayName:", JSON.stringify(state.val?.displayName ?? null));
  console.log("  scopes:", [...scopesIn(account)].join(" ") || "(none listed)");
}

if (args.links) {
  const userId = `check_${crypto.randomUUID()}`;
  const made: string[] = [];
  try {
    for (const n of [1, 2]) {
      const link = await client.createConnectLink({
        toolkit: "googledrive",
        userId,
        callbackUrl: "https://example.com/callback",
      });
      made.push(link.connectedAccountId);
      const url = new URL(link.redirectUrl);
      url.searchParams.set("state", "check");
      const res = await fetch(url, { redirect: "manual" });
      console.log(`\nConnect Link ${n}: ${link.connectedAccountId}, opened with state: ${res.status}`);
    }
  } finally {
    for (const id of made) await client.deleteConnectedAccount(id, { revoke: false }).catch(() => {});
  }
}

console.log(missing > 0 ? `\n${missing} actions missing at their pinned version` : "\nEvery listed action exists");
process.exit(missing > 0 ? 1 : 0);
