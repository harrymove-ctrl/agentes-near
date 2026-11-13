import type { Message, Proposal } from "@agenteschat/client";
import {
  keys,
  useActOnTeamWeek,
  useAgentActions,
  useApprovals,
  useCardProposals,
  useChannels,
  useDecideProposal,
  useSetTeamWeekPrefs,
  useTeamWeekPrefs,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt, formatUsd, joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  appliesInBulk,
  dayText,
  hourText,
  type TeamWeekCard,
  type TeamWeekNames,
  type TeamWeekRow,
  teamWeekDoneText,
  teamWeekOn,
  teamWeekRowMessage,
  teamWeekRowState,
  teamWeekRowText,
  teamWeekTitleKey,
  teamWeekWhen,
} from "@agenteschat/client/lib/team-week";
import { Button, Icon, Popover, Select } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { CardApproval } from "@/components/RightHandCards";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./team-week.css";

const NANO = 1_000_000_000;

/** The names a row's words need, from the reader's directory. */
export function useTeamWeekNames(): TeamWeekNames {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id).data ?? [];
  return {
    agent: (id) => (id ? dir.anyAgent(id)?.name : undefined) ?? t("channel.unknownAgent"),
    handle: (id) => (id ? (dir.anyAgent(id)?.handle ?? null) : null),
    channel: (id) => channels.find((c) => c.id === id)?.name ?? "…",
    usd: (n) => formatUsd(i18n.language, Math.round(n / NANO)),
    join: (names) => joinNames(names, t),
    since: (iso) => clockAt(i18n.language, iso),
  };
}

/**
 * Lodi's weekly card (ADR 0137 §9) in the admin's DM: four numbers, what worked, then a row per fix, each applied as
 * whoever clicks through its own card's path (the settings proposal with Undo, the approvals as the conversation
 * draws them, a routine, a message), "Aplicar as N" for the open ones and the day and hour in the footer.
 */
