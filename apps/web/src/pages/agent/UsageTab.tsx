import type { AgentPlanUsage } from "@agenteschat/client";
import { useAgentPlanUsage, useApi, useModels } from "@agenteschat/client";
import {
  formatMonth,
  formatPercent,
  formatShortDate,
  formatTokensShort,
  formatUsd,
  joinNames,
} from "@agenteschat/client/lib/format";
import { apiProviderOf } from "@agenteschat/client/lib/providers";
import {
  Card,
  CardFooter,
  Icon,
  InfoHint,
  Meter,
  PlanMeter,
  ProviderLogo,
  UsageDays,
  UsageSwatch,
} from "@agenteschat/ui";
import { type CSSProperties, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { AccountHead } from "@/components/PlanUsage";
import { useDirectory } from "@/hooks/useDirectory";
import { brandOf, noWindowsText, partedUsage, planMeterText, usageSourceName, usageSourcePart } from "@/lib/plan-usage";
import { CardHead, useAgentEdit } from "./context";

/*
 * Uso (ADR 0063): one sentence with the month by account, the month day by
 * day colored by account, the account it thinks with now with its windows
 * (its part in full ink) and the month by account. Money only where the
 * server sent it (`view_usage`).
 */

/** Plan accounts in inks, in the order they come (now first); the API in the agents' blue. */
const PLAN_TONES = ["var(--ink)", "var(--faint)", "var(--line-strong)"];
const API_TONE = "var(--agent)";

export function UsageTab() {
  const { org } = useOrg();
  const api = useApi();
  const { agent } = useAgentEdit();
  const usage = useAgentPlanUsage(org.id, agent.id);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (usage.isLoading) {
    return (
      <Card as="section" className="agp-card">
        <LoadingList count={3} avatar={false} trailing />
      </Card>
    );
  }
  if (!usage.data) {
    return (
      <Card as="section" className="agp-card">
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      </Card>
    );
  }
  const data = usage.data;
  const tones = new Map<string, CSSProperties>();
  let plans = 0;
  for (const s of data.sources) {
    const tone = s.type === "api" ? API_TONE : (PLAN_TONES[plans++ % PLAN_TONES.length] ?? API_TONE);
    tones.set(s.key, { "--part": tone } as CSSProperties);
  }
  return (
    <>
      <Month data={data} tones={tones} />
      {data.current && <Now data={data} />}
      {data.sources.length > 0 && <BySource data={data} />}
    </>
  );
}

function Month({ data, tones }: { data: AgentPlanUsage; tones: Map<string, CSSProperties> }) {
  const { t, i18n } = useTranslation();
  const { g } = useAgentEdit();
  const month = formatMonth(i18n.language, new Date(`${data.month}-15T12:00:00`));
  const total = (d: { tokens: Record<string, number> }) => Object.values(d.tokens).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...data.days.map(total));
  const daysInMonth = new Date(Number(data.month.slice(0, 4)), Number(data.month.slice(5, 7)), 0).getDate();
  const columns = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${data.month}-${String(i + 1).padStart(2, "0")}`;
    const day = data.days.find((d) => d.date === date);
    if (!day) return { key: date, parts: [], ahead: true };
    return {
      key: date,
      parts: Object.entries(day.tokens).map(([key, n]) => ({ key, value: (n / max) * 100, style: tones.get(key) })),
      title: `${formatShortDate(i18n.language, `${date}T12:00:00`)} · ${formatTokensShort(t, i18n.language, total(day))}`,
    };
  });
  const used = data.sources.filter((s) => s.tokens > 0);
  const marks = [1, 8, 15, 22, daysInMonth];
  return (
    <Card as="section" className="agp-card" aria-labelledby="agent-usage">
      <CardHead id="agent-usage" icon="chart" title={t("usageViews.agent.title", g)} />
      {data.tokens === 0 ? (
        <p className="plan-empty">{t("usageViews.agent.empty", { ...g, month })}</p>
      ) : (
        <>
          <p className="plan-sentence">
            {t("usageViews.agent.sentence", {
              ...g,
              month,
              tokens: formatTokensShort(t, i18n.language, data.tokens),
              parts: joinNames(
                used.map((s) => usageSourcePart(t, i18n.language, s)),
                t,
              ),
            })}
            {typeof data.equivalentUsd === "number" && data.equivalentUsd > 0 && (
              <>
                {" "}
                <span className="ac-hintline">
                  <span>
                    {t("usageViews.agent.equivalent", { amount: formatUsd(i18n.language, data.equivalentUsd) })}
                  </span>
                  <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                    {t("usageViews.apiPriceHint")}
                  </InfoHint>
                </span>
              </>
            )}
          </p>
          <div>
            <UsageDays days={columns} label={t("usageViews.agent.daysLabel", { month })} />
            <div className="plan-axis" style={{ "--days": daysInMonth } as CSSProperties} aria-hidden="true">
              {columns.map((c, i) => (
                <span key={c.key}>{marks.includes(i + 1) ? i + 1 : ""}</span>
              ))}
            </div>
          </div>
          <div className="plan-legend">
            {used.map((s) => (
              <span key={s.key} className="plan-legend__item">
                <UsageSwatch style={tones.get(s.key)} />
                {usageSourceName(t, s)}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function Now({ data }: { data: AgentPlanUsage }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, g } = useAgentEdit();
  const dir = useDirectory(org.id);
  const current = data.current;
  if (!current) return null;
  // Who else thinks with it now; one that used it earlier this month only counts in the windows' parts.
  const others = current.agents
    .filter((a) => a.now && a.agentId !== agent.id)
    .map((a) => dir.agentById.get(a.agentId)?.name ?? a.name);
  return (
    <Card as="section" className="agp-card" aria-labelledby="agent-usage-now">
      <CardHead id="agent-usage-now" icon="clock" title={t("usageViews.agent.now")} />
      <AccountHead
        account={current}
        extra={others.length ? t("usageViews.agent.sharedWith", { names: joinNames(others, t) }) : null}
      />
      {current.usage ? (
        <PlanMeter
          usage={partedUsage(
            current.usage,
            (parts) => {
              const mine = parts.find((p) => p.agentId === agent.id);
              return mine
                ? t("usageViews.agent.part", { ...g, percent: formatPercent(i18n.language, mine.percent) })
                : undefined;
            },
            agent.id,
          )}
          text={planMeterText(t, i18n.language)}
        />
      ) : (
        <p className="plan-empty">{noWindowsText(t, current)}</p>
      )}
      <CardFooter>{t("usageViews.agent.estimate", { ...g, brand: brandOf(current) })}</CardFooter>
    </Card>
  );
}

function BySource({ data }: { data: AgentPlanUsage }) {
  const { t, i18n } = useTranslation();
  const { agent, g } = useAgentEdit();
  const onApi = !agent.brain || agent.brain.kind === "model";
  const keyProvider = apiProviderOf(agent.model, useModels().data?.models ?? []);
  return (
    <Card as="section" className="agp-card" aria-labelledby="agent-usage-sources">
      <CardHead id="agent-usage-sources" icon="wallet" title={t("usageViews.agent.byAccount")} />
      <div className="plan-sources">
        {data.sources.map((s) => {
          const when =
            s.type === "plan" && !s.now && s.lastDay
              ? t("usageViews.agent.until", { date: formatShortDate(i18n.language, `${s.lastDay}T12:00:00`) })
              : s.now
                ? t("usageViews.agent.nowTag")
                : null;
          const money =
            s.type === "api"
              ? s.costUsd !== undefined
                ? t("usageViews.paid", { amount: formatUsd(i18n.language, s.costUsd) })
                : s.budgetPercent !== undefined
                  ? t("usageViews.budgetShare", { percent: formatPercent(i18n.language, s.budgetPercent) })
                  : null
              : typeof s.equivalentUsd === "number"
                ? t("usageViews.equivalent", { amount: formatUsd(i18n.language, s.equivalentUsd) })
                : t("usageViews.agent.ofMonth", { percent: formatPercent(i18n.language, s.share) });
          return (
            <div key={s.key} className="plan-source">
              {s.account ? (
                <AccountHead account={s.account} extra={when} />
              ) : (
                <div className="plan-acct ac-mediarow ac-mediarow--row">
                  <span className="ac-mediarow__face">
                    {s.type === "api" && keyProvider ? (
                      <ProviderLogo id={keyProvider} size="sm" />
                    ) : s.type === "api" ? (
                      <span className="plan-source__key" aria-hidden="true">
                        <Icon name="key" size={16} />
                      </span>
                    ) : (
                      <ProviderLogo id={s.kind ?? "claude_code"} size="sm" off />
                    )}
                  </span>
                  <span className="ac-mediarow__head">
                    <span className="plan-acct__name">{usageSourceName(t, s)}</span>
                  </span>
                  <span className="ac-mediarow__body plan-acct__sub">
                    {s.type === "api"
                      ? t(onApi ? "usageViews.agent.apiMain" : "usageViews.agent.apiFallback", g)
                      : s.removed
                        ? t("usageViews.agent.removedSub")
                        : t("usageViews.agent.oldSub")}
                  </span>
                </div>
              )}
              <Meter
                value={s.share}
                max={100}
                label={t("usageViews.agent.shareLabel", {
                  source: usageSourceName(t, s),
                  percent: formatPercent(i18n.language, s.share),
                })}
              />
              <span className="plan-source__n">
                <b>{formatTokensShort(t, i18n.language, s.tokens)}</b>
                {money &&
                  (s.type !== "api" && typeof s.equivalentUsd === "number" ? (
                    <small className="ac-hintline">
                      <span>{money}</span>
                      <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                        {t("usageViews.apiPriceHint")}
                      </InfoHint>
                    </small>
                  ) : (
                    <small>{money}</small>
                  ))}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
