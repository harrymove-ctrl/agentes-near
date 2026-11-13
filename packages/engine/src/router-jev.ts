import { cutText } from "./format";
import { callJev, type JevKeySource, JevOffError } from "./jev-key";
import {
  asksAddressee,
  ROUTER_MESSAGE_CHARS,
  RouterChainEnd,
  RouterSkip,
  type RouterStrategy,
  type RoutingInput,
  type RoutingResult,
  SOCIAL_REACTIONS,
  SPOKEN_TO,
  socialChoice,
  withAddressee,
} from "./router";

/**
 * TypeSafe Jev (System One) as a router strategy (docs/adr/0013-router.md):
 * one request to `POST https://api.typesafe.ai/v1/systemone` with the
 * conversation as `state` and, in parallel, one Noul per candidate ("should
 * <agent> answer?"), a Noul for "does this need any agent?", and, with two or
 * more candidates, a Noul for "is it for every agent?", a Choice over the
 * candidates plus "none" to break ties (its pick, `best`, also says how clearly
 * a message fits one agent), and, for a person's message, one for
 * "which agent does it speak to?" (`asksAddressee`, `withAddressee`).
 * It only scores; policy stays in `selectAgents`. Optional (needs the
 * installation's Jev key, ADR 0073), and the first step of `routeChain`:
 * on an error or a timeout the next step decides.
 *
 * Questions are in English (Jev's primary training language); the
 * conversation goes in as written.
 */
