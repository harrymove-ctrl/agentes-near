import { afterEach, expect, test } from "bun:test";
import { createFakeMailConnector, createFakeMailPoller, createFakeMailTester } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { turnsWorld } from "../eval/turns";
import {
  CONNECTOR_ALL,
  type ConnectorDeps,
  createApiKeyConnection,
  createBrowserToolSource,
  createConnectorToolSource,
  createDesktopToolSource,
  createOrganization,
  decideApproval,
  drainOutbox,
  EVERY_TOOL,
  grantScopes,
  listApprovals,
  postPersonMessage,
  rankTools,
  storeCustomConnection,
  type ToolContext,
  type ToolDefinition,
  toolDenyScope,
} from "../src";
import { fakeHub } from "./desktop-fixtures";
import { fakeGithubMcp } from "./fake-mcp";
import { addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { ICLOUD, PUBLIC_URL, runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const NOT_YET = "Not allowed for you yet: ";
const TURNED_OFF = "Turned off for you by an admin";

/**
 * `@dev` on a computer that serves the browser, without `browser:use` (the fixture's agent), its issue tools on
 * demand (so `find_tools` is listed) and `request_permission`.
 */
async function browserAgent(options: Parameters<typeof setup>[0] = {}) {
  const computer = { machineId: "", orgId: "" };
  const hub = fakeHub(computer);
  hub.s.status = {
    executors: { browser: { available: true, version: "0.39.1" } },
    access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true } },
  };
  f = await setup({
    issueTools: true,
    permissionTools: true,
    ...options,
    toolSources: [createBrowserToolSource({ machines: { hub: hub.hub }, publicUrl: PUBLIC_URL })],
  });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  Object.assign(computer, { machineId: paired.machineId, orgId: f.org.id });
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
}

/** A run of the agent with no tool group loaded: everything but the core is behind `find_tools`. */
const nothingLoaded = async (): Promise<ToolContext> => ({ ...(await runContext(f)), loadedGroups: [] });

async function findTools(ctx: ToolContext, query: string) {
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name: "find_tools", input: { query } });
  return r?.type === "result" ? r.output.content : "";
}

const OPEN = "- browser_open: Opens a website in the agent's own browser.";

test("find_tools names a tool the agent isn't allowed yet, with the permission to ask for; once given, it's a tool it has", async () => {
  await browserAgent();
  const ctx = await nothingLoaded();
  const text = await findTools(ctx, "open a web page");
  const notYet = text.slice(text.indexOf(NOT_YET));
  expect(notYet).toStartWith(`${NOT_YET}ask a person with request_permission`);
  expect(notYet).toContain(
    `\n- permission "browser:use" (Use a browser: Browse websites in its own browser on the agent's computer (logins kept per agent). Needs the browser turned on on that computer.), for:\n  ${OPEN}\n`,
  );
  // Its input never: nothing there is a way to call it.
  expect(notYet).not.toContain("Full address");

  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "browser:use" }]);
  const given = await findTools(ctx, "open a web page");
  expect(given).toContain('other tools for "open a web page" (call one with use_tool):');
  expect(given).toContain("- browser_open: Opens a website");
  const after = given.indexOf(NOT_YET);
  expect(after < 0 ? "" : given.slice(after)).not.toContain("browser_open");
});

test("with every tool listed, the input a search shows is never a blocked tool's", async () => {
  await browserAgent();
  const ctx = { ...(await runContext(f)), loadedGroups: [EVERY_TOOL] };
  const text = await findTools(ctx, "open a web page");
  expect(text).toContain(`  ${OPEN}\n`);
  expect(text).not.toContain("Full address");

  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "browser:use" }]);
  expect(await findTools(ctx, "open a web page")).toContain("Full address");
});

test("a tool an admin turned off by name is named as that, never as something to ask for", async () => {
  await browserAgent();
  const ctx = await nothingLoaded();
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "browser:use" },
    { connectionId: null, scope: toolDenyScope("browser_open") },
  ]);
  const text = await findTools(ctx, "open a web page");
  const [usable = "", turnedOff = ""] = text.split(TURNED_OFF);
  expect(turnedOff).toStartWith("; only an admin can turn them back on:\n");
  expect(turnedOff).toContain(OPEN);
  expect(turnedOff).not.toContain("request_permission");
  expect(turnedOff).not.toContain("permission");
  // Not listed among its tools (browser_close's description may still name it).
  expect(usable).not.toContain("- browser_open:");
});

