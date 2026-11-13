import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PERMISSION_TOOL } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import {
  askStillOpen,
  autonomySettings,
  brakeWakes,
  callableAgents,
  costlyGate,
  costlyKind,
  createAgent,
  DIGEST_AFTER_MS,
  decideCostlyProposal,
  endsAsking,
  FOLLOW_UP_JOB,
  getMessage,
  insertMessage,
  type Judge,
  LATER_JOB,
  LATER_LOOKS,
  LATER_MAX_LOOKS,
  LOOP_MAX,
  type OutboxJob,
  postAutonomyDigests,
  postPersonMessage,
  type RunAuthority,
  signatureOf,
  speakerFor,
  type ToolDefinition,
  teammatesFor,
  updateAgent,
  wakeFollowUp,
} from "../src";
import { decideTurnEnd, type TurnEnd } from "../src/continuation";
import { addMember, type Fixture, setup } from "./fixtures";

/** Autonomy brakes (ADR 0131): proactive agents, bounded where nobody asked. */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const { agentRuns, autonomySignals, messages, outbox } = schema;

async function agentOf(name: string, handle: string, brakes: Record<string, unknown> = {}) {
  const a = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Dev", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
  if (Object.keys(brakes).length > 0)
    await f.db.update(schema.agents).set({ autonomyBrakes: brakes }).where(eq(schema.agents.id, a.id));
  return a;
}

/** The agent under test set to ask before costly work nobody asked for (the default is to go ahead). */
const askFirst = () =>
  f.db
    .update(schema.agents)
    .set({ autonomyBrakes: { costly: "ask" } })
    .where(eq(schema.agents.id, f.agent.id));

/** An agent's message nobody asked for (no run, no person at its root): a routine's or an alert's. */
const alert = (agentId: string, body: string) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
    body,
  });

/** A run of `agentId` working on `trigger`. */
async function working(agentId: string, triggerId: string, status: "running" | "done" = "running") {
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId: f.general.id,
      threadRootId: triggerId,
      triggerMessageId: triggerId,
      trigger: "mention",
      hop: 2,
      status,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const signalsOf = async (kind: string) => (await f.db.select().from(autonomySignals)).filter((s) => s.kind === kind);
const jobsOf = async (kind: string) => (await f.db.select().from(outbox)).filter((j) => j.kind === kind);
const fakeJudge = (noise: number): Judge => ({
  name: "fake",
  ask: async () => ({
    verdict: { choice: noise >= 0.5 ? "noise" : "work", probabilities: { noise, work: 1 - noise } },
  }),
});
const UNATTENDED: RunAuthority = { kind: "unattended", personId: null, reason: "agent" };

describe("asking means waiting (§1)", () => {
  test("a reply that ends asking is a question, whatever trails it", () => {
    expect(endsAsking("Achei o gargalo no parser.\n\nQuer que eu faça?")).toBe(true);
    expect(endsAsking("Shall I open the PR? 🙂")).toBe(true);
    expect(endsAsking("Feito: abri o PR #12.")).toBe(false);
    expect(endsAsking("Rodei isto:\n```\nwhy?\n```\nTudo certo.")).toBe(false);
  });

  test("the controller ends the turn there: a judged promise never pushes it to go ahead", async () => {
    const turn: TurnEnd = {
      state: { count: 0 },
      kind: "conversation",
      executed: 3,
      bound: null,
      quiet: false,
      decided: null,
      unanswered: false,
      unreached: "",
      judged: "Dá pra acelerar instalando o hyperfine e rodando nos 40 arquivos. Quer que eu faça?",
      mission: false,
      wakesLater: async () => false,
      verdict: async () => "continue",
    };
    expect(await decideTurnEnd(turn)).toMatchObject({ outcome: "done", rule: "asked" });
    // Told to ask, its question still becomes the card.
    expect((await decideTurnEnd({ ...turn, state: { count: 0, askNudged: true, askPending: true } })).rule).not.toBe(
      "asked",
    );
    // A question that asks for a secret in the chat is still sent to the secure way.
    const secret = await decideTurnEnd({
      ...turn,
      judged: "Me manda o token do Sentry aqui?",
      verdict: async () => "secret",
    });
    expect(secret.rule).toBe("secret");
    // A question handed by mention to an agent the mention never reached is still handed over.
    const unreached = await decideTurnEnd({ ...turn, judged: "@bia, pode revisar?", unreached: "Use tell_agent." });
    expect(unreached.rule).toBe("unreached");
    // Its means left untried: still nudged to try them.
    const untried = await decideTurnEnd({
      ...turn,
      judged: "Qual é o endereço do servidor?",
      verdict: async () => "untried",
    });
    expect(untried.rule).toBe("untried");
  });

  test("a follow-up waits while the agent's question is unanswered", async () => {
    f = await setup();
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "olha o benchmark",
    });
    const run = await working(f.agent.id, asked.id, "done");
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: asked.id,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
      body: "Posso instalar as dependências e rodar tudo. Quer que eu faça?",
    });
    const thread = { ...run, threadRootId: asked.id, triggerMessageId: crypto.randomUUID() };
    expect(await askStillOpen(f.db, thread)).toBe(true);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "pode sim",
      threadId: asked.id,
    });
    expect(await askStillOpen(f.db, thread)).toBe(false);
  });
});

