import type {
  AppNotification,
  Message,
  PeopleUsage,
  PersonLimitCard,
  PersonLimits,
  PersonUsage,
  UsagePlace,
} from "@agenteschat/client";
import {
  keys,
  useApi,
  usePeopleUsage,
  usePersonLimits,
  usePersonUsage,
  useRaisePersonLimit,
  useRefuseMoreUsage,
  useRoles,
  useSetPersonLimits,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  capitalize,
  formatDecimal,
  formatInt,
  formatMonth,
  formatShortDate,
  formatUsd,
  relativeTime,
} from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  chipCounts,
  filterPeople,
  PEOPLE_CHIPS,
  type PeopleChip,
  type PeopleSort,
  type PersonRow,
  personAmount,
  sortPeople,
  USAGE_PERIODS,
  type UsagePeriodKind,
  usagePeriod,
} from "@agenteschat/client/lib/person-usage";
import { rolePicksInSight, settingsSectionNameKey } from "@agenteschat/client/lib/personal-view";
import { parseAmount } from "@agenteschat/client/lib/text";
import {
  AvatarStack,
  agentGradient,
  Button,
  Card,
  CountChip,
  cx,
  Dialog,
  DialogBody,
  EmptyState,
  EventPillAction,
  FilterToggle,
  GroupHeading,
  Icon,
  InfoHint,
  Input,
  Locked,
  Meter,
  RoleMark,
  Segmented,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Toolbar,
  UsageDays,
  UsageSwatch,
} from "@agenteschat/ui";

import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { AskAgentButton } from "@/components/AskAgentButton";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import "./people-usage.css";

/*
 * Usage per person (ADR 0141): Configurações › Orçamento e uso › Pessoas (admins: each person's month, their
 * drawer, the limits, the CSV, who uses agents now) and Seu uso (everyone: their own month in percentages), and the
 * card an agent posts when the person behind its run is at their limit. A DM's work is a count and its cost, never
 * a title.
 */

type Dir = ReturnType<typeof useDirectory>;

const partStyle = (dir: Dir, agentId: string) =>
  ({ "--part": agentGradient(colorOf(dir.agentById.get(agentId)))[0] }) as CSSProperties;

