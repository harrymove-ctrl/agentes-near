import type { PlanAccountInfo, PlanAccountUsage } from "@agenteschat/client";
import { useAiAccounts, useApi, useModels, usePlanUsage } from "@agenteschat/client";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { formatPercent, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { planName } from "@agenteschat/client/lib/plans";
import { AUTO, apiProviderOf } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  agentGradient,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  InfoHint,
  List,
  Meter,
  PLAN_ALMOST,
  PlanMeter,
  ProviderLogo,
  planLevel,
  planLine,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AccountActions } from "@/components/ai/AiAccounts";
import { PlanHold, usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi, useMayConnectAi } from "@/components/ConnectAi";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import {
  accountName,
  accountOwner,
  accountShares,
  brandOf,
  groupUsageAccounts,
  noWindowsText,
  planMeterText,
  shareFacts,
  splitUsage,
} from "@/lib/plan-usage";
import "./plan-usage.css";

/*
 * The usage views (ADR 0063): an account's head, shared with the agent's
 * "Uso" tab, and Configurações › IA e uso: the workspace's plan accounts, each
 * window with every agent's estimated part, and the API per agent. Money
 * only where the server sent it (`view_usage`).
 */

/** An en space between a row's name, its plan and whose it is: it ends a line unseen where a margin would indent the next. */
const WIDE_SPACE = "\u2002";

/** An account's head: the maker's mark, its name and plan, its maker and whose it is. */
export function AccountHead({ account, extra }: { account: PlanAccountInfo; extra?: string | null }) {
  const { t } = useTranslation();
  const whose = account.email ?? accountOwner(t, account);
  return (
    <div className="plan-acct ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
      </span>
      <span className="ac-mediarow__head">
        <span className="plan-acct__name">
          {accountName(t, account)}
          {account.plan && <span className="plan-acct__chip">{planName(account.plan)}</span>}
          {account.signedOut && (
            <span className="plan-acct__chip plan-acct__chip--out">{t("usageViews.signedOut")}</span>
          )}
        </span>
      </span>
      <span className="ac-mediarow__body plan-acct__sub">
        {[brandOf(account), whose, extra].filter(Boolean).join(" · ")}
      </span>
    </div>
  );
}

/**
 * Configurações › IA e uso, "Contas": every plan account of the workspace as one row that opens. The API per agent is
 * `ApiCard`, its own card, only where the workspace bills per use.
 */
export function PlanUsageCards() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const usage = usePlanUsage(org.id);
  const mine = useAiAccounts(org.id);
  const look = useRightHandLook();
  const connectAi = useConnectAi();
  const mayConnect = useMayConnectAi();
  const hold = usePlanHold();
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (usage.isLoading) {
    return (
      <Card>
        <LoadingList count={3} avatar={false} trailing />
      </Card>
    );
  }
  if (!usage.data) {
    return (
      <Card>
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      </Card>
    );
  }
  const { money } = usage.data;
  // The viewer's own logins of one account are one row, as their plans group them.
  const accounts = groupUsageAccounts(usage.data.accounts, mine.data);
  const several = new Set(accounts.map((a) => a.machineId)).size > 1;
  const connect = connectAi && mayConnect && !hold && (
    <Button size="sm" icon="plus" onClick={() => connectAi.open({})}>
      {t("aiAccounts.page.connect")}
    </Button>
  );
  return (
    <Card aria-labelledby="sec-usage-plans">
      <CardHeader
        id="sec-usage-plans"
        icon="computer"
        title={t("usageViews.accounts.title")}
        hint={{ name: t("common.about", { label: t("usageViews.accounts.title") }), text: t("usageViews.estimate") }}
        action={accounts.length > 0 && connect}
      />
      {/* What comes first: an invitation to connect a plan would contradict it. */}
      {hold && <PlanHold hold={hold} />}
      {accounts.length === 0 && !hold && (
        <EmptyState
          size="panel"
          agent={look}
          title={t("aiAccounts.page.emptyTitle")}
          actions={
            connectAi &&
            mayConnect && (
              <Button variant="primary" icon="plus" onClick={() => connectAi.open({})}>
                {t("aiAccounts.page.connect")}
              </Button>
            )
          }
        >
          {t(mayConnect ? "usageViews.accounts.empty" : "aiAccounts.page.emptyViewer")}
        </EmptyState>
      )}
      {accounts.length > 0 && (
        <List className="plan-rows">
          {accounts.map((a) => (
            <AccountRow
              key={a.key}
              account={a}
              money={money}
              computer={several ? computerNameOf(t, org.name, a.machineName, isPersonal(org)) : null}
            />
          ))}
        </List>
      )}
    </Card>
  );
}

