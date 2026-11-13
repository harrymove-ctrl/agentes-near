/*
 * Every fact about connecting an AI app to this server (ADR 0119), in one place: the "Conectar um app" dialog reads it.
 * Commands, file formats, menu paths and plan rules are each vendor's own docs as of 2026-11-03 (ADR 0119 addendum).
 * Menu paths and button names stay in the vendor's English, as its docs write them.
 */

import type { en } from "@agenteschat/i18n/en";

type Dialog = (typeof en)["apps"]["dialog"];
/** A key under `apps.dialog`, as "claude.step1". */
export type DialogKey = {
  [K in keyof Dialog & string]: Dialog[K] extends string ? K : `${K}.${keyof Dialog[K] & string}`;
}[keyof Dialog & string];

/** The name the app lists this server under. */
export const MCP_SERVER_NAME = "agentes";

/** A guide's words: a key under `apps.dialog`, with the vendor's own names as its values. */
export interface GuideStep {
  text: DialogKey;
  vars?: Record<string, string>;
  /** The vendor's page, opened from a button beside the words. */
  open?: string;
  /** A command or a file to copy, under the words. */
  code?: string;
  /** This server's address to copy, under the words. */
  address?: true;
  /** A one-click install link: the words are its button. */
  install?: string;
  /** "Criar um token pessoal" under the words. */
  token?: true;
}

export type GuideIcon = "info" | "phone" | "members" | "key";

export interface AppGuide {
  lead?: DialogKey;
  steps: GuideStep[];
  notes: { icon: GuideIcon; text: DialogKey }[];
}

export type AppClientGroup = "chat" | "code";

export interface AppClient {
  id: string;
  /** The product's name; "Outro app" has none and says `apps.dialog.client.other`. */
  name?: string;
  /** A `ProviderLogo` id; null draws the plug. */
  mark: string | null;
  group: AppClientGroup | null;
  /** The line under the name: the app's own address or maker as is, or a kind of app (`apps.dialog.clientText.*`). */
  site?: string;
  kind?: "claude" | "terminal" | "editor" | "extension" | "desktop" | "other";
  guide: (url: string) => AppGuide;
}

/** Where a token goes in a config, for the person to swap for a personal token. */
export const TOKEN_PLACEHOLDER = "<token>";

const json = (value: unknown) => JSON.stringify(value, null, 2);
const step = (text: keyof Dialog["step"], rest: Omit<GuideStep, "text"> = {}): GuideStep => ({
  text: `step.${text}`,
  ...rest,
});
const note = (text: keyof Dialog["note"], icon: GuideIcon = "info") => ({ icon, text: `note.${text}` as const });
const SIGN_IN = step("signIn");
const SIGN_IN_FIRST = step("signInFirst");
const COPILOT_POLICY = note("copilotPolicy", "members");
const TOKEN = step("token", { vars: { placeholder: TOKEN_PLACEHOLDER }, token: true });
const BEARER = `Bearer ${TOKEN_PLACEHOLDER}`;

/** User scope: the server is there in every folder Claude Code opens, not only the one it was added in. */
export const claudeCodeCommand = (url: string) =>
  `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${url}`;

