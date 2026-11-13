/**
 * Scripted turns for the token-trim eval: what an agent must still be offered (tools, and the autonomy rules word for
 * word) whatever is trimmed from its prompt. `test/turns-eval.test.ts` runs them on the fake provider (CI);
 * `eval/turns-real.ts` replays them against a real model to compare behavior before and after a prompt change.
 */
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  ASK_APPROVALS_TOGETHER,
  ASK_CHOICES_LINE,
  CONTINUE_THE_CONVERSATION,
  createAgent,
  createAgentStyleToolSource,
  createFeedbackToolSource,
  createSetStatusToolSource,
  createSetupToolSource,
  createUsageToolSource,
  createWebToolSource,
  createWorkspaceToolSource,
  finishWhatYouStart,
  grantScopes,
  HOW_YOU_WORK,
  openDm,
  type ToolSource,
  WORK_IN_BACKGROUND_LINE,
} from "../src";
import { setup } from "../test/fixtures";

/**
 * The autonomy and proactivity rules every run with tools reads, word for word (ADR 0037, 0097, 0113, 0120, 0121).
 * A trim may move them, never change them.
 */
export const AUTONOMY_PHRASES: string[] = [
  HOW_YOU_WORK,
  finishWhatYouStart(true),
  WORK_IN_BACKGROUND_LINE,
  CONTINUE_THE_CONVERSATION,
  ASK_APPROVALS_TOGETHER,
  ASK_CHOICES_LINE,
  "- Something to use rather than read (a what-if, options to see side by side, a view to filter, a short form): show it yourself with show_block, inside your reply; what the person picks comes back to you. A group deciding together: start_poll.",
  '- When the message only acknowledges or thanks and needs no answer ("thanks", "perfect", "ok, go ahead", "I\'ll wait"; in Portuguese "valeu", "perfeito", "ok, pode seguir", "aguardo"), don\'t reply: react with one fitting emoji using `react` and end your turn with an empty reply',
  "- When a request is still ambiguous after you have looked with your tools, or when the decision is really the person's (a product choice, a priority), ask one short clarifying question with `ask_user`",
  "- Actions marked sensitive (merge, deploy, rollback and similar) wait for a person's approval; you will be told the outcome.",
  "When you need another agent's answer for the task, ask it with `ask_agent`; to hand one work, use `tell_agent`, giving the whole job to the agent that owns it with everything it needs. Do this instead of saying you can't or sending the person to it.",
  "- When something took figuring out (several tries, a new API, a script), save how you did it with `save_how_to` before you answer",
  "- A skill you used was wrong, missed a step or hit a pitfall: fix it with `update_skill` before your turn ends, in its language (only skills you used).",
  "Search before saying you can't do something.",
];

export interface ScriptedTurn {
  id: string;
  title: string;
  where: "dm" | "channel";
  /** The person's message ("@dev" is added in a channel). */
  body: string;
  /** Tools the run must list up front. */
  listed: string[];
  /** Tools it must list or find with one `find_tools` search (`query`). */
  reachable?: { tool: string; query: string }[];
  /** What a good answer calls (any of them), for the real-model replay's summary. */
  wants?: string[];
  /** The fake model's first move before answering (a tool call), so the requests after a tool result are checked too. */
  first?: FakeReply;
}

