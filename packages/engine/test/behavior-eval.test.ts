import { expect, test } from "bun:test";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import { createFakeProvider, type FakeReply } from "@agenteschat/providers/testing";
import cases from "../eval/behavior-cases.json";
import { deterministicChecks } from "../eval/behavior-checks";
import { CONNECTORS } from "../eval/behavior-fakes";
import { type BehaviorCase, runCase } from "../eval/behavior-run";
import { createFakeJudge } from "../src";

// The behavior eval's harness, driven by the fake provider: the case goes through the
// real engine path (no network). The eval itself (real model) is manual: `bun run eval:behavior`.

const all = cases as unknown as BehaviorCase[];
const byId = (id: string) => all.find((c) => c.id === id) as BehaviorCase;

test("every case is well formed: known presets, connectors and tools", () => {
  const known = new Set([
    ...Object.values(CONNECTORS).flatMap((tools) => tools.map((t) => t.name)),
    "list_issues",
    "create_issue",
    "update_issue",
    "comment_issue",
    "search_context",
    "ask_user",
    "ask_agent",
    "tell_agent",
    "follow_up",
    "list_artifacts",
    "read_artifact",
    "list_files",
    "post_message",
    "send_dm",
    "send_gif",
    "send_sticker",
    "list_routines",
    "update_routine",
    "create_routine",
    "propose_mission",
    "add_agent_to_channel",
    "update_thread",
    "create_artifact",
    "show_block",
    "start_poll",
    "hand_off",
    "pass",
  ]);
  const ids = new Set<string>();
  for (const c of all) {
    expect(ids.has(c.id), c.id).toBe(false);
    ids.add(c.id);
    expect(c.expect.behavior.length, c.id).toBeGreaterThan(20);
    if (c.agent.preset) expect(["dev", "ops", "qa", "pm"]).toContain(c.agent.preset);
    for (const id of c.connectors ?? []) expect(Object.keys(CONNECTORS)).toContain(id);
    const tools = [
      ...Object.keys(c.fixtures ?? {}),
      // "a+key": the tool `a`, called with `key`.
      ...(c.expect.mustCall ?? []).flatMap((g) => g.split("|").map((t) => t.split("+")[0] ?? t)),
      ...(c.expect.mustNotExecute ?? []),
      ...(c.expect.mustNotCall ?? []),
      ...(c.expect.approval ?? []),
    ];
    for (const t of tools) expect(known.has(t), `${c.id}: ${t}`).toBe(true);
  }
});

/** A scripted model: one reply per call, in order. */
const script = (replies: FakeReply[]) => createFakeProvider((_req, n) => replies[n - 1] ?? { chunks: ["(done)"] });

/** Every approval request says why (ADR 0053 §8): the scripted merges give a reason. */
const MERGE_WHY = "PR #70 fixes the annual promo price; checks pass and the review approved it.";

test("a case runs through the real engine: prompt, fake connector tools, transcript", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [{ name: "github_search_code", input: { query: "subscription_completed repo:lumen/app" } }],
    },
    {
      chunks: [],
      toolUses: [
        {
          name: "github_get_file_contents",
          input: { owner: "lumen", repo: "app", path: "src/review/review-prompt.ts" },
        },
      ],
    },
    { chunks: ["O pedido dispara em src/review/review-prompt.ts:40 no subscription_completed. Abro um PR que move."] },
  ]);
  const c = byId("dev-review-prompt-subscription");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 6 });

  // The engine's prompt: the preset's instructions, the org context, the granted tools.
  expect(run.system).toContain("Ada (@ada)");
  expect(run.system).toContain("Lumen é um app");
  expect(run.system).toContain("`github_get_file_contents`");
  expect(run.system).toContain("Investiga primeiro");
  const request = provider.calls[0]?.request;
  expect(request?.tools?.map((t) => t.name)).toContain("github_merge_pull_request");
  expect(provider.calls[0]?.apiKey).toBe("sk-ant-fake-key-1234");

  expect(run.calls.map((t) => [t.name, t.executed])).toEqual([
    ["github_search_code", true],
    ["github_get_file_contents", true],
  ]);
  expect(run.calls[1]?.result).toContain("StoreReview.requestReview()");
  expect(run.turns).toHaveLength(3);
  expect(run.reply).toContain("review-prompt.ts:40");
  expect(run.status).toEqual(["done"]);
  expect(run.costNanoUsd).toBeGreaterThan(0);
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("a sensitive call becomes an approval request and never runs", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [
        { name: "github_merge_pull_request", input: { owner: "lumen", repo: "api", pullNumber: 70, why: MERGE_WHY } },
      ],
    },
  ]);
  const c = byId("dev-merge-pr-sensitive");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.approvals).toEqual(["github_merge_pull_request"]);
  expect(run.calls).toMatchObject([{ name: "github_merge_pull_request", executed: false }]);
  expect(run.status).toEqual(["waiting_approval"]);
  const checks = deterministicChecks(c.expect, run);
  expect(checks.find((k) => k.id === "no_sensitive_action")?.pass).toBe(true);
  expect(checks.find((k) => k.id === "requested_approval")?.pass).toBe(true);
});

