import type { Message, TeamAgentDraft, TeamPlan, TeamProposalCard } from "@agenteschat/client";
import { useAiStatus, useApplyTeamTemplate, useMessages, useTeamCard, useTeamTemplates } from "@agenteschat/client";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, whenAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import {
  answerAfter,
  answerPicks,
  answerText,
  firstTasks,
  replyChipsOf,
  teamColumns,
  teamCounts,
  teamFailureText,
  teamInDms,
  teamRoutines,
  teamStatus,
  teamUndoable,
} from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  AgentSticker,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  EventPillAction,
  Field,
  Icon,
  Input,
  Locked,
  Spinner,
  Textarea,
  WAVE_SECONDS,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { MESSAGE_STICKER } from "@/chat/ChatMedia";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { useChannelActions } from "@/components/channel-actions";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { useOrg } from "@/components/org-context";
import { RequestCard, RequestDone } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useEdited } from "@/hooks/useEdited";
import { lookOf } from "@/lib/look";
import { proposedRoutineWhen } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import "./team-plan.css";
import { useNewAgent } from "@/components/new-agent/NewAgentDialog";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Answers to tap (ADR 0137 §10): each one, or several with "Enviar N", goes as the person's own message, and typing
 * works all along. Answered (a message of theirs came after), only the picks stay, checked, and nothing is tappable.
 */
