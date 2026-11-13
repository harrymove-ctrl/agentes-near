/**
 * Real-environment smoke check: `bun run smoke [--desktop-agent <handle>]`
 * (reads `.env`). Never part of `bun test` (not a *.test.ts file, and it
 * talks to real services).
 *
 * Needs DATABASE_URL and AGENTES_SECRET, plus ANTHROPIC_API_KEY (used as the
 * throwaway org's own key) or PLATFORM_ANTHROPIC_API_KEY. Optional:
 * ANTHROPIC_WORKSPACE_ID / PLATFORM_ANTHROPIC_WORKSPACE_ID for keys that
 * aren't scoped to a workspace.
 *
 * Steps: migrate → throwaway user, org, credential, agent and channel → post
 * an @mention → run the real worker loop until the streamed reply is saved →
 * print the reply and its usage record → delete the throwaway org and user.
 * With `--desktop-agent <handle>` (or the agent's id), through the server
 * running at PUBLIC_URL: the agent's desktop (started by watching it, if it
 * wasn't running) watched until one framebuffer update, and its terminal's
 * `id -un`, which must not be root, or its refusal where sessions are screened
 * (`smoke-desktop.ts`). Without a model key, only that runs. With `--apps`, the
 * AI apps' endpoint at PUBLIC_URL (ADR 0119): its resource document and the exact
 * 401 challenge of `/mcp`, as an app sees them through every proxy in front.
 */
import { parseArgs } from "node:util";
import {
  channelTopic,
  createLogEmailSender,
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  createPostgresBlobStore,
  createPostgresSearchResolver,
  envPlatformCredentials,
} from "@agenteschat/adapters";
import { loadConfig } from "@agenteschat/config";
import { createDatabase, type Database, ensureMessagePartitions, eq, schema } from "@agenteschat/db";
import {
  APP_SCOPES,
  addChannelMember,
  appsUrls,
  createAgent,
  createCredential,
  createLocalKeyWrapper,
  createOrganization,
  drainOutbox,
  enableCaches,
  postPersonMessage,
} from "@agenteschat/engine";
import { createAnthropicProvider } from "@agenteschat/providers";
import { createAuth } from "../src/auth";
import { buildEngine } from "../src/engine";
import { createLogger } from "../src/logger";
import { checkDesktop, signInForDesktop } from "./smoke-desktop";

const args = parseArgs({
  args: process.argv.slice(2),
  options: { "desktop-agent": { type: "string" }, apps: { type: "boolean" } },
}).values;
const desktopAgent = args["desktop-agent"];
const config = loadConfig();
const orgKey = process.env.ANTHROPIC_API_KEY?.trim();
const orgWorkspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined;
const modelKey = Boolean(orgKey || config.PLATFORM_ANTHROPIC_API_KEY);
if (!modelKey && !desktopAgent && !args.apps) {
  console.error(
    "Set ANTHROPIC_API_KEY or PLATFORM_ANTHROPIC_API_KEY in .env, or check an agent's desktop only (--desktop-agent)",
  );
  process.exit(1);
}

const database = createDatabase({ url: config.DATABASE_URL, poolMax: 4 });
const started = Date.now();
const step = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