test("a routine run: background work from its brief, the conversation it reports to is read, no hand_off posts nothing", async () => {
  const provider = script([
    { chunks: [], toolUses: [{ name: "sentry_search_issues", input: { query: "is:unresolved firstSeen:-1h" } }] },
    { chunks: ["Nada novo: só o LUMEN-API-3A1, estável."] },
  ]);
  const c = byId("ops-sentry-routine-nothing-new");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.system).toContain("This is a routine run");
  expect(run.tools).toContain("hand_off");
  // Only the routine started a run: the agent's old reply is what was said where the report goes.
  expect(run.status).toEqual(["done"]);
  expect(run.system).toContain("# Where your report goes");
  expect(run.system).toContain("Sigo acompanhando LUMEN-API-3A1");
  expect(run.routineRun?.status).toBe("silent");
  expect(run.noReply).toBe(true);
  expect(run.reply).toBe("");
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("a good-morning GIF routine: hand_off takes `gif`, and its message goes with the GIF (ADR 0091)", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [{ name: "hand_off", input: { message: "Bom dia, pessoal! ☕", gif: "good morning coffee" } }],
    },
    { chunks: ["Bom dia enviado com GIF de café."] },
  ]);
  const c = byId("routine-good-morning-gif");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  const handOff = provider.calls[0]?.request.tools?.find((t) => t.name === "hand_off");
  expect(Object.keys((handOff?.inputSchema.properties ?? {}) as Record<string, unknown>)).toContain("gif");
  expect(handOff?.description).toContain("Never paste a link to a GIF site");
  expect(run.calls).toMatchObject([{ name: "hand_off", executed: true }]);
  expect(run.calls[0]?.isError).toBeFalsy();
  expect(run.calls[0]?.result).toStartWith("Posted with a GIF.");
  expect(run.routineRun?.status).toBe("reported");
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("a routine (ADR 0109: every routine acts): routine changes aren't listed, a mail send asks a person", async () => {
  const provider = script([
    { chunks: [], toolUses: [{ name: "mail_suporte_read", input: { id: "m_102" } }] },
    { chunks: ["Nada para reportar."] },
  ]);
  const c = byId("support-inbox-hostile-email");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.tools).toContain("mail_suporte_read");
  expect(run.tools).toContain("hand_off");
  expect(run.tools).not.toContain("update_routine");
  expect(run.tools).toContain("mail_suporte_send");
  // Mail reaches the model as untrusted email content, as the real mailbox tools give it.
  expect(run.calls[0]?.result).toContain('<email_content untrusted="true">');
});

test("a routine that may act: a rollback is an approval request with its why, never run", async () => {
  const why = "LUMEN-API-9E4 since api@3.8.0 (25 min ago): every checkout fails. Back to dep_9c7 (api@3.7.4).";
  const provider = script([
    { chunks: [], toolUses: [{ name: "railway_rollback", input: { service: "api", deploymentId: "dep_9c7", why } }] },
  ]);
  const c = byId("ops-routine-act-approval");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.approvals).toEqual(["railway_rollback"]);
  expect(run.approvalReasons).toEqual([{ tool: "railway_rollback", why }]);
  expect(run.calls).toMatchObject([{ name: "railway_rollback", executed: false }]);
  expect(run.cards).toContain(why);
  const checks = deterministicChecks(c.expect, run);
  for (const id of ["requested_approval", "no_sensitive_action", "approval_says_why"]) {
    expect(checks.find((k) => k.id === id)?.pass, id).toBe(true);
  }
});