test("a tool of a connection the agent lacks names that connection's permission; nothing of another workspace shows", async () => {
  const mcp = fakeGithubMcp();
  const deps = (): ConnectorDeps => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" });
  f = await setup({
    issueTools: true,
    permissionTools: true,
    toolSources: [
      { name: "connectors", tools: (ctx) => createConnectorToolSource({ ...deps(), connect: mcp.connect }).tools(ctx) },
    ],
  });
  const github = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "ghp_secret_123456",
  });
  // A new connection is every agent's: take it away from this one, as an admin can.
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, github.id));
  const bia = await addUser(f.db, "bia");
  const { organization: other } = await createOrganization(f.db, bia.id, { name: "Other" });
  const theirs = await createApiKeyConnection(deps(), bia.id, other.id, {
    connector: "github",
    apiKey: "ghp_secret_123456",
  });

  const text = await findTools(await nothingLoaded(), "merge a pull request");
  expect(text.slice(text.indexOf(NOT_YET))).toContain(
    `\n- permission "connector:${github.id}" (GitHub), for:\n  - github_merge_pull_request: [GitHub] Merge a pull request\n`,
  );
  expect(text).not.toContain(theirs.id);
  // The server lists it, but it isn't in our catalog: no agent ever gets it.
  expect(text).not.toContain("star_repository");
});

const WHY = "I need a person's answer before I go on: this decides what I change next.";
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

test("the request_permission call find_tools suggests is the one the card grants", async () => {
  await browserAgent({
    toolsOnDemand: true,
    reply: (req) => {
      const last = lastText(req);
      if (last.includes("Turned on")) return { chunks: ["Ligado."] };
      // The permission exactly as find_tools wrote it (quotes come escaped in the JSON).
      const permission = /permission \\"([^"\\]+)\\"/.exec(last)?.[1];
      if (permission) {
        return {
          chunks: [],
          toolUses: [{ name: "request_permission", input: { why: WHY, permission } }],
        };
      }
      if (last.includes("open the site"))
        return { chunks: [], toolUses: [{ name: "find_tools", input: { query: "open a web page" } }] };
      return { chunks: ["Feito."] };
    },
  });
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(approval).toMatchObject({ tool: "request_permission", title: "Turn on: Use a browser" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, f.handlers);

  const scopes = await f.db
    .select({ scope: schema.agentScopes.scope })
    .from(schema.agentScopes)
    .where(eq(schema.agentScopes.agentId, f.agent.id));
  expect(scopes.map((s) => s.scope)).toContain("browser:use");
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  expect(run?.status).toBe("done");
});

const TASK_QUERIES = ["create issue task backlog", "criar tarefa no backlog"];