/**
 * A plan account as a row that opens. Closed: its maker's mark, its name and plan, whose it is and one meter, the
 * window closest to its limit, with what matters near the limit on a line under them. Open: its maker and address,
 * every window with its bar split by agent in their colours, its agents (share of the window the bar splits, tokens
 * this month), when it renews, the month's total and, for its owner, what they do with it. Near its limit it starts
 * open.
 */
function AccountRow({
  account,
  money,
  computer,
}: {
  account: PlanAccountUsage;
  money: boolean;
  computer: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const text = planMeterText(t, i18n.language);
  const line = account.usage ? planLine(account.usage, text) : null;
  const [open, setOpen] = useState(line != null && line.state !== "ok");
  // What the row holds leaves the page once it has closed, so a closed list of many accounts stays light.
  const [held, setHeld] = useState(open);
  const body = useId();
  const shares = accountShares(account);
  const list = shares.shown.length > 0 && (
    <AgentShares shares={shares} window={shares.window ? text.short(shares.window) : null} />
  );
  const owner = accountOwner(t, account);
  const chips = Boolean(account.plan) || Boolean(account.signedOut);
  return (
    <div className="plan-row" data-open={open || undefined}>
      <button
        type="button"
        className="plan-row__head"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => {
          if (!open) setHeld(true);
          setOpen(!open);
        }}
      >
        <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
        {/* Two parts: one line of words on a wide row, and on a phone the name beside the mark with the plan and
            whose it is under both. The space that parts them ends the name, so neither starts with it. */}
        <span className="plan-acct__name">
          <span className="plan-row__title">
            {accountName(t, account)}
            {(chips || owner) && WIDE_SPACE}
          </span>
          {(chips || owner) && (
            <span className="plan-row__facts">
              {account.plan && <span className="plan-acct__chip">{planName(account.plan)}</span>}
              {account.plan && account.signedOut && WIDE_SPACE}
              {account.signedOut && (
                <span className="plan-acct__chip plan-acct__chip--out">{t("usageViews.signedOut")}</span>
              )}
              {chips && owner && WIDE_SPACE}
              {owner && <span className="plan-row__owner">{owner}</span>}
            </span>
          )}
        </span>
        {line?.top && (
          <span
            className="ac-planmeter ac-planmeter--compact plan-row__meter"
            data-level={planLevel(line.top.used, line.state === "limited")}
          >
            <span className="ac-planmeter__line">{`${text.short(line.top)} ${line.top.used}%`}</span>
            <Meter value={line.top.used} max={100} label={text.window(line.top)} marks={[PLAN_ALMOST]} />
          </span>
        )}
        <Icon name="chevronRight" size={16} className="plan-row__chevron" />
        {line?.alert && (
          <span
            className="ac-planmeter__state plan-row__alert"
            data-level={planLevel(line.top?.used ?? 0, line.state === "limited")}
          >
            {line.alert}
          </span>
        )}
      </button>
      <div
        id={body}
        className="plan-row__fold"
        inert={!open}
        aria-hidden={!open}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && !open) setHeld(false);
        }}
      >
        <div className="plan-row__body">
          {held && (
            <>
              <span className="plan-acct__sub">
                {[brandOf(account), account.email, computer].filter(Boolean).join(" · ")}
              </span>
              {account.usage ? (
                <PlanMeter
                  usage={splitUsage(account.usage, (id) => agentGradient(colorOf(dir.agentById.get(id))))}
                  text={text}
                >
                  {list}
                </PlanMeter>
              ) : (
                <>
                  <p className="plan-empty">{noWindowsText(t, account)}</p>
                  {list}
                </>
              )}
              {account.monthTokens > 0 && (
                <span className="plan-block__month">
                  {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
                  {money && typeof account.equivalentUsd === "number" && (
                    <>
                      {" · "}
                      <span className="ac-hintline">
                        <span>
                          {t("usageViews.equivalent", { amount: formatUsd(i18n.language, account.equivalentUsd) })}
                        </span>
                        <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                          {t("usageViews.apiPriceHint")}
                        </InfoHint>
                      </span>
                    </>
                  )}
                </span>
              )}
              {account.mine && account.accountId && (
                <AccountActions machineId={account.machineId} accountId={account.accountId} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The account's agents, biggest share first, each on one line of words ("Lia · semana 48% · 4,8 mi tokens"); past the
 * first few, one row that opens the rest in place.
 */
function AgentShares({ shares, window }: { shares: ReturnType<typeof accountShares>; window: string | null }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  return (
    <div className="plan-shares">
      {(open ? [...shares.shown, ...shares.rest] : shares.shown).map((a) => {
        const name = dir.agentById.get(a.agentId)?.name ?? a.name;
        return (
          <Link
            key={a.agentId}
            className="plan-shares__row"
            to="/org/$orgId/agents/$agentId"
            params={{ orgId: org.id, agentId: a.agentId }}
            search={{ tab: "usage" }}
          >
            <AgentAvatar agentId={a.agentId} size="xs" name={name} />
            <span>
              <b>{name}</b>
              {shareFacts(t, i18n.language, window, a)}
            </span>
          </Link>
        );
      })}
      {!open && shares.rest.length > 0 && (
        <button type="button" className="plan-shares__row" aria-expanded={false} onClick={() => setOpen(true)}>
          <span />
          <span>
            <b>{t("usageViews.moreAgents", { count: shares.rest.length })}</b>
            {shareFacts(t, i18n.language, window, { share: shares.restShare, tokens: shares.restTokens })}
          </span>
        </button>
      )}
    </div>
  );
}

/** "US$ 0,32 de US$ 50,00 (padrão do workspace)": the closing "(…)" wraps as one piece, not split across lines. */
function noteWhole(text: string) {
  const m = /^(.*\S)\s+(\(.+\))$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]} <span className="plan-api__note">{m[2]}</span>
    </>
  );
}

/** The API per agent this month: each one's share of its budget, and the money where the server sent it. */
export function ApiCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const data = usePlanUsage(org.id).data;
  const dir = useDirectory(org.id);
  const provider = apiProviderOf(AUTO, useModels().data?.models ?? []);
  if (!data || data.api.length === 0) return null;
  return (
    <Card aria-labelledby="sec-usage-api">
      <CardHeader id="sec-usage-api" icon="key" mark={provider} title={t("usageViews.api.title")} />
      <div className="plan-api">
        {data.api.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          // The server's percent has one decimal, so a tiny spend comes as 0: the money, when sent, is exact.
          const percent = a.costUsd !== undefined && a.budgetUsd ? (a.costUsd / a.budgetUsd) * 100 : a.budgetPercent;
          return (
            <Link
              key={a.agentId}
              className="plan-api__row"
              to="/org/$orgId/agents/$agentId"
              params={{ orgId: org.id, agentId: a.agentId }}
              search={{ tab: "usage" }}
            >
              <AgentAvatar agentId={a.agentId} size="sm" name={name} />
              <span className="plan-api__name">
                <b>{name}</b>
                <small>{t("usageViews.tokens", { tokens: formatTokensShort(t, i18n.language, a.tokens) })}</small>
              </span>
              <span className="plan-api__meter">
                <Meter value={Math.min(100, percent)} max={100} label={t("settings.usageAgentMeter", { name })} />
              </span>
              <span className="plan-api__value">
                {t("usageViews.budgetShare", { percent: formatPercent(i18n.language, percent) })}
                {a.costUsd !== undefined && a.budgetUsd !== undefined && (
                  <small>
                    {noteWhole(
                      t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                        spent: formatUsd(i18n.language, a.costUsd),
                        budget: formatUsd(i18n.language, a.budgetUsd),
                      }),
                    )}
                  </small>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