/** Cursor's one-click install: the config as base64 JSON. */
export const cursorInstallLink = (url: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${btoa(JSON.stringify({ url }))}`;

/** `~/.cursor/mcp.json`. */
export const cursorConfig = (url: string) => json({ mcpServers: { [MCP_SERVER_NAME]: { url } } });

/** VS Code's install link: the server as URL-encoded JSON. */
export const vscodeInstallLink = (url: string) =>
  `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_SERVER_NAME, type: "http", url }))}`;

/** `.vscode/mcp.json`. */
export const vscodeConfig = (url: string) => json({ servers: { [MCP_SERVER_NAME]: { type: "http", url } } });

/** The ChatGPT desktop app, the Codex CLI and its IDE extension share this config. */
export const codexCommands = (url: string) =>
  `codex mcp add ${MCP_SERVER_NAME} --url ${url}\ncodex mcp login ${MCP_SERVER_NAME}`;

export const codexConfig = (url: string) => `[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${url}"`;

export const geminiCliCommand = (url: string) => `gemini mcp add --transport http ${MCP_SERVER_NAME} ${url}`;

/** `httpUrl` is Streamable HTTP in Gemini CLI; `url` would be SSE. */
export const geminiCliConfig = (url: string) => json({ mcpServers: { [MCP_SERVER_NAME]: { httpUrl: url } } });

export const devinConfig = (url: string) => json({ mcpServers: { [MCP_SERVER_NAME]: { url, transport: "http" } } });

export const jetbrainsConfig = (url: string) => json({ mcpServers: { [MCP_SERVER_NAME]: { url } } });

/** Copilot in JetBrains, Xcode and Eclipse: GitHub documents only a header for a remote server, so a token. */
export const copilotIdesConfig = (url: string) =>
  json({ servers: { [MCP_SERVER_NAME]: { url, requestInit: { headers: { Authorization: BEARER } } } } });

export const visualStudioConfig = (url: string) => json({ servers: { [MCP_SERVER_NAME]: { url } } });

export const zedConfig = (url: string) => json({ context_servers: { [MCP_SERVER_NAME]: { url } } });

export const clineCommand = (url: string) => `cline mcp add ${MCP_SERVER_NAME} ${url} --transport http`;

/** Warp's sign-in returns to `warp://mcp/oauth2callback`, a custom scheme this server refuses, so a token. */
export const warpConfig = (url: string) => json({ [MCP_SERVER_NAME]: { url, headers: { Authorization: BEARER } } });

export const gooseInstallLink = (url: string) =>
  `goose://extension?url=${encodeURIComponent(url)}&type=streamable_http&id=${MCP_SERVER_NAME}&name=agentes.chat`;

export const gooseConfig = (url: string) =>
  [
    "extensions:",
    `  ${MCP_SERVER_NAME}:`,
    "    name: agentes.chat",
    "    type: streamable_http",
    `    uri: "${url}"`,
    "    enabled: true",
    "    timeout: 300",
  ].join("\n");

export const opencodeConfig = (url: string) =>
  json({ $schema: "https://opencode.ai/config.json", mcp: { [MCP_SERVER_NAME]: { type: "remote", url } } });

/** Continue documents no OAuth for MCP; its headers take the models' `requestOptions` form. */
export const continueConfig = (url: string) =>
  [
    "mcpServers:",
    `  - name: ${MCP_SERVER_NAME}`,
    "    type: streamable-http",
    `    url: ${url}`,
    "    requestOptions:",
    "      headers:",
    `        Authorization: ${BEARER}`,
  ].join("\n");

export const copilotCliCommand = (url: string) => `copilot mcp add --transport http ${MCP_SERVER_NAME} ${url}`;

/** The cards, most used worldwide first within each group; "Outro app" last, on its own. */
export const APP_CLIENTS: readonly AppClient[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    mark: "openai",
    group: "chat",
    site: "chatgpt.com",
    guide: () => ({
      steps: [
        step("open", { vars: { place: "chatgpt.com/plugins" }, open: "https://chatgpt.com/plugins" }),
        step("clickThen", { vars: { button: "+", next: "Add custom MCP server" } }),
        step("nameDescribe"),
        step("choosePaste", { vars: { option: "Connection\u00a0›\u00a0Public endpoint" }, address: true }),
        step("auth", { vars: { option: "OAuth" } }),
        step("tick", { vars: { box: "I understand and want to continue", button: "Create as a plugin" } }),
        SIGN_IN,
      ],
      notes: [note("chatgptPlans", "members"), note("chatgptPhone", "phone")],
    }),
  },
  {
    id: "claude",
    name: "Claude",
    mark: "claude",
    group: "chat",
    kind: "claude",
    guide: () => ({
      lead: "claude.lead",
      steps: [
        { text: "claude.step1", open: "https://claude.ai/customize/connectors" },
        { text: "claude.step2", address: true },
        { text: "claude.step3" },
      ],
      notes: [
        { icon: "phone", text: "claude.phone" },
        { icon: "members", text: "claude.team" },
        { icon: "info", text: "claude.free" },
      ],
    }),
  },
  {
    id: "gemini",
    name: "Gemini",
    mark: "gemini",
    group: "chat",
    site: "gemini.google.com",
    guide: () => ({
      steps: [
        step("open", {
          vars: { place: "Settings\u00a0›\u00a0Gemini Apps Developer Mode" },
          open: "https://gemini.google.com/devmode",
        }),
        step("click", { vars: { button: "+ Create new" } }),
        step("pasteIn", { vars: { field: "MCP Server URL" }, address: true }),
        step("emptySecret", { vars: { button: "Next" } }),
        step("tick", {
          vars: {
            box: "I understand and accept the security and privacy risks of connecting this custom app",
            button: "Connect",
          },
        }),
        step("nameConnect", { vars: { button: "Connect" } }),
        SIGN_IN,
      ],
      notes: [note("geminiPlans", "members")],
    }),
  },
  {
    id: "grok",
    name: "Grok",
    mark: "grok",
    group: "chat",
    site: "grok.com",
    guide: () => ({
      steps: [
        step("open", { vars: { place: "grok.com/connectors" }, open: "https://grok.com/connectors" }),
        step("clickThen", { vars: { button: "New Connector", next: "Custom" } }),
        step("paste", { address: true }),
        SIGN_IN,
      ],
      notes: [note("grokAdmin", "members")],
    }),
  },
  {
    id: "perplexity",
    name: "Perplexity",
    mark: "perplexity",
    group: "chat",
    site: "perplexity.ai",
    guide: () => ({
      steps: [
        step("open", { vars: { place: "Settings\u00a0›\u00a0Connectors" } }),
        step("clickThen", { vars: { button: "+ Custom connector", next: "Remote" } }),
        step("name", { address: true }),
        step("auth", { vars: { option: "OAuth" } }),
        SIGN_IN,
      ],
      notes: [note("perplexityPlans", "members")],
    }),
  },
  {
    id: "le_chat",
    name: "Le Chat",
    mark: "mistral",
    group: "chat",
    site: "chat.mistral.ai",
    guide: () => ({
      steps: [
        step("open", { vars: { place: "Intelligence\u00a0›\u00a0Connectors" } }),
        step("clickThen", { vars: { button: "+ Add Connector", next: "Custom MCP" } }),
        step("name", { address: true }),
        SIGN_IN,
      ],
      notes: [note("leChatAdmin", "members")],
    }),
  },
  {
    id: "raycast",
    name: "Raycast",
    mark: "raycast",
    group: "chat",
    kind: "desktop",
    guide: () => ({
      steps: [
        step("runCommand", { vars: { command: "Install MCP Server" } }),
        step("choose", { vars: { option: "HTTP" } }),
        step("name", { address: true }),
        step("auth", { vars: { option: "Dynamic" } }),
        step("clickThen", { vars: { button: "Install MCP Server", next: "Sign In" } }),
        SIGN_IN,
      ],
      notes: [note("raycastPro", "members")],
    }),
  },
  {
    id: "claude_code",
    name: "Claude Code",
    mark: "claude_code",
    group: "code",
    kind: "terminal",
    guide: (url) => ({
      steps: [{ text: "claudeCode.step1", code: claudeCodeCommand(url) }, { text: "claudeCode.step2" }],
      notes: [{ icon: "info", text: "claudeCode.scope" }],
    }),
  },
  {
    id: "cursor",
    name: "Cursor",
    mark: "cursor",
    group: "code",
    kind: "editor",
    guide: (url) => ({
      steps: [
        { text: "cursor.add", install: cursorInstallLink(url) },
        { text: "cursor.manual", code: cursorConfig(url) },
      ],
      notes: [{ icon: "info", text: "cursor.signIn" }],
    }),
  },
  {
    id: "codex",
    name: "Codex",
    mark: "codex",
    group: "code",
    kind: "terminal",
    guide: (url) => ({
      steps: [
        { text: "codex.step", code: codexCommands(url) },
        step("orFile", { vars: { file: "~/.codex/config.toml" }, code: codexConfig(url) }),
      ],
      notes: [note("codex", "members")],
    }),
  },
  {
    id: "vscode",
    name: "VS Code",
    mark: "vscode",
    group: "code",
    site: "GitHub Copilot",
    guide: (url) => ({
      steps: [
        { text: "vscode.add", install: vscodeInstallLink(url) },
        { text: "vscode.manual", code: vscodeConfig(url) },
        SIGN_IN_FIRST,
      ],
      notes: [COPILOT_POLICY],
    }),
  },
  {
    id: "gemini_cli",
    name: "Gemini CLI",
    mark: "gemini",
    group: "code",
    kind: "terminal",
    guide: (url) => ({
      steps: [
        step("run", { code: geminiCliCommand(url) }),
        step("loginType", { vars: { command: `/mcp auth ${MCP_SERVER_NAME}` } }),
        step("orFile", { vars: { file: "~/.gemini/settings.json" }, code: geminiCliConfig(url) }),
      ],
      notes: [],
    }),
  },
  {
    id: "devin",
    name: "Devin Desktop",
    mark: "devin",
    group: "code",
    site: "Windsurf",
    guide: (url) => ({
      steps: [
        step("file", { vars: { file: "~/.config/devin/mcp_config.json" }, code: devinConfig(url) }),
        SIGN_IN_FIRST,
      ],
      notes: [],
    }),
  },
  {
    id: "jetbrains",
    name: "JetBrains AI Assistant",
    mark: "jetbrains",
    group: "code",
    site: "IntelliJ IDEA, PyCharm, WebStorm",
    guide: (url) => ({
      steps: [
        step("open", { vars: { place: "Settings | Tools | AI Assistant | Model Context Protocol (MCP)" } }),
        step("click", { vars: { button: "Add" } }),
        step("chooseConfig", { vars: { option: "HTTP" }, code: jetbrainsConfig(url) }),
        step("chooseThen", { vars: { option: "Global", button: "OK", next: "Apply" } }),
        SIGN_IN_FIRST,
      ],
      notes: [],
    }),
  },
  {
    id: "copilot_ides",
    name: "GitHub Copilot",
    mark: "githubcopilot",
    group: "code",
    site: "JetBrains, Xcode, Eclipse",
    guide: (url) => ({
      steps: [{ text: "copilotIdes.config", code: copilotIdesConfig(url) }, TOKEN],
      notes: [COPILOT_POLICY],
    }),
  },
  {
    id: "zed",
    name: "Zed",
    mark: "zed",
    group: "code",
    kind: "editor",
    guide: (url) => ({
      steps: [
        step("open", { vars: { place: "Settings\u00a0›\u00a0AI\u00a0›\u00a0MCP Servers" } }),
        step("clickThen", { vars: { button: "Add Server", next: "Add Remote Server" } }),
        step("pasteConfig", { code: zedConfig(url) }),
        SIGN_IN_FIRST,
      ],
      notes: [],
    }),
  },
  {
    id: "cline",
    name: "Cline",
    mark: "cline",
    group: "code",
    kind: "extension",
    guide: (url) => ({
      steps: [
        step("open", { vars: { place: "MCP Servers\u00a0›\u00a0Remote Servers" } }),
        step("name", { address: true }),
        step("choose", { vars: { option: "Streamable HTTP" } }),
        step("click", { vars: { button: "Add Server" } }),
        SIGN_IN_FIRST,
        step("orRun", { code: clineCommand(url) }),
      ],
      notes: [],
    }),
  },
  {
    id: "warp",
    name: "Warp",
    mark: "warp",
    group: "code",
    kind: "terminal",
    guide: (url) => ({
      steps: [
        step("open", { vars: { place: "Settings\u00a0›\u00a0Agents\u00a0›\u00a0MCP servers" } }),
        step("click", { vars: { button: "+ Add" } }),
        step("pasteConfig", { code: warpConfig(url) }),
        TOKEN,
      ],
      notes: [],
    }),
  },
  {
    id: "goose",
    name: "Goose",
    mark: "goose",
    group: "code",
    kind: "desktop",
    guide: (url) => ({
      steps: [
        step("install", { vars: { app: "Goose" }, install: gooseInstallLink(url) }),
        step("orFile", { vars: { file: "~/.config/goose/config.yaml" }, code: gooseConfig(url) }),
        SIGN_IN_FIRST,
      ],
      notes: [],
    }),
  },
  {
    id: "opencode",
    name: "OpenCode",
    mark: "opencode",
    group: "code",
    kind: "terminal",
    guide: (url) => ({
      steps: [
        step("file", { vars: { file: "opencode.json" }, code: opencodeConfig(url) }),
        step("loginRun", { vars: { command: `opencode mcp auth ${MCP_SERVER_NAME}` } }),
      ],
      notes: [],
    }),
  },
  {
    id: "visual_studio",
    name: "Visual Studio",
    mark: "visualstudio",
    group: "code",
    site: "GitHub Copilot",
    guide: (url) => ({
      steps: [
        step("file", { vars: { file: "%USERPROFILE%\\.mcp.json" }, code: visualStudioConfig(url) }),
        step("clickThen", { vars: { button: "Authentication Required", next: "Authenticate" } }),
        SIGN_IN,
        step("mode", { vars: { mode: "Agent" } }),
      ],
      notes: [note("visualStudio"), COPILOT_POLICY],
    }),
  },
  {
    id: "continue",
    name: "Continue",
    mark: "continue",
    group: "code",
    kind: "extension",
    guide: (url) => ({
      steps: [step("file", { vars: { file: "~/.continue/config.yaml" }, code: continueConfig(url) }), TOKEN],
      notes: [note("continueAgent")],
    }),
  },
  {
    id: "copilot_cli",
    name: "Copilot CLI",
    mark: "githubcopilot",
    group: "code",
    kind: "terminal",
    guide: (url) => ({
      steps: [step("run", { code: copilotCliCommand(url) }), SIGN_IN_FIRST],
      notes: [COPILOT_POLICY],
    }),
  },
  {
    id: "other",
    mark: null,
    group: null,
    kind: "other",
    guide: () => ({
      steps: [
        { text: "other.anyStep", address: true },
        { text: "other.anyToken", token: true },
      ],
      notes: [],
    }),
  },
];