const agentName = (t: TFunction, dir: Dir, id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");

/**
 * The tabs of Orçamento e uso: Resumo (what was there) and Pessoas for who sees money, else Seu uso. Alone in a
 * personal workspace, only Resumo, without tabs (ADR 0159): an owner has no limit and nobody else uses it. A link to a
 * person still opens Pessoas.
 */
export function UsageTabs({ summary, person }: { summary: ReactNode; person?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { solo } = usePersonalView();
  const money = can(org, "view_usage");
  const [tab, setTab] = useState<"summary" | "people">(person ? "people" : "summary");
  useEffect(() => {
    if (person) setTab("people");
  }, [person]);
  if (solo && !person) return <>{summary}</>;
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      label={t(settingsSectionNameKey(org, "usage"))}
      items={[
        { value: "summary", label: t("peopleUsage.tabs.summary") },
        { value: "people", label: money ? t("peopleUsage.tabs.people") : t("peopleUsage.tabs.mine") },
      ]}
    >
      <TabPanel value="summary">{summary}</TabPanel>
      <TabPanel value="people">{money ? <PeopleTab person={person} /> : <MyUsage />}</TabPanel>
    </Tabs>
  );
}

/** Uso › Pessoas for who sees money (ADR 0141): each person's use, or the limits. Equipe's Governança e uso shows it too. */
export function PeopleTab({ person }: { person?: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<"usage" | "limits">("usage");
  const segmented = (
    <Segmented
      value={view}
      onValueChange={setView}
      label={t("peopleUsage.tabs.people")}
      size="sm"
      options={[
        { value: "usage", label: t("peopleUsage.view.usage") },
        { value: "limits", label: t("peopleUsage.view.limits") },
      ]}
    />
  );
  return view === "usage" ? (
    <PeopleView switcher={segmented} person={person} onLimits={() => setView("limits")} />
  ) : (
    <LimitsView switcher={segmented} />
  );
}

/** "Agora" in a row: with which agent, where (as the viewer may see it), or when they last used one. */
function nowLine(t: TFunction, locale: string, dir: Dir, p: PersonRow) {
  if (!p.now) {
    return p.lastActiveAt
      ? t("peopleUsage.now.last", { when: relativeTime(t, locale, p.lastActiveAt) })
      : t("peopleUsage.now.never");
  }
  return placeLine(t, p.now.place, agentName(t, dir, p.now.agentId));
}

function placeLine(t: TFunction, place: UsagePlace, agent: string) {
  if (place.kind === "channel") return t("peopleUsage.now.channel", { agent, channel: place.channelName ?? "" });
  if (place.kind === "routine") return t("peopleUsage.now.routine", { name: place.routineName ?? "" });
  if (place.kind === "hidden") return t("peopleUsage.now.hidden", { agent });
  return t("peopleUsage.now.private", { agent });
}

/** A month's use against a limit: the amount, of the limit, the bar amber from 80% and red at it. */
function UseMeter({ p }: { p: PersonRow }) {
  const { t, i18n } = useTranslation();
  const shown = personAmount(t, i18n.language, p.estimated, p.monthUsd);
  return (
    <div className="pu-meter" data-state={p.state}>
      <span className="pu-meter__line">
        <b className="tabular">{shown}</b>
        <span className="muted">
          {p.limitUsd === null
            ? t("peopleUsage.meter.noLimit")
            : t("peopleUsage.meter.of", { limit: formatDecimal(i18n.language, p.limitUsd) })}
        </span>
        {p.state === "at" && <span className="pu-meter__at">{t("peopleUsage.chips.at")}</span>}
      </span>
      {p.limitUsd !== null && (
        <Meter value={Math.min(p.monthUsd, p.limitUsd)} max={p.limitUsd} label={shown} marks={[80]} />
      )}
    </div>
  );
}

function PeopleView({ switcher, person, onLimits }: { switcher: ReactNode; person?: string; onLimits: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const look = useRightHandLook();
  const api = useApi();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const [period, setPeriod] = useState<UsagePeriodKind>("month");
  const [roleId, setRoleId] = useState("all");
  const [agentId, setAgentId] = useState("all");
  const [chips, setChips] = useState<PeopleChip[]>([]);
  const [sort, setSort] = useState<{ by: PeopleSort; desc: boolean }>({ by: "usage", desc: true });
  const [open, setOpen] = useState<string | null>(person ?? null);
  useEffect(() => {
    if (person) setOpen(person);
  }, [person]);
  const range = usagePeriod(period);
  const usage = usePeopleUsage(org.id, range);
  if (usage.isLoading) return <LoadingList count={6} avatar trailing />;
  if (!usage.data) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const data = usage.data;
  const counts = chipCounts(data.people);
  const roleList = (roles.data?.roles ?? []).filter((r) => r.kind === "custom");
  const roleById = new Map(roleList.map((r) => [r.id, r]));
  const rows = sortPeople(
    filterPeople(data.people, {
      roleId: roleId === "all" ? null : roleId,
      agentId: agentId === "all" ? null : agentId,
      chips,
    }),
    sort.by,
    sort.desc,
    i18n.language,
  );
  const month = capitalize(formatMonth(i18n.language, new Date(`${data.month}-15T12:00:00`)), i18n.language);
  const head = (by: PeopleSort, label: string, className?: string, hint?: ReactNode) => {
    const sorter = (
      <button
        type="button"
        className="pu-sort"
        onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by !== "name" }))}
      >
        {label}
        {sort.by === by && <Icon name={sort.desc ? "chevronDown" : "chevronUp"} size={14} />}
      </button>
    );
    return (
      <th className={className} aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : undefined}>
        {hint ? (
          <span className="ac-hintline">
            {sorter}
            {hint}
          </span>
        ) : (
          sorter
        )}
      </th>
    );
  };
  const nobody = data.people.every((p) => p.runs === 0);
  return (
    <>
      <div className="pu-head">
        <div className="pu-head__text">
          <h3 className="pu-title ac-hintline">
            <span>{t("peopleUsage.title")}</span>
            <InfoHint name={t("common.about", { label: t("peopleUsage.title") })}>
              {data.plansOnly
                ? t("common.joinSentences", { a: t("peopleUsage.about"), b: t("peopleUsage.plansAbout") })
                : t("peopleUsage.about")}
            </InfoHint>
          </h3>
          {data.plansOnly ? (
            // What plans' use would cost through the API: said as that, with why behind the ⓘ.
            <span className="muted ac-hintline">
              <span>
                {t("peopleUsage.subPlans", {
                  month,
                  count: data.people.length,
                  amount: t("peopleUsage.meter.estimate", { amount: formatUsd(i18n.language, data.totalUsd) }),
                })}
              </span>
              <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                {t("usageViews.apiPriceHint")}
              </InfoHint>
            </span>
          ) : (
            <span className="muted">
              {t("peopleUsage.sub", {
                month,
                count: data.people.length,
                amount: formatUsd(i18n.language, data.totalUsd),
              })}
            </span>
          )}
        </div>
        <span className="pu-head__acts">
          <Button
            size="sm"
            icon="download"
            onClick={() =>
              fileSaver.save(
                api.orgs.peopleUsageCsvUrl(org.id, range),
                `usage-per-person-${new Date().toISOString().slice(0, 10)}.csv`,
              )
            }
          >
            {t("peopleUsage.export")}
          </Button>
          {switcher}
        </span>
      </div>
      <Toolbar size="sm">
        <Select
          size="sm"
          aria-label={t("peopleUsage.periodLabel")}
          value={period}
          onValueChange={setPeriod}
          options={USAGE_PERIODS.map((p) => ({ value: p, label: t(`peopleUsage.period.${p}`) }))}
        />
        <Select
          size="sm"
          aria-label={t("peopleUsage.role")}
          value={roleId}
          onValueChange={setRoleId}
          options={[
            { value: "all", label: t("peopleUsage.roleAll") },
            ...roleList.map((r) => ({
              value: r.id,
              label: r.name,
              leading: <RoleMark color={r.color} icon={r.icon} size={16} />,
            })),
          ]}
        />
        <Select
          size="sm"
          aria-label={t("peopleUsage.agent")}
          value={agentId}
          onValueChange={setAgentId}
          options={[
            { value: "all", label: t("peopleUsage.agentAll") },
            ...dir.agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        {PEOPLE_CHIPS.map((c) => (
          <FilterToggle
            key={c}
            pressed={chips.includes(c)}
            onPressedChange={(on) => setChips((l) => (on ? [...l, c] : l.filter((x) => x !== c)))}
            count={counts[c]}
          >
            {t(`peopleUsage.chips.${c}`)}
          </FilterToggle>
        ))}
      </Toolbar>
      <p className="pu-summary">
        <span data-tone="near">{t("peopleUsage.summary.near", { n: counts.near })}</span>
        {" · "}
        <span data-tone="at">{t("peopleUsage.summary.at", { n: counts.at })}</span>
        {" · "}
        <span>{t("peopleUsage.summary.idle", { n: counts.idle })}</span>
      </p>
      {!data.limitsOn && (
        <p className="pu-hint">
          <Icon name="info" size={16} />
          <button type="button" className="ac-link" onClick={onLimits}>
            {t("peopleUsage.limitsHint")}
          </button>
        </p>
      )}
      <LiveCard live={data.live} />
      {nobody && period === "month" ? (
        <EmptyState
          size="panel"
          agent={look}
          title={t("peopleUsage.emptyTitle")}
          actions={<AskAgentButton variant="primary" />}
        >
          {t("peopleUsage.empty")}
        </EmptyState>
      ) : (
        <Card className="pu-table-card">
          <table className="pu-table">
            <thead>
              <tr>
                {head("name", t("peopleUsage.columns.person"))}
                <th>{t("peopleUsage.columns.now")}</th>
                {head("runs", t("peopleUsage.columns.runs"), "pu-num")}
                <th>{t("peopleUsage.columns.agents")}</th>
                {head(
                  "usage",
                  t("peopleUsage.columns.usage"),
                  undefined,
                  // A ≈ in any row: what an estimate is, beside the column's name.
                  rows.some((p) => p.estimated) && (
                    <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                      {t("usageViews.apiPriceHint")}
                    </InfoHint>
                  ),
                )}
                <th>{t("peopleUsage.columns.caresFor")}</th>
                {head("created", t("peopleUsage.columns.created"), "pu-num")}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const role = p.roleIds.map((id) => roleById.get(id)).find(Boolean);
                return (
                  <tr key={p.userId} className="pu-row" onClick={() => setOpen(p.userId)}>
                    <td>
                      <button type="button" className="pu-person" onClick={() => setOpen(p.userId)}>
                        <ActorAvatar actor={{ type: "person", id: p.userId }} name={p.name} size="sm" presence />
                        <span className="pu-person__text">
                          <span className="pu-person__name">{p.name}</span>
                          <span className="pu-person__role">
                            {role ? (
                              <>
                                <RoleMark color={role.color} icon={role.icon} size={14} />
                                {role.name}
                              </>
                            ) : p.owner ? (
                              t("peopleUsage.owner")
                            ) : (
                              t("peopleUsage.member")
                            )}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className={p.now ? "pu-now pu-now--live" : "pu-now"}>
                      <span className={p.now?.place.kind === "private" ? "ac-iconline" : undefined}>
                        {p.now?.place.kind === "private" && <Icon name="lock" size={14} />}
                        <span>{nowLine(t, i18n.language, dir, p)}</span>
                      </span>
                    </td>
                    <td className="pu-num tabular">{formatInt(i18n.language, p.runs)}</td>
                    <td>
                      <Faces
                        ids={p.agents.map((a) => a.agentId)}
                        titles={p.agents.map((a) => `${agentName(t, dir, a.agentId)} ${a.share}%`)}
                      />
                    </td>
                    <td className="pu-use">
                      <UseMeter p={p} />
                    </td>
                    <td>
                      <Faces ids={p.caresFor} />
                    </td>
                    <td className="pu-num tabular">{p.created || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <PersonDrawer userId={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Faces({ ids, titles }: { ids: string[]; titles?: string[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (ids.length === 0) return <span className="muted">—</span>;
  return (
    <AvatarStack className="pu-faces">
      {ids.slice(0, 3).map((id, i) => (
        <span key={id} title={titles?.[i] ?? agentName(t, dir, id)}>
          <AgentAvatar agentId={id} name={agentName(t, dir, id)} size="xs" labelled />
        </span>
      ))}
    </AvatarStack>
  );
}

/** "Agora": who is using which agent right now. */
function LiveCard({ live }: { live: PeopleUsage["live"] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (live.length === 0) return null;
  const people = new Set(live.map((w) => w.personId).filter(Boolean)).size;
  return (
    <Card className="pu-live" aria-labelledby="pu-live-title">
      <h4 id="pu-live-title" className="pu-live__title">
        <span className="pu-live__dot" aria-hidden="true" />
        {t("peopleUsage.live.title")}
        <CountChip>{people}</CountChip>
      </h4>
      <ul className="pu-live__list">
        {live.slice(0, 8).map((w) => {
          const who = w.personId ? (dir.memberById.get(w.personId)?.name ?? t("channel.unknownPerson")) : null;
          const agent = agentName(t, dir, w.agentId);
          return (
            <li key={`${w.agentId}-${w.startedAt}`} className="pu-live__row">
              <AgentAvatar agentId={w.agentId} name={agent} size="xs" />
              <span className="pu-live__text">
                <b>{w.routine ? t("peopleUsage.live.routineOf", { name: who ?? "" }) : (who ?? agent)}</b>
                {" → "}
                {agent}
                <span className="muted">
                  {" · "}
                  {[placeLine(t, w.place, agent), w.title, relativeTime(t, i18n.language, w.startedAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The month day by day, stacked by agent in their colors, with its legend. */
function DaysChart({ data, money }: { data: PersonUsage; money: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const since = new Date(data.since);
  const until = new Date(data.until);
  const month = data.days[0]?.date.slice(0, 7) ?? data.since.slice(0, 7);
  const sameMonth = since.getUTCMonth() === new Date(`${month}-15`).getUTCMonth();
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const total = (d: { agents: Record<string, number> }) => Object.values(d.agents).reduce((a, b) => a + b, 0);
  const max = Math.max(1e-9, ...data.days.map(total));
  const today = until.getUTCDate();
  const columns = Array.from({ length: sameMonth ? daysInMonth : data.days.length }, (_, i) => {
    const date = sameMonth ? `${month}-${String(i + 1).padStart(2, "0")}` : (data.days[i]?.date ?? "");
    const day = data.days.find((d) => d.date === date);
    if (sameMonth && i + 1 > today) return { key: date, parts: [], ahead: true };
    return {
      key: date,
      parts: Object.entries(day?.agents ?? {}).map(([id, v]) => ({
        key: id,
        value: (v / max) * 100,
        style: partStyle(dir, id),
      })),
    };
  });
  const amount = (v: number) => (money ? formatUsd(i18n.language, v) : `${Math.round(v)}%`);
  return (
    <div className="pu-days">
      <UsageDays days={columns} label={t("peopleUsage.drawer.days")} />
      {sameMonth && (
        <div className="pu-axis tabular" aria-hidden="true">
          <span>{formatShortDate(i18n.language, `${month}-01T12:00:00`)}</span>
          <span>15</span>
          <span>{daysInMonth}</span>
        </div>
      )}
      <div className="plan-legend">
        {data.agents.map((a) => (
          <span key={a.agentId} className="plan-legend__item">
            <UsageSwatch style={partStyle(dir, a.agentId)} />
            {agentName(t, dir, a.agentId)} · {amount(a.amount)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** What they did, newest first: a channel's work with its title; a DM or a private channel as a count. */
function RecentList({ data }: { data: PersonUsage }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const amount = (v: number) =>
    data.money ? formatUsd(i18n.language, v) : t("peopleUsage.mine.ofLimit", { percent: Math.round(v) });
  if (data.recent.length === 0) return <p className="plan-empty">{t("peopleUsage.drawer.noUse")}</p>;
  return (
    <ul className="pu-recent">
      {data.recent.map((r) => {
        const agent = agentName(t, dir, r.agentId);
        const [title, line] =
          r.kind === "work"
            ? r.place.kind === "routine"
              ? [
                  t("peopleUsage.drawer.routine", { name: r.place.routineName ?? "" }),
                  [agent, relativeTime(t, i18n.language, r.startedAt)].join(" · "),
                ]
              : [
                  r.title || t("peopleUsage.drawer.untitled"),
                  [
                    t("peopleUsage.drawer.with", { agent }),
                    r.place.kind === "channel" ? `#${r.place.channelName}` : null,
                    t("peopleUsage.drawer.minutes", { n: r.minutes }),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ]
            : [
                r.kind === "private"
                  ? t("peopleUsage.drawer.private", { agent })
                  : t("peopleUsage.drawer.hidden", { agent }),
                t("peopleUsage.drawer.runs", { count: r.runs }),
              ];
        return (
          <li
            key={`${r.kind}-${r.agentId}-${"startedAt" in r ? r.startedAt : r.lastAt}`}
            className="pu-recent__row ac-mediarow ac-mediarow--row"
          >
            <span className="ac-mediarow__face">
              <AgentAvatar agentId={r.agentId} name={agent} size="sm" />
            </span>
            <span className="ac-mediarow__head">
              <span className="pu-recent__title">
                {r.kind !== "work" && <Icon name="lock" size={14} inline />}
                {title}
              </span>
            </span>
            <span className="ac-mediarow__end pu-recent__amount tabular">{amount(r.amount)}</span>
            <span className="ac-mediarow__body muted">{line}</span>
          </li>
        );
      })}
    </ul>
  );
}

function limitFromText(t: TFunction, l: PersonUsage["limit"], roleName: (id: string) => string) {
  switch (l.limitFrom) {
    case "raised":
      return t("peopleUsage.from.raised");
    case "person":
      return t("peopleUsage.from.person");
    case "role":
      return t("peopleUsage.from.role", { role: roleName(l.limitRoleId ?? "") });
    case "default":
      return t("peopleUsage.from.default");
    default:
      return "";
  }
}

/** A person's month, at the side (480 px): their limit, use per day, agents, what they did and created. */
function PersonDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const usage = usePersonUsage(org.id, userId);
  const raise = useRaisePersonLimit(org.id);
  const toast = useToast();
  const [raising, setRaising] = useState<string | null>(null);
  const data = usage.data;
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? "";
  const member = userId ? dir.memberById.get(userId) : undefined;
  const role = data?.roleIds.map((id) => roles.data?.roles.find((r) => r.id === id)).find(Boolean);
  const l = data?.limit;
  const submitRaise = () => {
    const v = parseAmount(raising ?? "");
    if (!userId || !(v > 0)) return;
    raise.mutate([userId, v], {
      onSuccess: () => {
        setRaising(null);
        toast.show(t("peopleUsage.drawer.raised"));
      },
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  };
  return (
    <Dialog
      open={userId !== null}
      onOpenChange={(o) => !o && onClose()}
      title={data?.name ?? member?.name ?? ""}
      closeLabel={t("common.close")}
      className="pu-drawer"
      width={480}
      leading={
        userId ? (
          <ActorAvatar actor={{ type: "person", id: userId }} name={member?.name ?? ""} size="md" presence />
        ) : null
      }
      subtitle={
        role ? (
          <span className="pu-person__role">
            <RoleMark color={role.color} icon={role.icon} size={14} />
            {role.name}
          </span>
        ) : data?.owner ? (
          t("peopleUsage.owner")
        ) : (
          t("peopleUsage.member")
        )
      }
    >
      {!data ? (
        <DialogBody>
          {usage.isError ? (
            <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
          ) : (
            <LoadingList count={5} avatar trailing />
          )}
        </DialogBody>
      ) : (
        <div className="pu-drawer__body">
          {l && l.limitUsd != null ? (
            <section className="pu-limit" data-state={l.state}>
              <div className="pu-limit__head">
                <b>{t("peopleUsage.drawer.limit", { amount: formatUsd(i18n.language, l.limitUsd) })}</b>
                <span className="muted">{limitFromText(t, l, roleName)}</span>
              </div>
              <Meter
                value={Math.min(l.monthUsd ?? 0, l.limitUsd)}
                max={l.limitUsd}
                label={t("peopleUsage.drawer.limit", { amount: formatUsd(i18n.language, l.limitUsd) })}
                marks={[80]}
              />
              <span className="pu-limit__line">
                {l.reachedAt
                  ? t("peopleUsage.drawer.reached", {
                      date: formatShortDate(i18n.language, l.reachedAt),
                      used: personAmount(t, i18n.language, data.estimated, l.monthUsd ?? 0),
                    })
                  : t("peopleUsage.drawer.used", {
                      used: personAmount(t, i18n.language, data.estimated, l.monthUsd ?? 0),
                      percent: Math.round(l.percent ?? 0),
                    })}
              </span>
              {raising === null ? (
                <span className="pu-limit__acts">
                  <Button size="sm" variant="primary" onClick={() => setRaising(String(l.raiseToUsd ?? l.limitUsd))}>
                    {l.requested && l.raiseToUsd
                      ? t("peopleUsage.actions.raise", { amount: formatUsd(i18n.language, l.raiseToUsd) })
                      : t("peopleUsage.drawer.raise")}
                  </Button>
                  {l.requested && <span className="pu-limit__asked">{t("peopleUsage.drawer.asked")}</span>}
                </span>
              ) : (
                <form
                  className="pu-limit__acts"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitRaise();
                  }}
                >
                  <Locked when={raise.isPending}>
                    <Input
                      aria-label={t("peopleUsage.drawer.raiseTo")}
                      inputMode="decimal"
                      value={raising}
                      onChange={(e) => setRaising(e.target.value)}
                      className="pu-amount"
                      autoFocus
                    />
                  </Locked>
                  <Button size="sm" variant="primary" type="submit" loading={raise.isPending}>
                    {t("peopleUsage.drawer.raiseSave")}
                  </Button>
                  <Button size="sm" onClick={() => setRaising(null)}>
                    {t("common.cancel")}
                  </Button>
                </form>
              )}
            </section>
          ) : (
            <p className="muted">{t("peopleUsage.drawer.noLimit")}</p>
          )}
          <section>
            <h4 className="pu-h4">{t("peopleUsage.drawer.days")}</h4>
            <DaysChart data={data} money={data.money} />
          </section>
          {data.agents.length > 0 && (
            <section>
              <h4 className="pu-h4">{t("peopleUsage.drawer.agents")}</h4>
              <ul className="pu-agents">
                {data.agents.map((a) => (
                  <li key={a.agentId}>
                    <AgentAvatar agentId={a.agentId} name={agentName(t, dir, a.agentId)} size="sm" />
                    <b>{agentName(t, dir, a.agentId)}</b>
                    <span className="muted">{t("peopleUsage.drawer.runs", { count: a.runs })}</span>
                    <span className="pu-recent__amount tabular">{formatUsd(i18n.language, a.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="pu-h4">{t("peopleUsage.drawer.recent")}</h4>
            <RecentList data={data} />
          </section>
          {data.created.length > 0 && (
            <section>
              <h4 className="pu-h4">{t("peopleUsage.drawer.created")}</h4>
              <ul className="pu-agents">
                {data.created.map((c) => (
                  <li key={c.agentId}>
                    <AgentAvatar agentId={c.agentId} name={agentName(t, dir, c.agentId)} size="sm" />
                    <b>{agentName(t, dir, c.agentId)}</b>
                    <span className="muted">
                      {t("peopleUsage.drawer.createdAt", { date: formatShortDate(i18n.language, c.createdAt) })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "audit" }}
            className="pu-audit ac-link"
          >
            <Icon name="shield" size={16} />
            {t("peopleUsage.drawer.audit")}
          </Link>
        </div>
      )}
    </Dialog>
  );
}

type Choice = "default" | "none" | "amount";
/** What a limit's select shows: the default where it may follow it, else "Sem limite" or an amount, never an empty box. */
const choiceOf = (v: number | null | undefined, has: boolean, allowDefault: boolean): Choice =>
  !has && allowDefault ? "default" : v === null || v === undefined ? "none" : "amount";

/** One limit: "Usar o padrão" (not for the default itself), "Sem limite" or an amount a month. */
function LimitPick({
  id,
  label,
  value,
  has,
  allowDefault,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  has: boolean;
  allowDefault: boolean;
  onChange: (next: { has: boolean; value: number | null }) => void;
}) {
  const { t, i18n } = useTranslation();
  const choice = choiceOf(value, has, allowDefault);
  const [text, setText] = useState(value ? new Intl.NumberFormat(i18n.language).format(value) : "");
  return (
    <span className="pu-pick">
      {choice === "amount" && (
        <span className="pu-usd">
          <span aria-hidden="true">US$</span>
          <Input
            aria-label={label}
            inputMode="decimal"
            value={text || (value ? String(value) : "")}
            onChange={(e) => {
              setText(e.target.value);
              const n = parseAmount(e.target.value);
              if (n > 0) onChange({ has: true, value: n });
            }}
            className="pu-amount"
          />
        </span>
      )}
      <Select<Choice>
        size="sm"
        id={id}
        className="pu-pick__select"
        aria-label={label}
        value={choice}
        onValueChange={(c) =>
          onChange(
            c === "default"
              ? { has: false, value: null }
              : c === "none"
                ? { has: true, value: null }
                : { has: true, value: parseAmount(text) || 20 },
          )
        }
        options={[
          ...(allowDefault ? [{ value: "default" as const, label: t("peopleUsage.limits.useDefault") }] : []),
          { value: "none", label: t("peopleUsage.limits.none") },
          { value: "amount", label: t("peopleUsage.limits.amount") },
        ]}
      />
    </span>
  );
}

/** Limites: the default, per role, per person, what happens at the limit and the 80% notice. */
function LimitsView({ switcher }: { switcher: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const limits = usePersonLimits(org.id);
  const save = useSetPersonLimits(org.id);
  const toast = useToast();
  const editable = can(org, "configure");
  const [draft, setDraft] = useState<PersonLimits | null>(null);
  useEffect(() => {
    if (limits.data && !draft) setDraft(limits.data);
  }, [limits.data, draft]);
  if (!draft) {
    return limits.isError ? (
      <ErrorState error={limits.error} onRetry={() => void limits.refetch()} />
    ) : (
      <LoadingList count={4} avatar={false} trailing />
    );
  }
  // Limits per role, in a personal workspace only once a role is worth it or one already has a limit (ADR 0159).
  const allRoles = roles.data?.roles ?? [];
  const roleList = rolePicksInSight(org, allRoles, Object.keys(limits.data?.roles ?? {}))
    ? allRoles.filter((r) => r.kind === "custom")
    : [];
  const people = dir.members.filter((m) => m.userId in draft.people);
  const others = dir.members.filter((m) => !(m.userId in draft.people) && m.role !== "owner");
  const set = (patch: Partial<PersonLimits>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setIn = (field: "roles" | "people", id: string, next: { has: boolean; value: number | null }) => {
    const copy = { ...draft[field] };
    if (next.has) copy[id] = next.value;
    else delete copy[id];
    set({ [field]: copy });
  };
  const row = (label: ReactNode, pick: ReactNode, lead?: ReactNode) => (
    <div className={cx("settings-row ac-actrow", lead !== undefined && "settings-row--lead")}>
      {lead !== undefined && (
        <span className="settings-row__icon" aria-hidden="true">
          {lead}
        </span>
      )}
      <span className="settings-row__text ac-actrow__text">{label}</span>
      <span className="settings-row__end">{pick}</span>
    </div>
  );
  const hinted = (id: string, label: string, hint: string) => (
    <span className="ac-hintline">
      <label className="settings-row__label" htmlFor={id}>
        {label}
      </label>
      <InfoHint name={t("common.about", { label })}>{hint}</InfoHint>
    </span>
  );
  return (
    <>
      <div className="pu-head">
        <div className="pu-head__text">
          <h3 className="pu-title ac-hintline">
            <span>{t("peopleUsage.limits.title")}</span>
            <InfoHint name={t("common.about", { label: t("peopleUsage.limits.title") })}>
              {t("common.joinSentences", { a: t("peopleUsage.limits.leadMore"), b: t("peopleUsage.limits.rule") })}
            </InfoHint>
          </h3>
          <span className="muted">{t("peopleUsage.limits.lead")}</span>
        </div>
        {switcher}
      </div>
      <Card className="pu-limits">
        <Locked when={save.isPending}>
          <div className="settings-rows">
            {row(
              hinted("pu-default", t("peopleUsage.limits.default"), t("peopleUsage.limits.defaultHint")),
              <LimitPick
                id="pu-default"
                label={t("peopleUsage.limits.default")}
                value={draft.defaultUsd}
                has={draft.defaultUsd !== null}
                allowDefault={false}
                onChange={(n) => set({ defaultUsd: n.value })}
              />,
            )}
            {row(
              hinted("pu-when", t("peopleUsage.limits.whenTitle"), t("peopleUsage.limits.whenHint")),
              <Select
                size="sm"
                id="pu-when"
                className="pu-pick__select"
                aria-label={t("peopleUsage.limits.whenTitle")}
                value={draft.onLimit}
                onValueChange={(v) => set({ onLimit: v })}
                options={(["block", "notify"] as const).map((v) => ({
                  value: v,
                  label: t(v === "block" ? "peopleUsage.limits.blockShort" : "peopleUsage.limits.notify"),
                }))}
              />,
            )}
            {row(
              hinted("pu-warn", t("peopleUsage.limits.warn"), t("peopleUsage.limits.warnHint")),
              <Switch id="pu-warn" checked={draft.warn} onCheckedChange={(on) => set({ warn: on })} />,
            )}
            {roleList.length > 0 && <GroupHeading level={4} title={t("peopleUsage.limits.byRole")} />}
            {roleList.map((r) => (
              <Fragment key={r.id}>
                {row(
                  <span className="settings-row__label">{r.name}</span>,
                  <LimitPick
                    id={`pu-role-${r.id}`}
                    label={r.name}
                    value={draft.roles[r.id]}
                    has={r.id in draft.roles}
                    allowDefault
                    onChange={(n) => setIn("roles", r.id, n)}
                  />,
                  <RoleMark color={r.color} icon={r.icon} size={20} />,
                )}
              </Fragment>
            ))}
            {people.length + others.length > 0 && (
              <GroupHeading
                level={4}
                title={t("peopleUsage.limits.people")}
                aside={
                  others.length > 0 && (
                    <Select
                      size="sm"
                      className="pu-pick__select"
                      aria-label={t("peopleUsage.limits.addPerson")}
                      placeholder={t("peopleUsage.limits.addPerson")}
                      value={undefined}
                      align="end"
                      onValueChange={(id) => setIn("people", id, { has: true, value: draft.defaultUsd ?? 20 })}
                      options={others.map((m) => ({
                        value: m.userId,
                        label: m.name,
                        leading: <ActorAvatar actor={{ type: "person", id: m.userId }} name={m.name} size="sm" />,
                      }))}
                    />
                  )
                }
              />
            )}
            {people.map((m) => (
              <Fragment key={m.userId}>
                {row(
                  <span className="settings-row__label">{m.name}</span>,
                  <LimitPick
                    id={`pu-person-${m.userId}`}
                    label={m.name}
                    value={draft.people[m.userId]}
                    has
                    allowDefault
                    onChange={(n) => setIn("people", m.userId, n)}
                  />,
                  <ActorAvatar actor={{ type: "person", id: m.userId }} name={m.name} size="xs" />,
                )}
              </Fragment>
            ))}
          </div>
        </Locked>
        {editable && (
          <div className="pu-save">
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate([draft], {
                  onSuccess: (saved) => {
                    setDraft(saved);
                    toast.show(t("peopleUsage.limits.saved"));
                  },
                  onError: (e) => toast.show(errorText(t, e), "error"),
                })
              }
            >
              {t("common.save")}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

/** Seu uso: the viewer's own month, in percentages of their limit (never money). */
export function MyUsage() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const usage = usePersonUsage(org.id, me.user.id);
  if (usage.isLoading) return <LoadingList count={4} avatar={false} trailing />;
  if (!usage.data) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const data = usage.data;
  const l = data.limit;
  const renews = formatShortDate(i18n.language, data.renewsAt);
  return (
    <>
      <Card className="pu-mine">
        <h3 className="pu-title">
          {l.percent === null
            ? t("peopleUsage.mine.noLimit")
            : t("peopleUsage.mine.title", { percent: Math.round(l.percent) })}
        </h3>
        {l.percent !== null && (
          <div className="pu-meter" data-state={l.state}>
            <Meter value={Math.min(100, l.percent)} max={100} label={`${Math.round(l.percent)}%`} marks={[80]} />
          </div>
        )}
        <p className="muted pu-mine__line">
          {t("peopleUsage.mine.renews", { date: renews })}
          {l.state === "near" || l.state === "at" ? ` ${t("peopleUsage.mine.near")}` : ""}
        </p>
        <h4 className="pu-h4">{t("peopleUsage.drawer.days")}</h4>
        <DaysChart data={data} money={false} />
      </Card>
      <Card className="pu-mine">
        <h4 className="pu-h4">{t("peopleUsage.mine.recent")}</h4>
        <RecentList data={data} />
      </Card>
    </>
  );
}

/**
 * The waiting pill an agent posts in place of an answer when the person behind its run is at their monthly limit: for
 * that person, "Ask for more" (primary) and "See my usage", when it renews under it; anyone else reads who reached it,
 * quiet. A raise turns it into a decided pill; a refusal says so under it.
 */
export function PersonLimitCardView({ card }: { message: Message; card: PersonLimitCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [asked, setAsked] = useState(false);
  const [pending, setPending] = useState(false);
  const mine = card.userId === me.user.id;
  const date = formatShortDate(i18n.language, card.renewsAt);
  const by = card.byUserId ? (dir.memberById.get(card.byUserId)?.name ?? t("channel.unknownPerson")) : "";
  const who = card.userId ? (dir.memberById.get(card.userId)?.name ?? t("channel.unknownPerson")) : "";
  const ask = async () => {
    setPending(true);
    try {
      await api.orgs.requestMoreUsage(org.id);
      setAsked(true);
      void qc.invalidateQueries({ queryKey: keys.personUsage(org.id, me.user.id) });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(false);
    }
  };
  if (card.state === "raised") {
    const text = mine ? t("peopleUsage.card.raised", { name: by }) : t("peopleUsage.card.raisedOther", { name: by });
    return (
      <RequestDone done label={text}>
        {text}
      </RequestDone>
    );
  }
  const title = mine ? t("peopleUsage.card.title") : t("peopleUsage.card.other", { name: who });
  return (
    <RequestOpen
      mine={mine && card.state !== "refused"}
      icon="pause"
      label={title}
      action={
        mine ? (
          <>
            {card.state !== "refused" && (
              <EventPillAction primary disabled={pending || asked} onClick={ask}>
                {asked ? t("peopleUsage.card.asked") : t("peopleUsage.card.ask")}
              </EventPillAction>
            )}
            {/* A link (it opens in a new tab too), drawn as the pill's action. */}
            <Link
              to="/org/$orgId/settings/$section"
              params={{ orgId: org.id, section: "usage" }}
              className="ac-eventpill__action"
            >
              {t("peopleUsage.card.see")}
            </Link>
          </>
        ) : undefined
      }
      below={
        mine ? (
          <span>
            {card.state === "refused"
              ? t("peopleUsage.card.refused", { name: by, date })
              : t("peopleUsage.card.text", { date })}
          </span>
        ) : undefined
      }
    >
      {title}
    </RequestOpen>
  );
}

/**
 * A person's request for more, in the inbox of who decides: "Aumentar para US$ X este mês", "Recusar" and their
 * month. Gone once someone answered (the notice resolves).
 */
export function UsageLimitActions({ n }: { n: AppNotification }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const raise = useRaisePersonLimit(org.id);
  const refuse = useRefuseMoreUsage(org.id);
  const toast = useToast();
  const userId = n.source.userId;
  if (n.latest.statusTo !== "request" || !userId || n.doneAt) return null;
  const to = n.latest.raiseToUsd;
  const fail = (e: unknown) => toast.show(errorText(t, e), "error");
  return (
    <span className="pu-asks ac-acts">
      {to !== undefined && (
        <Button
          size="sm"
          variant="primary"
          loading={raise.isPending}
          onClick={(e) => {
            e.stopPropagation();
            raise.mutate([userId, to], { onError: fail });
          }}
        >
          {t("peopleUsage.actions.raise", { amount: formatUsd(i18n.language, to) })}
        </Button>
      )}
      <Button
        size="sm"
        loading={refuse.isPending}
        onClick={(e) => {
          e.stopPropagation();
          refuse.mutate([userId], { onError: fail });
        }}
      >
        {t("peopleUsage.actions.refuse")}
      </Button>
      <Link
        to="/org/$orgId/settings/$section"
        params={{ orgId: org.id, section: "usage" }}
        search={{ person: userId }}
        className="ac-link pu-asks__see"
        onClick={(e) => e.stopPropagation()}
      >
        {t("peopleUsage.actions.see")}
      </Link>
    </span>
  );
}
