import { type Message, useAiStatus, useApi, useMessages, useThreadMessages } from "@agenteschat/client";
import type { BillingHold } from "@agenteschat/client/lib/billing";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  aiStateOf,
  keptCardState,
  mayConnectAi,
  type NoAiCard as NoAiCardMeta,
  noAiCardOf,
  noAiLineKey,
  planLineFix,
  planLineKey,
  planLinePasses,
  planOfKind,
  signInAgainPlan,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { EventPillAction, EventPillText, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { AskDone, AskWaiting } from "../chat/asks";
import { TeamTemplatesSheet } from "../right-hand/TeamCard";
import { useDirectory, useMeId } from "../shared/hooks";
import { usePlanHold } from "./parts";

type Answer = "pending" | "answering" | "still_missing";

/**
 * Opens "Conectar uma IA" (the web's `connect.open`): `from`, the message answered once the agent has an AI;
 * `intent`, the step it asked for; `provider`, the key's maker it named; `agentId`, the agent to connect; `plan`, the
 * plan's page it opens on (Sign in again: the agent's own); `email`, one more login of the account with this email
 * (one other agents use), Claude's hint.
 */
export const openConnectAi = (
  request: {
    from?: string;
    intent?: string;
    provider?: string;
    agentId?: string;
    plan?: string;
    email?: string;
    /** "1": from the create-agent step, for the agent being made (a plan signs in for the agents I create). */
    forNew?: string;
  } = {},
) => {
  const query = Object.entries(request)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
  router.push((query ? `/connect-ai?${query}` : "/connect-ai") as never);
};

/**
 * The web's no-AI request under an agent's "I have no AI" reply (`meta.noAi`), as a waiting pill: Connect (tinted, for
 * who may connect) opens the key sheet; anyone else reads who can. Once the agent has an AI, a decided request's pill
 * with "Answer now" has it answer what it couldn't (who asked, its owner or an admin).
 */
export function NoAiCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const meId = useMeId();
  const hold = usePlanHold(orgId, org);
  const card = noAiCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  // Any card on a billing hold is the wall: a Connect or a key from before it leads nowhere until the plan.
  if (card.held || hold) return <KeptCard message={m} card={card} hold={hold} />;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const again = signInAgainPlan(card, agent);
  // The computer's own sign-in isn't there: Conectar opens on an account of that CLI's plan.
  const plan = card.own ? planOfKind(card.own) : again;
  const state = aiStateOf(status.data, card.agentId);
  const ready = state !== undefined && state !== "no_ai" && answer !== "still_missing";
  const mayAnswer =
    card.forUserId === meId || (meId !== null && agent?.ownerUserId === meId) || can(org, "manage_agents");
  const answering = answer === "answering";
  // The team's right hand on a plan that can't think now (ADR 0137 §7): one plain line, and the way to an API key.
  const planLine = card.planLine && !(planLinePasses(card.planLine) && state === "ready") ? card.planLine : null;
  const mayConnect = mayConnectAi(agent, meId, org);
  const fix = planLine ? planLineFix(planLine, agent, meId, org) : null;
  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const locked = (
    <EventPillText>
      <Text variant="footnote" tone="muted">
        {!planLine && owner ? t("noAi.locked", { name, owner }) : t("noAi.lockedAdmins")}
      </Text>
    </EventPillText>
  );
  const title = answering
    ? t("noAi.card.answering", { name })
    : planLine
      ? t(planLineKey(planLine, card.why), { name, model: card.model, why: card.why })
      : ready
        ? t("noAi.card.connected", { name })
        : answer === "still_missing"
          ? t("noAi.card.stillMissing", { name })
          : t(noAiLineKey(card), agentGrammar(name));
  const answerNow = async () => {
    setAnswer("pending");
    try {
      await api.chat.answerNow(orgId, m.id);
      setAnswer("answering");
    } catch (error) {
      const code = (error as { code?: string }).code;
      setAnswer(code === "ai.still_missing" ? "still_missing" : null);
    }
  };
  // Its agent has an AI now (or is answering): a decided request, one pill with "Answer now" in it.
  if (answering || (!planLine && (ready || answer === "pending")))
    return (
      <AskDone
        done
        words={title}
        actions={
          !answering && mayAnswer ? (
            <EventPillAction
              key="answer"
              label={t("noAi.card.answerNow")}
              loading={answer === "pending"}
              onPress={() => void answerNow()}
            />
          ) : null
        }
      />
    );
  // Still waiting for an AI: the waiting pill, Connect (or the plan's fix) tinted for who may press it.
  const action = planLine ? (
    fix ? (
      <EventPillAction
        key="connect"
        primary
        label={t(fix === "connectMine" ? "rightHand.settings.connectMine" : "noAi.rightHand.useKey")}
        onPress={() =>
          openConnectAi({
            from: m.id,
            agentId: card.agentId,
            ...(fix === "connectMine" ? {} : { intent: "api_key" }),
          })
        }
      />
    ) : null
  ) : mayConnect ? (
    <EventPillAction
      key="connect"
      primary
      label={t(again ? "agentPage.work.brain.signInAgain" : "noAi.action")}
      onPress={() =>
        openConnectAi({
          from: m.id,
          intent: card.intent,
          provider: card.provider,
          agentId: card.agentId,
          ...(plan ? { plan } : {}),
        })
      }
    />
  ) : null;
  return (
    <AskWaiting forMe={action !== null} mark="bolt" words={title} actions={action} below={action ? null : locked} />
  );
}