/** Grok Bot's settings have no field for an address: the bot adds a custom server when asked in its chat. */
export const grokBotMessage = (url: string) => `Add a custom MCP server called ${MCP_SERVER_NAME} at ${url}`;

/** `~/.hermes/config.yaml`. */
export const hermesConfig = (url: string) =>
  ["mcp_servers:", `  ${MCP_SERVER_NAME}:`, `    url: "${url}"`, "    auth: oauth"].join("\n");

/** `openclaw mcp login` only runs with the Gateway stopped; pasted together, the Gateway starts again once it ends. */
export const openclawCommands = (url: string) =>
  [
    "openclaw gateway stop",
    `openclaw mcp set ${MCP_SERVER_NAME} '${JSON.stringify({ url, transport: "streamable-http", auth: "oauth" })}'`,
    `openclaw mcp login ${MCP_SERVER_NAME}`,
    "openclaw gateway start",
  ].join("\n");

const importClient = (id: string, steps: (url: string) => GuideStep[]): AppClient => ({
  id,
  mark: null,
  group: null,
  guide: (url) => ({ steps: steps(url), notes: [] }),
});
const ANY_APP: GuideStep = { text: "other.anyStep", address: true };
/** The sign-in where the consent page asks for the access: creating agents needs `manage`, never pre-selected. */
const SIGN_IN_MANAGE = step("signInManage");
const chatgpt = APP_CLIENTS.find((c) => c.id === "chatgpt") as AppClient;

