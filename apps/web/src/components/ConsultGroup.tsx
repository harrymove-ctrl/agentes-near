import {
  keys,
  type Message,
  type MessageConsultation,
  type RunConsultation,
  useConsultationConversation,
  useConsultations,
} from "@agenteschat/client";
import {
  asExchanges,
  type ConsultLineState,
  type ConsultNoticeFold,
  type ConsultPairItem,
  type ConsultRow,
  consultAskedKey,
  consultBlocksNearEnd,
  consultLineKey,
  consultLineState,
  consultNoticeFolds,
  consultPair,
  groupsByRun,
  openableConsultation,
  pairItemOf,
} from "@agenteschat/client/lib/consult-group";
import { consultTimeText, withoutRelayLine } from "@agenteschat/client/lib/consultations";
import { joinNames, namesText } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { cx, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar, withAgentFace } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useChannelEvents } from "@/realtime/context";

export interface ConsultGroups {
  /** By the run whose reply draws the row: an exchange's first asking run (`asExchanges`). */
  byRun: Map<string, RunConsultation[]>;
  /** Every question the list has: a reply's `meta.consulted` adds only those it doesn't. */
  listed: ReadonlySet<string>;
  /** How each answer's notice draws: hidden under a reply close by, one line to a reply farther up, its card. */
  folds: ReadonlyMap<string, ConsultNoticeFold>;
  /** Runs whose reply shows their questions near the end: the working line doesn't say them again. */
  nearEnd: ReadonlySet<string>;
  /** Runs at work: their questions wait for their reply (a message they already posted leaves them to it). */
  live: ReadonlySet<string>;
  /** The question open in the panel beside the conversation: its line shows pressed. */
  open: string | null;
  /** By the consulted agent's run: the question it answers, so its cards here say whom it helps. */
  helping: ReadonlyMap<string, RunConsultation>;
}

const EMPTY: ConsultGroups = {
  byRun: new Map(),
  listed: new Set(),
  folds: new Map(),
  nearEnd: new Set(),
  live: new Set(),
  open: null,
  helping: new Map(),
};
const ConsultGroupsContext = createContext<ConsultGroups>(EMPTY);
export const ConsultGroupsProvider = ConsultGroupsContext.Provider;
/** The question open in the panel beside the conversation, if any (a card or a line that opens it shows pressed). */
export const useOpenConsultation = () => useContext(ConsultGroupsContext).open;

const RELOAD_ON = new Set(["agent.consulting", "agent.consulted", "agent.consultation"]);

/**
 * The conversation's questions to other agents, by the run that asked; reloaded when one changes. `rows`: the
 * messages drawn here, in order; `live`: the runs at work after them. A reply shows its run's questions: the answers'
 * notices close to it fold, and the working line leaves out the ones near the end. A run at work draws none until its
 * reply comes (its answers' notices fold meanwhile): the line says its questions.
 */
export function useConsultGroups(
  channelId: string,
  rows: readonly ConsultRow[],
  live: ReadonlySet<string>,
  open: string | null = null,
): ConsultGroups {
  const { org } = useOrg();
  const qc = useQueryClient();
  const list = useConsultations(org.id, channelId);
  useChannelEvents(channelId, true, (event) => {
    if (RELOAD_ON.has(event.type)) void qc.invalidateQueries({ queryKey: keys.consultations(org.id, channelId) });
  });
  // Its own memo: opening a question doesn't hand every row a new map.
  const helping = useMemo(() => {
    const out = new Map<string, RunConsultation>();
    // Latest first: a run answering two questions says the latest.
    for (const c of list.data ?? []) if (c.consultedRunId && !out.has(c.consultedRunId)) out.set(c.consultedRunId, c);
    return out;
  }, [list.data]);
  return useMemo(() => {
    const all = asExchanges(list.data ?? []);
    // A reply's `meta.consulted` row still shows pressed while its question is open beside the conversation.
    if (all.length === 0) return open === null && live.size === 0 ? EMPTY : { ...EMPTY, live, open };
    return {
      byRun: groupsByRun(all),
      listed: new Set(all.map((c) => c.id)),
      folds: consultNoticeFolds(rows, all, live),
      nearEnd: new Set([...consultBlocksNearEnd(rows, all)].filter((runId) => !live.has(runId))),
      live,
      open,
      helping,
    };
  }, [list.data, rows, live, open, helping]);
}

