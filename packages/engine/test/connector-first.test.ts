import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  createApiKeyConnection,
  createConnectorToolSource,
  grantScopes,
  postPersonMessage,
  type ToolContext,
  type ToolDefinition,
} from "../src";
import { requestSecretTool } from "../src/secret-request-tool";
import { fakeGithubMcp } from "./fake-mcp";
import { type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Reaching the computer is the card opening: the tool's own answer past every check. */
const CARD = "Failed: the card opens";
const KEY = { name: "GH_TOKEN", purpose: "Token do GitHub com leitura", target: "env" };

const offerConnectApp: ToolDefinition = {
  name: "offer_connect_app",
  description: "Offer to connect an app.",
  inputSchema: { type: "object", properties: {} },
  scope: "",
  execute: async () => ({ content: "ok" }),
};

const deps = (): ConnectorDeps => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" });

async function world(options: { offer?: boolean; catalog?: boolean } = {}) {
  const mcp = fakeGithubMcp();
  const secret = requestSecretTool({
    scope: "",
    browserOnly: false,
    toolPath: (raw) => raw,
    onComputer: async () => {
      throw new Error("the card opens");
    },
  });
  f = await setup({
    permissionTools: true,
    ...(options.catalog === false ? {} : { catalog: { oauthApps: {} } }),
    toolSources: [
      { name: "secrets", tools: async () => [secret, ...(options.offer ? [offerConnectApp] : [])] },
      { name: "connectors", tools: (ctx) => createConnectorToolSource({ ...deps(), connect: mcp.connect }).tools(ctx) },
    ],
  });
  return runContext(f);
}

const connectGithub = () =>
  createApiKeyConnection(deps(), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_fake_fixture" });

async function ask(ctx: ToolContext, input: Record<string, unknown>) {
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name: "request_secret", input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output.content;
}

test("a key of a service the agent has tools of opens no card: it gets its tools", async () => {
  const ctx = await world();
  await connectGithub();
  const text = await ask(ctx, KEY);
  expect(text).toStartWith("GitHub is connected and you have its tools (");
  expect(text).toContain("use them, not a key.");
  expect(await f.db.select().from(schema.secretRequests)).toEqual([]);
  for (const name of ["GITHUB_TOKEN", "GITHUB_PAT", "GITHUB_PERSONAL_ACCESS_TOKEN"]) {
    expect(await ask(ctx, { ...KEY, name })).toStartWith("GitHub is connected");
  }
});

test("a variable that says nothing is read by its purpose, a password by its site", async () => {
  const ctx = await world();
  await connectGithub();
  expect(await ask(ctx, { ...KEY, name: "API_KEY" })).toStartWith("GitHub is connected");
  expect(await ask(ctx, { ...KEY, name: "ACCOUNT_LOGIN", site: "https://github.com/login" })).toStartWith("GitHub is");
  // The purpose only speaks for a variable that says nothing.
  expect(await ask(ctx, { ...KEY, name: "NPM_TOKEN", purpose: "Publish from GitHub Actions" })).toBe(CARD);
});

test("a connection the agent lacks: says so and names the card that gives it", async () => {
  const ctx = await world();
  const github = await connectGithub();
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, github.id));
  const text = await ask(ctx, KEY);
  expect(text).toStartWith("GitHub is connected in this workspace but not given to you");
  expect(text).toContain(`request_permission (permission "connector:${github.id}")`);
});

test("some of a connection: its tools, and that an admin gives the rest", async () => {
  const ctx = await world();
  const github = await connectGithub();
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, github.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: github.id, scope: "github:pr.read" }]);
  const text = await ask(ctx, KEY);
  expect(text).toStartWith("GitHub is connected and you have its tools (");
  expect(text).toContain("If you need what you lack (");
  expect(text).toContain("an admin gives it on your page");
});

test("not connected: the connect card when the agent has it, else how an admin connects it", async () => {
  const offered = await world({ offer: true });
  expect(await ask(offered, KEY)).toStartWith(
    `GitHub isn't connected in this workspace: offer it with offer_connect_app`,
  );
  await f.close();
  const plain = await world();
  const text = await ask(plain, { ...KEY, name: "LINEAR_API_KEY", purpose: "Read issues" });
  expect(text).toContain("Settings › Connectors and MCPs › Add connector › Linear");
  expect(text).toContain("Tell the person this instead of asking for a key.");
});

test("a person's own word still gets a key; words nobody wrote don't", async () => {
  const ctx = await world();
  await connectGithub();
  const body = "Usa este   token, eu colo aqui";
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  const wrong = await ask(ctx, { ...KEY, person_said: "use a key, I said so" });
  expect(wrong).toStartWith("`person_said` isn't what a person wrote here. GitHub is connected");
  expect(await ask(ctx, { ...KEY, person_said: "usa este token" })).toBe(CARD);
});