test("a consultation case: the agent answers another agent's question as the person behind it", async () => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const provider = createFakeProvider((req, n) => {
    if (n === 1) return { chunks: [], toolUses: [{ name: "list_routines", input: {} }] };
    if (n === 2) {
      const id = uuid.exec(JSON.stringify(req.messages.at(-1)?.content))?.[0] ?? "";
      return { chunks: [], toolUses: [{ name: "update_routine", input: { id, prompt: "Peça à @ada uma análise." } }] };
    }
    return { chunks: ["Ajustei a rotina: erros novos vão para a Ada analisar na issue."] };
  });
  const c = byId("ops-consulted-on-behalf-edits-routine");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 6 });
  expect(run.system).toContain("A private conversation between agents");
  expect(run.calls.map((t) => [t.name, t.executed, t.isError])).toEqual([
    ["list_routines", true, false],
    ["update_routine", true, false],
  ]);
  expect(run.triggered).toEqual([]);
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("act with undo: the issue is a receipt on the reply while the merge waits for approval", async () => {
  const provider = script([
    {
      chunks: [],
      toolUses: [
        { name: "create_issue", input: { title: "Preço do plano anual", assignee: "me" } },
        { name: "github_merge_pull_request", input: { owner: "lumen", repo: "api", pullNumber: 70, why: MERGE_WHY } },
      ],
    },
  ]);
  const c = byId("dev-organize-and-merge");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.system).toContain("Done right away, no approval");
  expect(run.receipts).toEqual(["issue.created"]);
  expect(run.approvals).toEqual(["github_merge_pull_request"]);
  const checks = deterministicChecks(c.expect, run);
  for (const id of ["acted_with_undo", "requested_approval", "no_sensitive_action", "no_needless_question"]) {
    expect(checks.find((k) => k.id === id)?.pass, id).toBe(true);
  }
});

test("a mission proposal carries what the agent read; one without findings is refused by the schema", async () => {
  const proposal = {
    title: "Pedido de avaliação no momento certo",
    goal: "Tirar o pedido de avaliação do subscription_completed e mostrar após a primeira meditação concluída.",
    findings: [
      {
        kind: "read",
        text: "O pedido dispara em review-prompt.ts:40, no subscription_completed.",
        refs: ["src/review/review-prompt.ts:40"],
      },
      { kind: "decision", text: "Conta como concluída a meditação até o fim ou a partir de 80%?" },
    ],
    plan: ["Tirar o gatilho do subscription_completed", "Disparar após a primeira meditação", "Teste e PR"],
  };
  const provider = script([
    { chunks: [], toolUses: [{ name: "github_search_code", input: { query: "subscription_completed" } }] },
    { chunks: [], toolUses: [{ name: "propose_mission", input: { title: "x", goal: "y", findings: [] } }] },
    { chunks: [], toolUses: [{ name: "propose_mission", input: proposal }] },
    {
      chunks: [
        "Propus a missão: o pedido dispara em review-prompt.ts:40. Falta só decidir o que conta como concluída.",
      ],
    },
  ]);
  const c = byId("dev-mission-arrives-investigated");
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 6 });
  expect(run.calls.map((k) => [k.name, k.executed])).toEqual([
    ["github_search_code", true],
    ["propose_mission", false],
    ["propose_mission", true],
  ]);
  const checks = deterministicChecks(c.expect, run);
  expect(checks.find((k) => k.id === "mission_investigated")).toMatchObject({ pass: true });
  expect(checks.find((k) => k.id === "cites_evidence")?.pass).toBe(true);
});

test("a router case: nobody named the agent, it may pass; passing posts nothing and grades as a pass", async () => {
  const c = byId("router-pass-already-answered");
  const provider = script([{ chunks: [], toolUses: [{ name: "pass", input: { reason: "@dev already answered" } }] }]);
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.error).toBeUndefined();
  expect(run.tools).toContain("pass");
  // Another agent's earlier answer (`@dev` in the case) is history the agent reads.
  expect(JSON.stringify(run.turns[0]?.text ?? "")).not.toContain("NO_REPLY");
  expect(run.passed).toBe(true);
  expect(run.reply).toBe("");
  const checks = deterministicChecks(c.expect, run);
  expect(checks.find((k) => k.id === "passes_when_nothing_to_add")?.pass).toBe(true);
  expect(checks.find((k) => k.id === "no_silence_word")?.pass).toBe(true);
});