test("§1: a follow-up of work nobody asked for, whose question is open, waits and looks again; it isn't canceled", async () => {
  f = await setup();
  const trigger = await alert(f.agent.id, "Benchmark noturno ficou 30% mais lento");
  const run = await working(f.agent.id, trigger.id, "done");
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 2 },
    body: "Posso instalar o hyperfine e rodar nos 40 arquivos. Quer que eu faça?",
  });
  const line = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 2, stretchId: null },
    body: "Rodar o benchmark",
    meta: {
      notice: {
        kind: "follow_up",
        text: "Rodar o benchmark",
        refs: { runId: run.id, at: new Date().toISOString(), about: "", state: "pending" },
      },
    },
  });
  expect(await wakeFollowUp(f, f.org.id, line.id)).toBeNull();
  const kept = await getMessage(f.db, f.org.id, line.id);
  expect((kept?.meta.notice as { refs?: { state?: string } } | undefined)?.refs?.state).toBe("pending");
  expect((await jobsOf(FOLLOW_UP_JOB)).map((j) => j.payload)).toEqual([{ messageId: line.id }]);
  expect((await f.db.select().from(agentRuns)).length).toBe(1);
});

describe("costly work an agent starts on its own, set to ask first, needs a go (§3)", () => {
  test("what counts as costly: opening a PR, installing packages", () => {
    expect(costlyKind(PERMISSION_TOOL, { tool_name: "Bash", input: { command: "gh pr create --fill" } })).toBe("pr");
    expect(costlyKind("Bash", { command: "cd app && npm install hyperfine" })).toBe("install");
    expect(costlyKind("github_create_pull_request", { repo: "acme/app" })).toBe("pr");
    expect(costlyKind("Bash", { command: "npm test" })).toBeNull();
    expect(costlyKind("read_file", { path: "README.md" })).toBeNull();
  });

  test("the first try posts one proposal card; go lets that run do it; the run hears each decision", async () => {
    f = await setup();
    await askFirst();
    const trigger = await alert(f.agent.id, "Erro novo em produção");
    const run = await working(f.agent.id, trigger.id);
    const at = {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
    };
    // A person's request never meets the gate.
    expect(await costlyGate(f, at, { kind: "person", personId: f.owner.id }, "pr", "gh pr create")).toBeNull();
    // Nor a routine's own run: its brief is its creator's go.
    expect(await costlyGate(f, at, { kind: "routine", personId: null, brief: null }, "pr", "gh pr create")).toBeNull();
    const first = await costlyGate(f, at, UNATTENDED, "pr", "gh pr create --title fix");
    expect(first?.code).toBe("autonomy.needs_go");
    expect((await costlyGate(f, at, UNATTENDED, "pr", "gh pr create --title fix"))?.code).toBe("autonomy.needs_go");
    const cards = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { actionCard?: { kind?: string } }).actionCard?.kind === "autonomy_proposal",
    );
    expect(cards).toHaveLength(1);
    const card = (cards[0]?.meta as { actionCard: { signalId: string; forUserId: string | null } } | undefined)
      ?.actionCard;
    if (!card) throw new Error("no card");
    // Nobody is behind the run: the agent's owner decides.
    expect(card.forUserId).toBe(f.owner.id);
    const outsider = await addMember(f.db, f.org.id, "member", "Rui");
    await expect(decideCostlyProposal(f, outsider.id, f.org.id, card.signalId, "go")).rejects.toThrow();
    await decideCostlyProposal(f, f.owner.id, f.org.id, card.signalId, "go");
    await expect(decideCostlyProposal(f, f.owner.id, f.org.id, card.signalId, "never")).rejects.toThrow();
    expect(await costlyGate(f, at, UNATTENDED, "pr", "gh pr create --title fix")).toBeNull();
    const notes = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { notice?: { kind?: string } }).notice?.kind === "proposal_result",
    );
    expect(notes.map((n) => n.body)).toEqual([expect.stringContaining("said go")]);
    expect(await signalsOf("pr")).toHaveLength(1);
  });

  test("what a source the workspace set up sends is asked-for work: no card, only the hourly PR cap", async () => {
    f = await setup();
    const trigger = await alert(f.agent.id, "Sentry: TypeError em checkout https://sentry.example.com/issues/7/");
    const run = await working(f.agent.id, trigger.id);
    const at = {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
    };
    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { never: ["install"], maxPrsPerHour: 1 } })
      .where(eq(schema.agents.id, f.agent.id));
    for (const reason of ["routine_report", "routine"] as const) {
      const fed: RunAuthority = { kind: "unattended", personId: null, reason, brief: null };
      expect(await costlyGate(f, at, fed, "install", "npm install")).toBeNull();
      expect(await costlyGate(f, at, fed, "long", "step 41")).toBeNull();
    }
    const fed: RunAuthority = { kind: "unattended", personId: null, reason: "routine_report", brief: null };
    expect(await costlyGate(f, at, fed, "pr", "gh pr create a")).toBeNull();
    expect((await costlyGate(f, at, fed, "pr", "gh pr create b"))?.code).toBe("autonomy.pr_limit");
    expect(await signalsOf("proposal")).toHaveLength(0);
  });

  test("a go clicked after the asking run ended reaches the run it wakes: no second card", async () => {
    f = await setup();
    await askFirst();
    const trigger = await alert(f.agent.id, "Erro novo em produção");
    const run = await working(f.agent.id, trigger.id);
    const at = {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
    };
    expect((await costlyGate(f, at, UNATTENDED, "pr", "gh pr create"))?.code).toBe("autonomy.needs_go");
    await f.db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, run.id));
    const [proposal] = await signalsOf("proposal");
    await decideCostlyProposal(f, f.owner.id, f.org.id, proposal?.id ?? "", "go");
    const woken = (await f.db.select().from(agentRuns)).filter((r) => r.id !== run.id);
    expect(woken).toHaveLength(1);
    const next = woken[0];
    if (!next) throw new Error("no woken run");
    expect(await costlyGate(f, { ...at, runId: next.id }, UNATTENDED, "pr", "gh pr create")).toBeNull();
    const cards = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { actionCard?: { kind?: string } }).actionCard?.kind === "autonomy_proposal",
    );
    expect(cards).toHaveLength(1);
  });

  test("the person a card is for says go or not now; only the agent's owner or an admin says always or never", async () => {
    f = await setup();
    await askFirst();
    const trigger = await alert(f.agent.id, "Erro novo em produção");
    const run = await working(f.agent.id, trigger.id);
    const at = {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
    };
    const member = await addMember(f.db, f.org.id, "member", "Rui");
    await costlyGate(f, at, UNATTENDED, "pr", "gh pr create");
    // A card for a person who doesn't manage the agent (as a routine's creator would get).
    const [card] = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { actionCard?: { kind?: string } }).actionCard?.kind === "autonomy_proposal",
    );
    await f.db
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard,forUserId}', ${JSON.stringify(member.id)}::jsonb)` })
      .where(eq(messages.id, card?.id ?? ""));
    const [proposal] = await signalsOf("proposal");
    await expect(decideCostlyProposal(f, member.id, f.org.id, proposal?.id ?? "", "always")).rejects.toThrow();
    await expect(decideCostlyProposal(f, member.id, f.org.id, proposal?.id ?? "", "never")).rejects.toThrow();
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(autonomySettings(agent?.autonomyBrakes).go).toEqual([]);
    expect(await decideCostlyProposal(f, member.id, f.org.id, proposal?.id ?? "", "go")).toEqual({ state: "go" });
  });

  test("always and never are remembered on the agent; the hourly PR cap holds even with a go", async () => {
    f = await setup();
    await askFirst();
    const trigger = await alert(f.agent.id, "Sentry: TypeError em checkout");
    const run = await working(f.agent.id, trigger.id);
    const at = {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
    };
    await costlyGate(f, at, UNATTENDED, "install", "npm install left-pad");
    const [proposal] = await signalsOf("proposal");
    await decideCostlyProposal(f, f.owner.id, f.org.id, proposal?.id ?? "", "never");
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(autonomySettings(agent?.autonomyBrakes).never).toEqual(["install"]);
    const other = await working(f.agent.id, (await alert(f.agent.id, "outro")).id);
    expect((await costlyGate(f, { ...at, runId: other.id }, UNATTENDED, "install", "npm i x"))?.code).toBe(
      "autonomy.never",
    );

    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { costly: "go", maxPrsPerHour: 2 } })
      .where(eq(schema.agents.id, f.agent.id));
    expect(await costlyGate(f, at, UNATTENDED, "pr", "gh pr create a")).toBeNull();
    expect(await costlyGate(f, at, UNATTENDED, "pr", "gh pr create b")).toBeNull();
    expect((await costlyGate(f, at, UNATTENDED, "pr", "gh pr create c"))?.code).toBe("autonomy.pr_limit");
  });

  test("through the Tool Gateway, on a computer brain's permission prompt too", async () => {
    // Claude Code's prompt tool, which would allow anything.
    const prompt: ToolDefinition = {
      name: PERMISSION_TOOL,
      description: "Permission prompt (fake)",
      scope: "",
      inputSchema: { type: "object" },
      execute: async () => ({ content: JSON.stringify({ behavior: "allow" }) }),
    };
    f = await setup({ toolSources: [{ name: "fake-prompt", tools: async () => [prompt] }] });
    await askFirst();
    const trigger = await alert(f.agent.id, "Sentry: erro antigo de freeze");
    const run = await working(f.agent.id, trigger.id);
    const tools = f.tools;
    if (!tools) throw new Error("no tools");
    const out = await tools.invoke(
      {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: run.id,
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        bridge: { machineId: crypto.randomUUID() },
      },
      {
        toolUseId: "t1",
        name: PERMISSION_TOOL,
        input: { tool_name: "Bash", input: { command: "gh pr create --fill" } },
      },
    );
    if (out.type !== "result") throw new Error(`expected a result, got ${out.type}`);
    const answer = JSON.parse(out.output.content) as { behavior: string; code: string };
    expect(answer).toMatchObject({ behavior: "deny", code: "autonomy" });
    expect(await signalsOf("proposal")).toHaveLength(1);
  });
});