/** A question's state in words, in the panel and in place ("A Iris espera uma aprovação"). */
export const consultLineLabel = (
  t: TFunction,
  state: ConsultLineState,
  c: Pick<RunConsultation, "waiting" | "kind">,
  to: ReturnType<typeof agentGrammar>,
) => t(consultLineKey(state, c), { name: to.name, context: to.context });

const NO_ITEMS: ConsultPairItem[] = [];

/**
 * The questions a reply's pair row stands for: its run's (`runId`, null: none) and those its `meta.consulted` names
 * that the list doesn't have. `saved`: a saved message; one its run posted while it still works shows none, they wait
 * for the run's reply (the working line says them meanwhile).
 * `reached`: hand-offs the message's reach lines show (`reachHandoffs`), left out here.
 */
export function useReplyConsults(
  runId: string | null | undefined,
  consulted: readonly MessageConsultation[],
  saved: boolean,
  reached: ReadonlySet<string>,
): ConsultPairItem[] {
  const groups = useContext(ConsultGroupsContext);
  return useMemo(() => {
    if (saved && runId && groups.live.has(runId)) return NO_ITEMS;
    const all = (runId && groups.byRun.get(runId)) || NO_ITEMS;
    const run = reached.size === 0 ? all : all.filter((c) => !reached.has(c.id));
    const extra = consulted.filter((c) => !groups.listed.has(c.consultationId)).map(pairItemOf);
    return extra.length === 0 ? run : [...run, ...extra];
  }, [groups.byRun, groups.listed, groups.live, runId, consulted, saved, reached]);
}

/**
 * The conversation's question with this id (a hand-off a reach line shows): from its list, or, older than the list
 * goes back, on its own.
 */
export function useConsultById(channelId: string, id: string | undefined): RunConsultation | null {
  const { org } = useOrg();
  const list = useConsultations(org.id, channelId, Boolean(id));
  const listed = useMemo(() => (id && list.data?.find((c) => c.id === id)) || null, [list.data, id]);
  const alone = useConsultationConversation(org.id, channelId, id && list.isSuccess && !listed ? id : null);
  return listed ?? alone.data?.consultation ?? null;
}

/**
 * The slim row right before a reply whose agent asked other agents first (`ask_agent`) or handed them work
 * (`tell_agent`): the asker's face and name, ⇄, the consulted agent's (several fold into stacked faces, "Atlas e
 * mais 2"), then how long it took, or while it runs "perguntando 42 s", or "não respondeu". Never what they said: in a
 * channel or a DM a click opens the two agents' conversation in the panel; in a thread view and inside that panel
 * (no panel to open) the question and the answer open under the row. The same row stands for an answer whose reply
 * is farther up or not here, and for a hand-off by direct message on a reach line.
 */
