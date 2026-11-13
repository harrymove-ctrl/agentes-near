import type {
  Agent,
  AppNotification,
  Approval,
  Message,
  Mission,
  MissionDecision,
  ThreadInfo,
} from "@agenteschat/client";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { withMobileKeys } from "../../src/i18n/merge";

/** Small builders for the screens' pure logic (only the fields each test cares about change). */

/** The app's `t` in one language: the shared strings with the phone's own, as the app merges them. */
export async function translator(lng: "pt-BR" | "en"): Promise<TFunction> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: "pt-BR",
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    interpolation: { escapeValue: false },
  });
  return i18n.t;
}

export const at = (minutesAgo: number, now = new Date(2026, 9, 17, 15, 0)) =>
  new Date(now.getTime() - minutesAgo * 60_000).toISOString();

export function message(over: Partial<Message> & { id: string }): Message {
  return {
    channelId: "c1",
    threadId: null,
    author: { type: "person", id: "u1" },
    body: "oi",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: at(10),
    ...over,
  };
}

export function thread(over: Partial<ThreadInfo> & { id: string }): ThreadInfo {
  return {
    channelId: "c1",
    channelName: "produto",
    channelKind: "channel",
    title: null,
    rootText: "Erro no login com Google",
    rootAuthor: { type: "person", id: "u1" },
    state: "open",
    createdBy: null,
    closedBy: null,
    closedAt: null,
    archivedBy: null,
    archivedAt: null,
    context: null,
    replyCount: 1,
    lastActivityAt: at(5),
    lastMessage: null,
    participants: [{ type: "person", id: "u1" }],
    working: false,
    needsYou: false,
    openedByReplyAt: null,
    suggestedResolved: false,
    canManage: true,
    createdAt: at(30),
    ...over,
  };
}

export function notification(over: Partial<AppNotification> & { id: string }): AppNotification {
  return {
    kind: "mention",
    waiting: false,
    actors: [{ type: "user", id: "u2" }],
    count: 1,
    source: { channelId: "c1" },
    latest: { text: "Walter, prefere o post com ou sem foto?" },
    readAt: null,
    doneAt: null,
    snoozedUntil: null,
    createdAt: at(20),
    updatedAt: at(20),
    ...over,
  };
}

export function approval(over: Partial<Approval> & { id: string }): Approval {
  return {
    runId: "r1",
    agentId: "a1",
    channelId: "c1",
    threadId: "m1",
    messageId: null,
    tool: "github_merge_pull_request",
    scope: "github:pulls.merge",
    title: "Merge PR #42 into main",
    detail: "",
    params: {},
    status: "pending",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    decidedByUserId: null,
    decidedAt: null,
    reason: null,
    canDecide: true,
    ...over,
  };
}

export function mission(over: Partial<Mission> & { id: string }): Mission {
  return {
    threadId: "t1",
    channelId: "c1",
    agentId: "a1",
    ownerId: "u1",
    executor: "claude",
    title: "App no celular",
    goal: "Construir o app",
    findings: [],
    openQuestion: null,
    status: "active",
    repoDir: "",
    resumeTasks: true,
    commandApproval: "low_risk_auto",
    plan: { version: 1, done: 0, total: 0, waiting: 0, doing: 0, items: [] },
    pending: { decisions: 0, provisional: 0, reviews: 0, suggestions: 0, joinRequests: 0, commands: 0 },
    joinRequested: false,
    runningTasks: 0,
    machine: null,
    needsComputer: false,
    role: "owner",
    canAct: true,
    canManage: true,
    createdAt: at(60),
    startedAt: at(50),
    pausedAt: null,
    closedAt: null,
    closeReason: null,
    wikiPageId: null,
    ...over,
  };
}

export function decision(over: Partial<MissionDecision> & { id: string }): MissionDecision {
  return {
    missionId: "m1",
    taskId: null,
    messageId: null,
    question: "Ao abrir, o app vai para o Início ou para a última conversa?",
    options: ["Início", "Última conversa"],
    recommendation: "Início",
    why: null,
    impact: null,
    blocking: false,
    status: "pending",
    chosen: null,
    chosenBy: null,
    chosenAt: null,
    opinions: [],
    createdAt: at(5),
    ...over,
  };
}

export function agent(over: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    handle: over.name.toLowerCase(),
    role: "",
    instructions: "",
    model: "m",
    ownerUserId: null,
    hasCredential: true,
    createdAt: at(1000),
    ...over,
  };
}