describe("one item is worked once, noise waits for a digest, repeats stop (§4–6)", () => {
  test("a person's message is never braked", async () => {
    f = await setup();
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "Sentry: TypeError em checkout https://sentry.example.com/issues/42/",
    });
    const message = await getMessage(f.db, f.org.id, asked.id);
    if (!message) throw new Error("no message");
    const out = await brakeWakes({ db: f.db, judge: fakeJudge(1) }, message, [f.agent.id]);
    expect(out.wake).toEqual([f.agent.id]);
    expect(await f.db.select().from(autonomySignals)).toEqual([]);
  });

  test("the same alert while the agent is still on it joins that run instead of a second one", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada");
    const body = "Sentry: TypeError em checkout https://sentry.example.com/issues/42/?ref=1";
    const one = await alert(f.agent.id, body);
    expect((await brakeWakes({ db: f.db, judge: fakeJudge(0) }, one, [ada.id])).wake).toEqual([ada.id]);
    const run = await working(ada.id, one.id);
    const again = await alert(
      f.agent.id,
      "Sentry: TypeError em checkout (3 events) https://sentry.example.com/issues/42",
    );
    const out = await brakeWakes({ db: f.db, judge: fakeJudge(0) }, again, [ada.id]);
    expect(out.held.get(ada.id)).toBe("linked");
    const [linked] = await signalsOf("linked");
    expect(linked?.runId).toBe(run.id);
    const [updated] = await f.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(updated?.pendingMessageIds?.length).toBe(1);
  });

  test("a burst of one alert starts one run: a wake whose run is still starting counts as open work", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada");
    const body = "Sentry: TypeError em checkout https://sentry.example.com/issues/42/";
    const burst = await Promise.all([1, 2, 3].map(() => alert(f.agent.id, body)));
    const outs = await Promise.all(burst.map((m) => brakeWakes({ db: f.db, judge: fakeJudge(0) }, m, [ada.id])));
    expect(outs.filter((o) => o.wake.length > 0)).toHaveLength(1);
    expect(outs.filter((o) => o.held.get(ada.id) === "linked")).toHaveLength(2);
    expect(await signalsOf("wake")).toHaveLength(1);
  });

  test(`${LOOP_MAX} tries at one item in a day: it stops and a person hears it once`, async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada");
    const body = (n: number) => `Sentry: ANR freeze on main thread ${n}ms https://sentry.example.com/issues/7/`;
    for (let i = 0; i < LOOP_MAX; i++) {
      const m = await alert(f.agent.id, body(100 + i));
      expect((await brakeWakes({ db: f.db, judge: fakeJudge(0) }, m, [ada.id])).wake).toEqual([ada.id]);
      await working(ada.id, m.id, "done");
    }
    for (const n of [1, 2]) {
      const m = await alert(f.agent.id, body(200 + n));
      expect((await brakeWakes({ db: f.db, judge: fakeJudge(0) }, m, [ada.id])).held.get(ada.id)).toBe("loop");
    }
    const stops = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { bodyCode?: string }).bodyCode === "autonomy_loop",
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]?.body).not.toContain("@");
  });

  test("noise goes to one digest an hour later, not to work", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada");
    for (const n of [1, 2, 3]) {
      const m = await alert(f.agent.id, `Sentry: ResizeObserver loop limit exceeded (${n})`);
      expect((await brakeWakes({ db: f.db, judge: fakeJudge(0.9) }, m, [ada.id])).held.get(ada.id)).toBe("digest");
    }
    expect(await postAutonomyDigests(f)).toBe(0);
    expect(await postAutonomyDigests(f, new Date(Date.now() + DIGEST_AFTER_MS + 1000))).toBe(1);
    const digests = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { bodyCode?: string }).bodyCode === "autonomy_digest",
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]?.authorAgentId).toBe(ada.id);
    expect(digests[0]?.body).toContain("×3");
    expect(await postAutonomyDigests(f, new Date(Date.now() + 2 * DIGEST_AFTER_MS))).toBe(0);
  });

  test("an agent at its cap of unrequested work looks again later", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada", { maxUnrequested: 1 });
    const first = await alert(f.agent.id, "Deploy falhou no job build-web");
    expect((await brakeWakes({ db: f.db, judge: fakeJudge(0) }, first, [ada.id])).wake).toEqual([ada.id]);
    await working(ada.id, first.id);
    const second = await alert(f.agent.id, "Fila de e-mails parada há 20 min");
    expect((await brakeWakes({ db: f.db, judge: fakeJudge(0) }, second, [ada.id])).held.get(ada.id)).toBe("later");
    const [later] = await jobsOf(LATER_JOB);
    expect(later?.payload).toMatchObject({ messageId: second.id, agentId: ada.id, look: 1 });
  });

  test("work held only for room is never digested as noise: past the hour it looks slower, after a day it starts", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada", { maxUnrequested: 1 });
    const first = await alert(f.agent.id, "Deploy falhou no job build-web");
    await brakeWakes({ db: f.db, judge: fakeJudge(0) }, first, [ada.id]);
    await working(ada.id, first.id);
    const outage = await alert(f.agent.id, "Checkout fora do ar para todos os clientes");
    const at = (look: number) => brakeWakes({ db: f.db, judge: null }, outage, [ada.id], { look });
    expect((await at(LATER_LOOKS)).held.get(ada.id)).toBe("later");
    const slow = (await jobsOf(LATER_JOB)).find((j) => j.payload.look === LATER_LOOKS + 1);
    expect(slow?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect((await at(LATER_MAX_LOOKS)).wake).toEqual([ada.id]);
    expect(await signalsOf("digest")).toHaveLength(0);
  });

  test("only alerts count as items: hand-offs and recurring reports with a dashboard link never link or stop", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada");
    expect(signatureOf("@bob pode revisar?")?.alert).toBe(false);
    expect(signatureOf("Relatório de vendas — 14h: https://dash.example.com")?.alert).toBe(false);
    expect(signatureOf("Novo erro https://sentry.example.com/issues/42/")?.alert).toBe(true);
    expect(signatureOf("TypeError: x is undefined")?.alert).toBe(true);
    for (let i = 0; i < LOOP_MAX + 2; i++) {
      const m = await alert(f.agent.id, `@ada Relatório de vendas — ${8 + i}h: https://dash.example.com`);
      expect((await brakeWakes({ db: f.db, judge: fakeJudge(0) }, m, [ada.id])).wake).toEqual([ada.id]);
      // Still working on the first one: a new report is no duplicate of it.
      await working(ada.id, m.id, i === 0 ? "running" : "done");
    }
    expect(await signalsOf("loop")).toEqual([]);
    expect(await signalsOf("linked")).toEqual([]);
  });

  test("signatures: the same issue link or the same line without its numbers", () => {
    const a = signatureOf("Sentry: TypeError x https://sentry.example.com/issues/42/?ref=a");
    const b = signatureOf("TypeError x again https://sentry.example.com/issues/42");
    expect(a?.key).toBe(b?.key);
    expect(signatureOf("Timeout after 3012ms in job 99")?.key).toBe(signatureOf("Timeout after 15ms in job 7")?.key);
    expect(signatureOf("@ada fix it")?.title).not.toContain("@");
  });
});