export interface JevUsage {
  orgId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Jev price: $0.042 per million input tokens ($42 per billion); output tokens are free
 * (docs.typesafe.ai/models, 2026-10). In nano-USD per token like the catalog (USD per million × 1000): 42.
 */
export const JEV_NANO_USD_PER_INPUT_TOKEN = 42;
export const jevCostNanoUsd = (inputTokens: number) => Math.round(inputTokens * JEV_NANO_USD_PER_INPUT_TOKEN);

const NONE = "none";

/**
 * How to read the state and who a message is for: the small model's rules too (`ROUTER_SYSTEM`). Built per
 * call: loading `router.ts` first loads this module before `SPOKEN_TO` exists (router.ts → messages.ts →
 * judge.ts → here).
 */
const whoFor = () =>
  `People are written by name, agents as @handle, and \`names\` lists who a message names, by @ or by name. \`latest_message\` may hold a few messages the same person sent in a row, one per line: they are one message. Messages a person sends in a row continue the same address: after "boa tarde walter", "como está hoje" is still for Walter. A message to a person, by @ or by name, is for that person, not for an agent. Greetings and small talk between people get no agent. When \`alone_with\` names an agent, the author is the only person in the channel with it: what they write to the room is for it. ${SPOKEN_TO}`;

/** Who talks to whom (ADR 0159): in a personal workspace the person mostly talks to their agents. */
const TEAM_CHAT = "People in a team chat mostly talk among themselves";
const PERSONAL_CHAT =
  "Here one person (and maybe their family) mostly talks to their agents, though family members may also talk among themselves";

interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export function createJevRouterStrategy(options: {
  /** Read on every call (`jev-key.ts`): without one it throws `JevOffError`. */
  key: JevKeySource;
  /** Records the call's usage (kind `router`, provider `typesafe`). */
  recordUsage(usage: JevUsage): Promise<void>;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): RouterStrategy {
  return {
    name: "jev",
    on: () => typeof options.key === "string" || options.key.usable(),
    async decide(input: RoutingInput): Promise<RoutingResult> {
      const handles = input.candidates.map((c) => c.handle);
      const state = {
        channel: { name: input.channel.name, topic: input.channel.topic || null, direct_message: false },
        recent_messages: input.thread.map((m) => ({ from: m.author, names: m.names ?? [], text: m.body })),
        latest_message: {
          from: input.message.author,
          names: input.message.names ?? [],
          text: cutText(input.message.body, ROUTER_MESSAGE_CHARS),
        },
        agent_just_talking: input.continuityHandle ? `@${input.continuityHandle}` : null,
        alone_with: input.aloneWith ? `@${input.aloneWith}` : null,
        agents_in_channel: input.candidates.map((c) => ({
          handle: `@${c.handle}`,
          name: c.name,
          role: c.role || null,
          about: c.about || null,
          can: c.can ?? null,
        })),
      };
      const questions: Record<string, unknown> = {
        needs_agent: {
          type: "noul",
          instructions: `Should any AI agent reply to \`latest_message\`? ${whoFor()} ${input.personal ? PERSONAL_CHAT : TEAM_CHAT}: an agent should reply only when the message speaks to an agent (by @, by name or by its role), asks the agents or anyone something an agent can help with ("does anyone know…", "alguém sabe…"), speaks to the agents as a group, or continues a conversation with an agent. Also yes when the person insists or complains that nobody answered ("alô???", "ninguém vai responder?", a greeting again after nobody answered the first): they want an agent's reply. Otherwise, when unsure, no.`,
          criteria: {
            true: "The message is for an agent or needs an agent's answer, or the person insists that nobody answered.",
            false: "People talking to each other, or unclear; no agent should interrupt.",
          },
        },
      };
      input.candidates.forEach((c, i) => {
        questions[`agent_${i}`] = {
          type: "noul",
          instructions: {
            agent: {
              handle: `@${c.handle}`,
              name: c.name,
              role: c.role || null,
              about: c.about || null,
              can: c.can ?? null,
            },
            question: `Should \`agent\` reply to \`latest_message\`? ${whoFor()} Yes when the message speaks to this agent, even when what it asks needs another agent: it can ask that one. When it speaks to no agent in particular, yes when it asks this agent or anyone something its role and what it \`can\` do cover, or follows up on a conversation this agent was just part of (see \`agent_just_talking\`). Also yes when it speaks to all the agents or the whole room ("everyone", "all of you", "gente", "vocês", "agentes") and each one has its own answer about itself (its name, its own usage limit, its status): then every agent should reply. No when it speaks to another agent, even when it names this one as someone to ask, involve or hand over to; when it is for a person; when it is a greeting or small talk not to this agent; and when it speaks to no agent in particular and this agent can't actually help with it, or it is about an app or tool (Sentry, GitHub, the Drive…) that is not in its \`can\`: it has no access to it.`,
          },
          criteria: {
            true: "This agent should answer (alone, or along with the others when the message is for all of them).",
            false: "This agent should stay quiet.",
          },
        };
      });
      if (input.thread.length > 0) {
        questions.already_answered = {
          type: "noul",
          instructions:
            "Has an AI agent in `recent_messages` already answered what `latest_message` asks, so another agent's answer would just repeat it?",
          criteria: {
            true: "An agent already answered this; a second answer would be a duplicate.",
            false: "It is a new question or request that nobody answered yet.",
          },
        };
      }
      if (input.candidates.length >= 2) {
        questions.for_everyone = {
          type: "noul",
          instructions:
            'Does `latest_message` speak to all the agents (or the whole room: "everyone", "all of you", "gente", "vocês", "agentes") so that each one should give its own answer about itself (its name, its own usage limit, its status)? A question or task with one answer (a number, a report, a fix) is for one agent, even when several could do it. Something they share (the workspace computer, a repo, the team numbers) has one answer, even when the message says "our" or comes right after a question to each of them.',
          criteria: {
            true: "Every agent should answer for itself.",
            false: "One answer is enough: one agent should take it.",
          },
        };
        const criteria: Record<string, string> = {};
        for (const c of input.candidates)
          criteria[c.handle] =
            `${c.name}${c.role ? `, ${c.role}` : ""}${c.about ? `: ${cutText(c.about, 200)}` : ""}${c.can ? ` (can use: ${c.can})` : ""}`;
        criteria[NONE] = "No agent should reply.";
        questions.best_agent = {
          type: "choice",
          instructions: `Which agent is best placed to reply to \`latest_message\`? ${whoFor()}`,
          criteria,
        };
      }
      if (asksAddressee(input)) {
        const spoken: Record<string, string> = {};
        for (const c of input.candidates) spoken[c.handle] = `${c.name} (@${c.handle})${c.role ? `, ${c.role}` : ""}`;
        spoken[NONE] = "No agent in particular.";
        questions.addressee = {
          type: "choice",
          instructions: `Which agent does \`latest_message\` speak to? ${whoFor()} The agent the person was just talking to is \`agent_just_talking\`. \`${NONE}\` when it speaks to no agent in particular: to a person, to anyone, to all the agents, or a follow-up that names nobody.`,
          criteria: spoken,
        };
      }
      if (input.authorUserId !== null) {
        questions.social = {
          type: "choice",
          instructions: `Is \`latest_message\` purely social, needing no real answer, and which emoji fits it as a reaction? ${whoFor()} \`${NONE}\` when it asks or says anything that needs an answer, or the person wants an actual reply: they insist, or complain that nobody answered ("alô???", "ninguém vai responder?", a greeting again after nobody answered the first).`,
          criteria: { ...SOCIAL_REACTIONS, [NONE]: "Needs a real answer, or isn't social." },
        };
      }

      const body = await callJev<{
        model?: string;
        answers?: Record<string, JevAnswer>;
        usage?: { input_tokens?: number; output_tokens?: number };
      }>(options.key, {
        fetch: options.fetch,
        baseURL: options.baseURL,
        body: { state, model: options.model ?? "jev-latest", questions },
        timeoutMs: options.timeoutMs ?? 2000,
      });
      await options
        .recordUsage({
          orgId: input.orgId,
          model: body.model ?? options.model ?? "jev-latest",
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
        })
        .catch(() => {});
      const answers = body.answers ?? {};
      const best = answers.best_agent?.probabilities ?? {};
      const to = answers.addressee?.probabilities ?? {};
      const scored = withAddressee(
        {
          agents: input.candidates.map((c, i) => {
            const noul = clamp(answers[`agent_${i}`]?.noul);
            // The Choice only breaks near-ties: a small nudge toward the agent it prefers.
            const nudge = input.candidates.length >= 2 ? 0.1 * ((best[c.handle] ?? 0) - 1 / (handles.length + 1)) : 0;
            return { agentId: c.agentId, score: clamp(noul + nudge) };
          }),
          needsAgent: clamp(answers.needs_agent?.noul),
          ...(answers.for_everyone ? { forEveryone: clamp(answers.for_everyone.noul) } : {}),
        },
        new Map(input.candidates.map((c) => [c.agentId, clamp(to[c.handle])])),
      );
      const social = answers.social?.choice;
      const reaction = social ? socialChoice(social) : null;
      const choice = answers.best_agent?.choice;
      const bestPlaced = input.candidates.find((c) => c.handle === choice);
      const spokenTo = input.candidates.find((c) => c.agentId === scored.addressee);
      const reason = [
        spokenTo ? `to @${spokenTo.handle} (${clamp(to[spokenTo.handle]).toFixed(2)})` : null,
        choice
          ? choice === NONE
            ? "no agent should reply"
            : `best @${choice} (confidence ${(answers.best_agent?.confidence ?? 0).toFixed(2)})`
          : null,
      ]
        .filter(Boolean)
        .join("; ");
      return {
        ...scored,
        ...(bestPlaced
          ? { best: { agentId: bestPlaced.agentId, confidence: clamp(answers.best_agent?.confidence) } }
          : {}),
        ...(answers.already_answered ? { alreadyAnswered: clamp(answers.already_answered.noul) } : {}),
        ...(social
          ? {
              social: {
                react: reaction !== null && clamp(answers.social?.confidence) >= 0.5,
                emoji: reaction ?? "",
              },
            }
          : {}),
        ...(reason ? { reason } : {}),
        strategy: "jev",
        decidedBy: { step: "jev" },
      };
    },
  };
}

const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * The router's chain (ADR 0074): each step in order until one decides. A step that can't read this message
 * (`RouterSkip`, or Jev without a key) passes without a trace. One that fails (an error, a timeout, an answer
 * that isn't JSON) is noted (`jev: TypeSafe answered 529`) and the next one runs. When none decides,
 * `RouterChainEnd` carries what failed, and the rules decide. Each step's time goes to `onTiming`
 * (`router_step_ms`, with the step and how it ended). Named after the first step that is on now, so nothing
 * names Jev while it has no key.
 */
export function routeChain(
  steps: RouterStrategy[],
  o: { onTiming?(name: string, ms: number, attrs: Record<string, unknown>): void } = {},
): RouterStrategy {
  return {
    get name() {
      return steps.find((s) => s.on?.() ?? true)?.name ?? "none";
    },
    async decide(input) {
      const failures: string[] = [];
      for (const step of steps) {
        const started = Date.now();
        const timed = (outcome: "decided" | "skipped" | "failed") =>
          o.onTiming?.("router_step_ms", Date.now() - started, { step: step.name, outcome });
        try {
          const result = await step.decide(input);
          timed("decided");
          return { ...result, strategy: result.strategy ?? step.name, ...(failures.length ? { failures } : {}) };
        } catch (error) {
          const skipped = error instanceof RouterSkip || error instanceof JevOffError;
          timed(skipped ? "skipped" : "failed");
          if (!skipped) failures.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new RouterChainEnd(failures);
    },
  };
}
