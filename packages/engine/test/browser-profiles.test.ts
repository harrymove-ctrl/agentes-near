import { afterEach, expect, test } from "bun:test";
import { BROWSER_PROFILE_PROTOCOL, channelTopic, type MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  absorbBrowserCall,
  absorbToolData,
  browsersPrompt,
  createAgent,
  createBrowserHandoffToolSource,
  createBrowserProfile,
  createBrowserToolSource,
  createPermissionToolSource,
  deleteBrowserProfile,
  endProfileControl,
  ForbiddenError,
  grantScopes,
  listBrowserProfiles,
  type MachineCaller,
  type MachineStatus,
  missingPermissions,
  requestBrowserProfile,
  requireProfileDriver,
  requireProfileWatcher,
  setAgentBrowserProfile,
  setBrowserProfileAgents,
  startProfileControl,
  type ToolContext,
  type ToolSideEffects,
  takeProfileTurn,
  transitionRun,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as never;
});

/** A hub for one computer at the profiles protocol, answering every command with a page, recording each request. */
function fakeHub(state: { machineId: string; orgId: string }) {
  const calls: MachineRequest[] = [];
  const s = { status: {} as Partial<MachineStatus> };
  const hub: MachineCaller = {
    async status(id) {
      if (id !== state.machineId) return null;
      return {
        id,
        orgId: state.orgId,
        name: "Laptop",
        online: true,
        execAllowed: true,
        os: "linux",
        protocol: BROWSER_PROFILE_PROTOCOL,
        executors: { browser: { available: true, version: "0.39.1" } },
        paused: null,
        access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
        ...s.status,
      };
    },
    async call(_id, sent) {
      const request = sent as MachineRequest;
      calls.push(request);
      if (request.op === "browser.batch") {
        return {
          answers: request.commands.map(() => ({ success: true, data: { snapshot: '- button "Send" [ref=e1]' } })),
        } as never;
      }
      if (request.op === "browser.warm") return { started: true } as never;
      return { success: true, data: { snapshot: '- button "Send" [ref=e1]', url: "https://chat.example/" } } as never;
    },
  };
  return { hub, calls, s };
}

/** A run of `agentId` in #general, as the executor would make it. */
async function runOf(agentId: string): Promise<ToolContext> {
  const [msg] = await f.db
    .insert(schema.messages)
    .values({ orgId: f.org.id, channelId: f.general.id, authorType: "person", authorUserId: f.owner.id, body: "go" })
    .returning();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId: f.general.id,
      threadRootId: msg?.id ?? "",
      triggerMessageId: msg?.id ?? "",
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run?.id ?? "",
    channelId: f.general.id,
    threadRootId: msg?.id ?? "",
    triggerMessageId: msg?.id ?? "",
  };
}

async function profilesSetup() {
  const holder: { hub?: MachineCaller } = {};
  const source = createBrowserToolSource({
    machines: {
      hub: {
        status: (id) => (holder.hub as MachineCaller).status(id),
        call: (id, request, options) => (holder.hub as MachineCaller).call(id, request, options),
      },
    },
    pubsub: {
      publish: (topic, event) => f.pubsub.publish(topic, event),
      subscribe: (topic, fn) => f.pubsub.subscribe(topic, fn),
    } as Fixture["pubsub"],
    profileWaitMs: 150,
    profilePollMs: 30,
  });
  f = await setup({ toolSources: [source] });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Laptop" });
  await f.db
    .update(schema.machines)
    .set({ protocol: BROWSER_PROFILE_PROTOCOL })
    .where(eq(schema.machines.id, paired.machineId));
  const fake = fakeHub({ machineId: paired.machineId, orgId: f.org.id });
  holder.hub = fake.hub;
  const bia = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Bia", handle: "bia", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  for (const id of [f.agent.id, bia.id]) {
    await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, id));
    await grantScopes(f.db, f.org.id, id, [{ connectionId: null, scope: "browser:use" }]);
  }
  const tools = f.tools as NonNullable<Fixture["tools"]>;
  const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
    const r = await tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
    if (r.type !== "result") throw new Error(`expected a result, got ${r.type}`);
    return r.output;
  };
  const names = async (ctx: ToolContext) => (await tools.list(ctx)).map((t) => t.name);
  const profile = (agentIds: string[], name = "Shop chat") =>
    createBrowserProfile({ db: f.db, hub: fake.hub }, f.owner.id, f.org.id, {
      machineId: paired.machineId,
      name,
      agentIds,
    });
  const ops = () => fake.calls.filter((c) => c.op === "browser.act" || c.op === "browser.batch");
  return { ...fake, machineId: paired.machineId, bia, call, names, profile, ops, readPage: source.readPage };
}

