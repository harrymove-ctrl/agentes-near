import { afterEach, describe, expect, test } from "bun:test";
import {
  ComposioActionError,
  type ComposioTool,
  createFakeComposioClient,
  createFakeMailConnector,
  FAKE_COMPOSIO_SIGNATURE,
  FileTooLargeError,
  fakeMailAuthError,
  MailError,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  ARTIFACT_LIMITS,
  acceptCustomSuggestion,
  actionLevel,
  ConflictError,
  type CustomDeps,
  classifyByRules,
  completeOAuth,
  composioMcpTool,
  composioToolkitUrl,
  composioToolName,
  composioUsageOf,
  connectCustomServer,
  connectorListing,
  createConnectorToolSource,
  createToolGateway,
  ForbiddenError,
  handleComposioWebhook,
  keepComposioFiles,
  MCP_PRESETS,
  mcpPreset,
  meterComposio,
  missingConnectors,
  openEnded,
  postPersonMessage,
  reconcileComposioConnectors,
  revokeConnection,
  saveCustomTools,
  syncCustomTools,
  type ToolContext,
  ValidationError,
  withComposio,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const DRIVE = composioToolkitUrl("googledrive");
const VERSION = mcpPreset("drive")?.composio?.version ?? "";
const WHY = "The client asked for the report in the shared folder: this gives them read access to it.";

const tool = (slug: string, tags: string[] = []): ComposioTool => ({
  slug,
  description: `${slug} (fake)`,
  inputSchema: { type: "object", properties: { q: { type: "string" }, folder: { type: "string" } } },
  tags,
});

/** The fixture plus a fake Composio with Drive's tools, metered (`cap` per month), and deps wired as the server does. */
async function world(options: { cap?: number } = {}) {
  f = await setup();
  const fake = createFakeComposioClient({ beforeToolCall: meterComposio({ db: f.db, cap: options.cap ?? 0 }) });
  fake.addTools("googledrive", VERSION, [
    tool("GOOGLEDRIVE_FIND_FILE", ["readOnlyHint"]),
    tool("GOOGLEDRIVE_GET_FILE_METADATA", ["readOnlyHint"]),
    tool("GOOGLEDRIVE_DOWNLOAD_FILE", ["readOnlyHint"]),
    tool("GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE", ["readOnlyHint"]),
    tool("GOOGLEDRIVE_CREATE_FILE_FROM_TEXT"),
    tool("GOOGLEDRIVE_CREATE_FOLDER"),
    tool("GOOGLEDRIVE_MOVE_FILE"),
    tool("GOOGLEDRIVE_CREATE_COMMENT"),
    // It shares: it asks whatever Composio says (the entry's `ask`).
    tool("GOOGLEDRIVE_CREATE_PERMISSION", ["readOnlyHint"]),
    // Not one of the entry's actions: never listed.
    tool("GOOGLEDRIVE_EMPTY_TRASH", ["destructiveHint"]),
  ]);
  const signedIn = { email: "ana@acme.com" };
  fake.answer("GOOGLEDRIVE_GET_ABOUT", () => ({ user: { emailAddress: signedIn.email, displayName: "Ana" } }));
  const composio = { client: fake.client };
  const deps: CustomDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async (host) => (host.endsWith(".corp") ? ["10.0.0.5"] : ["93.184.216.34"]),
    connect: withComposio(async () => {
      throw new Error("no MCP server in this test");
    }, composio),
    composio,
    composioPollMs: 0,
  };
  /** Connects Drive as `actor` signed in to `email` at Composio, as the callback finishes it. */
  const connect = async (email: string, options: { actor?: string; connectionId?: string } = {}) => {
    const actor = options.actor ?? f.owner.id;
    const started = await connectCustomServer(deps, actor, f.org.id, {
      serverUrl: DRIVE,
      returnTo: "/org/x/settings/connectors",
      connectionId: options.connectionId,
    });
    if (started.status !== "oauth") throw new Error(`expected oauth, got ${started.status}`);
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    const code = fake.state.links.at(-1)?.connectedAccountId ?? "";
    signedIn.email = email;
    fake.activate(code, "", null);
    const done = await completeOAuth(deps, { id: actor }, { state, code });
    // What the routes do next (`afterConnected`): its tools read, our classification applied.
    await syncCustomTools(deps, done.connection);
    await acceptCustomSuggestion(deps, actor, f.org.id, done.connection.id);
    return { ...done, code };
  };
  return { fake, composio, deps, connect, signedIn };
}

