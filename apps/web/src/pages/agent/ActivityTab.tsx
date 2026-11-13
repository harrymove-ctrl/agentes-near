import type { Run } from "@agenteschat/client";
import { useAgentDetail, useChannels, useRoutines, useRuns, useUsage } from "@agenteschat/client";
import { runErrorText } from "@agenteschat/client/lib/errors";
import {
  capitalize,
  dayLabel,
  formatInt,
  formatMonth,
  formatPercent,
  formatTime,
  formatTokensShort,
  formatUsd,
} from "@agenteschat/client/lib/format";
import { covers } from "@agenteschat/client/lib/repos";
import { excerpt } from "@agenteschat/client/lib/text";
import {
  type AgentColor,
  Button,
  Card,
  Chip,
  EmptyState,
  GroupHeading,
  Icon,
  Meter,
  type MonthDay,
  MonthRuns,
  RunMark,
  SearchField,
  Segmented,
  Toolbar,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usd } from "@/components/AgentFields";
import { AskAgentButton } from "@/components/AskAgentButton";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { groupByDay, isRoutineRun, type RunFilter, runMatches } from "@/lib/agent-edit";
import { lookOf } from "@/lib/look";
import { usageShown } from "@/lib/plan-usage";
import { useAgentEdit } from "./context";
import { RunChip, runWhere } from "./pieces";

/** How many runs show at first, and how many more each "Carregar mais". */
export const RUNS_PAGE = 20;

/** Why a run failed, in the person's language (the server's code), else its own words. */
const failure = (t: TFunction, run: Run) =>
  runErrorText(t, run.errorCode, run.errorParams) ??
  run.errorParams?.detail ??
  run.error ??
  t("agentPage.activity.errors.unknown");

/**
 * The month on top of Atividade (NumerosAgente C): its runs per day in pixels, in the agent's tones, failures
 * capped in the danger tone, and the numbers beside it as the legend (runs, failures, tokens, money). No money
 * for an agent on a plan that spent nothing through the API: its limits are in Uso (ADR 0063 §5).
 */