const audits = async (action: string) =>
  f.db
    .select({ details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, action)));

test("a new profile is granted only to the agents chosen; only manage_connectors creates, grants and deletes", async () => {
  const b = await profilesSetup();
  const member = await addMember(f.db, f.org.id, "member", "Rui");
  await expect(
    createBrowserProfile({ db: f.db, hub: b.hub }, member.id, f.org.id, { machineId: b.machineId, name: "X" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const p = await b.profile([]);
  expect(p.agentIds).toEqual([]);
  // Any member sees names and who may use them.
  expect((await listBrowserProfiles(f.db, member.id, f.org.id)).map((x) => x.name)).toEqual(["Shop chat"]);
  await expect(b.profile([], "shop CHAT")).rejects.toMatchObject({ code: "browser_profile.name_taken" });
  await expect(setBrowserProfileAgents(f.db, member.id, f.org.id, p.id, [f.agent.id])).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  const granted = await setBrowserProfileAgents(f.db, f.owner.id, f.org.id, p.id, [f.agent.id, b.bia.id]);
  expect(granted.agentIds.sort()).toEqual([f.agent.id, b.bia.id].sort());
  await setBrowserProfileAgents(f.db, f.owner.id, f.org.id, p.id, [b.bia.id]);
  expect((await audits("browser_profile.created")).length).toBe(1);
  expect((await audits("browser_profile.granted")).map((a) => a.details.agentId).sort()).toEqual(
    [f.agent.id, b.bia.id].sort(),
  );
  expect((await audits("browser_profile.revoked")).map((a) => a.details.agentId)).toEqual([f.agent.id]);
  await expect(deleteBrowserProfile({ db: f.db, hub: b.hub }, member.id, f.org.id, p.id)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await deleteBrowserProfile({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, p.id);
  expect(await listBrowserProfiles(f.db, f.owner.id, f.org.id)).toEqual([]);
  expect(b.calls.some((c) => c.op === "browser.profile.delete" && c.profile?.id === p.id)).toBe(true);
  // Its name is free again.
  expect((await b.profile([])).name).toBe("Shop chat");
});

test("a computer too old can't hold profiles", async () => {
  const b = await profilesSetup();
  b.s.status = { protocol: BROWSER_PROFILE_PROTOCOL - 1 };
  await expect(b.profile([])).rejects.toThrow("Update this computer");
});

test("on a system-mode computer profiles don't exist: none listed, no tool or prompt line, every call refused", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id]);
  // The runner reported system mode (each agent its own OS user), as a Cloud computer does.
  await f.db
    .update(schema.machines)
    .set({ executors: { mode: "system", browser: { available: true } } })
    .where(eq(schema.machines.id, b.machineId));
  const refused = { code: "browser_profile.system_mode" };
  await expect(b.profile([], "Other")).rejects.toMatchObject(refused);
  await expect(listBrowserProfiles(f.db, f.owner.id, f.org.id, { machineId: b.machineId })).rejects.toMatchObject(
    refused,
  );
  await expect(setBrowserProfileAgents(f.db, f.owner.id, f.org.id, p.id, [b.bia.id])).rejects.toMatchObject(refused);
  await expect(setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id)).rejects.toMatchObject(refused);
  await expect(startProfileControl({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, p.id)).rejects.toMatchObject(
    refused,
  );
  expect(await listBrowserProfiles(f.db, f.owner.id, f.org.id)).toEqual([]);
  const ada = await runOf(f.agent.id);
  expect(await b.names(ada)).not.toContain("browser_profile");
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
  expect((await missingPermissions(await runOf(b.bia.id))).some((m) => m.profileId)).toBe(false);

  // A workspace with both kinds: a single-mode computer's profile still shows and is offered.
  const laptop = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Notebook" });
  await f.db
    .update(schema.machines)
    .set({ protocol: BROWSER_PROFILE_PROTOCOL })
    .where(eq(schema.machines.id, laptop.machineId));
  await createBrowserProfile({ db: f.db }, f.owner.id, f.org.id, {
    machineId: laptop.machineId,
    name: "Shop mail",
    agentIds: [f.agent.id],
  });
  expect((await listBrowserProfiles(f.db, f.owner.id, f.org.id)).map((x) => x.name)).toEqual(["Shop mail"]);
  const tool = (await (f.tools as NonNullable<Fixture["tools"]>).list(ada)).find((t) => t.name === "browser_profile");
  if (!tool) throw new Error("no browser_profile tool");
  expect((tool.inputSchema.properties as { name: { enum: string[] } }).name.enum).toEqual(["own", "Shop mail"]);
});

test("an agent not granted the profile is refused: no tool for it, and a default set behind its back sends nothing", async () => {
  const b = await profilesSetup();
  const p = await b.profile([b.bia.id]);
  const ada = await runOf(f.agent.id);
  expect(await b.names(ada)).not.toContain("browser_profile");
  await expect(setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id)).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect(
    (await takeProfileTurn(f.db, { orgId: f.org.id, profileId: p.id, agentId: f.agent.id, runId: ada.runId })).ok,
  ).toBe(false);
  await f.db.update(schema.agents).set({ browserProfileId: p.id }).where(eq(schema.agents.id, f.agent.id));
  const out = await b.call(ada, "browser_open", { url: "https://chat.example/" });
  expect(out.isError).toBe(true);
  expect(out.content).toContain("was removed");
  expect(b.ops().some((c) => c.profile?.id === p.id)).toBe(false);
});

test("a granted agent switches with browser_profile; its commands go to the profile's session, and the prompt names its browsers", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id]);
  const ada = await runOf(f.agent.id);
  expect(await b.names(ada)).toContain("browser_profile");
  expect(browsersPrompt([{ id: p.id, name: p.name }], null)).toBe(
    'Browsers: your own (default), "Shop chat". Switch with `browser_profile`; the profiles are the workspace\'s shared logins, one agent at a time.',
  );
  const switched = await b.call(ada, "browser_profile", { name: "Shop chat" });
  expect(switched.content).toContain('profile "Shop chat" now (free)');
  const out = await b.call(ada, "browser_open", { url: "https://chat.example/" });
  expect(out.isError).toBeFalsy();
  expect(out.data?.browserProfile).toEqual({ id: p.id, name: "Shop chat" });
  const sent = b.ops();
  expect(sent.length).toBeGreaterThan(0);
  expect(
    sent.every((c) => c.profile?.id === p.id && c.agent?.id === f.agent.id && !("desktop" in c && c.desktop)),
  ).toBe(true);
  // "own" goes back to its own browser, and lets go of the profile's turn at once.
  await b.call(ada, "browser_profile", { name: "own" });
  const [row] = await f.db.select().from(schema.browserProfiles).where(eq(schema.browserProfiles.id, p.id));
  expect(row?.heldByRunId).toBeNull();
  const n = b.ops().length;
  await b.call(ada, "browser_open", { url: "https://chat.example/" });
  expect(
    b
      .ops()
      .slice(n)
      .every((c) => c.profile === undefined),
  ).toBe(true);
});

