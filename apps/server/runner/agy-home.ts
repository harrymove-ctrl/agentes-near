import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_MCP_SERVER } from "./mcp";

/**
 * An Antigravity CLI account's home (ADR 0143). `agy` documents no folder of its own to move, so the account's folder
 * is its whole `HOME`: settings in `.gemini/antigravity-cli/settings.json`, MCP servers, agents, rules, skills, hooks
 * and plugins under `.gemini/config/`, and, with no D-Bus session to reach a keyring, its sign-in in its private
 * secrets file there too (antigravity.google/docs: install, cli/reference, mcp, subagents, changelog 1.2.x–1.4.x, read
 * 2026-11-04).
 */

const settingsFile = (home: string) => path.join(home, ".gemini", "antigravity-cli", "settings.json");
const configDir = (home: string) => path.join(home, ".gemini", "config");

/** The agent Lodi's turns run as (`--agent`): no built-in tool, our server's alone. */
export const AGY_CHAT_AGENT = "agenteschat-chat";

/** How the account signs in (`auth.type`): a personal Google account, or Gemini Enterprise. */
export type AgyAuth = "oauth-personal" | "oauth-business";

function readSettings(home: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(settingsFile(home), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The account's sign-in type as its settings say it; null when they say none. */
export function agyAuthOf(home: string): AgyAuth | null {
  const auth = readSettings(home).auth;
  const type = auth && typeof auth === "object" ? (auth as Record<string, unknown>).type : undefined;
  return type === "oauth-business" || type === "oauth-personal" ? type : null;
}

/** Written whole, then renamed, when it isn't that already (600). */
function writeIfChanged(file: string, text: string) {
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch {
    // not there yet
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The account's `settings.json`, the same for every turn on it: its sign-in type (and the Google Cloud project the
 * CLI saved for an Enterprise seat) kept, everything else ours. Terminal commands in the sandbox, nothing outside the
 * turn's folder, our server's tools without asking, no AI credits spent past the plan's quota. Slash commands stay on
 * here: turns pass `--disable-slash-commands`, and `/usage` and `/logout` must reach the CLI, not the model.
 */
export function writeAgySettings(home: string, auth?: AgyAuth) {
  const was = readSettings(home);
  const kept = auth ?? agyAuthOf(home) ?? "oauth-personal";
  const settings = {
    auth: { type: kept },
    ...(kept === "oauth-business" && was.gcp && typeof was.gcp === "object" ? { gcp: was.gcp } : {}),
    toolPermission: "proceed-in-sandbox",
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    useG1Credits: false,
    showTips: false,
    showFeedbackSurvey: false,
    notifications: false,
    artifactReviewPolicy: "always-proceed",
    permissions: { allow: [`mcp(${CODEX_MCP_SERVER}/*)`] },
  };
  writeIfChanged(settingsFile(home), `${JSON.stringify(settings, null, 2)}\n`);
  mkdirSync(agyRuntimeDir(home), { recursive: true, mode: 0o700 });
}

/**
 * The account's own `XDG_RUNTIME_DIR`: with the computer user's, a D-Bus client finds its session bus at
 * `$XDG_RUNTIME_DIR/bus` even with no `DBUS_SESSION_BUS_ADDRESS`, and every account would share one keyring.
 */
export const agyRuntimeDir = (home: string) => path.join(home, ".run");

/**
 * What a turn could leave in the account's home that a later turn (another agent's, or Lodi's) would load as its
 * own, outside every tool and the chat guard: global rules, skills, agents, hooks, plugins and their lists, project
 * settings, the ADC switch, and the rules files `agy` reads beside `.gemini/config`. Removed before every turn; the
 * sandbox keeps a turn's commands out of the home anyway.
 */
export const AGY_PLANTED = [
  ".gemini/config/agents",
  ".gemini/config/skills",
  ".gemini/config/rules",
  ".gemini/config/plugins",
  ".gemini/config/projects",
  ".gemini/config/hooks.json",
  ".gemini/config/config.json",
  ".gemini/config/skills.json",
  ".gemini/config/rules.json",
  ".gemini/config/plugins.json",
  ".gemini/config/agents.json",
  ".gemini/config/GEMINI.md",
  ".gemini/config/AGENTS.md",
  ".gemini/GEMINI.md",
  ".gemini/AGENTS.md",
] as const;

/** `mcp_config.json` with our server alone: `agentes-runner mcp`, the run and its token from the env it inherits. */
export function agyMcpConfig(command: string[] | undefined): string {
  const [bin, ...args] = command ?? [];
  const server = { command: bin ?? "agentes-runner", args: [...args, "mcp"], timeoutSeconds: 360 };
  return `${JSON.stringify({ mcpServers: { [CODEX_MCP_SERVER]: server } }, null, 2)}\n`;
}

/** Lodi's agent: none of the CLI's tools, no commands, never a subagent; it answers through our server. */
export const agyChatAgent = (): string =>
  [
    "---",
    `name: ${AGY_CHAT_AGENT}`,
    "description: Answers the team in agentes.chat through the agentes tools only.",
    "tools: []",
    "mainAgent: true",
    "subagent: false",
    "commandExecutionPolicy: off",
    "---",
    "Use only the agentes tools. Never read or write files, run commands, browse or start other agents.",
    "",
  ].join("\n");

/**
 * Before a turn: what an earlier turn planted dropped, then our settings, our server alone and Lodi's agent written
 * (each only when it differs).
 */
export function prepareAgyHome(home: string, command: string[] | undefined) {
  for (const rel of AGY_PLANTED) rmSync(path.join(home, rel), { recursive: true, force: true });
  writeAgySettings(home);
  writeIfChanged(path.join(configDir(home), "mcp_config.json"), agyMcpConfig(command));
  writeIfChanged(path.join(configDir(home), "agents", AGY_CHAT_AGENT, "agent.md"), agyChatAgent());
}