test("called by name in a DM: no pass tool; the silence word is never posted", async () => {
  const c = byId("dm-thanks-never-silent");
  // It tries the silence word: nudged once, then it answers.
  const provider = script([{ chunks: ["NO_REPLY"] }, { chunks: ["Por nada!"] }]);
  const run = await runCase(c, { apiKey: "sk-ant-fake-key-1234", provider, maxToolTurns: 4 });
  expect(run.tools).not.toContain("pass");
  expect(run.reply).toBe("Por nada!");
  const checks = deterministicChecks(c.expect, run);
  expect(checks.find((k) => k.id === "answers_when_called")?.pass).toBe(true);
  expect(checks.find((k) => k.id === "no_silence_word")?.pass).toBe(true);
});

test("agents working together: colleagues really run, one is held until a step lets it go, and the case sees it all", async () => {
  const c = byId("status-while-colleague-works");
  const youAre = (req: ModelRequest, name: string) =>
    systemText(req.system).includes(`You are ${name} (@${name.toLowerCase()})`);
  const provider = createFakeProvider((req): FakeReply => {
    const last = JSON.stringify(req.messages.at(-1)?.content);
    if (youAre(req, "Diogo")) return { chunks: ["Recebi as notas da Acme, da Borba e do Cais, abri tudo."] };
    if (youAre(req, "Rita"))
      return last.includes("tool_result")
        ? { chunks: ["Passei ao Diogo as notas dos 3 clientes, e ele confirmou que abriu."] }
        : {
            chunks: [],
            toolUses: [
              { name: "tell_agent", input: { agent: "@diogo", message: "Acme, Borba e Cais: as notas de cada um." } },
            ],
          };
    if (last.includes("did with the work you handed it"))
      return { chunks: ["Pronto: a Rita passou ao Diogo as notas dos 3 clientes, e ele confirmou."] };
    if (last.includes("como ficou")) return { chunks: ["A Rita ainda está nisso, desde agora há pouco."] };
    if (last.includes("tool_result")) return { chunks: ["Pedi à Rita: ela já está nisso."] };
    return {
      chunks: [],
      toolUses: [
        {
          name: "tell_agent",
          input: { agent: "@rita", message: "Passa ao Diogo tudo o que sabes dos teus clientes." },
        },
      ],
    };
  });
  const run = await runCase(c, {
    apiKey: "sk-ant-fake-key-1234",
    provider,
    maxToolTurns: 6,
    lang: "pt",
    judge: createFakeJudge((kind) => (kind === "note_reply" ? 0.9 : undefined)),
  });
  expect(run.error).toBeUndefined();
  expect(run.handOffs).toEqual({ "chefe>rita": 1, "rita>diogo": 1 });
  expect(run.agentRuns).toEqual({ all: 5, chefe: 3, rita: 1, diogo: 1 });
  expect(run.personSaw).toEqual({ agentMessages: 3, noteLines: 0 });
  // Asked while Rita was held, Chefe said who has it, and asked nobody again.
  expect(run.stepChecks?.find((k) => k.id === "step2:no_forbidden_call")).toMatchObject({ pass: true });
  expect(run.transcript).toContain("[Marina]: E aí, como ficou?");
  expect(run.transcript).toContain("A Rita ainda está nisso");
  expect(run.transcript?.split("\n").at(-1)).toContain("Pronto: a Rita passou ao Diogo");
  // Only the agent under test's turns are its own.
  expect(run.turns.every((t) => !t.text.includes("Recebi as notas"))).toBe(true);
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});

test("another agent's note as the trigger: the real tell_agent, and whether what came of it went back", async () => {
  const c = byId("note-announces-work");
  const provider = createFakeProvider(
    (): FakeReply => ({ chunks: ["Combinado, assumo os clientes da Rita assim que chegarem."] }),
  );
  const run = await runCase(c, {
    apiKey: "sk-ant-fake-key-1234",
    provider,
    maxToolTurns: 4,
    lang: "en",
    // An acknowledgement: nothing for the sender.
    judge: createFakeJudge((kind) => (kind === "note_reply" ? 0.1 : undefined)),
  });
  expect(run.error).toBeUndefined();
  expect(run.system).toContain("handed you work or news (`tell_agent`)");
  expect(JSON.stringify(provider.calls[0]?.request.messages)).toContain(
    "Rita will send you her folder and notes shortly",
  );
  expect(run.handOffs).toEqual({ "chefe>diogo": 1 });
  expect(run.reported).toBe(false);
  expect(deterministicChecks(c.expect, run).filter((k) => !k.pass)).toEqual([]);
});
