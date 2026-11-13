import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { createHttpApi } from "../src/api/http-client";
import type { AgentBrain, AgentSetupResult, Model, NewAgentSetup } from "../src/api/types";
import {
  changes,
  newAgentStart,
  newAgentStartText,
  setupOfBrain,
  setupOutcome,
  setupResultLine,
  sortedResults,
  takers,
} from "../src/lib/agent-setup";

/** Says the key and what it was given, so each line shows which words it picked. */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;
const W = "agentPage.work.brain.copy";
const A = "missions.commandApproval";

describe("Usar em outros agentes", () => {
  const results: AgentSetupResult[] = [
    { agentId: "a", status: "skipped", reason: "not_allowed" },
    { agentId: "b", status: "same" },
    { agentId: "c", status: "applied" },
    { agentId: "d", status: "applied", keeps: { account: "GLM Coding" } },
  ];

  test("who can take it first, then who already thinks so, then who can't; Todos picks who can", () => {
    expect(sortedResults(results).map((r) => r.agentId)).toEqual(["c", "d", "b", "a"]);
    expect(takers(results)).toEqual(["c", "d"]);
  });

  test("each line says what changes, what it keeps or why not, with whose it is", () => {
    const line = (r: AgentSetupResult, owner?: string) => setupResultLine(t, r, { now: "Automático", owner });
    expect(line({ agentId: "c", status: "applied" })).toBe(`${W}.now {"brain":"Automático"}`);
    expect(line({ agentId: "d", status: "applied", keeps: { account: "GLM Coding" } })).toBe(
      `${W}.keeps {"account":"GLM Coding"}`,
    );
    expect(line({ agentId: "d", status: "applied", keeps: { account: null } })).toBe(`${W}.keepsOwn`);
    expect(line({ agentId: "b", status: "same" })).toBe(`${W}.same`);
    expect(line({ agentId: "a", status: "skipped", reason: "not_allowed" }, "Ana")).toBe(
      `${W}.reasons.not_allowed {"owner":"Ana"}`,
    );
    expect(line({ agentId: "a", status: "skipped", reason: "not_allowed" })).toBe(`${W}.reasons.not_allowedNobody`);
    // The account's owner by first name; none: the caller's own account.
    expect(line({ agentId: "a", status: "skipped", reason: "account_owner", params: { owner: "Ana Souza" } })).toBe(
      `${W}.reasons.account_ownerOf {"owner":"Ana"}`,
    );
    expect(line({ agentId: "a", status: "skipped", reason: "account_owner" })).toBe(`${W}.reasons.account_owner`);
    expect(line({ agentId: "a", status: "skipped", reason: "other_computer", params: { computer: "PC" } })).toBe(
      `${W}.reasons.other_computer {"computer":"PC"}`,
    );
    expect(line({ agentId: "a", status: "skipped", reason: "other_computer" })).toBe(`${W}.reasons.other_computerNone`);
    expect(
      line({ agentId: "a", status: "skipped", reason: "model_missing", params: { plan: "GLM Coding", model: "Opus" } }),
    ).toBe(`${W}.reasons.model_missing {"plan":"GLM Coding","model":"Opus"}`);
    expect(line({ agentId: "a", status: "skipped" })).toBe(`${W}.reasons.failed`);
  });

  test("the Autonomia: who changes only it can take it too, its line says from what to what", () => {
    const onPc = { reason: "other_computer", params: { computer: "PC" } } as const;
    const withAutonomy: AgentSetupResult[] = [
      { agentId: "a", status: "skipped", reason: "not_allowed" },
      { agentId: "b", status: "same" },
      { agentId: "f", status: "skipped", ...onPc, autonomy: { from: "always", to: "never" } },
      { agentId: "e", status: "same", autonomy: { from: "always", to: "never" } },
      { agentId: "c", status: "applied", autonomy: { from: "low_risk_auto", to: "never" } },
    ];
    expect(withAutonomy.map(changes)).toEqual([false, false, true, true, true]);
    // Who takes it all, then who takes only the Autonomia, then who has it all already, then who can't.
    expect(sortedResults(withAutonomy).map((r) => r.agentId)).toEqual(["e", "c", "f", "b", "a"]);
    expect(takers(withAutonomy)).toEqual(["f", "e", "c"]);
    const line = (r: AgentSetupResult) => setupResultLine(t, r, { now: "Automático" });
    const change = (from: string, to: string) => `${W}.autonomy {"from":"${A}.${from}","to":"${A}.${to}"}`;
    expect(line({ agentId: "e", status: "same", autonomy: { from: "always", to: "never" } })).toBe(
      `${W}.same · ${change("always", "never")}`,
    );
    expect(line({ agentId: "c", status: "applied", autonomy: { from: "low_risk_auto", to: "never" } })).toBe(
      `${W}.now {"brain":"Automático"} · ${change("low_risk_auto", "never")}`,
    );
    expect(line({ agentId: "f", status: "skipped", ...onPc, autonomy: { from: "always", to: "never" } })).toBe(
      `${W}.reasons.other_computer {"computer":"PC"} · ${change("always", "never")}`,
    );
    // After "Usar": who thinks with it now, who took only the Autonomia, who didn't change (one asked is gone).
    expect(setupOutcome(withAutonomy, 6)).toEqual({ done: 3, autonomyOnly: 1, missed: 2 });
  });

  test("more agents than one call takes go in calls of 200, the results in the order asked", async () => {
    const sent: string[][] = [];
    const api = createHttpApi({
      fetch: async (_url: string, init: RequestInit) => {
        const { agentIds } = JSON.parse(String(init.body)) as { agentIds: string[] };
        sent.push(agentIds);
        const results = agentIds.map((agentId) => ({ agentId, status: "applied" }));
        return new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const ids = Array.from({ length: 201 }, (_, i) => `a${i}`);
    const results = await api.agents.applySetup("o1", { setup: { brain: "model", model: "auto" }, agentIds: ids });
    expect(sent.map((s) => s.length)).toEqual([200, 1]);
    expect(results.map((r) => r.agentId)).toEqual(ids);
  });

  test("on the phone the setup is the agent's saved one, on a computer only", () => {
    const view = {
      brain: "claude_code",
      model: "opus",
      effort: "high",
      contextTokens: 400_000,
      fallback: false,
      onlyOwner: true,
      account: "acc",
      accounts: [],
      computer: { machineId: "m1", name: "MacBook", online: true },
    } as unknown as AgentBrain;
    expect(setupOfBrain(view)).toEqual({
      brain: "claude_code",
      machineId: "m1",
      account: "acc",
      model: "opus",
      effort: "high",
      contextTokens: 400_000,
      fallback: false,
      onlyOwner: true,
    });
    expect(setupOfBrain({ ...view, brain: "model" })).toBeNull();
    expect(setupOfBrain({ ...view, computer: null })).toBeNull();
    // Its Autonomia goes with it.
    expect(setupOfBrain({ ...view, autonomy: "never" })).toMatchObject({ autonomy: "never" });
  });
});

describe("a new agent starts with the last setup", () => {
  const plan: NewAgentSetup = {
    brain: "claude_code",
    model: "opus",
    key: null,
    contextTokens: null,
    computer: { machineId: "m1", name: "MacBook" },
    account: { id: "acc", label: "Claude", provider: null, mine: true, free: true },
    ownSignIn: false,
    effort: "high",
    fallback: true,
  };

  const mine = { ownerIsMe: true, usable: new Set(["claude-opus-5-5"]), keys: [{ id: "k" }] };

  test("the API's model, key and context window while the model runs, for anyone's agent", () => {
    const api = { brain: "model", model: "claude-opus-5-5", key: "k", contextTokens: 400_000 } as const;
    expect(newAgentStart(api, { ...mine, ownerIsMe: false })).toEqual({
      brain: "model",
      model: "claude-opus-5-5",
      key: "k",
      contextTokens: 400_000,
    });
    // A key the person doesn't see: the workspace's default. A model nothing runs now: Automático.
    expect(newAgentStart(api, { ...mine, keys: [] })).toMatchObject({ model: "claude-opus-5-5", key: null });
    expect(newAgentStart(api, { ...mine, usable: new Set() })).toBeNull();
    expect(newAgentStart({ ...api, model: "auto" }, { ...mine, usable: new Set() })).toBeNull();
    expect(newAgentStart({ ...api, model: "auto" }, mine)).toMatchObject({ model: "auto" });
    expect(newAgentStart(null, mine)).toBeNull();
  });

  test("a plan only for an agent of the person's own, on their account with room or their computer's sign-in", () => {
    expect(newAgentStart(plan, mine)).toEqual({
      brain: "claude_code",
      machineId: "m1",
      computer: "MacBook",
      account: { id: "acc", label: "Claude" },
      input: {
        brain: "claude_code",
        account: "acc",
        model: "opus",
        effort: "high",
        contextTokens: null,
        fallback: true,
      },
    });
    expect(newAgentStart(plan, { ...mine, ownerIsMe: false })).toBeNull();
    const theirs = { ...plan, account: { id: "acc", label: "Claude", provider: null, mine: false, free: true } };
    expect(newAgentStart(theirs, mine)).toBeNull();
    const taken = { ...plan, account: { id: "acc", label: "Claude", provider: null, mine: true, free: false } };
    expect(newAgentStart(taken, mine)).toBeNull();
    expect(newAgentStart({ ...plan, account: null, ownSignIn: false }, mine)).toBeNull();
    expect(newAgentStart({ ...plan, account: null, ownSignIn: true }, mine)).toMatchObject({
      account: null,
      input: { account: null },
    });
  });

  test("its Autonomia goes with it only where the person could set it: their own agent, or anyone's for an admin", () => {
    const api = {
      brain: "model",
      model: "claude-opus-5-5",
      key: null,
      contextTokens: null,
      autonomy: "never",
    } as const;
    expect(newAgentStart(api, mine)).toMatchObject({ autonomy: "never" });
    expect(newAgentStart(api, { ...mine, ownerIsMe: false })).not.toHaveProperty("autonomy");
    expect(newAgentStart(api, { ...mine, ownerIsMe: false, admin: true })).toMatchObject({ autonomy: "never" });
    expect(newAgentStart({ ...plan, autonomy: "always" }, mine)).toMatchObject({ autonomy: "always" });
    expect(newAgentStart({ ...api, autonomy: null }, mine)).not.toHaveProperty("autonomy");
    // Where the setup can't think for it, none of it.
    expect(newAgentStart(api, { ...mine, usable: new Set() })).toBeNull();
  });

  test("said as it starts: the API's model by its label, a coding plan's by the plan's own", () => {
    const models = [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }] as Model[];
    const say = (start: Parameters<typeof newAgentStartText>[2], provider?: string) =>
      newAgentStartText(t, "pt-BR", start, { models, machines: [], provider });
    expect(say({ brain: "model", model: "claude-opus-5-5", key: null, contextTokens: null })).toBe("Claude Opus 5.5");
    expect(say({ brain: "model", model: "auto", key: null, contextTokens: null })).toBe("brain.auto.label");
    const glm = {
      brain: "claude_code" as const,
      machineId: "m1",
      computer: "MacBook",
      account: { id: "acc", label: "GLM Coding" },
      input: { brain: "claude_code" as const, model: "sonnet", effort: "medium" as const },
    };
    // The model by the plan that pays for it, never the program it runs in.
    const glmLine = 'brain.line.coding {"model":"GLM-5.3","plan":"GLM Coding"}';
    expect(say(glm, "zai")).toBe(glmLine);
    expect(say(glm)).toBe('brain.line.claude {"model":"sonnet","plan":"aiAccounts.connect.claude_code"}');
    // Then its Autonomia.
    const autonomy = (a: string) => `${A}.changed {"value":"${A}.${a}"}`;
    expect(say({ brain: "model", model: "claude-opus-5-5", key: null, contextTokens: null, autonomy: "never" })).toBe(
      `Claude Opus 5.5 · ${autonomy("never")}`,
    );
    expect(say({ ...glm, autonomy: "always" }, "zai")).toBe(`${glmLine} · ${autonomy("always")}`);
  });
});