async function runOf(fx: Fixture): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "organize a pasta do cliente",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

let seq = 0;
const call = (gateway: ReturnType<typeof createToolGateway>, ctx: ToolContext, name: string, input: object = {}) =>
  gateway.invoke(ctx, { toolUseId: `call-${++seq}`, name, input: input as Record<string, unknown> });

describe("the entries", () => {
  test("22 services, each once: explicit actions under one prefix, names that never collide, no meta tool", () => {
    const ways = MCP_PRESETS.filter((p) => p.composio);
    expect(ways.map((p) => p.id).sort()).toEqual(
      [
        "asana",
        "drive",
        "dropbox",
        "facebook",
        "figma",
        "google-calendar",
        "google-docs",
        "google-sheets",
        "hubspot",
        "instagram",
        "intercom",
        "linkedin",
        "microsoft-teams",
        "onedrive",
        "pinterest",
        "reddit",
        "salesforce",
        "slack",
        "square",
        "whatsapp",
        "youtube",
        "zendesk",
      ].sort(),
    );
    for (const p of ways) {
      const way = p.composio;
      if (!way) continue;
      const prefix = `${way.prefix ?? way.toolkit.toUpperCase()}_`;
      expect([p.id, way.actions.length >= 8 && way.actions.length <= 20]).toEqual([p.id, true]);
      for (const action of way.actions) {
        expect([action, action.startsWith(prefix)]).toEqual([action, true]);
        expect([action, action.startsWith("COMPOSIO_") || openEnded(action)]).toEqual([action, false]);
      }
      const names = way.actions.map((a) => composioToolName(way, a));
      expect([p.id, new Set(names).size]).toEqual([p.id, names.length]);
      for (const asked of way.ask ?? []) expect(way.actions).toContain(asked);
      expect(way.version).toMatch(/^\d{8}_\d{2}$/);
    }
    // GitHub never goes through Composio: its actions would bypass the agent's repository list.
    expect(ways.some((p) => p.composio?.toolkit === "github")).toBe(false);
    expect(composioToolName({ toolkit: "googledrive" }, "GOOGLEDRIVE_FIND_FILE")).toBe("find_file");
  });

  test("social networks: posts and comments go out on their own, deletes, sends, moderation and board changes ask", () => {
    const social = ["instagram", "facebook", "linkedin", "youtube", "pinterest", "reddit", "whatsapp"];
    const asking = Object.fromEntries(
      social.map((id) => {
        const way = mcpPreset(id)?.composio;
        if (!way) return [id, null];
        return [id, way.actions.filter((a) => composioMcpTool(way, tool(a)).destructiveHint === true)];
      }),
    );
    expect(asking).toEqual({
      instagram: ["INSTAGRAM_SEND_TEXT_MESSAGE"],
      facebook: ["FACEBOOK_DELETE_POST", "FACEBOOK_DELETE_COMMENT"],
      linkedin: ["LINKEDIN_DELETE_POST"],
      youtube: ["YOUTUBE_CREATE_COMMENT_REPLY", "YOUTUBE_SET_COMMENT_MODERATION_STATUS", "YOUTUBE_DELETE_COMMENT"],
      pinterest: ["PINTEREST_UPDATE_BOARD", "PINTEREST_DELETE_PIN", "PINTEREST_DELETE_BOARD"],
      reddit: ["REDDIT_DELETE_REDDIT_POST", "REDDIT_DELETE_REDDIT_COMMENT"],
      whatsapp: [
        "WHATSAPP_SEND_MESSAGE",
        "WHATSAPP_SEND_TEMPLATE_MESSAGE",
        "WHATSAPP_SEND_MEDIA",
        "WHATSAPP_SEND_INTERACTIVE_BUTTONS",
        "WHATSAPP_SEND_INTERACTIVE_LIST",
        "WHATSAPP_SEND_LOCATION",
      ],
    });
    // What Composio's own apps can't do stays out: Instagram's comments, Reddit's inbox and votes.
    const listed = (id: string, word: RegExp) => mcpPreset(id)?.composio?.actions.filter((a) => word.test(a));
    expect(listed("instagram", /COMMENT|MENTION|TAGS/)).toEqual([]);
    expect(listed("reddit", /INBOX|PRIVATE_MESSAGE|VOTE|WIKI|MODERAT/)).toEqual([]);
    expect(social.map((id) => [id, mcpPreset(id)?.category])).toEqual(social.map((id) => [id, "social"]));
  });

  test("Instagram's publish step and a LinkedIn link share are posts: plain writes, while any other publish or share asks", () => {
    expect(
      [
        "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
        "LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE",
        "FACEBOOK_PUBLISH_SCHEDULED_POST",
        "LINKEDIN_PUBLISH_POST",
        "WEBFLOW_PUBLISH_SITE",
        "BOX_SHARE_FILE",
      ].map((slug) => [slug, actionLevel(slug)]),
    ).toEqual([
      ["INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", "write"],
      ["LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE", "write"],
      ["FACEBOOK_PUBLISH_SCHEDULED_POST", "sensitive"],
      ["LINKEDIN_PUBLISH_POST", "sensitive"],
      ["WEBFLOW_PUBLISH_SITE", "sensitive"],
      ["BOX_SHARE_FILE", "sensitive"],
    ]);
    // Only through Composio: another server's tool of the same name keeps the rule of its words.
    expect(classifyByRules({ name: "post_ig_user_media_publish" })).toMatchObject({
      level: "approval",
      sensitive: true,
    });
  });

  test("one way per service: the vendor's server, else Composio here, else Em breve, else unavailable", () => {
    const entry = (list: ReturnType<typeof connectorListing>, id: string) => list.find((e) => e.id === id);
    const without = connectorListing({ oauthApps: {} });
    expect(entry(without, "drive")).toMatchObject({
      kind: "remote_mcp",
      via: "composio",
      available: false,
      soon: false,
      serverUrl: DRIVE,
    });
    expect(entry(without, "asana")).toMatchObject({
      available: false,
      soon: true,
      serverUrl: "https://mcp.asana.com/mcp",
    });
    expect(entry(without, "asana")?.via).toBeUndefined();
    expect(entry(without, "linear")).toMatchObject({ available: true, serverUrl: "https://mcp.linear.app/mcp" });

    const withKey = connectorListing({ oauthApps: {}, composio: { client: createFakeComposioClient().client } });
    expect(entry(withKey, "drive")).toMatchObject({ available: true, via: "composio", auth: ["oauth"] });
    expect(entry(withKey, "asana")).toMatchObject({
      available: true,
      soon: false,
      via: "composio",
      serverUrl: composioToolkitUrl("asana"),
    });
    // Still Em breve: Composio has no toolkit for Mercado Pago, and would connect Vercel only with a pasted key.
    for (const id of ["mercadopago", "vercel"]) {
      expect(entry(withKey, id)).toMatchObject({ available: false, soon: true });
      expect(entry(withKey, id)?.via).toBeUndefined();
    }
    // Each service once, and every entry has its mark.
    expect(new Set(withKey.map((e) => e.id)).size).toBe(withKey.length);
    expect(withKey.filter((e) => !e.iconUrl).map((e) => e.id)).toEqual([]);
  });
});