/**
 * The import's "Connect with MCP" steps, by source card (`IMPORT_CARDS`): each app's own words where its docs or
 * guides give them, as of 2026-11-10. Grok Bot's come from third-party guides (xAI publishes none), which attach the
 * server with @ before using it. A dot uses the plugins connected in ChatGPT, so it takes ChatGPT's. OpenBot.run
 * documents no menu words. Paperclip and our own export have no entry: neither takes an MCP server.
 */
export const IMPORT_APP_CLIENTS: readonly AppClient[] = [
  importClient("grok-bot", (url) => [
    step("sendInChat", { code: grokBotMessage(url) }),
    step("clickThen", { vars: { button: "Add it", next: "Authorize" } }),
    SIGN_IN_MANAGE,
    step("mention", { vars: { name: MCP_SERVER_NAME } }),
  ]),
  {
    ...chatgpt,
    id: "chatgpt-dots",
    guide: (url) => {
      const guide = chatgpt.guide(url);
      return { ...guide, steps: guide.steps.map((s) => (s === SIGN_IN ? SIGN_IN_MANAGE : s)) };
    },
  },
  importClient("openbotrun", () => [ANY_APP, SIGN_IN_MANAGE]),
  importClient("openmausbot", () => [
    step("open", { vars: { place: "Plugins\u00a0›\u00a0MCP servers" } }),
    step("click", { vars: { button: "Add server" } }),
    step("paste", { address: true }),
    step("clickThen", { vars: { button: "Add", next: "Sign in" } }),
    SIGN_IN_MANAGE,
  ]),
  importClient("hermes", (url) => [
    step("file", { vars: { file: "~/.hermes/config.yaml" }, code: hermesConfig(url) }),
    step("loginRun", { vars: { command: `hermes mcp login ${MCP_SERVER_NAME}` } }),
    SIGN_IN_MANAGE,
    step("reload", { vars: { command: "/reload-mcp" } }),
  ]),
  importClient("openclaw", (url) => [step("run", { code: openclawCommands(url) }), SIGN_IN_MANAGE]),
  importClient("other", () => [ANY_APP, SIGN_IN_MANAGE]),
];

/** The groups in order; null is "Outro app" on its own, under no heading. */
export const APP_CLIENT_GROUPS: readonly (AppClientGroup | null)[] = ["chat", "code", null];