export function ConsultPairRow({ askerId, items }: { askerId: string; items: readonly ConsultPairItem[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const panel = useChannelActions()?.openConsultation;
  const openId = useOpenConsultation();
  const [open, setOpen] = useState(false);
  const live = items.some((c) => c.status === "open");
  const now = useNow(live);
  const pair = consultPair(items, now, askerId);
  if (!pair) return null;
  // An old reply's question with no id of its own has no conversation to open: it opens in place.
  const openConsultation = openableConsultation(pair.opens) ? panel : undefined;
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const from = nameOf(askerId);
  const names = pair.faces.map((f) => nameOf(f.agentId));
  const title =
    names.length === 1
      ? t("chat.consultPanel.label", { from, to: names[0] })
      : t("chat.consultPair.labelMany", { from, to: joinNames(names, t) });
  return (
    <div className="consult-pair">
      <button
        type="button"
        className={cx("consult-pair__row", pair.tone && `consult-pair__row--${pair.tone}`)}
        title={title}
        {...(openConsultation
          ? {
              "aria-pressed": items.some((c) => c.id === openId),
              onClick: () => openConsultation(pair.opens),
            }
          : { "aria-expanded": open, onClick: () => setOpen((o) => !o) })}
      >
        {/* One sentence that wraps at its spaces: each face keeps its name's first word, the · its name's last. */}
        <span className="consult-pair__who">
          <AgentAvatar agentId={askerId} size="xs" name={from} state="idle" />
          <span className="consult-pair__name">{from}</span>
        </span>
        <Icon name="swap" size={16} className="consult-pair__swap" label={t("newAgent.and")} />
        <span className="consult-pair__who">
          <span className="ac-avatar-stack consult-pair__faces">
            {pair.faces.slice(0, 3).map((f) => (
              <AgentAvatar
                key={f.agentId}
                agentId={f.agentId}
                size="xs"
                name={nameOf(f.agentId)}
                state={live && !f.off ? "thinking" : "idle"}
                className={f.off ? "consult-pair__off" : undefined}
              />
            ))}
          </span>
          <span className="consult-pair__name">{names.length === 1 ? names[0] : namesText(t, names, 1)}</span>
        </span>
        {(pair.word || pair.seconds !== null) && (
          <span className="consult-pair__sep" aria-hidden="true">
            ·
          </span>
        )}{" "}
        {pair.word && <span className="consult-pair__word">{t(pair.word.key, pair.word.values)}</span>}
        {pair.seconds !== null && (
          <span className="consult-pair__time">{consultTimeText(t, i18n.language, live, pair.seconds)}</span>
        )}
        <Icon name={openConsultation ? "chevronRight" : "chevronDown"} size={14} className="consult-pair__chev" />
      </button>
      {open && !openConsultation && (
        <div className="consult-pair__detail">
          {items.map((c) => (
            <ConsultInPlace key={c.id} consultation={c} askerId={askerId} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One question opened under its row where no panel opens: what was asked or handed, and the answer or its state. */
function ConsultInPlace({
  consultation: c,
  askerId,
  now,
}: {
  consultation: ConsultPairItem;
  askerId: string;
  now: number;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  // In an exchange the other agent may be the one who asked this part.
  const askedBy = c.agentId ?? askerId;
  const from = agentGrammar(dir.agentById.get(askedBy)?.name ?? t("channel.unknownAgent"));
  const to = agentGrammar(dir.agentById.get(c.consultedAgentId)?.name ?? t("channel.unknownAgent"));
  const state = consultLineState(c, now);
  return (
    <div className="ac-consult__body ac-consult__body--inline">
      <small>{withAgentFace(t(consultAskedKey(c), { name: from.name }), from.name, askedBy)}</small>
      <div className="ac-consult__text ac-consult__text--q">
        <MessageBody
          body={withoutRelayLine(c.question)}
          resolveMention={dir.mentionName}
          mentionTone={dir.mentionTone}
        />
      </div>
      <small>{t("chat.consultation.answerOf", { name: to.name, context: to.context })}</small>
      {state === "answered" ? (
        <div className="ac-consult__text">
          <MessageBody body={c.answer ?? ""} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
        </div>
      ) : (
        <p className="ac-consult__text ac-consult__text--q">{consultLineLabel(t, state, c, to)}</p>
      )}
      <p className="ac-consult__foot ac-iconline">
        <Icon name="eyeOff" size={14} />
        {t("chat.consultation.private", { from: from.name, to: to.name })}
      </p>
    </div>
  );
}

/**
 * An answer to a question asked in a reply farther up (`consultNoticeFolds`): the same pair row where the answer
 * arrived, opening the two agents' conversation. The words of the answer stay there, not here.
 */
export function ConsultAnswerLine({
  message,
  fold,
}: {
  message: Message;
  fold: Extract<ConsultNoticeFold, { fold: "line" }>;
}) {
  const c = fold.consultation;
  return (
    <div data-message-id={message.id}>
      <ConsultPairRow askerId={c.agentId} items={[c]} />
    </div>
  );
}

/**
 * On a card the consulted agent posted here (its approval, question or secret request): whom it is helping, and
 * "Ver conversa" opening the two agents' conversation over the channel ("ajudando o Theo · Ver conversa").
 */
export function ConsultHelpingTag({ consultation: c }: { consultation: RunConsultation }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const from = agentGrammar(dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent"));
  return (
    <span className="msg-reminder msg-talker">
      {withAgentFace(t("chat.consultPanel.helping", { name: from.name, context: from.context }), from.name, c.agentId)}
      {actions?.openConsultation && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="cn-line__toggle" onClick={() => actions.openConsultation?.(c.id)}>
            {t("chat.consultPanel.see")}
          </button>
        </>
      )}
    </span>
  );
}