describe("connecting through Composio", () => {
  test("a Connect Link with our state; only the person who started it, with the link's own account, finishes it", async () => {
    const w = await world();
    const started = await connectCustomServer(w.deps, f.owner.id, f.org.id, { serverUrl: DRIVE, returnTo: "/x" });
    if (started.status !== "oauth") throw new Error("expected oauth");
    const url = new URL(started.authorizeUrl);
    const state = url.searchParams.get("state") ?? "";
    expect(`${url.origin}${url.pathname}`).toBe("https://composio.example/connect/ca_1");
    expect(w.fake.state.links).toEqual([
      {
        toolkit: "googledrive",
        userId: `org_${f.org.id}`,
        callbackUrl: `https://chat.example.com/api/app/connectors/oauth/callback?state=${state}`,
        connectedAccountId: "ca_1",
      },
    ]);
    const [row] = await f.db.select().from(schema.oauthStates);
    expect(row).toMatchObject({ composioAccountId: "ca_1", verifierCiphertext: null, returnTo: "/x" });

    // Someone else signed in where the link was opened: their session isn't the one that started it.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(completeOAuth(w.deps, { id: bia.id }, { state, code: "ca_1" })).rejects.toBeInstanceOf(ForbiddenError);
    // Not finished at Composio: read again for a while, then refused.
    await expect(completeOAuth(w.deps, { id: f.owner.id }, { state, code: "ca_1" })).rejects.toMatchObject({
      code: "connector.unfinished",
    });
    expect(await f.db.select().from(schema.connectorConnections)).toEqual([]);
    // Nothing can finish it now: Composio forgets it, before it turns active with a sign-in nobody holds.
    expect(w.fake.state.grantsKept).toEqual(["ca_1"]);

    // Another account than the link's: refused, and the state is used up.
    const again = await connectCustomServer(w.deps, f.owner.id, f.org.id, { serverUrl: DRIVE });
    if (again.status !== "oauth") throw new Error("expected oauth");
    const second = new URL(again.authorizeUrl).searchParams.get("state") ?? "";
    await expect(completeOAuth(w.deps, { id: f.owner.id }, { state: second, code: "ca_1" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(completeOAuth(w.deps, { id: f.owner.id }, { state: second, code: "ca_2" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("Instagram's publish step is stored as a write an admin can narrow, even when Composio tags it destructive", async () => {
    const w = await world();
    const way = mcpPreset("instagram")?.composio;
    if (!way) throw new Error("no Instagram way");
    w.fake.addTools("instagram", way.version, [
      tool("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", ["destructiveHint"]),
      tool("INSTAGRAM_SEND_TEXT_MESSAGE"),
    ]);
    const started = await connectCustomServer(w.deps, f.owner.id, f.org.id, {
      serverUrl: composioToolkitUrl("instagram"),
      returnTo: "/x",
    });
    if (started.status !== "oauth") throw new Error("expected oauth");
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    const code = w.fake.state.links.at(-1)?.connectedAccountId ?? "";
    w.fake.activate(code, "", null);
    const { connection } = await completeOAuth(w.deps, { id: f.owner.id }, { state, code });
    await syncCustomTools(w.deps, connection);
    await acceptCustomSuggestion(w.deps, f.owner.id, f.org.id, connection.id);
    const tools = await f.db
      .select()
      .from(schema.customTools)
      .where(eq(schema.customTools.connectionId, connection.id));
    expect(Object.fromEntries(tools.map((t) => [t.name, [t.access, t.sensitive]]))).toEqual({
      post_ig_user_media_publish: ["write", false],
      send_text_message: ["approval", true],
    });
  });

  test("stored with Composio's account and no secret, named by its Google address, every agent's, its tools ours", async () => {
    const w = await world();
    const { connection, outcome } = await w.connect("ana@acme.com");
    expect(outcome).toBe("connected");
    expect(connection).toMatchObject({
      serverUrl: DRIVE,
      label: "Google Drive (ana@acme.com)",
      accountId: "ana@acme.com",
      composioAccountId: "ca_1",
      secretCiphertext: null,
      toolPrefix: "google_drive",
      status: "active",
    });
    expect(
      (await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, connection.id))).map(
        (g) => g.scope,
      ),
    ).toEqual(["connector:*"]);
    const tools = await f.db
      .select()
      .from(schema.customTools)
      .where(eq(schema.customTools.connectionId, connection.id));
    const level = Object.fromEntries(tools.map((t) => [t.name, [t.access, t.sensitive]]));
    expect(Object.keys(level).sort()).toEqual(
      (mcpPreset("drive")?.composio?.actions ?? []).map((a) => composioToolName({ toolkit: "googledrive" }, a)).sort(),
    );
    expect(level.find_file).toEqual(["read", false]);
    expect(level.create_folder).toEqual(["write", false]);
    // Composio said it only reads; it shares, so it asks.
    expect(level.create_permission).toEqual(["approval", true]);
    // Tools are listed once per pinned version, whatever the accounts.
    expect(w.fake.state.toolLists).toEqual([`googledrive@${VERSION}`]);
  });

  test("another account is a new row, every agent's too; the same one only swaps Composio's account; Reconectar keeps it", async () => {
    const w = await world();
    const ana = await w.connect("ana@acme.com");
    const bob = await w.connect("bob@acme.com");
    expect(bob.outcome).toBe("connected");
    expect(bob.connection).toMatchObject({ label: "Google Drive (bob@acme.com)", toolPrefix: "google_drive_2" });
    const given = await f.db
      .select()
      .from(schema.agentScopes)
      .where(eq(schema.agentScopes.connectionId, bob.connection.id));
    expect([...new Set(given.map((g) => g.scope))]).toEqual(["connector:*"]);

    const same = await w.connect("ana@acme.com");
    expect(same.outcome).toBe("same_account");
    expect(same.connection).toMatchObject({ id: ana.connection.id, composioAccountId: same.code });
    // The replaced account goes away at Composio, its grant left alone.
    expect(w.fake.state.grantsKept).toEqual([ana.code]);
    expect(w.fake.state.revokedAccounts).toEqual([]);

    // Reconectar on Bob's row signed in to someone else: refused, and that sign-in goes away.
    await expect(w.connect("carol@acme.com", { connectionId: bob.connection.id })).rejects.toMatchObject({
      code: "connector.other_account",
    });
    const refused = w.fake.state.links.at(-1)?.connectedAccountId ?? "";
    expect(w.fake.state.grantsKept).toContain(refused);
    const back = await w.connect("bob@acme.com", { connectionId: bob.connection.id });
    expect(back.outcome).toBe("reconnected");
    expect(back.connection).toMatchObject({ id: bob.connection.id, toolPrefix: "google_drive_2", status: "active" });
    expect(w.fake.state.grantsKept).toContain(bob.code);
  });

  test("a service this server can't connect is refused before any link: a toolkit no entry has, or no Composio", async () => {
    const w = await world();
    // X has no entry: Composio would sign in to it only with an X app of ours.
    const x = composioToolkitUrl("twitter");
    await expect(connectCustomServer(w.deps, f.owner.id, f.org.id, { serverUrl: x })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const off = { ...w.deps, composio: null };
    await expect(connectCustomServer(off, f.owner.id, f.org.id, { serverUrl: DRIVE })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(w.fake.state.links).toEqual([]);
  });
});

describe("tools through Composio", () => {
  test("the pinned version for the workspace's user; writes audited; sharing asks; Aprovar sempre only for a level", async () => {
    const w = await world();
    const { connection, code } = await w.connect("ana@acme.com");
    const gateway = createToolGateway({
      sources: [createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps })],
    });
    const ctx = await runOf(f);
    expect((await gateway.list(ctx)).map((t) => t.name)).toContain("google_drive_find_file");
    // Composio pins its tools by toolkit version: ours never do (ADR 0117).
    expect(await f.db.select().from(schema.connectorToolPins)).toEqual([]);

    w.fake.answer("GOOGLEDRIVE_FIND_FILE", { files: [{ id: "f1", name: "Relatório" }] });
    const found = await call(gateway, ctx, "google_drive_find_file", { q: "relatório" });
    expect(found.type).toBe("result");
    if (found.type === "result") expect(found.output.content).toContain("Relatório");
    expect(w.fake.state.executions.at(-1)).toEqual({
      slug: "GOOGLEDRIVE_FIND_FILE",
      account: { connectedAccountId: code, userId: `org_${f.org.id}`, toolkit: "googledrive" },
      args: { q: "relatório" },
      version: VERSION,
    });

    expect((await call(gateway, ctx, "google_drive_create_folder", { folder: "Clientes" })).type).toBe("result");
    const changed = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "connector.tool_changed"));
    expect(changed.map((r) => r.details.tool)).toEqual(["create_folder"]);

    const share = await call(gateway, ctx, "google_drive_create_permission", { q: "f1", why: WHY });
    if (share.type !== "approval") throw new Error(`expected an approval, got ${share.type}`);
    expect(share.approval.title).toBe("Google Drive (ana@acme.com): Create permission");
    expect(share.approval.approveAlways).toBeNull();

    // An admin made a write ask: that one may be approved for good, by its own name.
    await saveCustomTools(w.deps, f.owner.id, f.org.id, connection.id, {
      label: connection.label,
      tools: [{ name: "create_folder", access: "approval", label: "Create folder" }],
    });
    const asked = await call(gateway, ctx, "google_drive_create_folder", { folder: "Notas", why: WHY });
    if (asked.type !== "approval") throw new Error(`expected an approval, got ${asked.type}`);
    expect(asked.approval.approveAlways).toEqual({ tool: "create_folder", actions: [] });
  });

  test("an action our rules make ask asks at once, on a connection whose tools were stored before they did", async () => {
    const w = await world();
    const { connection } = await w.connect("ana@acme.com");
    // As an older sync stored it, before the entry's `ask` named it.
    await f.db
      .update(schema.customTools)
      .set({ access: "write", sensitive: false })
      .where(and(eq(schema.customTools.connectionId, connection.id), eq(schema.customTools.name, "create_permission")));
    const gateway = createToolGateway({
      sources: [createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps })],
    });
    const share = await call(gateway, await runOf(f), "google_drive_create_permission", { q: "f1", why: WHY });
    if (share.type !== "approval") throw new Error(`expected an approval, got ${share.type}`);
    expect(share.approval.approveAlways).toBeNull();
    expect(w.fake.state.executions.map((e) => e.slug)).not.toContain("GOOGLEDRIVE_CREATE_PERMISSION");
  });

  test("a file in the answer is downloaded at once: text comes back as text, the rest goes to the Drive; no link", async () => {
    const w = await world();
    await w.connect("ana@acme.com");
    const gateway = createToolGateway({
      sources: [createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps })],
    });
    const ctx = await runOf(f);
    w.fake.state.files.set("https://files.example/r1", new Uint8Array([37, 80, 68, 70]));
    w.fake.state.files.set("https://files.example/n1", new TextEncoder().encode("ata da reunião"));
    w.fake.answer("GOOGLEDRIVE_DOWNLOAD_FILE", {
      downloaded_file_content: { name: "report.pdf", mimetype: "application/pdf", s3url: "https://files.example/r1" },
    });
    w.fake.answer("GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE", {
      file: { name: "notes.txt", mimetype: "text/plain", s3url: "https://files.example/n1" },
    });
    const pdf = await call(gateway, ctx, "google_drive_download_file", { q: "f1" });
    if (pdf.type !== "result") throw new Error(`expected a result, got ${pdf.type}`);
    expect(pdf.output.content).not.toContain("files.example");
    const [saved] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.kind, "file"));
    expect(saved).toMatchObject({ title: "report.pdf", untrusted: true });
    expect(pdf.output.content).toContain(`file ${saved?.id} (untrusted content). It is in the shared Drive`);
    const text = await call(gateway, ctx, "google_drive_export_google_workspace_file", { q: "f2" });
    if (text.type !== "result") throw new Error(`expected a result, got ${text.type}`);
    expect(text.output.content).toContain("ata da reunião");
    expect(text.output.content).not.toContain("files.example");
    // A link into our own network is never fetched, nor shown.
    w.fake.state.files.set("https://intranet.corp/x", new Uint8Array([1]));
    w.fake.answer("GOOGLEDRIVE_GET_FILE_METADATA", { file: { name: "x.pdf", s3url: "https://intranet.corp/x" } });
    const inside = await call(gateway, ctx, "google_drive_get_file_metadata", { q: "f3" });
    if (inside.type !== "result") throw new Error(`expected a result, got ${inside.type}`);
    expect(inside.output.content).toContain("couldn't be downloaded");
    expect(inside.output.content).not.toContain("intranet.corp");
    expect(w.fake.state.fetched).toEqual(["https://files.example/r1", "https://files.example/n1"]);
  });

  test("a link anywhere in a file, under any key, is fetched only off our own network", async () => {
    const w = await world();
    await w.connect("ana@acme.com");
    const gateway = createToolGateway({
      sources: [createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps })],
    });
    const ctx = await runOf(f);
    w.fake.state.files.set("https://files.example/ok.txt", new TextEncoder().encode("public"));
    for (const path of ["a", "b", "c"]) {
      w.fake.state.files.set(`https://intranet.corp/${path}.txt`, new TextEncoder().encode("internal secret"));
    }
    for (const data of [
      { s3url: "https://files.example/ok.txt", file: { url: "https://intranet.corp/a.txt" } },
      { name: "b.txt", base64: "aGk=", file: { s3url: "https://intranet.corp/b.txt" } },
      { s3url: "https://files.example/ok.txt", response_data: { url: "https://intranet.corp/c.txt" } },
    ]) {
      w.fake.answer("GOOGLEDRIVE_DOWNLOAD_FILE", data);
      const out = await call(gateway, ctx, "google_drive_download_file", { q: "f1" });
      if (out.type !== "result") throw new Error(`expected a result, got ${out.type}`);
      expect(out.output.content).toContain("couldn't be downloaded");
      expect(out.output.content).not.toContain("internal secret");
    }
    expect(w.fake.state.fetched).toEqual([]);
  });

  test("a file past what the Drive keeps is refused without being read", async () => {
    f = await setup();
    const asked: [string, number | undefined][] = [];
    const kept = await keepComposioFiles(
      {
        client: {
          fetchFile: async (url, maxBytes) => {
            asked.push([url, maxBytes]);
            throw new FileTooLargeError(maxBytes ?? 0);
          },
        },
        resolveHost: async () => ["93.184.216.34"],
      },
      await runOf(f),
      { content: "", isError: false, data: { file: { name: "backup.zip", s3url: "https://files.example/big" } } },
      "Google Drive",
    );
    expect(asked).toEqual([["https://files.example/big", ARTIFACT_LIMITS.fileBytes]]);
    expect(JSON.parse(kept)).toEqual({
      file: { file: "backup.zip", error: "The file is over 50 MB, too large to keep." },
    });
  });

  test("an action that fails answers in the service's own words, even ones that read like an outage", async () => {
    const w = await world();
    await w.connect("ana@acme.com");
    const gateway = createToolGateway({
      sources: [createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps })],
    });
    const ctx = await runOf(f);
    const said = "Composio GOOGLEDRIVE_FIND_FILE failed: The user's Drive storage quota has been exceeded.";
    w.fake.answer("GOOGLEDRIVE_FIND_FILE", new ComposioActionError(said, true));
    const failed = await call(gateway, ctx, "google_drive_find_file", { q: "x" });
    if (failed.type !== "result") throw new Error(`expected a result, got ${failed.type}`);
    expect(failed.output).toMatchObject({ isError: true, data: { code: "composio.action_failed" } });
    expect(failed.output.content).toContain(said);
    // Composio itself answered 503.
    w.fake.answer("GOOGLEDRIVE_FIND_FILE", new MailError("Composio POST /tools/execute failed (503): down", true));
    const busy = await call(gateway, ctx, "google_drive_find_file", { q: "x" });
    if (busy.type !== "result") throw new Error(`expected a result, got ${busy.type}`);
    expect(busy.output).toMatchObject({ isError: true, data: { code: "composio.busy" } });
  });

  test("an account that stops working leaves the agents' lists until Composio says it works again", async () => {
    const w = await world();
    const { connection, code } = await w.connect("ana@acme.com");
    const source = createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps });
    const gateway = createToolGateway({ sources: [source] });
    const ctx = await runOf(f);
    w.fake.answer("GOOGLEDRIVE_FIND_FILE", fakeMailAuthError());
    const failed = await call(gateway, ctx, "google_drive_find_file", { q: "x" });
    if (failed.type !== "result") throw new Error(`expected a result, got ${failed.type}`);
    expect(failed.output).toMatchObject({ isError: true, data: { code: "connector.needs_reconnect" } });
    const row = async () =>
      (
        await f.db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, connection.id))
      )[0];
    expect(await row()).toMatchObject({ status: "needs_reconnect" });
    expect(await source.tools(ctx)).toEqual([]);
    const missing = await missingConnectors(
      f.db,
      f.org.id,
      { oauthApps: {}, composio: w.composio },
      {
        usable: [],
        listed: [],
      },
    );
    expect(missing.find((m) => m.label === "Google Drive")?.state).toBe("needs_reconnect");

    // A wrong mark heals itself: Composio still says the account works.
    expect((await reconcileComposioConnectors(f.db, w.fake.client)).healed).toBe(1);
    expect(await row()).toMatchObject({ status: "active", lastError: null });

    // Composio's webhook says it expired.
    const mail = { composio: { client: w.fake.client, connector: createFakeMailConnector().connector }, imap: null };
    await handleComposioWebhook(
      { db: f.db, mail },
      new Headers({ "webhook-signature": FAKE_COMPOSIO_SIGNATURE }),
      JSON.stringify({ type: "account.expired", connectedAccountId: code }),
    );
    expect(await row()).toMatchObject({ status: "needs_reconnect", lastError: "composio_expired" });
  });

  test("calls count per workspace and month before they are made: at the cap nothing reaches Composio, admins hear it once", async () => {
    const w = await world({ cap: 2 });
    // The account's address was read at connect: one call.
    await w.connect("ana@acme.com");
    const gateway = createToolGateway({
      sources: [createConnectorToolSource({ ...w.deps, artifacts: f.artifactDeps })],
    });
    const ctx = await runOf(f);
    expect((await call(gateway, ctx, "google_drive_find_file", { q: "a" })).type).toBe("result");
    const ran = w.fake.state.executions.length;
    for (const q of ["b", "c"]) {
      const refused = await call(gateway, ctx, "google_drive_find_file", { q });
      if (refused.type !== "result") throw new Error(`expected a result, got ${refused.type}`);
      expect(refused.output).toMatchObject({ isError: true, data: { code: "composio.monthly_limit" } });
      expect(refused.output.content).toContain("used its 2 Composio calls");
    }
    expect(w.fake.state.executions).toHaveLength(ran);
    const usage = await composioUsageOf(f.db, f.owner.id, f.org.id, 2);
    expect(usage).toMatchObject({ calls: 2, limit: 2 });
    expect(usage.month).toMatch(/^\d{4}-\d{2}$/);
    const notices = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "composio_limit")));
    expect(notices.map((n) => [n.userId, n.latest])).toEqual([[f.owner.id, { title: usage.month, calls: 2 }]]);
    // No cap: counted all the same.
    expect(await composioUsageOf(f.db, f.owner.id, f.org.id, 0)).toMatchObject({ calls: 2, limit: null });
  });

  test("disconnecting drops the account at Composio without revoking its grant", async () => {
    const w = await world();
    const { connection, code } = await w.connect("ana@acme.com");
    await revokeConnection(f.db, f.owner.id, f.org.id, connection.id, w.composio);
    expect(w.fake.state.deletedAccounts).toEqual([code]);
    expect(w.fake.state.grantsKept).toEqual([code]);
    expect(w.fake.state.revokedAccounts).toEqual([]);
  });
});