/** `@dev`, with GitHub's `issue_write`, on demand; the fixture's agent lacks `issues:write`. */
async function githubAgent() {
  const mcp = fakeGithubMcp({ issueWrite: true });
  const deps = (): ConnectorDeps => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" });
  f = await setup({
    issueTools: true,
    permissionTools: true,
    toolSources: [
      { name: "connectors", tools: (ctx) => createConnectorToolSource({ ...deps(), connect: mcp.connect }).tools(ctx) },
    ],
  });
  await createApiKeyConnection(deps(), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" });
}

test("a task is our board: create_issue ranks above GitHub's tool and every other, in English and Portuguese", async () => {
  await githubAgent();
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
  const github = (await f.tools?.granted(await nothingLoaded()))?.find((t) => t.name === "github_issue_write");
  if (!github) throw new Error("no github_issue_write");
  await f.close();
  const world = await turnsWorld();
  f = world;
  const every = (await world.tools?.granted(await nothingLoaded())) ?? [];
  for (const query of TASK_QUERIES) expect(rankTools([github, ...every], "", query)[0]?.name).toBe("create_issue");
});

test("without issues:write, find_tools says a task is our board and to ask, beside GitHub's tool it could use", async () => {
  await githubAgent();
  const ctx = await nothingLoaded();
  for (const query of TASK_QUERIES) {
    const text = await findTools(ctx, query);
    const notYet = text.slice(text.indexOf(NOT_YET));
    expect(notYet).toStartWith(`${NOT_YET}ask a person with request_permission`);
    expect(notYet).toContain(`- permission "issues:write" (Issues), for:`);
    expect(notYet).toContain(
      "- create_issue: Create a task on this workspace's board: task, tarefa or backlog mean this board, never GitHub or another tool unless the person names it",
    );
  }
  expect(await findTools(ctx, "create issue task backlog")).toContain("- github_issue_write");
  const asks = (await f.tools?.list(ctx))?.find((t) => t.name === "request_permission");
  expect(asks?.description).toContain("A task goes on our board: ask for issues:write");
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
  const given = (await f.tools?.list(ctx))?.find((t) => t.name === "request_permission");
  expect(given?.description).not.toContain("A task goes on our board");
});

const DESKTOP_DO =
  "- desktop_do: Does several steps on the agent's desktop in one go (open an app, click, type, press keys), checking each one.";
const RUN_CODE = `permission "sandbox:run" (Run code: Run code and skill scripts on the agent's computer (files kept between conversations).)`;

test('the desktop, which "all tools" never covers, is named with what giving it means, and with the Run code it needs', async () => {
  f = await setup({
    issueTools: true,
    permissionTools: true,
    toolSources: [
      createDesktopToolSource({ machines: { hub: fakeHub({ machineId: "", orgId: "" }).hub }, publicUrl: PUBLIC_URL }),
    ],
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
  const ctx = await nothingLoaded();
  expect(await findTools(ctx, "click a button in an app")).toContain(
    `${NOT_YET}ask a person with request_permission (the permission as written here, and why), if the request needs it.\n- permission "desktop:use" (Use its desktop: Use any app on its own desktop on the agent's computer; people can watch and take control. It can run anything there, so it also needs Run code, and the desktop turned on on that computer.) and ${RUN_CODE}, for:\n  ${DESKTOP_DO}\n`,
  );

  // Its own permission given, Run code is what's left to ask for: named, and a call says so.
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "desktop:use" }]);
  expect(await findTools(ctx, "click a button in an app")).toContain(`\n- ${RUN_CODE}, for:\n  ${DESKTOP_DO}\n`);
  const call = await f.tools?.invoke(ctx, { toolUseId: "tu_desktop", name: "desktop_do", input: { steps: [] } });
  expect(call?.type === "result" ? call.output.content : "").toBe(
    'Not allowed: this agent lacks the scope sandbox:run. If the request needs it, call request_permission now with permission "sandbox:run": a card asks a person and your work goes on once they decide. Never ask the person to try again',
  );
});

test("use_tool with the name of a tool not allowed yet answers as a direct call does", async () => {
  await browserAgent();
  const r = await f.tools?.invoke(await nothingLoaded(), {
    toolUseId: "tu_use",
    name: "use_tool",
    input: { tool: "browser_open", arguments: { url: "https://example.com" } },
  });
  expect(r?.type === "result" ? r.output.content : "").toBe(
    'Not allowed: this agent lacks the scope browser:use. If the request needs it, call request_permission now with permission "browser:use": a card asks a person and your work goes on once they decide. Never ask the person to try again',
  );
});

test("a routine's run is told the browser a person can turn on, never to ask for it itself (ADR 0109)", async () => {
  await browserAgent();
  const ctx = await nothingLoaded();
  // A routine's background run: the browser is the agent's like in any run; asking for permissions is not a routine's.
  await f.db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, ctx.runId));
  const text = await findTools(ctx, "open a web page");
  expect(text).toStartWith(
    "Not allowed for you yet: a person can turn these on for you; you can't ask for them from here.",
  );
  expect(text).toContain("browser_open");
  expect(text).not.toContain("request_permission");
});

test("a run that can't call request_permission is never told to", async () => {
  await browserAgent({ permissionTools: false });
  const text = await findTools(await nothingLoaded(), "open a web page");
  expect(text).toContain(
    `${NOT_YET}a person can turn these on for you; you can't ask for them from here.\n- permission "browser:use" (Use a browser`,
  );
  expect(text).toContain(`, for:\n  ${OPEN}\n`);
  expect(text).not.toContain("request_permission");
});

const connectorDeps = (): ConnectorDeps => ({
  db: f.db,
  keyWrappers: [f.keyWrapper],
  publicUrl: "https://chat.example.com",
});
const TO_GET =
  "Connectors you don't have yet. If the person wants one, offer it with offer_connect_app (a card that opens the app's own connect dialog) or say how to get it, never that it doesn't exist.";