export function AnswerChips({
  choices,
  multiple,
  answer,
  onSend,
  step,
}: {
  choices: readonly string[];
  multiple: boolean;
  /** Their answer, once they gave one. */
  answer: string | null;
  onSend: (choice: string) => void;
  /** "Pergunta 2 de 3". */
  step?: { step: number; of: number };
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const answered = answer !== null;
  const shown = answered ? new Set(answerPicks(choices, answer)) : picked;
  const tap = (c: string) => {
    if (!multiple) return onSend(c);
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };
  const listed = answered ? choices.filter((c) => shown.has(c)) : choices;
  if (listed.length === 0 && !(step && step.of > 1)) return null;
  return (
    <div className="tp-chips">
      {listed.length > 0 && (
        <div className="tp-chips__row">
          {listed.map((c) => (
            <button
              key={c}
              type="button"
              className="tp-chip"
              aria-pressed={shown.has(c)}
              disabled={answered}
              onClick={() => tap(c)}
            >
              {shown.has(c) && <Icon name="check" size={14} />}
              <span>{c}</span>
            </button>
          ))}
        </div>
      )}
      {((step && step.of > 1) || (multiple && !answered)) && (
        <div className="tp-chips__foot">
          {multiple && !answered && picked.size > 0 && (
            <Button size="sm" variant="primary" onClick={() => onSend(answerText(choices, picked))}>
              {t("teamPlan.send", { count: picked.size })}
            </Button>
          )}
          {step && step.of > 1 && (
            <span className="small muted">{t("teamPlan.step", { step: step.step, of: step.of })}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Under a right hand's question (`meta.replyChips`): its answers, sent in this conversation as the person. */
export function ReplyChips({ message }: { message: Message }) {
  const { org } = useOrg();
  const actions = useChannelActions();
  const messages = useMessages(org.id, message.channelId).data;
  const chips = replyChipsOf(message.meta);
  if (!chips) return null;
  return (
    <AnswerChips
      choices={chips.choices}
      multiple={chips.multiple}
      answer={answerAfter(messages, message.id)}
      onSend={(text) => actions?.resend(text)}
      step={{ step: chips.step, of: chips.of }}
    />
  );
}

/**
 * The team on a card or a template: a row per agent, the routines, the skills and what waits for approval. `reviewer`:
 * the right hand's name, whose weekly check is one of the routines. `personal` (ADR 0159): each agent is someone to
 * talk to, not a place, so its channel shows only in a team's workspace and when it has one.
 */
export function TeamPlanBody({
  plan,
  reviewer,
  personal = false,
  onAdjust,
  locked,
}: {
  plan: TeamPlan;
  reviewer: string;
  personal?: boolean;
  onAdjust?: (agent: TeamAgentDraft) => void;
  locked?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const routines = teamRoutines(plan);
  const channelOf = (a: TeamAgentDraft) => (personal ? "" : a.channel);
  return (
    <div className="tp-body">
      <ul className="tp-agents">
        {plan.agents.map((a) => (
          <li key={a.handle} className="tp-agent ac-mediarow">
            <span className="ac-mediarow__face">
              <AgentAvatar name={a.name} appearance={lookOf(a)} size="md" />
            </span>
            <span className="ac-mediarow__head">
              <b>{a.name}</b>
              <span className="ac-mediarow__meta">{a.role}</span>
            </span>
            <span className="ac-mediarow__end ac-mediarow__end--wrap">
              {channelOf(a) && (
                <span className="tp-pill">
                  <Icon name="channel" size={14} />
                  <span>{a.channel}</span>
                  {plan.newChannels.includes(a.channel) && <b className="tp-pill__new">{t("teamPlan.card.new")}</b>}
                </span>
              )}
              {onAdjust && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("teamPlan.card.adjustName", { name: a.name })}
                  disabled={locked}
                  onClick={() => onAdjust(a)}
                >
                  {t("teamPlan.card.adjust")}
                </Button>
              )}
            </span>
            <span className="ac-mediarow__body">
              <span className="tp-agent__line">{a.line}</span>
            </span>
          </li>
        ))}
      </ul>
      {routines.length > 0 && (
        <section className="tp-section" aria-label={t("teamPlan.card.routines")}>
          <h4 className="tp-section__title">{t("teamPlan.card.routines")}</h4>
          <ul>
            {routines.map(({ agent, routine }) => (
              <li key={`${agent?.handle ?? "weekly"}-${routine.name}`} className="ac-iconline">
                <Icon name="routines" size={14} />
                <span>
                  <b>{proposedRoutineWhen(t, i18n.language, routine)}</b> ·{" "}
                  {agent
                    ? `${channelOf(agent) ? `${agent.name}, #${agent.channel}` : agent.name}: ${routine.name}`
                    : `${reviewer}: ${t(personal ? "teamPlan.card.weeklyPersonal" : "teamPlan.card.weekly")}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.skills.length > 0 && (
        <section className="tp-section" aria-label={t("teamPlan.card.skills")}>
          <h4 className="tp-section__title">{t("teamPlan.card.skills")}</h4>
          <ul>
            {plan.skills.map((s) => (
              <li key={s.name} className="ac-iconline">
                <Icon name="book" size={14} />
                <span>
                  <b>{s.title}</b> · {s.description}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.approvals && (
        <p className="tp-note ac-iconline">
          <Icon name="shield" size={16} />
          <span>{plan.approvals}</span>
        </p>
      )}
    </div>
  );
}

/** "3 agents · 2 new channels · 3 routines"; a personal workspace counts no channels (ADR 0159). */
const countsText = (t: TFunction, plan: TeamPlan, personal: boolean) => {
  const n = teamCounts(plan);
  return [
    t("teamPlan.card.agents", { count: n.agents }),
    n.newChannels > 0 && !personal ? t("teamPlan.card.newChannels", { count: n.newChannels }) : "",
    n.routines > 0 ? t("teamPlan.card.routineCount", { count: n.routines }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

/**
 * The right hand's team card (`meta.actionCard.kind = team_proposal`, ADR 0137 §10). Open: the team, "Criar o time"
 * (everything at once as whoever clicks, or nothing and the step that failed), "Ajustar" per agent, "Ver como mapa"
 * and Descartar. Created: a receipt with Desfazer, then a first task per agent and inviting the people it named.
 */
export function TeamPlanCardView({ message, card }: { message: Message; card: TeamProposalCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const team = useTeamCard(org.id, { channelId: message.channelId, messageId: message.id });
  // Made here and now, on a hold: the new agents wave, once.
  const [wave, setWave] = useState(false);
  const [adjusting, setAdjusting] = useState<TeamAgentDraft | null>(null);
  const [map, setMap] = useState(false);
  const agent = message.author.id ? dir.anyAgent(message.author.id) : undefined;
  const plan = card.params;
  const status = teamStatus(card);
  const personal = isPersonal(org);
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const title = t("ask.kind.team");
  const names = joinNames(
    plan.agents.map((a) => a.name),
    t,
  );
  if (status === "superseded") {
    return (
      <RequestCard
        id={message.id}
        kind="team"
        agent={agent}
        label={title}
        mine={false}
        muted
        waitingFor={t("rightHand.card.superseded")}
        lead={plan.lead || names}
        what={names}
      />
    );
  }
  if (status === "open") {
    const decides = can(org, "create_agents");
    const busy = team.create.isPending || team.deny.isPending || card.state === "creating";
    return (
      <>
        <RequestCard
          id={message.id}
          kind="team"
          agent={agent}
          label={title}
          mine={decides}
          waitingFor={t("teamPlan.card.onlyCreators")}
          lead={plan.lead || names}
          body={
            <>
              <TeamPlanBody
                plan={plan}
                reviewer={dir.agents.find(isRightHand)?.name ?? RIGHT_HAND_DEFAULT.name}
                personal={personal}
                onAdjust={decides ? setAdjusting : undefined}
                locked={busy}
              />
              {card.error && (
                <p className="rq__error" role="alert">
                  {teamFailureText(t, card.error, i18n.language)}
                </p>
              )}
            </>
          }
          actions={
            <>
              {decides && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={team.create.isPending || card.state === "creating"}
                  disabled={team.deny.isPending}
                  onClick={() =>
                    team.create.mutate(undefined, {
                      onSuccess: ({ noAi }) => {
                        if (held) setWave(true);
                        else if (noAi?.length) connect?.open({ agentId: noAi[0], agentIds: noAi });
                      },
                      onError: failed,
                    })
                  }
                >
                  {t(card.error ? "teamPlan.card.retry" : modeKey(org, "teamPlan.card.create"))}
                </Button>
              )}
              {/* Agents that each live in a DM with the person have no map to show (ADR 0159): the list says it all. */}
              {!teamInDms(plan) && (
                <Button size="sm" icon="diagram" onClick={() => setMap(true)}>
                  {t("teamPlan.card.map")}
                </Button>
              )}
              {(decides || card.forUserId === me.user.id) && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={team.deny.isPending}
                  disabled={busy}
                  onClick={() => team.deny.mutate(undefined, { onError: failed })}
                >
                  {t("rightHand.card.dismiss")}
                </Button>
              )}
            </>
          }
          end={<span className="small muted">{countsText(t, plan, personal)}</span>}
          what={names}
        />
        {adjusting && (
          <AdjustDialog
            agent={adjusting}
            saving={team.adjust.isPending}
            onClose={() => setAdjusting(null)}
            onSave={(patch) =>
              team.adjust.mutate(
                { handle: adjusting.handle, patch },
                { onSuccess: () => setAdjusting(null), onError: failed },
              )
            }
          />
        )}
        <TeamMapDialog plan={plan} open={map} onClose={() => setMap(false)} />
      </>
    );
  }
  if (status === "created") {
    const by = card.decidedByUserId === me.user.id ? null : dir.memberById.get(card.decidedByUserId ?? "")?.name;
    const channels = personal
      ? ""
      : joinNames(
          plan.newChannels.map((c) => `#${c}`),
          t,
        );
    const counts = teamCounts(plan);
    const madeBy = by
      ? t(modeKey(org, "teamPlan.card.created"), { name: by })
      : t(modeKey(org, "teamPlan.card.createdYou"));
    const undoable = teamUndoable(card, { userId: me.user.id, admin: can(org, "manage_agents") });
    return (
      <>
        <RequestDone
          done
          label={title}
          action={
            undoable ? (
              <EventPillAction
                disabled={team.undo.isPending}
                onClick={() => team.undo.mutate(undefined, { onError: failed })}
              >
                {t("agentActions.undo")}
              </EventPillAction>
            ) : undefined
          }
          time={card.decidedAt ? whenAt(t, i18n.language, card.decidedAt) : undefined}
        >
          {madeBy}: <b>{names}</b>
          {channels && ` · ${channels}`}
          {counts.routines > 0 && ` · ${t("teamPlan.card.routineCount", { count: counts.routines })}`}
        </RequestDone>
        {card.created?.skipped.includes("skills") && <p className="small muted">{t("teamPlan.card.skillsWait")}</p>}
        {card.created?.skipped.includes("weekly") && <p className="small muted">{t("teamPlan.card.weeklyWait")}</p>}
        {wave && (
          <div className="tp-wave" aria-hidden="true">
            {plan.agents.map((a) => (
              <AgentSticker
                key={a.handle}
                appearance={lookOf(a)}
                mood="wave"
                playFor={WAVE_SECONDS}
                size={MESSAGE_STICKER}
              />
            ))}
          </div>
        )}
        {card.decidedByUserId === me.user.id && !held && <FirstTaskCard message={message} card={card} />}
      </>
    );
  }
  return (
    <RequestDone done={false} label={title}>
      {t(
        status === "undone"
          ? modeKey(org, "teamPlan.card.undone")
          : status === "denied"
            ? modeKey(org, "teamPlan.card.dismissed")
            : "approval.expired",
      )}
      : <b>{names}</b>
    </RequestDone>
  );
}

/**
 * After the team: a short first task per agent (its DM opens with it typed, never sent, for the person to finish) and
 * inviting the people. Only once the team can answer: never on a billing hold (the caller's), nor before an AI.
 */
function FirstTaskCard({ message, card }: { message: Message; card: TeamProposalCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const invite = useInviteDialog();
  const thinks = useAiStatus(org.id).data?.any === true;
  const [later, setLater] = useState(false);
  const tasks = firstTasks(card).filter((f) => dir.agentById.has(f.agentId));
  // No "Invite …" in a personal workspace (ADR 0159): it is for one person, inviting stays in Settings.
  const people = isPersonal(org) ? [] : card.params.invite;
  if (later || !thinks || (tasks.length === 0 && people.length === 0)) return null;
  const agent = message.author.id ? dir.anyAgent(message.author.id) : undefined;
  const label = t("ask.kind.firstTask");
  return (
    <RequestCard
      id={`${message.id}-first`}
      kind="firstTask"
      agent={agent}
      label={label}
      mine={false}
      waitingFor={t("teamPlan.firstTask.suggestion")}
      lead={t("teamPlan.firstTask.lead")}
      body={
        tasks.length > 0 ? (
          <ul className="tp-agents">
            {tasks.map((f) => (
              <li key={f.agentId} className="tp-agent ac-mediarow">
                <span className="ac-mediarow__face">
                  <AgentAvatar agentId={f.agentId} name={f.name} size="md" />
                </span>
                <span className="ac-mediarow__head">
                  <b>{f.name}</b>
                </span>
                <span className="ac-mediarow__end ac-mediarow__end--wrap">
                  <Button
                    size="sm"
                    onClick={() => {
                      // The task ends in a blank for them to finish.
                      setDraftFor(`agent:${f.agentId}`, `${f.task} `);
                      void navigate({
                        to: "/org/$orgId/dm/agent/$agentId",
                        params: { orgId: org.id, agentId: f.agentId },
                      });
                    }}
                  >
                    {t("teamPlan.firstTask.open")}
                  </Button>
                </span>
                <span className="ac-mediarow__body">
                  <span className="tp-agent__line">{f.task}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
      actions={
        <>
          {people.length > 0 && invite && can(org, "invite_people") && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => invite.open({ emails: people.filter((p) => EMAIL.test(p)) })}
            >
              {t("teamPlan.firstTask.invite", { names: joinNames(people, t) })}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setLater(true)}>
            {t("teamPlan.firstTask.later")}
          </Button>
        </>
      }
      what={label}
    />
  );
}

/** "Ajustar": the agent's draft on the card, edited before the team exists. */
function AdjustDialog({
  agent,
  saving,
  onSave,
  onClose,
}: {
  agent: TeamAgentDraft;
  saving: boolean;
  onSave: (patch: {
    name: string;
    role: string;
    line: string;
    channel: string;
    instructions: string;
    firstTask: string;
  }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState({
    name: agent.name,
    role: agent.role,
    line: agent.line,
    channel: agent.channel,
    instructions: agent.instructions,
    firstTask: agent.firstTask ?? "",
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const unsaved = useEdited(true, v);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("teamPlan.adjust.title", { name: agent.name })}
      closeLabel={t("common.close")}
      unsaved={unsaved}
      width={560}
      leading={<AgentAvatar name={v.name || agent.name} appearance={lookOf(agent)} size="md" />}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <Locked when={saving}>
          <DialogBody>
            <Field label={t("teamPlan.adjust.name")}>
              <Input value={v.name} onChange={set("name")} maxLength={80} required />
            </Field>
            <Field label={t("teamPlan.adjust.role")}>
              <Input value={v.role} onChange={set("role")} maxLength={200} />
            </Field>
            <Field label={t("teamPlan.adjust.line")}>
              <Input value={v.line} onChange={set("line")} maxLength={300} required />
            </Field>
            {/* An agent with no channel lives in its DM with the person (ADR 0159): nothing to name. */}
            {agent.channel && (
              <Field label={t("teamPlan.adjust.channel")}>
                <Input value={v.channel} onChange={set("channel")} maxLength={80} required />
              </Field>
            )}
            <Field label={t("teamPlan.adjust.instructions")}>
              <Textarea value={v.instructions} onChange={set("instructions")} rows={5} />
            </Field>
            <Field label={t("teamPlan.adjust.firstTask")}>
              <Input value={v.firstTask} onChange={set("firstTask")} maxLength={500} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "See as a map": the team read only, the people on top, a column per channel with its agents and routines, the
 * right hand under it as the weekly reviewer. An agent with no channel has a column of its own, with no channel on top.
 */
export function TeamMapDialog({ plan, open, onClose }: { plan: TeamPlan; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const lodi = dir.agents.find(isRightHand);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t(modeKey(org, "teamPlan.map.title"))}
      closeLabel={t("common.close")}
      width={960}
    >
      <DialogBody className="tp-map">
        <section className="tp-map__people" aria-label={t("teamPlan.map.people")}>
          {[me.user.name, ...plan.invite].map((p) => (
            <span key={p} className="tp-pill">
              <Icon name="person" size={14} />
              <span>{p}</span>
            </span>
          ))}
        </section>
        <div className="tp-map__columns">
          {teamColumns(plan).map((col) => (
            <section
              key={col.key}
              className="tp-map__col"
              aria-label={col.channel ? `#${col.channel}` : col.agents[0]?.name}
            >
              {col.channel && (
                <h4 className="tp-pill">
                  <Icon name="channel" size={14} />
                  <span>{col.channel}</span>
                  {col.fresh && <b className="tp-pill__new">{t("teamPlan.card.new")}</b>}
                </h4>
              )}
              {col.agents.map((a) => (
                <div key={a.handle} className="tp-map__agent">
                  <span className="ac-iconline">
                    <AgentAvatar name={a.name} appearance={lookOf(a)} size="sm" />
                    <span>
                      <b>{a.name}</b> <span className="small muted">{a.role}</span>
                    </span>
                  </span>
                  {a.routines.map((r) => (
                    <span key={r.name} className="small muted ac-iconline">
                      <Icon name="routines" size={14} />
                      <span>{proposedRoutineWhen(t, i18n.language, r)}</span>
                    </span>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
        {plan.weekly && lodi && (
          <p className="tp-map__lodi ac-iconline">
            <AgentAvatar agentId={lodi.id} name={lodi.name} size="sm" />
            <span>{t("teamPlan.map.reviewer", { name: lodi.name })}</span>
          </p>
        )}
        {plan.approvals && (
          <p className="tp-note ac-iconline">
            <Icon name="shield" size={16} />
            <span>
              <b>{t("teamPlan.map.waits")}</b> · {plan.approvals}
            </span>
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}

/**
 * "Team templates": the templates by business type, one picked (`initial`: the business row 1 saved), and "Create the
 * team" makes it at once (ADR 0155 §6). Under the list, the other ways in: an import, or one agent from scratch. In a
 * personal workspace (ADR 0159) the server lists them by area of life, and the words are about the person's agents.
 */
export function TeamTemplatesDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const actions = useChannelActions();
  const held = usePlanHold() !== null;
  const lodi = dir.agents.find(isRightHand);
  const name = lodi?.name ?? "Lodi";
  const personal = isPersonal(org);
  const list = useTeamTemplates(org.id, i18n.language, open);
  const use = useApplyTeamTemplate(org.id);
  const newAgent = useNewAgent();
  const [picked, setPicked] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const templates = list.data ?? [];
  const chosen = templates.find((x) => x.id === (picked ?? initial)) ?? templates[0];
  let preview: ReactNode = <Spinner />;
  if (chosen) {
    preview = (
      <>
        <h3 className="tp-gallery__title">{chosen.name}</h3>
        <p className="muted">{chosen.description}</p>
        <TeamPlanBody plan={chosen.team} reviewer={name} personal={personal} />
        {!held && (
          <p className={lodi ? "small muted ac-iconline" : "small muted"}>
            {lodi && <AgentAvatar agentId={lodi.id} name={name} size="xs" />}
            <span>{t(modeKey(org, "teamPlan.templates.tailor"))}</span>
          </p>
        )}
      </>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t(modeKey(org, "teamPlan.templates.title"))}
      description={
        held ? t(modeKey(org, "teamPlan.templates.heldLead")) : t(modeKey(org, "teamPlan.templates.lead"), { name })
      }
      closeLabel={t("common.close")}
      width={1040}
    >
      <Locked when={use.isPending}>
        <DialogBody>
          <div className="tp-gallery">
            <ul className="tp-gallery__list">
              {templates.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className="tp-gallery__item ac-iconline"
                    aria-pressed={x.id === chosen?.id}
                    onClick={() => setPicked(x.id)}
                  >
                    <span className="tp-gallery__faces" aria-hidden="true">
                      {x.team.agents.map((a) => (
                        <AgentAvatar key={a.handle} name={a.name} appearance={lookOf(a)} size="xs" />
                      ))}
                    </span>
                    <span className="tp-gallery__text">
                      <b>{x.name}</b>
                      <small>{x.sub}</small>
                    </span>
                  </button>
                </li>
              ))}
              {!held && (
                <li>
                  <button
                    type="button"
                    className="tp-gallery__item ac-iconline"
                    onClick={() => {
                      onClose();
                      actions?.focusComposer();
                    }}
                  >
                    <span className="tp-gallery__faces" aria-hidden="true">
                      <Icon name="edit" size={16} />
                    </span>
                    <span className="tp-gallery__text">
                      <b>{t("teamPlan.templates.none")}</b>
                      <small>{t(modeKey(org, "teamPlan.templates.noneSub"), { name })}</small>
                    </span>
                  </button>
                </li>
              )}
            </ul>
            <div className="tp-gallery__preview">{preview}</div>
          </div>
          <p className="tp-gallery__more">
            <button
              type="button"
              className="ac-link"
              onClick={() => {
                onClose();
                void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "import" } });
              }}
            >
              {t("teamPlan.templates.import")}
            </button>
            <button
              type="button"
              className="ac-link"
              onClick={() => {
                onClose();
                // One agent from scratch: the new agent's dialog (ADR 0164).
                if (newAgent) newAgent.open();
                else void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } });
              }}
            >
              {t("teamPlan.templates.scratch")}
            </button>
          </p>
        </DialogBody>
      </Locked>
      <DialogFooter
        note={
          failed ? (
            <span className="tp-gallery__error">{failed}</span>
          ) : chosen ? (
            countsText(t, chosen.team, personal)
          ) : null
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!chosen}
          loading={use.isPending}
          onClick={() =>
            chosen &&
            use.mutate(
              { templateId: chosen.id, locale: i18n.language },
              {
                onSuccess: (out) => {
                  // A step that failed: its reason here, the card stays open in the right hand's DM.
                  if (out.state !== "created")
                    return setFailed(
                      out.error
                        ? teamFailureText(t, out.error, i18n.language)
                        : t(modeKey(org, "teamPlan.templates.failed")),
                    );
                  setFailed(null);
                  onClose();
                  if (lodi)
                    void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: lodi.id } });
                },
                onError: (e) => setFailed(errorText(t, e)),
              },
            )
          }
        >
          {t(modeKey(org, "teamPlan.templates.create"))}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