describe("who an agent may call (§8)", () => {
  test("its list, nobody, or only its own project", async () => {
    f = await setup();
    const ada = await agentOf("Ada", "ada", { project: "app-mobile" });
    const kai = await agentOf("Kai", "kai", { project: "site" });
    const rio = await agentOf("Rio", "rio");
    const caller = await agentOf("Theo", "theo", { project: "app-mobile" });
    expect(await callableAgents(f.db, f.org.id, caller.id, [ada.id, kai.id, rio.id])).toEqual(
      new Set([ada.id, rio.id]),
    );
    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { callAgents: "some", callAgentIds: [kai.id], otherProjects: true } })
      .where(eq(schema.agents.id, caller.id));
    expect(await callableAgents(f.db, f.org.id, caller.id, [ada.id, kai.id])).toEqual(new Set([kai.id]));
    const team = await f.db.select().from(schema.agents);
    const listed = teammatesFor(team, caller.id, f.owner.id, new Set(), await speakerFor(f.db, f.org.id, f.owner.id));
    expect(listed.map((a) => a.handle)).toEqual(["kai"]);
  });

  test("an agent's mention of an agent it may not call wakes nobody and tells it why", async () => {
    // The mention needs Ada: without the setting it would wake her.
    f = await setup({ judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined) });
    const ada = await agentOf("Ada", "ada");
    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { callAgents: "none" } })
      .where(eq(schema.agents.id, f.agent.id));
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev revisa o PR",
    });
    const [run] = await f.db.select().from(agentRuns).where(eq(agentRuns.triggerMessageId, asked.id));
    if (!run) throw new Error("no run");
    const mention = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: asked.id,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
      body: "@ada pode olhar o outro repositório?",
    });
    await f.handlers["message.posted"]?.(
      { orgId: f.org.id, payload: { messageId: mention.id } } as unknown as OutboxJob,
      {
        finalAttempt: false,
      },
    );
    expect((await f.db.select().from(agentRuns)).filter((r) => r.agentId === ada.id)).toEqual([]);
    const told = (await f.db.select().from(messages)).filter(
      (m) => (m.meta as { notice?: { kind?: string } }).notice?.kind === "wake_skipped",
    );
    expect(told.map((m) => m.body)).toEqual([expect.stringContaining("call ada")]);
    expect(told[0]?.meta).toMatchObject({ notice: { refs: { agentHandles: "ada", reason: "callable" } } });
  });

  test("only the settings people set are stored, normalized: the rest follows the defaults", async () => {
    f = await setup();
    const saved = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, {
      autonomyBrakes: { maxUnrequested: 99, callAgents: "none" },
    });
    // A default that changes later still reaches this agent.
    expect(saved.autonomyBrakes).toEqual({ maxUnrequested: 20, callAgents: "none" });
    expect(autonomySettings(saved.autonomyBrakes)).toMatchObject({
      maxUnrequested: 20,
      callAgents: "none",
      costly: "go",
    });
    const again = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { autonomyBrakes: { costly: "ask" } });
    expect(autonomySettings(again.autonomyBrakes)).toMatchObject({
      maxUnrequested: 20,
      callAgents: "none",
      costly: "ask",
    });
  });
});
