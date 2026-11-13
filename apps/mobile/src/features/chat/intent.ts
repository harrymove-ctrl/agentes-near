import type { Agent, Message } from "@agenteschat/client";
import type { IconName } from "@/ui";
import { approvalIdOf, artifactsOf, questionOf } from "./logic";

/**
 * What the conversation offers next: the
 * composer's suggestions come from the latest card in the conversation, not a fixed list; an agent's
 * first conversation introduces it in plain words and offers three first requests tied to what it does.
 * Pure: the screen turns the keys into text (`mobile.chat.intent.*`).
 */

// ── Composer suggestions ─────────────────────────────────────────────────────

export type SuggestionKey = "merge" | "review" | "seeChange" | "summarize" | "nextStep";

export interface Suggestion {
  icon: IconName;
  /** Under `mobile.chat.intent.suggest.*`. */
  key: SuggestionKey;
  values?: Record<string, string>;
}

export interface SuggestInput {
  /** The conversation's messages, oldest first (as the screen lists them). */
  messages: Message[];
  meId: string | null;
  /** People in the workspace (a code change can be handed to one the agent named). */
  people: { id: string; name: string }[];
}

/** A pull request or a merge in an agent's words: "PR #128", "pull request", a GitHub pull link. */
const CODE = /\bPR\s*#?\d+|\bpull request\b|github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+|\bmerge\b/i;

export const mentionsCodeChange = (text: string) => CODE.test(text);

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The first person (not me) the text names by first name, as a whole word. */
export function personNamed(text: string, people: SuggestInput["people"], meId: string | null) {
  const words = new Set(fold(text).split(/[^a-z0-9]+/));
  for (const p of people) {
    if (p.id === meId) continue;
    const first = fold(p.name.trim().split(/\s+/)[0] ?? "");
    if (first.length >= 2 && words.has(first)) return p;
  }
  return null;
}

/**
 * 2–3 suggestions from the latest message, or none: nothing while the latest is a person's (the agent is
 * on it), a request to approve or an open question (the card asks), or a plain reply.
 * After a code change: merge it, have the person the agent named review it, see the change.
 * After a file: summarize it, the next step.
 */
export function composerSuggestions({ messages, meId, people }: SuggestInput): Suggestion[] {
  const last = [...messages].reverse().find((m) => !m.local && !m.meta?.issueTaken);
  if (last?.author.type !== "agent") return [];
  if (approvalIdOf(last.meta)) return [];
  const q = questionOf(last.meta);
  if (q && q.status !== "answered") return [];
  if (mentionsCodeChange(last.body)) {
    const who = personNamed(last.body, people, meId);
    return [
      { icon: "check", key: "merge" },
      ...(who ? [{ icon: "reply" as const, key: "review" as const, values: { name: firstName(who.name) } }] : []),
      { icon: "code", key: "seeChange" },
    ];
  }
  if (artifactsOf(last.meta).some((f) => !f.deleted)) {
    return [
      { icon: "list", key: "summarize" },
      { icon: "target", key: "nextStep" },
    ];
  }
  return [];
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

// ── First conversation with an agent ─────────────────────────────────────────

/** What an agent does, as one plain sentence ("Responde os clientes no e-mail."), or null. */
export function plainWhat(instructions: string | null | undefined): string | null {
  const line = (instructions ?? "")
    .split("\n")
    // Headings name a section ("# Função"), they don't say what it does.
    .filter((l) => !/^\s*#/.test(l))
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, "")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .find((l) => l.length > 0);
  if (!line) return null;
  const sentence = (/^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line).trim();
  if (sentence.length < 8 || sentence.length > 160) return null;
  // A prompt ("Você é…", "You are…") is not how a colleague introduces itself.
  if (/^(voce e|voces sao|you are|act as|aja como|atue como)\b/.test(fold(sentence))) return null;
  const text = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return /[.!?]$/.test(text) ? text.replace(/!$/, ".") : `${text}.`;
}

export type AgentIntro = { kind: "what"; text: string } | { kind: "role"; role: string } | { kind: "none" };

/** How a new agent introduces itself: what it does in its own words, else its role. */
export function agentIntro(agent: Pick<Agent, "role" | "instructions">): AgentIntro {
  const what = plainWhat(agent.instructions);
  if (what) return { kind: "what", text: what };
  const role = agent.role.trim();
  return role ? { kind: "role", role } : { kind: "none" };
}

/** Joined less than two weeks ago: "chegou na equipe". */
export const isNewAgent = (createdAt: string, now = Date.now(), days = 14) =>
  now - new Date(createdAt).getTime() < days * 86_400_000;

export const FIRST_ASK_KINDS = [
  "support",
  "ops",
  "qa",
  "dev",
  "research",
  "writing",
  "product",
  "sales",
  "general",
] as const;
export type FirstAskKind = (typeof FIRST_ASK_KINDS)[number];

/** Words (accents and case folded) that tell what an agent does; the first kind that matches wins. */
const KIND_WORDS: [FirstAskKind, RegExp][] = [
  ["support", /\b(atend\w*|suporte|support|clientes?|customers?|tickets?|sac|helpdesk)\b/],
  ["ops", /\b(ops|devops|sre|infra\w*|operac\w*|operations?|servidor\w*|servers?|deploys?|monitor\w*|uptime)\b/],
  ["qa", /\b(qa|testes?|tests?|testing|qualidade|quality)\b/],
  [
    "dev",
    /\b(dev|devs|developer|desenvolv\w*|codigo|code|coding|programa\w*|engenh\w*|engineer\w*|bugs?|github|frontend|backend|pull requests?)\b/,
  ],
  ["research", /\b(pesquis\w*|research\w*|mercado|market|concorr\w*|competitors?|analis\w*|analyst|analytics)\b/],
  ["writing", /\b(relatorios?|reports?|escrev\w*|writ\w*|redac\w*|redator\w*|conteudo|content|blog|textos?|copy)\b/],
  ["product", /\b(pm|produto|product|roadmap|issues?|planej\w*|projetos?|projects?|backlog)\b/],
  ["sales", /\b(vendas?|vend\w*|sales|leads?|comercial|marketing|campanhas?|campaigns?|prospec\w*)\b/],
];

/** What kind of work the agent does, from its role first and then its instructions. */
export function firstAskKind(agent: Pick<Agent, "role" | "instructions">): FirstAskKind {
  for (const text of [agent.role, agent.instructions]) {
    const folded = fold(text ?? "");
    for (const [kind, re] of KIND_WORDS) if (re.test(folded)) return kind;
  }
  return "general";
}

export interface FirstAsk {
  icon: IconName;
  /** Under `mobile.chat.intent.first.<kind>.*`: how it works, a first task, something every week. */
  key: `${FirstAskKind}.${"how" | "task" | "routine"}`;
}

/** Three first requests tied to what the agent does: a question, a first task and a routine. */
export function firstAsks(agent: Pick<Agent, "role" | "instructions">): FirstAsk[] {
  const kind = firstAskKind(agent);
  return [
    { icon: "help", key: `${kind}.how` },
    { icon: "pen", key: `${kind}.task` },
    { icon: "clock", key: `${kind}.routine` },
  ];
}