function MonthStrip({
  color,
  month,
  runs,
  failures,
  perDay,
  tokens,
  money,
}: {
  color: AgentColor;
  month: string;
  runs: number;
  failures: number;
  perDay: MonthDay[];
  tokens: string;
  /** Admins see dollars against the budget; the others its share used. */
  money: { spent: number; limit: number } | { percent: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const now = new Date();
  // The month is counted in UTC (the server's), like its days.
  const today = now.getUTCDate();
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const [tip, setTip] = useState<string | undefined>(undefined);
  const byDay = new Map(perDay.map((d) => [d.day, d]));
  const say = (day: number) => {
    const d = byDay.get(day);
    const text = t("agentPage.activity.dayRuns", { day, count: d?.runs ?? 0 });
    return d?.failed ? `${text} · ${t("agentPage.stats.failures", { count: d.failed })}` : text;
  };
  const ticks = [1, 8, 15, 22, days];
  return (
    <section className="agp-month" aria-label={t("agentPage.activity.monthLabel", { month })}>
      <div className="agp-month__chart">
        <p className="agp-month__cap">
          <b>{capitalize(month, i18n.language)}</b>
          <span>{t("agentPage.activity.perDay")}</span>
        </p>
        <div
          role="img"
          aria-label={t("agentPage.activity.chartLabel", { count: runs, month })}
          title={tip}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const day = Math.min(days, Math.max(1, Math.floor(((e.clientX - r.left) / r.width) * days) + 1));
            setTip(day > today ? undefined : say(day));
          }}
          onMouseLeave={() => setTip(undefined)}
        >
          <MonthRuns days={days} today={today} perDay={perDay} color={color} />
        </div>
        <div className="agp-month__axis" aria-hidden="true">
          {ticks.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
      </div>
      <dl className="agp-month__legend">
        <dt>
          <RunMark color={color} status="ok" />
          {t("agentPage.activity.runs")}
        </dt>
        <dd>{formatInt(locale, runs)}</dd>
        <dt>
          <RunMark color={color} status="failed" />
          {t("agentPage.activity.failures")}
        </dt>
        <dd>{formatInt(locale, failures)}</dd>
        <dt>
          <Icon name="document" size={14} />
          {t("agentPage.activity.tokens")}
        </dt>
        <dd>{tokens}</dd>
        {money && (
          <>
            <dt>
              <Icon name="wallet" size={14} />
              {"spent" in money ? t("agentPage.activity.spent") : t("agentPage.stats.budget")}
            </dt>
            <dd>
              {"spent" in money ? (
                <>
                  {formatUsd(locale, money.spent)}{" "}
                  <small>{t("agentPage.stats.of", { amount: usd(t, locale, money.limit) })}</small>
                </>
              ) : (
                formatPercent(locale, money.percent)
              )}
            </dd>
            <div className="agp-month__meter">
              {"spent" in money ? (
                <Meter value={money.spent} max={money.limit} label={t("agentPage.activity.spent")} />
              ) : (
                <Meter value={money.percent} max={100} label={t("agentPage.stats.budget")} />
              )}
            </div>
          </>
        )}
      </dl>
    </section>
  );
}

/** Atividade: this month's runs by day, with search and filters (all, failures, waiting, routines). */
export function ActivityTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org } = useOrg();
  const { agent, g, viewer, ownerFirst, saved, can, pickRepos } = useAgentEdit();
  const allowed = viewer !== "member";
  const runs = useRuns(org.id, agent.id, allowed);
  const detail = useAgentDetail(org.id, agent.id);
  const channels = useChannels(org.id);
  const routines = useRoutines(org.id);
  const usage = useUsage(org.id);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const [shown, setShown] = useState(RUNS_PAGE);
  const prompts = useMemo(
    () => (routines.data ?? []).flatMap((r) => (r.agentId === agent.id && r.prompt ? [r.prompt] : [])),
    [routines.data, agent.id],
  );
  const month = formatMonth(locale, new Date());
  if (!allowed) {
    return (
      <Card className="agp-card">
        <div className="agp-empty">
          <Icon name="lock" />
          <b>{t("agentPage.activity.hidden", { owner: ownerFirst ?? t("roles.adminLower") })}</b>
        </div>
      </Card>
    );
  }
  // Newest first (the day groups rely on it).
  const list = [...(runs.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const extra = (r: Run) => ({
    where: runWhere(t, r, channels.data ?? []),
    routine: isRoutineRun(r, prompts, agent.handle),
  });
  const filtered = list.filter((r) => runMatches(r, filter, q, extra(r)));
  const visible = filtered.slice(0, shown);
  const failures = list.filter((r) => r.status === "failed").length;
  const waiting = list.filter((r) => r.status === "waiting_approval" || r.status === "waiting_input").length;
  const routineCount = list.filter((r) => extra(r).routine).length;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const used = detail.data?.budgetUsedPercent ?? 0;
  const days = groupByDay(visible);
  return (
    <>
      <MonthStrip
        color={colorOf(agent)}
        month={month}
        runs={detail.data?.runsThisMonth ?? 0}
        failures={detail.data?.failuresThisMonth ?? 0}
        perDay={detail.data?.runsByDay ?? []}
        tokens={formatTokensShort(t, locale, detail.data?.tokensThisMonth ?? 0)}
        money={
          !usageShown(agent.brain, used).budget
            ? null
            : viewer === "admin" && spent !== undefined && limit !== undefined
              ? { spent, limit }
              : { percent: used }
        }
      />
      <Card as="section" className="agp-card" aria-label={t("agentPage.activity.title")}>
        <Toolbar
          size="sm"
          search={
            <SearchField
              size="sm"
              aria-label={t("agent.runsSearch")}
              placeholder={t("agent.runsPlaceholder")}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setShown(RUNS_PAGE);
              }}
              onClear={() => {
                setQ("");
                setShown(RUNS_PAGE);
              }}
              clearLabel={t("filters.clearSearch")}
            />
          }
        >
          <Segmented
            size="sm"
            label={t("agentPage.activity.filter")}
            value={filter}
            onValueChange={(f) => {
              setFilter(f);
              setShown(RUNS_PAGE);
            }}
            options={[
              { value: "all" as const, label: t("agentPage.activity.filters.all") },
              {
                value: "failed" as const,
                label: t("agentPage.activity.filters.failed"),
                count: failures,
              },
              {
                value: "waiting" as const,
                label: t("agentPage.activity.filters.waiting"),
                count: waiting,
              },
              {
                value: "routines" as const,
                label: t("agentPage.activity.filters.routines"),
                count: routineCount,
              },
            ]}
          />
        </Toolbar>
        {runs.isLoading ? (
          <LoadingList count={4} />
        ) : runs.isError && !runs.data ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            size="panel"
            agent={lookOf(agent) ?? true}
            title={t("agentPage.activity.emptyTitle")}
            actions={<AskAgentButton agent={agent} variant="primary" />}
          >
            {t("agentPage.activity.emptyText", g)}
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState
            size="inline"
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setQ("");
                  setFilter("all");
                }}
              >
                {t("filters.clearAll")}
              </Button>
            }
          >
            {q.trim() ? t("agent.runsEmpty", { q }) : t("agentPage.activity.noneFilter")}
          </EmptyState>
        ) : (
          <div className="ac-groups">
            {days.map((d) => (
              <section key={d.day} aria-label={dayLabel(t, locale, d.runs[0]?.createdAt ?? "")}>
                <GroupHeading level={3} title={dayLabel(t, locale, d.runs[0]?.createdAt ?? "")} />
                <ul className="agp-list">
                  {d.runs.map((r) => {
                    const x = extra(r);
                    // New input apart from what the prompt cache gave back (cheaper), and the output.
                    const cached = r.cachedTokens ?? 0;
                    const tokens = (fmt: (locale: string, n: number) => string) => ({
                      input: fmt(locale, Math.max(0, r.inputTokens - cached)),
                      cached: fmt(locale, cached),
                      output: fmt(locale, r.outputTokens),
                    });
                    return (
                      <li key={r.id} className="agp-run">
                        <time dateTime={r.createdAt}>{formatTime(locale, r.createdAt)}</time>
                        <span className="agp-run__t">
                          <b>{r.private ? t("agent.runPrivate") : excerpt(r.what, 200) || t("agent.runNoText")}</b>
                          <span className="agp-chips">
                            <RunChip run={r} />
                            <Chip icon={x.where.startsWith("#") ? "channel" : "person"}>
                              {x.where.replace(/^#/, "")}
                            </Chip>
                            {r.repo && <Chip icon="repo">{r.repo}</Chip>}
                            {x.routine && <Chip icon="routines">{t("agentPage.activity.routine")}</Chip>}
                          </span>
                          {r.status === "failed" && (
                            <span className="agp-run__fail ac-iconline">
                              <Icon name="alert" size={14} />
                              {/* A computer's own code, worded generically, only on hover (as in the chat). */}
                              <span title={r.errorParams?.code}>{failure(t, r)}</span>
                            </span>
                          )}
                          {r.deniedRepo && saved.repos?.mode === "some" && !covers(saved.repos.list, r.deniedRepo) && (
                            <span className="agp-run__fail ac-iconline">
                              <Icon name="alert" size={14} />
                              {t("repos.deniedRun", { repo: r.deniedRepo, ...g })}
                            </span>
                          )}
                          {r.deniedRepo &&
                            can("repos") &&
                            saved.repos?.mode === "some" &&
                            !covers(saved.repos.list, r.deniedRepo) && (
                              <span>
                                <Button size="sm" icon="plus" onClick={() => pickRepos(r.deniedRepo ?? undefined)}>
                                  {t("repos.allow", { repo: r.deniedRepo })}
                                </Button>
                              </span>
                            )}
                        </span>
                        <span className="agp-run__r" title={t("agent.runTokensTip", tokens(formatInt))}>
                          {t(
                            "agent.runTokens",
                            tokens((l, n) => formatTokensShort(t, l, n)),
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        <div className="agp-row agp-row--between">
          <span className="small muted">
            {t("agentPage.activity.showing", { shown: visible.length, total: filtered.length })}
          </span>
          {filtered.length > visible.length && (
            <Button size="sm" onClick={() => setShown((n) => n + RUNS_PAGE)}>
              {t("agentPage.activity.more")}
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}