export const TURNS: ScriptedTurn[] = [
  {
    id: "greet-channel",
    title: "A greeting in a channel",
    where: "channel",
    body: "oi",
    listed: ["react", "ask_user", "search_context", "remember"],
  },
  {
    id: "greet-dm",
    title: "A greeting in a DM",
    where: "dm",
    body: "oi",
    listed: ["react", "ask_user", "search_context", "remember"],
  },
  {
    id: "long-work",
    title: "A request that should go to long work",
    where: "dm",
    body: "migra os 40 endpoints da API antiga pro formato novo, roda os testes de cada um e abre um PR no fim",
    listed: ["work_in_background", "post_update", "follow_up"],
    wants: ["work_in_background"],
  },
  {
    id: "correction",
    title: "A correction that should be learned",
    where: "channel",
    body: "na verdade o deploy da API é pelo GitHub Actions, não pela Vercel. Não esquece mais",
    listed: ["remember", "save_how_to", "update_memory", "search_context"],
    wants: ["remember"],
  },
  {
    id: "choice",
    title: "A choice between options",
    where: "dm",
    body: "Postgres ou MySQL pro serviço novo de faturas? é decisão de produto, me ajuda a escolher",
    listed: ["ask_user", "ask_choices", "show_block", "search_context"],
    wants: ["ask_choices", "ask_user", "show_block"],
  },
  {
    id: "block",
    title: "A block-worthy answer",
    where: "channel",
    body: "quanto um cliente economiza no plano anual (R$ 290) contra o mensal (R$ 29)? quero brincar com os números",
    listed: ["show_block", "start_poll"],
    wants: ["show_block"],
  },
  {
    id: "follow-through",
    title: "A proactive follow-through after a tool result",
    where: "channel",
    body: "o deploy de staging terminou? me avisa quando acabar",
    listed: ["follow_up", "search_context", "work_in_background"],
    reachable: [{ tool: "deploy_status", query: "deploy status" }],
    wants: ["follow_up"],
    first: { chunks: [], toolUses: [{ name: "search_context", input: { query: "deploy de staging" } }] },
  },
  {
    id: "computer",
    title: "A computer task that needs a deferred tool",
    where: "dm",
    body: "roda os testes do repositório no teu computador e me diz o que falhou",
    listed: ["find_tools", "use_tool"],
    reachable: [{ tool: "run_code", query: "run a command on my computer" }],
    wants: ["run_code", "find_tools", "use_tool"],
  },
  {
    id: "approval",
    title: "An action that needs a person's approval",
    where: "channel",
    body: "faz o deploy do serviço de pagamentos em produção agora",
    listed: ["ask_user", "find_tools", "use_tool"],
    reachable: [{ tool: "deploy_service", query: "deploy service to production" }],
    wants: ["deploy_service", "find_tools", "use_tool"],
  },
  {
    id: "start-over",
    title: "Starting the team over, with no sign-in to our own app",
    where: "dm",
    body: "Quero apagar todos os outros agentes e vamos reconstruir tudo novamente.",
    listed: ["find_tools", "use_tool"],
    reachable: [{ tool: "propose_remove_agents", query: "archive or delete agents" }],
    wants: ["propose_remove_agents", "find_tools", "use_tool"],
  },
  {
    id: "task",
    title: "A task on our own board",
    where: "dm",
    body: "cria uma tarefa no backlog pra revisar o onboarding",
    listed: ["find_tools", "use_tool"],
    reachable: [{ tool: "create_issue", query: "criar tarefa no backlog" }],
    wants: ["create_issue", "find_tools", "use_tool"],
  },
  {
    id: "feedback",
    title: "Feedback about the app, sent for the person",
    where: "dm",
    body: "manda um feedback pra quem cuida do app: o céu fica escuro demais à noite",
    listed: ["find_tools", "use_tool"],
    reachable: [{ tool: "send_feedback", query: "send feedback about the app" }],
    wants: ["send_feedback", "find_tools", "use_tool"],
  },
  {
    id: "feedback-offer",
    title: "A complaint about the app itself: a report offered, not sent",
    where: "dm",
    body: "mandei a planilha em anexo de novo e ela sumiu, é a terceira vez que o anexo some aqui no app",
    listed: ["find_tools", "use_tool"],
    reachable: [{ tool: "offer_feedback", query: "report a problem with the app" }],
    wants: ["offer_feedback", "find_tools", "use_tool"],
  },
];

/** A made-up deploy connector: one read, one action that asks a person's approval. */
const deploys: ToolSource = {
  name: "deploys",
  tools: async () => [
    {
      name: "deploy_status",
      description:
        "The status of a deploy of one of the company's services (staging or production): running, done or failed, with its step.",
      scope: "deploys:read",
      inputSchema: {
        type: "object",
        properties: { service: { type: "string" }, environment: { type: "string" } },
        additionalProperties: false,
      },
      execute: async () => ({ content: "staging: running, step 6 of 10 (migrations), started 4 min ago" }),
    },
    {
      name: "deploy_service",
      description: "Deploy a service to staging or production.",
      scope: "deploys:run",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: { service: { type: "string" }, environment: { type: "string" }, why: { type: "string" } },
        required: ["service", "environment"],
        additionalProperties: false,
      },
      execute: async () => ({ content: "deployed" }),
    },
  ],
};

/** Every built-in tool source a production agent has, tools on demand, one teammate, the made-up deploy connector. */
export async function turnsWorld(
  options: Pick<NonNullable<Parameters<typeof setup>[0]>, "reply" | "judge" | "workspaceComputer"> = {},
) {
  const f = await setup({
    contextTools: true,
    askUser: true,
    permissionTools: true,
    askAgent: true,
    react: true,
    mediaTools: true,
    followUps: true,
    handOff: true,
    artifactTools: true,
    blockTools: true,
    chatTools: true,
    issueTools: true,
    calendarTools: true,
    skillTools: true,
    scheduleTools: true,
    wikiTools: true,
    machines: true,
    workTools: true,
    toolsOnDemand: true,
    toolSources: [
      createUsageToolSource(),
      createSetStatusToolSource({}),
      createAgentStyleToolSource(),
      createFeedbackToolSource({ to: "feedback@example.com", version: "0.0.0" }),
      createWorkspaceToolSource({}),
      createSetupToolSource({}),
      createWebToolSource({}),
      deploys,
    ],
    ...options,
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "sandbox:run" },
    { connectionId: null, scope: "issues:write" },
    { connectionId: null, scope: "deploys:read" },
    { connectionId: null, scope: "deploys:run" },
  ]);
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Ops",
      handle: "ops",
      role: "DevOps",
      instructions: "Keeps the services running.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  return { ...f, dm };
}

export type TurnsWorld = Awaited<ReturnType<typeof turnsWorld>>;

/** Where a turn is said and its message body. */
export const placeOf = (w: TurnsWorld, turn: ScriptedTurn) =>
  turn.where === "dm"
    ? { channelId: w.dm.id, body: turn.body }
    : { channelId: w.general.id, body: `@dev ${turn.body}` };