test("one agent at a time: the other waits, then hears who has it; the turn ends with the run", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id, b.bia.id]);
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id);
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, b.bia.id, p.id);
  const ada = await runOf(f.agent.id);
  const bia = await runOf(b.bia.id);
  expect((await b.call(ada, "browser_open", { url: "https://chat.example/" })).isError).toBeFalsy();
  const events: unknown[] = [];
  const unsubscribe = f.pubsub.subscribe(channelTopic(f.general.id), (e) => {
    if ((e as { type?: string }).type === "agent.browser.waiting") events.push(e);
  });
  const n = b.ops().length;
  const busy = await b.call(bia, "browser_open", { url: "https://chat.example/" });
  unsubscribe();
  expect(busy.isError).toBe(true);
  expect(busy.content).toMatch(/^profile_busy: The profile "Shop chat" is in use by @dev \(since \d\d:\d\d UTC\)/);
  expect(b.ops().length).toBe(n);
  // Bia's card heard she waits for Ada, then that she stopped waiting.
  expect(
    events.map((e) => (e as { wait: { holder?: { agentId?: string } } | null }).wait?.holder?.agentId ?? null),
  ).toEqual([f.agent.id, null]);
  await transitionRun(f.db, ada.runId, "running", "done");
  expect((await b.call(bia, "browser_open", { url: "https://chat.example/" })).isError).toBeFalsy();
});