let orgId: string | undefined;
const userId = `smoke_${crypto.randomUUID().slice(0, 8)}`;
/** The throwaway org's agent answers an @mention through the real worker loop and model. */
async function modelSmoke(db: Database) {
  const keyWrapper = createLocalKeyWrapper(config.AGENTES_SECRET);
  const pubsub = createMemoryPubSub();
  const adapters = {
    search: createPostgresSearchResolver(db),
    pubsub,
    presence: createMemoryPresence(),
    rateLimiter: createMemoryRateLimiter(),
    keyWrapper,
    legacyKeyWrappers: [],
    email: createLogEmailSender(() => {}),
    platformBlobs: createPostgresBlobStore(db),
    platformCredentials: envPlatformCredentials({
      anthropic: { apiKey: config.PLATFORM_ANTHROPIC_API_KEY, workspaceId: config.PLATFORM_ANTHROPIC_WORKSPACE_ID },
    }),
  };
  enableCaches();
  let profile: unknown = null;
  const engine = buildEngine({
    onRunProfile: (p) => {
      profile = p;
    },
    db,
    config: { ...config, ROUTER_ENABLED: false },
    adapters,
    modelProviders: { anthropic: createAnthropicProvider() },
  });

  step("creating a throwaway org, user, agent and channel");
  await db.insert(schema.users).values({ id: userId, name: "Smoke", email: `${userId}@smoke.invalid` });
  const { organization, general } = await createOrganization(db, userId, {
    name: `smoke ${new Date().toISOString()}`,
    context: "This is an automated smoke test of agentes.chat.",
  });
  orgId = organization.id;
  const credential = orgKey
    ? await createCredential(db, keyWrapper, userId, orgId, {
        provider: "anthropic",
        label: "smoke",
        apiKey: orgKey,
        workspaceId: orgWorkspace,
      })
    : null;
  const agent = await createAgent(
    db,
    userId,
    orgId,
    {
      name: "Smoke",
      handle: "smoke",
      instructions: "Reply in one short sentence.",
      model: "claude-haiku-5-5",
      credentialId: credential?.id ?? null,
      monthlyBudgetNanoUsd: 50_000_000, // US$ 0.05
    },
    { model: "claude-haiku-5-5" },
  );
  await addChannelMember(db, userId, orgId, general.id, { agentId: agent.id });
  step(`using ${credential ? "the org's own key" : "the platform key"}${orgWorkspace ? " with a workspace id" : ""}`);

  let firstTypingAt = 0;
  const seen = new Map<string, number>();
  const postedAt = { t: 0 };
  pubsub.subscribe(channelTopic(general.id), (e: { type: string }) => {
    seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
    if (e.type === "agent.thinking" && !seen.has("thinking@")) {
      seen.set("thinking@", Date.now() - postedAt.t);
    }
    // Its words never go out live: the reply comes whole in its message.
    if (e.type === "agent.typing" && !firstTypingAt) firstTypingAt = Date.now();
  });
  postedAt.t = Date.now();
  await postPersonMessage({ db, pubsub }, userId, orgId, general.id, { body: "@smoke say hello to the team" });

  step("running workers (real model call)");
  const deadline = Date.now() + 120_000;
  let run: typeof schema.agentRuns.$inferSelect | undefined;
  while (Date.now() < deadline) {
    await drainOutbox(db, engine.handlers);
    [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, orgId));
    if (run && (run.status === "done" || run.status === "failed")) break;
    await Bun.sleep(500);
  }
  if (run?.status !== "done") throw new Error(`run did not finish: ${run?.status ?? "none"} ${run?.error ?? ""}`);

  const [reply] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, run.replyMessageId ?? ""));
  const usage = await db.select().from(schema.usageRecords).where(eq(schema.usageRecords.orgId, orgId));
  step("reply saved");
  console.log(
    JSON.stringify(
      {
        reply: reply?.body,
        postToThinkingMs: seen.get("thinking@") ?? null,
        postToFirstTypingMs: firstTypingAt ? firstTypingAt - postedAt.t : null,
        events: Object.fromEntries([...seen].filter(([k]) => !k.endsWith("@"))),
      },
      null,
      2,
    ),
  );
  console.log("run profile:", JSON.stringify(profile, null, 2));
  console.log(
    JSON.stringify(
      usage.map((u) => ({
        kind: u.kind,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: u.costNanoUsd / 1e9,
        partial: u.partial,
      })),
      null,
      2,
    ),
  );
}

/** AI apps (ADR 0119): what an MCP client reads first, through the proxies in front of PUBLIC_URL. */
async function appsSmoke() {
  const urls = appsUrls(config.PUBLIC_URL);
  const doc = (await (await fetch(urls.resourceMetadata)).json()) as { resource?: string };
  if (doc.resource !== urls.resource) throw new Error(`resource document says ${doc.resource}, not ${urls.resource}`);
  const res = await fetch(urls.resource, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const want = `Bearer resource_metadata="${urls.resourceMetadata}", scope="${APP_SCOPES.join(" ")}"`;
  if (res.status !== 401 || res.headers.get("www-authenticate") !== want)
    throw new Error(`/mcp answered ${res.status} with ${res.headers.get("www-authenticate")}, not 401 with ${want}`);
  step(`apps: ${urls.resource} answers its challenge`);
}

/** The agent's desktop and terminal through the server at PUBLIC_URL, as whoever may drive its computer. */
async function desktopSmoke(db: Database, agent: string) {
  const origin = new URL(config.PUBLIC_URL).origin;
  const auth = createAuth({ db, config, log: createLogger("error"), rateLimiter: createMemoryRateLimiter() });
  const session = await signInForDesktop({ db, auth, base: origin, origin }, agent);
  step(`desktop: @${session.handle} through ${origin}, signed in as ${session.person}`);
  try {
    await checkDesktop(session, step);
  } finally {
    await session.signOut();
  }
}

try {
  step("migrating");
  await database.migrate();
  await ensureMessagePartitions(database.db);
  if (modelKey) await modelSmoke(database.db);
  else step("model: skipped (no ANTHROPIC_API_KEY or PLATFORM_ANTHROPIC_API_KEY)");
  if (desktopAgent) await desktopSmoke(database.db, desktopAgent);
  if (args.apps) await appsSmoke();
  step("smoke ok");
} catch (error) {
  console.error("smoke FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    if (orgId) await database.db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await database.db.delete(schema.users).where(eq(schema.users.id, userId));
    if (modelKey) step("throwaway org and user deleted");
  } catch (error) {
    console.error("cleanup failed:", error instanceof Error ? error.message : error);
  }
  await database.close();
}