/**
 * The web's wall (ADR 0079 §6): the agent kept the message for after the plan, in words only, since paying has no
 * button or link here (`keptCardState`). Once an AI is there, opening the conversation starts the answer.
 */
function KeptCard({ message: m, card, hold }: { message: Message; card: NoAiCardMeta; hold: BillingHold | null }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const meId = useMeId();
  // A card in a thread is answered there.
  const channel = useMessages(orgId, m.channelId, !m.threadId).data;
  const thread = useThreadMessages(orgId, m.threadId ? m.channelId : undefined, m.threadId ?? "");
  const messages = m.threadId ? thread.data : channel;
  const started = useRef(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [templates, setTemplates] = useState(false);
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const ai = aiStateOf(status.data, card.agentId);
  const state = keptCardState({ hold, paid: false, ready: ai !== undefined && ai !== "no_ai" });
  const mayAnswer =
    card.forUserId === meId || (meId !== null && agent?.ownerUserId === meId) || can(org, "manage_agents");
  const replied = messages?.some(
    (x) => x.author.id === card.agentId && x.createdAt > m.createdAt && !noAiCardOf(x.meta),
  );
  const start = () => {
    setAnswer("pending");
    api.chat.answerNow(orgId, m.id).then(
      () => setAnswer("answering"),
      () => setAnswer(null),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per card here
  useEffect(() => {
    if (state !== "answer" || !mayAnswer || replied !== false || started.current) return;
    started.current = true;
    start();
  }, [state, mayAnswer, replied]);
  const answering = !replied && answer !== null;
  // Not known yet: no moment of "Plano ativo" on a card an AI has long answered.
  if (state === "connect" && !status.data) return null;
  const code = hold ?? "payment";
  // With no team yet, the way to one needs no model.
  const noTeam = isRightHand(agent) && can(org, "create_agents") && dir.agents.every(isRightHand);
  const title =
    state === "held" || state === "paid"
      ? t("noAi.kept.title")
      : state === "connect"
        ? t("noAi.kept.active", { name })
        : t(answering ? "noAi.card.answering" : "noAi.card.connected", { name });
  if (state === "answer")
    return (
      <AskDone
        done
        words={title}
        actions={
          // The start refused: never a promise with nothing behind it.
          !answering && !replied && mayAnswer ? (
            <EventPillAction key="answer" label={t("noAi.card.answerNow")} onPress={start} />
          ) : null
        }
      />
    );
  if (state === "connect") {
    const mine = mayConnectAi(agent, meId, org);
    return (
      <AskWaiting
        forMe={mine}
        mark="bolt"
        words={title}
        actions={
          mine ? (
            <EventPillAction
              key="connect"
              primary
              label={t("noAi.action")}
              onPress={() => openConnectAi({ from: m.id })}
            />
          ) : null
        }
        below={
          mine ? null : (
            <EventPillText>
              <Text variant="footnote" tone="muted">
                {t("noAi.lockedAdmins")}
              </Text>
            </EventPillText>
          )
        }
      />
    );
  }
  // Paying has no button here: the words say where, and who.
  return (
    <>
      <AskWaiting
        forMe={false}
        mark="clock"
        words={title}
        actions={
          state === "held" && noTeam ? (
            <EventPillAction key="templates" label={t("teamPlan.start.templates")} onPress={() => setTemplates(true)} />
          ) : null
        }
        below={
          <EventPillText>
            <Text variant="footnote" tone="ink2">
              {code === "payment" ? t("noAi.kept.line") : t(`standing.billing.${code}`)}
            </Text>
            {code === "payment" ? (
              <Text variant="footnote" tone="ink2">
                {t("noAi.kept.plan")}
              </Text>
            ) : null}
            <Text variant="footnote" tone="muted">
              {t(can(org, "manage_billing") ? "connectAi.billingWeb" : "standing.billing.askAdmin")}
            </Text>
          </EventPillText>
        }
      />
      {state === "held" && noTeam ? (
        <TeamTemplatesSheet open={templates} onClose={() => setTemplates(false)} onNone={() => setTemplates(false)} />
      ) : null}
    </>
  );
}