test("a revoke stops the holder's very next command and sends its run back to its own browser", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id]);
  const ada = await runOf(f.agent.id);
  await b.call(ada, "browser_profile", { name: "Shop chat" });
  expect((await b.call(ada, "browser_open", { url: "https://chat.example/" })).isError).toBeFalsy();
  await setBrowserProfileAgents(f.db, f.owner.id, f.org.id, p.id, []);
  const n = b.ops().length;
  const out = await b.call(ada, "browser_open", { url: "https://chat.example/" });
  expect(out.isError).toBe(true);
  expect(out.content).toContain('Your access to the profile "Shop chat" was removed.');
  expect(b.ops().length).toBe(n);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ada.runId));
  expect(run?.browserProfileOwn).toBe(true);
  const [row] = await f.db.select().from(schema.browserProfiles).where(eq(schema.browserProfiles.id, p.id));
  expect(row?.heldByRunId).toBeNull();
});

test("a web search's page opens in the agent's own browser, never its default profile, and takes no turn", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id, b.bia.id]);
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id);
  const bia = await runOf(b.bia.id);
  expect(
    (await takeProfileTurn(f.db, { orgId: f.org.id, profileId: p.id, agentId: b.bia.id, runId: bia.runId })).ok,
  ).toBe(true);
  const ada = await runOf(f.agent.id);
  const page = await b.readPage(ada, "https://search.example/?q=x");
  expect(page?.text).toContain("Send");
  const sent = b.ops();
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((c) => c.profile === undefined)).toBe(true);
});

test("revoking or deleting an agent's default profile tells its next command, not its own browser", async () => {
  for (const how of ["revoke", "delete"] as const) {
    const b = await profilesSetup();
    const p = await b.profile([f.agent.id]);
    await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id);
    const ada = await runOf(f.agent.id);
    expect((await b.call(ada, "browser_open", { url: "https://chat.example/" })).isError).toBeFalsy();
    if (how === "revoke") await setBrowserProfileAgents(f.db, f.owner.id, f.org.id, p.id, []);
    else await deleteBrowserProfile({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, p.id);
    const n = b.ops().length;
    const out = await b.call(ada, "browser_click", { target: "e1" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain(how === "revoke" ? "was removed" : "was deleted");
    expect(b.ops().length).toBe(n);
    // Told once: from now on its commands go to its own browser.
    await b.call(ada, "browser_open", { url: "https://chat.example/" });
    expect(
      b
        .ops()
        .slice(n)
        .every((c) => c.profile === undefined),
    ).toBe(true);
    await f.close();
  }
  f = undefined as never;
});

test("a hold the app's clock thinks lapsed but the database's doesn't answers busy at once, never spins", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id, b.bia.id]);
  const ada = await runOf(f.agent.id);
  const bia = await runOf(b.bia.id);
  // Inside a transaction Postgres's now() stands still while Date.now() moves on: an app clock ahead of the DB's.
  const t = await f.db.transaction(async (tx) => {
    await tx
      .update(schema.browserProfiles)
      .set({
        heldByRunId: ada.runId,
        heldByAgentId: f.agent.id,
        heldSince: sql`now()`,
        heldUntil: sql`now() + interval '50 milliseconds'`,
      })
      .where(eq(schema.browserProfiles.id, p.id));
    await Bun.sleep(120);
    return takeProfileTurn(tx as never, { orgId: f.org.id, profileId: p.id, agentId: b.bia.id, runId: bia.runId });
  });
  expect(t).toMatchObject({ ok: false, reason: "busy" });
}, 5000);