test("the agent's words aren't a person's", async () => {
  const ctx = await world();
  await connectGithub();
  await f.db.insert(schema.messages).values({
    orgId: f.org.id,
    channelId: f.general.id,
    authorType: "agent",
    authorAgentId: f.agent.id,
    body: "o humano mandou usar um token",
  });
  expect(await ask(ctx, { ...KEY, person_said: "mandou usar um token" })).toStartWith("`person_said`");
});

test("a service with no connector, a one-time code and what isn't an access key go as today", async () => {
  const ctx = await world();
  await connectGithub();
  expect(await ask(ctx, { ...KEY, name: "NPM_TOKEN", purpose: "Publish the package" })).toBe(CARD);
  expect(await ask(ctx, { ...KEY, name: "GITHUB_WEBHOOK_SECRET" })).toBe(CARD);
  expect(await ask(ctx, { ...KEY, name: "GITHUB_REPO" })).toBe(CARD);
  const code = await ask(ctx, {
    ...KEY,
    name: "GITHUB_CODE",
    site: "https://github.com/login",
    code: { digits: 6 },
  });
  expect(code).toBe(CARD);
});

test("a key that only looks like a connected service's goes as today", async () => {
  const ctx = await world();
  await connectGithub();
  const names = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_CLIENT_SECRET", "SUPABASE_ANON_KEY"];
  for (const name of [...names, "STRIPE_PUBLISHABLE_KEY", "DATABASE_PASSWORD", "POSTGRES_PASSWORD"]) {
    expect(await ask(ctx, { ...KEY, name })).toBe(CARD);
  }
  // Only the gh CLI's own variables are GitHub by name; any other GH_ name goes by its purpose.
  expect(await ask(ctx, { ...KEY, name: "GH_API_KEY", purpose: "Candidates in Greenhouse" })).toBe(CARD);
  expect(await ask(ctx, { ...KEY, name: "GH_API_KEY" })).toStartWith("GitHub is connected");
});

test("a project's own file takes its keys: they are the app's, not the agent's access", async () => {
  const ctx = await world();
  await connectGithub();
  expect(await ask(ctx, { ...KEY, name: "GITHUB_TOKEN", target: "file", path: ".env" })).toBe(CARD);
});

test("a customer's site on a service's domain isn't the service", async () => {
  const ctx = await world();
  await connectGithub();
  const login = { ...KEY, name: "ACCOUNT_LOGIN" };
  expect(await ask(ctx, { ...login, site: "https://acme.github.io/login" })).toBe(CARD);
  expect(await ask(ctx, { ...login, site: "https://shop.vercel.app/login" })).toBe(CARD);
  expect(await ask(ctx, { ...login, site: "https://www.github.com/login" })).toStartWith("GitHub is connected");
});

test("a service this server can't connect goes as today", async () => {
  const ctx = await world();
  // Its vendor hasn't approved agentes.chat yet (`soon`): a key is the way in.
  expect(await ask(ctx, { ...KEY, name: "ASANA_TOKEN", purpose: "Read the tasks" })).toBe(CARD);
});

test("without a catalog nothing is decided", async () => {
  const ctx = await world({ catalog: false });
  expect(await ask(ctx, KEY)).toBe(CARD);
});

test("a key the agent was given is replaced by its card, as long as it holds it", async () => {
  const ctx = await world();
  await connectGithub();
  const held = {
    orgId: f.org.id,
    runId: ctx.runId,
    agentId: f.agent.id,
    channelId: f.general.id,
    toolUseId: "tu_given",
    requestedForUserId: f.owner.id,
    name: KEY.name,
    purpose: KEY.purpose,
    targetKind: "env" as const,
    publicKey: "fixture",
    status: "delivered" as const,
    deliveredAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  const [row] = await f.db.insert(schema.secretRequests).values(held).returning();
  // Past the connector's answer: the tool's own rule for a key this run was given.
  expect(await ask(ctx, KEY)).toStartWith("GH_TOKEN was already delivered");
  await f.db
    .update(schema.secretRequests)
    .set({ removedAt: new Date() })
    .where(eq(schema.secretRequests.id, row?.id ?? ""));
  expect(await ask(ctx, KEY)).toStartWith("GitHub is connected");
});

test("a key of that name in the Vault keeps its way too", async () => {
  const ctx = await world();
  await connectGithub();
  await f.db.insert(schema.vaultItems).values({ orgId: f.org.id, kind: "key", title: "Deploy", keyName: KEY.name });
  expect(await ask(ctx, KEY)).toBe(CARD);
});