export function TeamWeekCardView({ message, card }: { message: Message; card: TeamWeekCard }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const names = useTeamWeekNames();
  const proposals = useCardProposals(org.id, card.proposalIds);
  const approvals = useApprovals(org.id);
  const decide = useDecideProposal(org.id);
  const act = useActOnTeamWeek(org.id);
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const locale = i18n.language;
  const lodi = dir.agents.find(isRightHand);
  const rows = card.rows.map((row) => ({
    row,
    state: teamWeekRowState(card, row, { proposals, approvals: approvals.data }),
    text: teamWeekRowText(t, locale, row, names),
  }));
  const open = rows.filter((r) => r.state === "open");
  const bulk = open.filter((r) => appliesInBulk(r.row));
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const apply = async (row: TeamWeekRow) => {
    if (row.kind === "budget" || row.kind === "channel")
      await decide.mutateAsync({ id: row.proposalId, decision: "accept" });
    else if (row.kind !== "approvals")
      await act.mutateAsync({
        messageId: message.id,
        act: { rowId: row.id, text: teamWeekRowMessage(t, row, names) },
      });
  };
  const applyAll = async () => {
    setApplying(true);
    try {
      for (const r of bulk) await apply(r.row);
    } catch (e) {
      failed(e);
    } finally {
      setApplying(false);
    }
  };
  const { stats } = card;
  const dismissed = !!card.dismissedAt;
  return (
    // Its week ("Como foi a semana do time, de 28 out. a 3 nov.") is the message's text, above.
    <div className="tw">
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div className="rq tw__card" role="group" aria-label={t(teamWeekTitleKey(card))}>
        <div className="rq__head">
          <span className="rq__kind">{t(teamWeekTitleKey(card))}</span>
          {open.length > 0 && !dismissed && (
            <span className="rq__state">
              <WaitMark />
              {t("teamWeek.suggestions", { count: open.length })}
            </span>
          )}
        </div>
        <div className="tw__stats">
          <Stat value={String(stats.done)} label={t("teamWeek.stat.done")} />
          <Stat value={String(stats.stuck)} label={t("teamWeek.stat.stuck")} warn={stats.stuck > 0} />
          <Stat value={String(stats.waiting)} label={t("teamWeek.stat.waiting")} warn={stats.waiting > 0} />
          {/* The workspace's money: only on an administrator's card. */}
          {stats.budgetNanoUsd > 0 && (
            <Stat
              value={names.usd(stats.spentNanoUsd)}
              label={t("teamWeek.stat.budget", { budget: names.usd(stats.budgetNanoUsd) })}
            />
          )}
        </div>
        {card.worked.length > 0 && (
          <section className="tw__sec">
            <h4 className="tw__sec-t">{t("teamWeek.worked")}</h4>
            <ul className="waitcard__lines tw__worked">
              {card.worked.map((w) => (
                <li key={`${w.kind}:${w.agentId}`} className="ac-iconline">
                  <Icon name="check" size={14} />
                  <span>
                    {w.kind === "runs"
                      ? t("teamWeek.workedRuns", {
                          name: names.agent(w.agentId),
                          count: w.count,
                          channel: names.channel(w.channelId),
                        })
                      : t("teamWeek.workedTasks", { name: names.agent(w.agentId), count: w.count })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {dismissed ? (
          <p className="tw__dismissed">{t("teamWeek.dismissed")}</p>
        ) : (
          rows.length > 0 && (
            <section className="tw__sec">
              <h4 className="tw__sec-t">{t("teamWeek.improve")}</h4>
              <div className="tw__rows">
                {rows.map(({ row, state, text }) => (
                  <FixRow
                    key={row.id}
                    message={message}
                    row={row}
                    state={state}
                    title={text.title}
                    line={text.line}
                    action={text.action}
                    proposal={proposals.find((p) => "proposalId" in row && p.id === row.proposalId)}
                    doneText={teamWeekDoneText(t, row, lodi?.name ?? "Lodi")}
                    onApply={() => apply(row).catch(failed)}
                    busy={applying || act.isPending}
                  />
                ))}
              </div>
            </section>
          )
        )}
        <div className="rq__foot">
          {!dismissed && bulk.length > 0 && (
            <Button
              size="sm"
              variant="primary"
              loading={applying}
              disabled={act.isPending}
              onClick={() => void applyAll()}
            >
              {t("teamWeek.applyAll", { count: bulk.length })}
            </Button>
          )}
          {!dismissed && open.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={applying}
              loading={act.isPending}
              onClick={() => act.mutate({ messageId: message.id, act: { dismiss: true } }, { onError: failed })}
            >
              {t("teamWeek.notNow")}
            </Button>
          )}
          <span className="rq__end tw__when">
            <TeamWeekWhen />
          </span>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, warn = false }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="tw__stat" data-warn={warn || undefined}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** One fix: its face (or icon), what and why, and its button, or how it ended. */
function FixRow({
  message,
  row,
  state,
  title,
  line,
  action,
  proposal,
  doneText,
  onApply,
  busy,
}: {
  message: Message;
  row: TeamWeekRow;
  state: "open" | "done" | "gone";
  title: string;
  line: string;
  action: string;
  proposal: Proposal | undefined;
  doneText: string;
  onApply: () => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useAgentActions(org.id, message.channelId);
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [showing, setShowing] = useState(false);
  const agentId = "agentId" in row ? row.agentId : null;
  const lead: ReactNode = agentId ? (
    <AgentAvatar agentId={agentId} name={dir.anyAgent(agentId)?.name ?? ""} size="md" />
  ) : (
    <span className="tw__tile" aria-hidden="true">
      <Icon
        name={
          row.kind === "unanswered"
            ? "question"
            : row.kind === "stalled"
              ? "issues"
              : row.kind === "howto"
                ? "book"
                : "routines"
        }
        size={16}
      />
    </span>
  );
  const receipt = proposal?.undoActionId ? message.actions?.find((a) => a.id === proposal.undoActionId) : undefined;
  const undoable =
    receipt && !receipt.undoneAt && receipt.undoableUntil && Date.parse(receipt.undoableUntil) > Date.now();
  const side =
    state === "done" ? (
      <>
        <span className="tw__done">
          <Icon name="check" size={14} />
          {receipt?.undoneAt ? t("rightHand.card.undone") : doneText}
        </span>
        {undoable && (
          <Button
            size="sm"
            variant="ghost"
            loading={actions.undo.isPending}
            onClick={() =>
              actions.undo.mutate(receipt.id, {
                onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org.id) }),
                onError: (e) => toast.show(errorText(t, e), "error"),
              })
            }
          >
            {t("teamWeek.undo")}
          </Button>
        )}
      </>
    ) : state === "gone" ? (
      <span className="tw__gone">{t("teamWeek.gone")}</span>
    ) : row.kind === "approvals" ? (
      <Button size="sm" onClick={() => setShowing((v) => !v)} aria-expanded={showing}>
        {showing ? t("teamWeek.approvals.hide") : action}
      </Button>
    ) : (
      <Button
        size="sm"
        loading={pending}
        disabled={busy}
        onClick={() => {
          setPending(true);
          void onApply().finally(() => setPending(false));
        }}
      >
        {action}
      </Button>
    );
  return (
    <div className="tw__fix" data-done={state !== "open" || undefined}>
      <div className="tw__fix-row">
        {lead}
        <span className="tw__fix-t">
          <b>{title}</b>
          <span>{line}</span>
        </span>
        <span className="tw__fix-side">{side}</span>
      </div>
      {showing && row.kind === "approvals" && (
        <div className="tw__approvals">
          {row.approvalIds.map((id) => (
            <CardApproval key={id} id={id} />
          ))}
        </div>
      )}
    </div>
  );
}

/** "Toda sexta às 17:00 · Mudar": the day and hour of the reader's card, changed in place, or stopped. */
export function TeamWeekWhen() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const prefs = useTeamWeekPrefs(org.id).data;
  const set = useSetTeamWeekPrefs(org.id);
  const toast = useToast();
  const admin = can(org, "administrator");
  if (!prefs) return null;
  const save = (patch: Parameters<typeof set.mutate>[0]) =>
    set.mutate(patch, { onError: (e) => toast.show(errorText(t, e), "error") });
  const locale = i18n.language;
  return (
    <>
      <span>{teamWeekOn(prefs, admin) ? teamWeekWhen(t, locale, prefs) : t("teamWeek.off")}</span>
      {" · "}
      <Popover
        label={t("teamWeek.schedule.title")}
        side="top"
        align="end"
        trigger={
          <button type="button" className="ac-link tw__change">
            {t("teamWeek.change")}
          </button>
        }
      >
        <div className="tw__schedule">
          <TeamWeekSchedule prefs={prefs} admin={admin} locale={locale} onChange={save} />
        </div>
      </Popover>
    </>
  );
}

/** The day and hour selects and "Parar de receber" (the card's footer and Settings › Lodi). */
export function TeamWeekSchedule({
  prefs,
  admin,
  locale,
  onChange,
  plated = false,
}: {
  prefs: { off: boolean; day: number; hour: number; daily?: boolean };
  /** An administrator picks a day of the week or every day; anyone else gets it every day or not at all. */
  admin: boolean;
  locale: string;
  onChange: (patch: { off?: boolean; day?: number; hour?: number; daily?: boolean }) => void;
  /**
   * The button on a plate like the selects: where it can wrap under them (a settings row on a phone), a plate starts
   * on their edge, while bare words would start a padding further in.
   */
  plated?: boolean;
}) {
  const { t } = useTranslation();
  const on = teamWeekOn(prefs, admin);
  const days = [
    ...(admin ? [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: dayText(locale, d) })) : []),
    { value: DAILY, label: t("teamWeek.schedule.daily") },
  ];
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourText(locale, h) }));
  return (
    <>
      <Select
        size="sm"
        aria-label={t("teamWeek.schedule.day")}
        value={prefs.daily || !admin ? DAILY : String(prefs.day)}
        options={days}
        disabled={!on || !admin}
        onValueChange={(v) => onChange(v === DAILY ? { daily: true } : { daily: false, day: Number(v) })}
      />
      <Select
        size="sm"
        aria-label={t("teamWeek.schedule.hour")}
        value={String(prefs.hour)}
        options={hours}
        disabled={!on}
        onValueChange={(v) => onChange({ hour: Number(v) })}
      />
      <Button
        size="sm"
        {...(plated ? {} : { variant: "ghost" as const })}
        onClick={() => onChange(admin ? { off: !prefs.off } : on ? { daily: false } : { daily: true, off: false })}
      >
        {t(on ? "teamWeek.schedule.stop" : "teamWeek.schedule.start")}
      </Button>
    </>
  );
}

/** The day select's "every day" ("Resumo do dia"). */
const DAILY = "daily";