test("browser_ask_person inside a profile points at its drivers and never opens the agent's own browser", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id]);
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id);
  const ada = await runOf(f.agent.id);
  const source = createBrowserHandoffToolSource({ machines: { hub: b.hub }, pubsub: f.pubsub });
  const ask = (await source.tools(ada)).find((t) => t.name === "browser_ask_person");
  if (!ask) throw new Error("browser_ask_person not offered");
  const out = await ask.execute({ instructions: "Sign in" }, ada);
  expect(out.isError).toBe(true);
  expect(out.content).toContain('Fazer login on "Shop chat"');
  expect(await f.db.select().from(schema.browserHandoffs)).toEqual([]);
});

test("a run that lost its turn to another doesn't run its command: it looks at the page and decides again", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id, b.bia.id]);
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id);
  await setAgentBrowserProfile(f.db, f.owner.id, f.org.id, b.bia.id, p.id);
  const ada = await runOf(f.agent.id);
  const bia = await runOf(b.bia.id);
  await b.call(ada, "browser_open", { url: "https://chat.example/" });
  // Ada waits on an approval for more than 2 minutes: her turn lapses and Bia uses the profile.
  await f.db
    .update(schema.browserProfiles)
    .set({ heldUntil: sql`now() - interval '1 second'` })
    .where(eq(schema.browserProfiles.id, p.id));
  expect((await b.call(bia, "browser_open", { url: "https://chat.example/b" })).isError).toBeFalsy();
  await transitionRun(f.db, bia.runId, "running", "done");
  const n = b.calls.length;
  const out = await b.call(ada, "browser_click", { target: "e1" });
  expect(out.isError).toBe(true);
  expect(out.content).toContain("so that command was not run");
  expect(out.content).toContain("<page_content");
  const sent = b.calls.slice(n);
  // Only the look: no click reached the page.
  expect(sent.length).toBe(1);
  expect(JSON.stringify(sent[0])).toContain("snapshot");
  expect(JSON.stringify(sent)).not.toContain('"click"');
  // It holds a fresh turn now: its next command runs.
  expect((await b.call(ada, "browser_click", { target: "e1" })).isError).toBeFalsy();
});

test("a person in control holds the profile: agents wait, Devolver frees it; watchers are drivers and the owners of granted agents", async () => {
  const b = await profilesSetup();
  const p = await b.profile([b.bia.id]);
  await startProfileControl({ db: f.db, hub: b.hub }, f.owner.id, f.org.id, p.id);
  expect(b.calls.some((c) => c.op === "browser.warm" && c.profile?.id === p.id)).toBe(true);
  const bia = await runOf(b.bia.id);
  const turn = await takeProfileTurn(f.db, { orgId: f.org.id, profileId: p.id, agentId: b.bia.id, runId: bia.runId });
  expect(turn).toMatchObject({ ok: false, reason: "busy", holder: { type: "person", userId: f.owner.id } });
  await endProfileControl({ db: f.db }, f.owner.id, f.org.id, p.id);
  expect(
    (await takeProfileTurn(f.db, { orgId: f.org.id, profileId: p.id, agentId: b.bia.id, runId: bia.runId })).ok,
  ).toBe(true);
  // Someone who only talks to Bia doesn't watch the account.
  const asker = await addMember(f.db, f.org.id, "member", "Asker");
  await expect(requireProfileWatcher(f.db, asker.id, f.org.id, p.id)).rejects.toBeInstanceOf(ForbiddenError);
  await f.db.update(schema.agents).set({ ownerUserId: asker.id }).where(eq(schema.agents.id, b.bia.id));
  expect((await requireProfileWatcher(f.db, asker.id, f.org.id, p.id)).id).toBe(p.id);
});