const SENTRY = "- Sentry: Sentry errors, issues and releases.";
const CONNECT_SENTRY = `${SENTRY} Not connected in this workspace: an admin connects it in Settings › Connectors and MCPs › Add connector › Sentry (in Portuguese, Configurações › Conectores e MCPs › Adicionar conector › Sentry).`;

test("a search for an app the workspace hasn't connected says it exists and how an admin connects it, after any other match", async () => {
  f = await setup({ artifactTools: true, catalog: { oauthApps: {} } });
  const ctx = await nothingLoaded();
  expect(await findTools(ctx, "sentry")).toEndWith(`\n\n${TO_GET}\n${CONNECT_SENTRY}`);
  expect(await findTools(ctx, "connect sentry")).toEndWith(`\n\n${TO_GET}\n${CONNECT_SENTRY}`);
  // Through Composio, on a server without it: it exists, and this server can't connect it.
  const drive = await findTools(ctx, "google drive");
  // The workspace's own Drive matches the word: Google Drive still closes the answer.
  expect(drive).toContain("- list_artifacts");
  expect(drive).toEndWith(
    `\n\n${TO_GET}\n- Google Drive: Google Drive files and folders: search, read, create and share. Not available on this installation: whoever runs the installation has to turn it on first.`,
  );
  expect(await findTools(ctx, "set up github")).toContain(
    "- GitHub: Repositories, pull requests, issues and Actions. Not connected in this workspace: an admin connects it in Settings › Connectors and MCPs › Add connector › GitHub",
  );
  expect(await findTools(ctx, "create an issue")).not.toContain(TO_GET);
});

test("an app connected in the workspace but not given to the agent says an admin gives it on the agent's page; once given, its tools", async () => {
  let sentryId = "";
  const searchIssues = (): ToolDefinition => ({
    name: "sentry_search_issues",
    description: "[Sentry] Search issues",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    scope: "sentry:issues.read",
    connectionId: sentryId,
    connectorLabel: "Sentry",
    execute: async () => ({ content: "No issues." }),
  });
  f = await setup({
    issueTools: true,
    catalog: { oauthApps: {} },
    toolSources: [{ name: "sentry", tools: async () => (sentryId ? [searchIssues()] : []) }],
  });
  const sentry = await createApiKeyConnection(connectorDeps(), f.owner.id, f.org.id, {
    connector: "sentry",
    label: "Sentry do Financeiro",
    apiKey: "not-a-real-key",
  });
  const ctx = await nothingLoaded();
  // Connected but none of its tools listed (its server down): nothing says the agent lacks it.
  expect(await findTools(ctx, "sentry")).not.toContain(TO_GET);

  sentryId = sentry.id;
  // A new connection is every agent's: take it away from this one, as an admin can.
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, sentry.id));
  const text = await findTools(ctx, "sentry");
  expect(text).toEndWith(
    `\n\n${TO_GET}\n${SENTRY} Connected in this workspace but not given to you: an admin gives you access on your page, in Tools and access (in Portuguese, Ferramentas e acesso).`,
  );
  // The catalog's name only, never the connection's own label or key.
  const toGet = text.slice(text.indexOf(TO_GET));
  for (const detail of ["Sentry do Financeiro", "not-a-real-key"]) {
    expect(toGet).not.toContain(detail);
  }

  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: sentry.id, scope: CONNECTOR_ALL }]);
  const given = await findTools(ctx, "sentry");
  expect(given).toContain("- sentry_search_issues: [Sentry] Search issues");
  expect(given).not.toContain(TO_GET);
});

/** IMAP only, no Composio: this server connects iCloud and other mailboxes, never Gmail or Outlook. */
const imapOnly = () => ({
  composio: null,
  imap: {
    connector: createFakeMailConnector().connector,
    poller: createFakeMailPoller().poller,
    tester: createFakeMailTester().tester,
    presets: [ICLOUD],
  },
});

test("an app this installation can't connect says whoever runs it turns it on; one it can, that an admin connects it", async () => {
  f = await setup({ issueTools: true, catalog: { oauthApps: {}, mail: imapOnly() } });
  const ctx = await nothingLoaded();
  // Nothing matches: the groups to search again still come first.
  expect(await findTools(ctx, "gmail")).toBe(
    `No other tool matches "gmail". Try other words (Issues).\n\n${TO_GET}\n- Gmail: Read, organize and answer Gmail email. Not available on this installation: whoever runs the installation has to turn it on first.`,
  );
  expect(await findTools(ctx, "icloud")).toEndWith(
    "\n- iCloud: iCloud email, custom domains included. Not connected in this workspace: an admin connects it in Settings › Connectors and MCPs › Add connector › iCloud (in Portuguese, Configurações › Conectores e MCPs › Adicionar conector › iCloud).",
  );
  expect(await findTools(ctx, "send an e-mail")).toContain(
    "\n- Email: A mailbox: Gmail, Outlook, iCloud or another provider. Not connected in this workspace: an admin connects it in Settings › Connectors and MCPs › Add connector › Email",
  );
});