test("a workspace being deleted: its profiles are still watched, never driven (the socket's typing checks this too)", async () => {
  const b = await profilesSetup();
  const p = await b.profile([b.bia.id]);
  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 7 * 86_400_000) })
    .where(eq(schema.organizations.id, f.org.id));
  expect((await requireProfileWatcher(f.db, f.owner.id, f.org.id, p.id)).id).toBe(p.id);
  await expect(requireProfileDriver(f.db, f.owner.id, f.org.id, p.id)).rejects.toMatchObject({
    code: "org.deleting",
  });
});

test("request_permission offers profiles apart from 'all tools'; approving grants one", async () => {
  const b = await profilesSetup();
  const p = await b.profile([]);
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
  const ctx = await runOf(f.agent.id);
  const missing = await missingPermissions(ctx);
  expect(missing.map((m) => m.id)).toContain(`browser-profile:${p.id}`);
  const [tool] = await createPermissionToolSource().tools(ctx);
  const out = await tool?.execute({ permission: `browser-profile:${p.id}` }, ctx);
  expect(out?.content).toContain('Turned on: Browser profile "Shop chat"');
  expect((await listBrowserProfiles(f.db, f.owner.id, f.org.id))[0]?.agentIds).toEqual([f.agent.id]);
  expect((await missingPermissions(ctx)).map((m) => m.id)).not.toContain(`browser-profile:${p.id}`);
});

test("the Cloud's computer before its first hello, or an old system-mode one, is refused as system mode", async () => {
  const b = await profilesSetup();
  const p = await b.profile([f.agent.id]);
  // Managed and never connected: no mode reported yet.
  await f.db.update(schema.machines).set({ kind: "managed", executors: {} }).where(eq(schema.machines.id, b.machineId));
  const refused = { code: "browser_profile.system_mode" };
  await expect(b.profile([], "Other")).rejects.toMatchObject(refused);
  await expect(setAgentBrowserProfile(f.db, f.owner.id, f.org.id, f.agent.id, p.id)).rejects.toMatchObject(refused);
  expect(await listBrowserProfiles(f.db, f.owner.id, f.org.id)).toEqual([]);
  expect(await b.names(await runOf(f.agent.id))).not.toContain("browser_profile");
  await f.db.update(schema.agents).set({ browserMachineId: b.machineId }).where(eq(schema.agents.id, f.agent.id));
  await expect(requestBrowserProfile({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).rejects.toMatchObject(refused);
  // A system-mode computer whose runner is too old for profiles: still system mode, never "update this computer".
  await f.db
    .update(schema.machines)
    .set({ kind: "connected", executors: { mode: "system", browser: { available: true } } })
    .where(eq(schema.machines.id, b.machineId));
  b.s.status = { protocol: BROWSER_PROFILE_PROTOCOL - 1 };
  await expect(b.profile([], "Older")).rejects.toMatchObject(refused);
});

test("an agent's owner asks the people who grant profiles; the inbox says so", async () => {
  await profilesSetup();
  const owner = await addMember(f.db, f.org.id, "member", "Owner");
  await f.db.update(schema.agents).set({ ownerUserId: owner.id }).where(eq(schema.agents.id, f.agent.id));
  await requestBrowserProfile({ db: f.db }, owner.id, f.org.id, f.agent.id);
  const rows = await f.db
    .select({ userId: schema.notifications.userId })
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "browser_profile_request"));
  expect(rows.map((r) => r.userId)).toEqual([f.owner.id]);
  const stranger = await addMember(f.db, f.org.id, "member", "Stranger");
  await expect(requestBrowserProfile({ db: f.db }, stranger.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

test("the chat's trail says which profile each step ran in", () => {
  const t: ToolSideEffects = {};
  absorbBrowserCall(t, { name: "browser_open", input: { url: "https://chat.example/" } }, false);
  absorbToolData(t, { browserProfile: { id: "p1", name: "Shop chat" } });
  absorbBrowserCall(t, { name: "browser_profile", input: { name: "own" } }, false);
  absorbBrowserCall(t, { name: "browser_read", input: {} }, false);
  absorbToolData(t, {});
  expect(t.browser?.map((s) => [s.tool, s.profileName ?? null])).toEqual([
    ["browser_open", "Shop chat"],
    ["browser_read", null],
  ]);
});