test("an app whose maker hasn't approved agentes.chat says so, and how an admin connects it with a key instead", async () => {
  f = await setup({ issueTools: true, catalog: { oauthApps: {} } });
  const ctx = await nothingLoaded();
  expect(await findTools(ctx, "figma")).toEndWith(
    `\n\n${TO_GET}\n- Figma: Figma designs, components and variables. Not open to agentes.chat yet: it only lets apps it approved connect in one click. If it gives an API key, an admin connects it with that by its address, in Settings › Connectors and MCPs › Add MCP (in Portuguese, Configurações › Conectores e MCPs › Adicionar MCP).`,
  );
});

test("a mailbox that needs reconnecting says an admin reconnects it, never to connect it again", async () => {
  f = await setup({ issueTools: true, catalog: { oauthApps: {}, mail: imapOnly() } });
  // Its app password stopped working: connecting the same address again fails as already connected.
  await f.db.insert(schema.mailAccounts).values({
    orgId: f.org.id,
    provider: "imap",
    via: "imap",
    preset: "icloud",
    address: "ana@icloud.example.com",
    label: "Caixa da Ana",
    status: "needs_reconnect",
  });
  const ctx = await nothingLoaded();
  const RECONNECT =
    "Connected in this workspace but needs reconnecting: an admin clicks Reconnect on its row in Settings › Connectors and MCPs (in Portuguese, Configurações › Conectores e MCPs › Reconectar).";
  const text = await findTools(ctx, "icloud");
  expect(text).toEndWith(`\n- iCloud: iCloud email, custom domains included. ${RECONNECT}`);
  for (const detail of ["ana@icloud.example.com", "Caixa da Ana"]) expect(text).not.toContain(detail);
  expect(await findTools(ctx, "email")).toEndWith(
    `\n- Email: A mailbox: Gmail, Outlook, iCloud or another provider. ${RECONNECT}`,
  );
});

test("a server connected by address and named after a mailbox's service is that service: its tools, nothing to get", async () => {
  let gmailId = "";
  const searchMail = (): ToolDefinition => ({
    name: "gmail_search_mail",
    description: "[Gmail] Search mail",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    scope: `custom:${gmailId}:read`,
    connectionId: gmailId,
    connectorLabel: "Gmail",
    execute: async () => ({ content: "No mail." }),
  });
  f = await setup({
    issueTools: true,
    catalog: { oauthApps: {}, mail: imapOnly() },
    toolSources: [{ name: "gmail", tools: async () => (gmailId ? [searchMail()] : []) }],
  });
  // A new server is every agent's.
  const gmail = await storeCustomConnection(connectorDeps(), {
    orgId: f.org.id,
    actorId: f.owner.id,
    serverUrl: "https://gmail-mcp.example.com/mcp",
    label: "Gmail",
    authType: "none",
    secret: null,
  });
  gmailId = gmail.connection.id;
  const text = await findTools(await nothingLoaded(), "gmail");
  expect(text).toContain("- gmail_search_mail: [Gmail] Search mail");
  expect(text).not.toContain(TO_GET);
});

test("what another workspace connected never shows: the search answers for this workspace only", async () => {
  f = await setup({ issueTools: true, catalog: { oauthApps: {} } });
  const bia = await addUser(f.db, "bia");
  const { organization: other } = await createOrganization(f.db, bia.id, { name: "Bia Labs" });
  const theirs = await createApiKeyConnection(connectorDeps(), bia.id, other.id, {
    connector: "sentry",
    label: "Sentry da Bia",
    apiKey: "not-a-real-key-bia",
  });
  const text = await findTools(await nothingLoaded(), "sentry");
  expect(text).toEndWith(`\n\n${TO_GET}\n${CONNECT_SENTRY}`);
  for (const detail of [theirs.id, "Sentry da Bia", "not-a-real-key-bia", "Bia Labs"]) {
    expect(text).not.toContain(detail);
  }
});
