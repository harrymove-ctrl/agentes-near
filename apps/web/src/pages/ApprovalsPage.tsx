import type { Agent, Approval, ConnectorDef } from "@agenteschat/client";
import {
  sendHelpers,
  useApprovals,
  useApprovalsDeciding,
  useCatalog,
  useChannels,
  useCustomServers,
  useDecideApproval,
  useDecideApprovals,
  usePostMessage,
  useRun,
} from "@agenteschat/client";
import {
  approvalCards,
  approvalRuns,
  approveAllScope,
  approveAlwaysAlso,
  approveAlwaysOn,
  cardDeadline,
  runKeys,
} from "@agenteschat/client/lib/approval-card";
import { aheadPhase, approveAlwaysOffered } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalWords } from "@agenteschat/client/lib/approval-origin";
import {
  type ApprovalEffect,
  type ApprovalUndo,
  approvalEffects,
  approvalTarget,
  approvalText,
  stepsAround,
} from "@agenteschat/client/lib/approval-review";
import {
  aheadEndLine,
  approvalDoing,
  approvalGroupWaitsFor,
  approvalWaitsFor,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { fromServer, itemName } from "@agenteschat/client/lib/connected";
import { daysBetween, formatTime, joinNames, nextLabel, relativeTime, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { formatDuration, type ToolItem, toolItemsSaved, toolPhrase, workFromSteps } from "@agenteschat/client/lib/work";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  cx,
  DetailsDialog,
  EmptyState,
  ExpiryFuse,
  type Fact,
  FactStrip,
  GroupHeading,
  Icon,
  type IconName,
  Kbd,
  Locked,
  PageHeader,
  SearchInput,
  Segmented,
  StepTrack,
  type StepTrackStep,
  Tip,
  Toolbar,
  WorkSweep,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar, AgentWho } from "@/components/AgentAvatar";
import {
  AheadLine,
  ApproveAlways,
  approvalAction,
  approvalReadsOnly,
  approvalRisk,
  approvalTitle,
  approvalValues,
  CancelAhead,
  decisionLabel,
} from "@/components/ApprovalItem";
import { ApprovalsTabs } from "@/components/ApprovalsTabs";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { EmailLetter } from "@/components/EmailLetter";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingCards } from "@/components/Loading";
import {
  MissionCommandsPending,
  MissionsWaitingList,
  missionsWaiting,
  pendingCommandCount,
  useMissionsWaitingYou,
} from "@/components/missions/MissionWaiting";
import { useOrg } from "@/components/org-context";
import { colorOf, prepareBurst } from "@/components/Sky";
import { TaskStepsBlock, useCallLogo } from "@/components/ToolCalls";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { TYPED_VALUES } from "@/i18n";
import { inlineWords, Markdown } from "@/lib/markdown";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./approvals.css";

type Filter = "pending" | "approved" | "refused" | "expired" | "all";
const FILTERS: Filter[] = ["pending", "approved", "refused", "expired", "all"];
const TTL_MS = 24 * 3_600_000;
const URGENT_MS = 3_600_000;
/** Approved without a result for this long: it ran before results were kept (or the run died); stop showing "running". */
const RUNNING_FOR_MS = 15 * 60_000;

/** Where an approval goes on this screen. */
export type ApprovalPhase =
  | "waiting"
  | "running"
  | "scheduled"
  | "done"
  | "failed"
  | "refused"
  | "expired"
  | "canceled";

export function approvalPhase(a: Approval, now = Date.now()): ApprovalPhase {
  if (a.status === "pending") return "waiting";
  if (a.status === "approved") {
    if (a.result) return a.result.ok ? "done" : "failed";
    if (a.executedAt) return "done";
    // Approved ahead: it waits for its time, when its routine's run does it.
    if (aheadPhase(a) === "scheduled") return "scheduled";
    const decided = a.decidedAt ? new Date(a.decidedAt).getTime() : 0;
    return now - decided < RUNNING_FOR_MS ? "running" : "done";
  }
  return a.status;
}

const bucketOf = (p: ApprovalPhase): Exclude<Filter, "all"> =>
  p === "waiting" || p === "running"
    ? "pending"
    : p === "done" || p === "failed" || p === "scheduled"
      ? "approved"
      : p === "refused"
        ? "refused"
        : "expired";

/** Waiting first, the one closest to expiring on top; running after them. */
export function sortOpen(list: Approval[]) {
  return [...list].sort((a, b) => {
    const ra = approvalPhase(a) === "running" ? 1 : 0;
    const rb = approvalPhase(b) === "running" ? 1 : 0;
    return ra - rb || a.expiresAt.localeCompare(b.expiresAt);
  });
}

const decidedAt = (a: Approval) => a.decidedAt ?? (a.status === "expired" ? a.expiresAt : a.createdAt);

/** The top-level scalar values of the action (what the card shows; the details show them all). */
function scalars(params: Record<string, unknown>) {
  return Object.entries(params ?? {}).filter(
    (e): e is [string, string | number | boolean] =>
      typeof e[1] === "string" || typeof e[1] === "number" || typeof e[1] === "boolean",
  );
}

/** A GitHub PR the action points at, when its values say so. */
function prLink(a: Approval) {
  if (a.connector !== "github") return null;
  const p = a.params ?? {};
  const pr = p.pullNumber ?? p.pull_number ?? p.pr ?? p.number;
  const owner = typeof p.owner === "string" ? p.owner : null;
  const repo = typeof p.repo === "string" ? p.repo : null;
  if (!repo || (typeof pr !== "number" && typeof pr !== "string")) return null;
  const full = owner && !repo.includes("/") ? `${owner}/${repo}` : repo;
  return /^[\w.-]+\/[\w.-]+$/.test(full) && /^\d+$/.test(String(pr)) ? `https://github.com/${full}/pull/${pr}` : null;
}

/**
 * Aprovações: who waits on you, each request with its
 * exact action, then the history. Under the requests, the missions' command
 * cards and the decisions and reviews waiting on you in missions (ADR 0029).
 * The requests are a list; the open one (`?open=<id>`, else the first) reads beside it (`ReviewHead`, `ReviewBody`,
 * `DecisionBar`), the same review the details dialog shows on other pages.
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const [filter, setFilter] = useState<Filter>("pending");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useOpenParam();
  const [refusing, setRefusing] = useState<string | null>(null);
  // Unfolded runs, by card and `runKeys`: here, not in the run's card, which remounts when its card regroups.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set());
  const all = approvals.data ?? [];
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const query = q.trim().toLowerCase();
  const look = useRightHandLook();
  const matches = (a: Approval) =>
    !query ||
    [
      approvalTitle(t, a),
      dir.agentById.get(a.agentId)?.name ?? "",
      channelName(a.channelId),
      ...scalars(a.params).map(([, v]) => String(v)),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  const open = sortOpen(all.filter((a) => bucketOf(approvalPhase(a)) === "pending"));
  const decided = all
    .filter((a) => bucketOf(approvalPhase(a)) !== "pending")
    .sort((a, b) => decidedAt(b).localeCompare(decidedAt(a)));
  const waiting = open.filter((a) => a.status === "pending");
  const mine = waiting.filter((a) => a.canDecide);
  const urgent = mine[0];
  const urgentLeft = urgent && new Date(urgent.expiresAt).getTime() - Date.now();
  const shownOpen = filter === "pending" || filter === "all" ? open.filter(matches) : [];
  const shownDecided = decided.filter(
    (a) => matches(a) && (filter === "all" || filter === "pending" || bucketOf(approvalPhase(a)) === filter),
  );
  // The rows in the order shown; the open one (`?open=<id>`), else the first, is the request beside the list.
  const order = [...shownOpen, ...(filter === "pending" ? shownDecided.slice(0, 3) : shownDecided)].map((a) => a.id);
  const selectedId = openId && order.includes(openId) ? openId : (order[0] ?? null);
  const selected = all.find((a) => a.id === selectedId) ?? null;
  const cardOf = new Map(approvalCards(shownOpen).flatMap((items) => items.map((a) => [a.id, items] as const)));
  // A newly opened request starts at its top, not where the last one was scrolled to: in its own column on a wide
  // window, in the page under the list on a narrow one.
  useEffect(() => {
    if (!selectedId) return;
    const pane = document.querySelector<HTMLElement>(".ap-review");
    if (!pane) return;
    pane.scrollTop = 0;
    if (pane.getBoundingClientRect().top < 0) pane.scrollIntoView?.({ block: "start" });
  }, [selectedId]);
  const selectedCard = selected ? cardOf.get(selected.id) : undefined;
  const select = (id: string) => {
    if (id !== selectedId) setRefusing(null);
    setOpenId(id);
  };
  // Missions you own or decide in: the executor's commands and what waits on you (decisions, reviews).
  const { missions } = useMissionsWaitingYou();
  const commands = pendingCommandCount(missions);
  const missionWaiting = missionsWaiting(missions).length > 0;
  const missionsBelow = filter === "pending" && (commands > 0 || missionWaiting);
  const waitingYou = mine.length + commands;

  // J/K (and ↑/↓ inside the list) walk the requests, A approves the open one (high risk: focuses the hold), R
  // refuses it, / searches, Escape backs out of refusing. A dialog over the page keeps its own keys.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable], [role=menu], [role=listbox], [role=dialog]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const inList = Boolean(el?.closest(".ap-list"));
      const down = key === "j" || (inList && e.key === "ArrowDown");
      const up = key === "k" || (inList && e.key === "ArrowUp");
      const step = down ? 1 : up ? -1 : 0;
      if (e.key === "Escape") {
        if (refusing) setRefusing(null);
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".ap-tools__search input")?.focus();
      } else if (step !== 0) {
        e.preventDefault();
        const i = selectedId ? order.indexOf(selectedId) : -1;
        const next = order[Math.max(0, Math.min(order.length - 1, i + step))];
        if (next && next !== selectedId) {
          setRefusing(null);
          setOpenId(next);
          document.querySelector<HTMLElement>(`.ap-li[data-id="${next}"]`)?.focus();
        }
      } else if ((key === "a" || key === "r") && selected) {
        if (selected.status !== "pending" || !selected.canDecide) return;
        e.preventDefault();
        if (key === "r") setRefusing(selected.id);
        else document.querySelector<HTMLElement>(`[data-approve="${selected.id}"]`)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, selectedId, refusing, setOpenId]);

  const countOf = (f: Filter) =>
    f === "all"
      ? all.length
      : all.filter((a) => bucketOf(approvalPhase(a)) === f).length + (f === "pending" ? commands : 0);
  const waiters = [...new Set(mine.map((a) => a.agentId))];

  return (
    <div className="page page--list ap">
      <div className="ap__main">
        <PageHeader
          title={t("approvals.title")}
          meta={
            waitingYou > 0 ? (
              <>
                {t("approvals.summary", { count: waitingYou })}
                {urgentLeft && urgentLeft <= 2 * URGENT_MS
                  ? ` · ${t("approvals.urgent", { time: timeLeft(t, urgent.expiresAt) ?? "" })}`
                  : ""}
              </>
            ) : (
              t("approvals.nothing")
            )
          }
        />
        <ApprovalsTabs value="requests" />
        <Toolbar
          label={t("approvals.filters")}
          search={
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("approvals.search")}
              aria-label={t("approvals.search")}
              className="ap-tools__search"
            />
          }
        >
          <Segmented
            label={t("approvals.filters")}
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((f) => ({ value: f, label: t(`approvals.filter.${f}`), count: countOf(f) }))}
          />
        </Toolbar>

        {filter === "pending" && waiters.length > 1 && (
          <div className="ap-waiters">
            <span className="ap-waiters__faces">
              {waiters.map((id) => (
                <AgentAvatar key={id} agentId={id} name={dir.agentById.get(id)?.name ?? ""} size="sm" state="waiting" />
              ))}
            </span>
            <span className="ap-waiters__text">
              <Trans
                i18nKey="approvals.waiters"
                count={waiters.length}
                values={{
                  names: joinNames(
                    waiters.map((id) => dir.agentById.get(id)?.name ?? ""),
                    t,
                  ),
                }}
                components={{ b: <b /> }}
                {...TYPED_VALUES}
              />
            </span>
          </div>
        )}

        {approvals.isLoading && <LoadingCards count={2} />}
        {approvals.isError && !approvals.data && (
          <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
        )}
        {approvals.isSuccess &&
          filter === "pending" &&
          shownOpen.length === 0 &&
          !query &&
          commands === 0 &&
          !missionWaiting &&
          shownDecided.length === 0 && (
            <EmptyState size="page" agent={look} mood="deal" title={t("approvals.emptyTitle")}>
              <HelpLink slug="approvals">{t("approvals.how")}</HelpLink>
            </EmptyState>
          )}
        {approvals.isSuccess && query && shownOpen.length === 0 && shownDecided.length === 0 && (
          <EmptyState size="panel" actions={<Button onClick={() => setQ("")}>{t("filters.clearSearch")}</Button>}>
            {t("approvals.noResults")}
          </EmptyState>
        )}

        {(shownOpen.length > 0 || shownDecided.length > 0) && (
          // A split ends its page (over-pages.css): with the missions listed under it, the page scrolls as one.
          <div className={cx("ap-split", !missionsBelow && "page-split")}>
            <nav
              className="ap-list"
              data-scroll-restoration-id="approvals-list"
              aria-label={t("approvals.review.list")}
            >
              {shownOpen.length > 0 &&
                approvalCards(shownOpen).map((items) => {
                  const always = approveAlwaysOn(items);
                  const row = (a: Approval) => (
                    <ReqRow key={a.id} approval={a} selected={selectedId === a.id} onOpen={() => select(a.id)} />
                  );
                  // Waiting requests of one kind in a row: one row that unfolds into them.
                  // Keyed by `runKeys`: an unfolded run stays open while its requests are decided one by one.
                  const runs = approvalRuns(items);
                  const keys = runKeys(runs).map((key) => `${items[0]?.messageId ?? ""}:${key}`);
                  const rows = runs.map((run, i) =>
                    run.length > 1 && run[0] ? (
                      <RunRow
                        key={keys[i]}
                        open={openRuns.has(keys[i] ?? "")}
                        onToggle={() =>
                          setOpenRuns((o) => {
                            const next = new Set(o);
                            if (!next.delete(keys[i] ?? "")) next.add(keys[i] ?? "");
                            return next;
                          })
                        }
                        run={run}
                        items={items}
                        always={always}
                        agent={dir.agentById.get(run[0].agentId)}
                      >
                        {run.map(row)}
                      </RunRow>
                    ) : (
                      run[0] && row(run[0])
                    ),
                  );
                  const first = items[0];
                  if (!first || runs.length < 2) return rows;
                  // Requests sharing one card in the conversation: together, with "Aprovar tudo".
                  const agent = dir.agentById.get(first.agentId);
                  const partial = approveAllPartial(
                    t,
                    items,
                    approvalGroupWaitsFor(
                      items,
                      dir.memberById.get(first.ownerUserId ?? agent?.ownerUserId ?? "")?.name,
                    ),
                  );
                  return (
                    <section key={first.messageId ?? first.id} className="ap-group" aria-label={agent?.name}>
                      <div className="ap-group__head">
                        <span className="ap-group__who">
                          <Trans
                            i18nKey="approvals.groupHead"
                            count={items.length}
                            values={{ name: agent?.name ?? t("channel.unknownAgent") }}
                            components={{
                              b: <AgentWho agentId={first.agentId} name={agent?.name ?? t("channel.unknownAgent")} />,
                            }}
                            {...TYPED_VALUES}
                          />
                        </span>
                        <span className="ap-group__acts">
                          <ApproveAll items={items} />
                        </span>
                      </div>
                      {partial && <p className="ap-group__note">{partial}</p>}
                      {rows}
                    </section>
                  );
                })}
              {filter === "pending"
                ? shownDecided.length > 0 && (
                    <section className="ap-list__section">
                      <GroupHeading
                        title={t("approvals.recent")}
                        aside={
                          <button type="button" className="ac-link ac-link--muted" onClick={() => setFilter("all")}>
                            {t("approvals.seeHistory")}
                          </button>
                        }
                      />
                      <div className="ap-list__rows">
                        {shownDecided.slice(0, 3).map((a) => (
                          <ReqRow key={a.id} approval={a} selected={selectedId === a.id} onOpen={() => select(a.id)} />
                        ))}
                      </div>
                    </section>
                  )
                : groups(shownDecided).map(([key, list]) => (
                    <section key={key} className="ap-list__section">
                      <GroupHeading title={t(`approvals.groups.${key}`)} count={list.length} />
                      <div className="ap-list__rows">
                        {list.map((a) => (
                          <ReqRow key={a.id} approval={a} selected={selectedId === a.id} onOpen={() => select(a.id)} />
                        ))}
                      </div>
                    </section>
                  ))}
            </nav>
            {selected && (
              <section
                className="ap-review"
                data-scroll-restoration-id="approvals-request"
                data-burst=""
                aria-label={approvalTitle(t, selected)}
              >
                <ReviewHead approval={selected} channel={channelName(selected.channelId)} />
                <ReviewBody key={selected.id} approval={selected} channel={channelName(selected.channelId)} />
                <DecisionBar
                  approval={selected}
                  refusing={refusing === selected.id}
                  onRefuse={() => setRefusing(selected.id)}
                  onCancelRefuse={() => setRefusing(null)}
                  also={selectedCard ? approveAlwaysAlso(selectedCard, selected) : undefined}
                  floating
                />
              </section>
            )}
          </div>
        )}

        {filter === "pending" && (
          <div className="ac-groups">
            <MissionCommandsPending missions={missions} query={query} />
            <MissionsWaitingList missions={missions} query={query} />
          </div>
        )}
        {approvals.isSuccess && filter !== "pending" && !query && shownOpen.length + shownDecided.length === 0 && (
          <EmptyState
            size="panel"
            actions={<Button onClick={() => setFilter("pending")}>{t("filters.clearAll")}</Button>}
          >
            {t("approvals.noResults")}
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function groups(list: Approval[]): ["today" | "yesterday" | "earlier", Approval[]][] {
  const out: ["today" | "yesterday" | "earlier", Approval[]][] = [
    ["today", []],
    ["yesterday", []],
    ["earlier", []],
  ];
  for (const a of list) {
    const d = daysBetween(decidedAt(a), new Date());
    out[d <= 0 ? 0 : d === 1 ? 1 : 2]?.[1].push(a);
  }
  return out.filter(([, l]) => l.length > 0);
}

/** "github · acme" with the brand icon, or the app's own tool. */
type ApprovalVia = {
  kind: "mail" | "connector" | "own";
  name: string;
  account: string | null;
  def: ConnectorDef | null;
  /** A server connected by address: its own icon. */
  image?: string | null;
};

/** What an approval goes through: a mailbox, a server connected by address, a catalog connector, or the app itself. */
function useApprovalVia(approval: Approval): ApprovalVia {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  // A server connected by address (`custom:{connectionId}`): its own name, and the preset's icon when it came from one.
  const customId = approval.connector?.startsWith("custom:") ? approval.connector.slice("custom:".length) : null;
  const servers = useCustomServers(org.id, customId !== null);
  // An email goes through a mailbox, not a catalog connector ("email" has no entry): the box and its provider.
  if (approval.email)
    return { kind: "mail", name: approval.email.mailbox, account: approval.email.provider, def: null };
  if (!approval.connector) return { kind: "own", name: t("approvals.panel.builtIn"), account: null, def: null };
  const server = customId ? servers.data?.find((s) => s.id === customId) : undefined;
  const custom = server ? fromServer(server, catalog.data?.connectors ?? []) : null;
  const def = custom ? custom.def : (catalog.data?.connectors.find((c) => c.id === approval.connector) ?? null);
  const name = custom
    ? itemName(t, custom)
    : customId
      ? t("approvals.panel.orgConnector")
      : connectorName(t, def ?? { id: approval.connector, label: approval.connector });
  return { kind: "connector", name, account: approval.connectorAccount ?? null, def, image: custom?.image };
}

function ViaGlyph({ via }: { via: ApprovalVia }) {
  if (via.kind === "connector") return <ConnectorIcon def={via.def} image={via.image} label={via.name} />;
  return (
    <span className="ap-conn__own" aria-hidden="true">
      <Icon name={via.kind === "mail" ? "mail" : "shield"} size={14} />
    </span>
  );
}

export function ConnectorLine({ approval }: { approval: Approval }) {
  const via = useApprovalVia(approval);
  return (
    <span className="ap-conn">
      <ViaGlyph via={via} />
      <b>{via.name}</b>
      {via.account && <span className="ap-conn__account">· {via.account}</span>}
    </span>
  );
}

/** Only the logo, its name in a tooltip and for screen readers (the approval sentence in Notificações). */
export function ConnectorMark({ approval }: { approval: Approval }) {
  const via = useApprovalVia(approval);
  const label = via.account ? `${via.name} · ${via.account}` : via.name;
  return (
    // Focusable so a keyboard reaches the name in its tip.
    <Tip
      className="ap-conn-mark"
      role="img"
      aria-label={label}
      tabIndex={0}
      tip={label}
      look="ap-conn-mark__tip"
      align="center"
      delay={0}
    >
      <ViaGlyph via={via} />
    </Tip>
  );
}

/**
 * The exact action, in words (AprovacaoConector B): the connector and "Só lê" on one line, then its values
 * with labels; a list shows a few as chips, the details every one, and the tool's own name and values
 * behind "Detalhes técnicos". An email shows as the email itself.
 */
/** A value longer than this (a message, a command with its flags) takes a row of its own in the details, whole. */
const LONG_VALUE = 80;

export function ExactAction({
  approval,
  max,
  bare,
}: {
  approval: Approval;
  max?: number;
  /** Without the connector line and "Só lê" (the review's facts say both). */
  bare?: boolean;
}) {
  const { t } = useTranslation();
  // An email shows as the email itself (folded in lists, whole in the details).
  if (approval.email) return <EmailLetter email={approval.email} full={!max} />;
  const full = max === undefined;
  const values = approvalValues(approval, full ? { long: true } : { max });
  return (
    <div className="ap-exact">
      {!bare && (
        <div className="ap-exact__via">
          <ConnectorLine approval={approval} />
          {approvalReadsOnly(approval) && <Chip icon="eye">{t("approvals.readsOnly")}</Chip>}
        </div>
      )}
      {values.length > 0 &&
        (full ? (
          <dl className="ap-exact__rows">
            {values.map(([label, value]) => (
              <div key={label} data-long={value.length > LONG_VALUE || undefined}>
                <dt>{label}</dt>
                <dd>{inlineWords(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="ap-exact__facts">
            {values.map(([label, value]) => (
              <Chip key={label}>
                {label}: {value}
              </Chip>
            ))}
          </div>
        ))}
      {full && (
        <details className="ap-exact__tech">
          <summary>{t("approvals.technical")}</summary>
          <pre>{`${approval.tool}\n${JSON.stringify(approval.params ?? {}, null, 2)}`}</pre>
        </details>
      )}
    </div>
  );
}

/** The time a decision has left ("23 h para decidir", "expira em 12 min"): an approval's, or any request's. */
export function expiryText(t: TFunction, a: Pick<Approval, "expiresAt">) {
  const left = timeLeft(t, a.expiresAt);
  if (!left) return t("approval.expired");
  return new Date(a.expiresAt).getTime() - Date.now() <= URGENT_MS
    ? t("approvals.leftUrgent", { time: left })
    : t("approvals.left", { time: left });
}

/** Approve: one click, or a hold for high risk (let go early and nothing happens). */
export function ApproveButton({ approval, block, tip }: { approval: Approval; block?: boolean; tip?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  return (
    <HoldToApprove
      label={t(`approval.approve.${approvalAction(approval)}`)}
      high={approvalRisk(approval) === "high"}
      block={block}
      id={approval.id}
      tip={tip}
      pending={decide.isPending}
      onGo={(el) => {
        // Approved: a burst of the agent's pixels from its avatar.
        const burst = prepareBurst(el);
        decide.mutate({ id: approval.id, decision: "approve" }, { onSuccess: burst });
      }}
    />
  );
}

/**
 * The approve button itself: one click, or held for `high` risk; `id` lets A focus it. `tip`: what approving does, in
 * its tip (the bar under a request holds only its buttons).
 */
export function HoldToApprove({
  label,
  high,
  block,
  id,
  tip,
  pending,
  onGo,
}: {
  label: string;
  high: boolean;
  block?: boolean;
  id: string;
  tip?: string;
  pending: boolean;
  onGo: (el: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const tipped = (button: ReactElement) =>
    tip ? (
      <Tip tip={tip} look="ac-hint__bubble ac-glass" align="center" button>
        {button}
      </Tip>
    ) : (
      button
    );
  if (!high)
    return tipped(
      <Button
        variant="primary"
        size="sm"
        block={block}
        icon="check"
        data-approve={id}
        disabled={pending}
        loading={pending}
        onClick={(e) => onGo(e.currentTarget)}
      >
        {label}
      </Button>,
    );
  const start = (el: HTMLElement) => {
    if (timer.current || pending) return;
    held.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      held.current = true;
      setHolding(false);
      onGo(el);
    }, 1100);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return tipped(
    <Button
      variant="primary"
      size="sm"
      block={block}
      icon="check"
      className={cx("ap-hold", holding && "is-holding")}
      data-approve={id}
      aria-label={t("approvals.holdLabel", { action: label })}
      disabled={pending}
      loading={pending}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button > 0) return;
        // The press is the button's until it ends: a hand that drifts past the edge is still holding.
        e.currentTarget.setPointerCapture(e.pointerId);
        start(e.currentTarget);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => {
        // A finger's long press would open the menu and cancel the hold.
        if (timer.current) e.preventDefault();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start(e.currentTarget);
        }
      }}
      onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onClick={(e) => {
        // A plain click (no hold) only explains; the click that ends a finished hold says nothing.
        if (e.detail > 0 && !held.current && !timer.current && !pending) toast.show(t("approvals.holdHint"), "info");
        held.current = false;
      }}
    >
      {/* One label: a shorter one while held would shrink the button out from under the pointer. */}
      {t("approvals.hold")}
    </Button>,
  );
}

/**
 * "Aprovar tudo" / "Agora não para todos" over one card's requests: exactly the ones listed now that this person
 * may decide (one joining during the click is never approved unseen). Held when any of them is high risk.
 * Nothing when fewer than two are theirs: each item's own buttons do. `children` sit between the two ("Aprovar sempre").
 */
export function ApproveAll({ items, label, children }: { items: Approval[]; label?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApprovals(org.id);
  const { ids } = approveAllScope(items);
  if (ids.length < 2) return null;
  const high = items.some((a) => ids.includes(a.id) && approvalRisk(a) === "high");
  return (
    <>
      <HoldToApprove
        label={label ?? t("approval.all.approve")}
        high={high}
        id={`all-${ids[0]}`}
        pending={decide.isPending}
        onGo={(el) => {
          const burst = prepareBurst(el);
          decide.mutate({ ids, decision: "approve" }, { onSuccess: burst });
        }}
      />
      {children}
      <Button
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ ids, decision: "refuse" })}
      >
        {t("approval.all.refuse")}
      </Button>
    </>
  );
}

/** Said when this person may decide only some of a card's requests: "Aprovar tudo" covers only those. */
export function approveAllPartial(t: TFunction, items: Approval[], who: string | undefined) {
  const { ids, waiting, blocked } = approveAllScope(items);
  if (blocked === 0 || ids.length === 0) return null;
  return t("approval.all.partial", {
    mine: ids.length,
    count: waiting,
    who: who ?? t("approval.all.partialAdmin"),
  });
}

const SUGGESTIONS = ["later", "review", "tests", "smaller"] as const;

/** Refuse with a reason the agent reads (and keeps as a lesson). */
export function RefuseBox({ approval, agent, onCancel }: { approval: Approval; agent?: Agent; onCancel: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const decide = useDecideApproval(org.id);
  const [reason, setReason] = useState("");
  const g = agentGrammar(agent?.name ?? "");
  const id = `ap-reason-${approval.id}`;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = () =>
    decide.mutate(
      { id: approval.id, decision: "refuse", reason: reason.trim() || undefined },
      { onSuccess: () => toast.show(t("approvals.refused", { name: g.name }), "info") },
    );
  return (
    <div className="ap-refuse">
      <Locked when={decide.isPending}>
        <label htmlFor={id}>{t("approvals.refuseLabel")}</label>
        <textarea
          id={id}
          ref={ref}
          rows={2}
          value={reason}
          placeholder={t("approvals.refusePlaceholder")}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="ap-refuse__suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => setReason(t(`approvals.suggest.${s}`))}>
              {t(`approvals.suggest.${s}`)}
            </button>
          ))}
        </div>
        <div className="ap-refuse__row">
          <span className="ap-refuse__learn">{t("approvals.refuseLearn", { context: g.context, name: g.name })}</span>
          <span className="ap-refuse__acts">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("approvals.back")}
            </Button>
            <Button variant="danger" size="sm" kbd={["⌘", "↵"]} loading={decide.isPending} onClick={send}>
              {t("approvals.refuseConfirm")}
            </Button>
          </span>
        </div>
      </Locked>
    </div>
  );
}

/** Where a list row of a request goes: its agent, what it wants in one line, where and when, its time left. */
function ReqRow({ approval: a, selected, onOpen }: { approval: Approval; selected: boolean; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = approvalPhase(a);
  const via = useApprovalVia(a);
  const leftMs = new Date(a.expiresAt).getTime() - Date.now();
  const waits = approvalWaitsFor(a, dir.memberById.get(a.ownerUserId ?? agent?.ownerUserId ?? "")?.name);
  const where = approvalTarget(a) ?? via.name;
  const end =
    p === "waiting" ? (
      <span className={cx("ap-li__left", leftMs <= URGENT_MS && "is-urgent")}>
        {a.canDecide
          ? (timeLeft(t, a.expiresAt) ?? t("approval.expired"))
          : waits
            ? t("approval.waitingFor", { name: waits })
            : t("approval.waitingAdmin")}
      </span>
    ) : (
      <PhaseMark approval={a} />
    );
  return (
    <button
      type="button"
      className={cx("ap-li ac-mediarow ac-mediarow--row", selected && "is-selected")}
      data-id={a.id}
      aria-current={selected || undefined}
      onClick={onOpen}
    >
      <span className="ac-mediarow__face">
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="sm"
          state={p === "waiting" ? "waiting" : p === "running" ? "writing" : "idle"}
          expression={p === "done" ? "happy" : p === "refused" || p === "expired" ? "closed" : undefined}
        />
      </span>
      <span className="ac-mediarow__head">
        <span className="ap-li__line">
          {p === "waiting" || p === "running" ? (
            <Trans
              i18nKey="notifications.wait.wants"
              values={{ name, action: approvalDoing(t, a, i18n.language) }}
              components={{ b: <b /> }}
              {...TYPED_VALUES}
            />
          ) : (
            <b>{approvalTitle(t, a)}</b>
          )}
        </span>
      </span>
      <span className="ac-mediarow__end">{end}</span>
      <span className="ac-mediarow__body">
        <span className="ap-li__meta">
          <ViaGlyph via={via} />
          {where && <span className="ap-li__where">{where}</span>}
          <span className="ap-li__when">
            {p === "waiting" || p === "running"
              ? relativeTime(t, i18n.language, a.createdAt)
              : decisionLabel(t, i18n.language, a, me.user.id, dir.memberById)}
          </span>
        </span>
      </span>
      {p === "waiting" && <ExpiryFuse left={Math.max(0, leftMs) / TTL_MS} color={colorOf(agent)} />}
    </button>
  );
}

/**
 * Several waiting requests of one kind in a row from one agent, as one row: "3 pedidos de Ada para Executar sql",
 * "Aprovar todos", "Aprovar sempre" where its kind offers it, and "Ver cada um" unfolding each request's own row.
 */
function RunRow({
  run,
  items,
  always,
  agent,
  open,
  onToggle,
  children,
}: {
  run: Approval[];
  items: Approval[];
  always: Set<string>;
  agent: Agent | undefined;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const deciding = useApprovalsDeciding(
    org.id,
    run.map((a) => a.id),
  );
  const first = run[0];
  if (!first) return null;
  const name = agent?.name ?? t("channel.unknownAgent");
  const head = t("approval.run.head", { count: run.length, name, what: approvalTitle(t, first) });
  const lead = run.find((a) => always.has(a.id) && a.canDecide);
  const deadline = cardDeadline(run) ?? first.expiresAt;
  const leftMs = new Date(deadline).getTime() - Date.now();
  return (
    <section className="ap-run" data-burst="" aria-label={head}>
      <div className="ac-mediarow ac-mediarow--row">
        <span className="ac-mediarow__face">
          <AgentAvatar agentId={first.agentId} name={name} size="sm" state="waiting" />
        </span>
        <span className="ac-mediarow__head">
          <b className="ap-li__line">{head}</b>
        </span>
        <span className={cx("ac-mediarow__end ap-li__left", leftMs <= URGENT_MS && "is-urgent")}>
          {expiryText(t, { expiresAt: deadline })}
        </span>
      </div>
      <div className="ap-run__acts">
        <Locked when={deciding}>
          <ApproveAll items={run} label={t("approval.run.approve")}>
            {lead && <ApproveAlways approval={lead} agent={agent} also={approveAlwaysAlso(items, lead)} />}
          </ApproveAll>
        </Locked>
      </div>
      <Button size="sm" variant="ghost" className="ap-run__more" aria-expanded={open} onClick={onToggle}>
        {t("approval.run.show")}
      </Button>
      {open && <div className="ap-run__items">{children}</div>}
    </section>
  );
}

const EFFECT_ICON: Record<ApprovalEffect, IconName> = {
  external: "send",
  production: "cloud",
  unsent: "archiveBox",
  readsOnly: "eye",
};
const UNDO_ICON: Record<ApprovalUndo, IconName> = { irreversible: "alert", reversible: "undo", deletable: "undo" };
/** Its text folds past this many characters ("Ver inteiro"). */
const TEXT_FOLD = 360;

/** The request's head on the page: the agent, who asked and from where, and the action in one line. */
function ReviewHead({ approval: a, channel }: { approval: Approval; channel: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = approvalPhase(a);
  const origin = approvalOriginShort(a);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const title = approvalTitle(t, a);
  const by = [
    agent?.role,
    origin ? tt(origin.key, origin.values) : "",
    channel ? `#${channel}` : "",
    relativeTime(t, i18n.language, a.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <header className="ap-review__head ac-mediarow">
      <span className="ac-mediarow__face">
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="md"
          state={p === "running" ? "writing" : p === "waiting" ? "waiting" : "idle"}
          running={p === "running"}
          expression={p === "done" ? "happy" : undefined}
        />
      </span>
      <p className="ap-review__by ac-mediarow__head">
        <b>{name}</b>
        <span className="ac-mediarow__meta">{by}</span>
      </p>
      <div className="ac-mediarow__body">
        <div className="ap-review__titleline">
          <h2 className="ap-review__title" title={title}>
            {title}
          </h2>{" "}
          <UndoChip approval={a} />
        </div>
      </div>
    </header>
  );
}

/** Whether what it does can be undone, as a chip after the request's title (on the page and in the dialog). */
function UndoChip({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const { undo } = approvalEffects(a);
  if (!undo) return null;
  return (
    <Chip icon={UNDO_ICON[undo]} tone={undo === "irreversible" ? "waiting" : undefined} className="ap-review__undo">
      {t(`approvals.trait.${undo}`)}
    </Chip>
  );
}

/**
 * The request itself, under its head (the page's pane) or inside the details dialog: its facts, the outcome once
 * decided, why the agent asks, what it will write (an email as the email, a long text as it will read, else its
 * values), and how it got there (the run's steps as a track, unfolding into the reply's tool block).
 */
function ReviewBody({ approval: a, channel }: { approval: Approval; channel: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = approvalPhase(a);
  const via = useApprovalVia(a);
  const [unfold, setUnfold] = useState(false);
  const [steps, setSteps] = useState(false);
  const [tech, setTech] = useState(false);
  const { effect } = approvalEffects(a);
  const target = approvalTarget(a);
  const text = approvalText(a);
  const why = approvalWords(a);
  const pr = prLink(a);
  const leftMs = new Date(a.expiresAt).getTime() - Date.now();
  const waits = approvalWaitsFor(a, dir.memberById.get(a.ownerUserId ?? agent?.ownerUserId ?? "")?.name);
  const facts: Fact[] = [
    {
      key: "where",
      icon: <ViaGlyph via={via} />,
      label: t("approvals.review.where"),
      value: [via.name, target ?? via.account].filter(Boolean).join(" · "),
      title: [via.name, target ?? via.account].filter(Boolean).join(" · "),
    },
    ...(effect
      ? [
          {
            key: "effect",
            icon: EFFECT_ICON[effect],
            label: t("approvals.review.effect"),
            value: t(`approvals.review.effects.${effect}`),
            tone: effect === "production" ? ("waiting" as const) : undefined,
          },
        ]
      : []),
    p === "waiting"
      ? {
          key: "when",
          icon: a.canDecide ? "clock" : "person",
          label: a.canDecide ? t("approvals.review.deadline") : t("approvals.review.decides"),
          value: a.canDecide
            ? (timeLeft(t, a.expiresAt) ?? t("approval.expired"))
            : waits
              ? t("approval.waitingFor", { name: waits })
              : t("approval.waitingAdmin"),
          tone: a.canDecide && leftMs <= URGENT_MS ? "waiting" : undefined,
        }
      : {
          key: "when",
          icon: p === "done" ? "check" : p === "failed" ? "alert" : "clock",
          label: t("approvals.review.state"),
          value: t(`approvals.status.${PHASE_STATUS[p]}`),
          tone: p === "done" ? "done" : p === "failed" ? "waiting" : undefined,
        },
  ];

  const logo = useCallLogo();
  const run = useRun(org.id, a.runId);
  const around = run.data ? stepsAround(run.data.steps, a) : null;
  const before = around ? toolItemsSaved(workFromSteps(around.before, run.data?.run)) : [];
  const after = around ? toolItemsSaved(workFromSteps(around.after, run.data?.run)) : [];
  const calls = (items: ToolItem[]) =>
    items
      .flatMap((i) => (i.kind === "call" ? [i.line] : []))
      .filter((l, i, all) => !(i === all.length - 1 && l.state === "stop"));
  const lines = calls(before);
  const afterLines = after.flatMap((i) => (i.kind === "call" ? [i.line] : []));
  const at = (iso: string) => formatTime(i18n.language, iso);
  const track: StepTrackStep[] = [
    ...lines.map((l) => ({
      key: l.key,
      icon: logo(l),
      label: toolPhrase(t, l),
      title: [toolPhrase(t, l), l.hint].filter(Boolean).join(" · "),
      state: l.state === "fail" ? ("failed" as const) : ("done" as const),
    })),
    {
      key: "asked",
      icon: "waiting",
      label: t("approvals.review.asked"),
      time: at(a.createdAt),
      state: p === "waiting" ? ("now" as const) : ("done" as const),
    },
    ...(a.decidedAt && p !== "waiting"
      ? [
          {
            key: "decided",
            icon: (a.status === "approved" ? "check" : a.status === "refused" ? "close" : "clock") as IconName,
            label: t(`approvals.status.${PHASE_STATUS[p]}`),
            time: at(a.decidedAt),
            state: a.status === "approved" ? ("after" as const) : ("done" as const),
          },
        ]
      : []),
    ...afterLines.map((l) => ({
      key: `after-${l.key}`,
      icon: logo(l),
      label: toolPhrase(t, l),
      title: [toolPhrase(t, l), l.hint].filter(Boolean).join(" · "),
      state: l.state === "fail" ? ("failed" as const) : ("after" as const),
    })),
  ];
  const durationMs = around ? workFromSteps(around.before, run.data?.run).durationMs : null;
  const long = (text?.text.length ?? 0) > TEXT_FOLD || (text?.text.split("\n").length ?? 0) > 6;

  return (
    <div className="ap-review__body">
      <FactStrip facts={facts} className="ap-review__facts" />
      <AheadLine approval={a} className="ap-card__ahead" />
      <Outcome approval={a} agent={agent} />

      {why && (
        <Card className="ap-review__card">
          <CardHeader icon="message" title={t("approvals.review.why", { name })} />
          <p className="ap-review__why">{inlineWords(why)}</p>
          {a.issue && (
            <Link
              className="ap-link"
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(a.issue.number) }}
            >
              #{a.issue.number} {a.issue.title}
            </Link>
          )}
        </Card>
      )}

      <Card className="ap-review__card">
        <CardHeader
          icon={a.email ? "mail" : text ? "edit" : "approve"}
          title={
            a.email
              ? t("approvals.review.email")
              : text
                ? t(p === "done" ? "approvals.review.textDone" : "approvals.review.text")
                : t(p === "waiting" ? "approvals.review.values" : "approvals.review.valuesDone")
          }
          subtitle={[via.name, target].filter(Boolean).join(" · ") || undefined}
          action={
            text && long ? (
              <Button variant="ghost" size="sm" aria-expanded={unfold} onClick={() => setUnfold((o) => !o)}>
                {unfold ? t("approvals.review.less") : t("approvals.review.more")}
              </Button>
            ) : undefined
          }
        />
        {a.email ? (
          <EmailLetter email={a.email} full />
        ) : text ? (
          <div className={cx("ap-review__text", long && !unfold && "is-folded")}>
            <Markdown source={text.text} variant="message" />
          </div>
        ) : (
          <ExactAction approval={a} bare />
        )}
        {pr && (
          <a className="ap-link" href={pr} target="_blank" rel="noreferrer">
            {t("approvals.panel.openPr")}
          </a>
        )}
      </Card>

      <Card className="ap-review__card">
        <CardHeader
          icon="layers"
          title={t("approvals.review.trail")}
          subtitle={
            around
              ? [t("chat.work.steps", { count: track.length }), durationMs ? formatDuration(t, durationMs) : ""]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
          action={
            lines.length + afterLines.length > 0 ? (
              <Button variant="ghost" size="sm" aria-expanded={steps} onClick={() => setSteps((o) => !o)}>
                {steps ? t("approvals.review.hideSteps") : t("approvals.review.showSteps")}
              </Button>
            ) : undefined
          }
        />
        <StepTrack
          steps={track}
          className="ap-review__track"
          more={(count) => t("chat.work.steps", { count })}
          aria-label={t("approvals.review.trail")}
        />
        {steps && run.data && around && (
          <TaskStepsBlock
            steps={[...around.before, ...around.after]}
            run={run.data.run}
            working={false}
            agentName={name}
            color={colorOf(agent)}
          />
        )}
        {tech && text && (
          <pre className="ap-code ap-review__tech">
            <code>{`${a.tool}\n${JSON.stringify(a.params ?? {}, null, 2)}`}</code>
          </pre>
        )}
        {(channel || text) && (
          <p className="ac-card__foot ap-review__foot">
            {channel && (
              <Link
                className="ap-link"
                to="/org/$orgId/c/$channelId"
                params={{ orgId: org.id, channelId: a.channelId }}
                search={{ m: a.messageId ?? a.threadId ?? undefined }}
              >
                {t("approvals.panel.viewChannel", { channel })}
              </Link>
            )}
            {text && (
              <button type="button" className="ap-link" aria-expanded={tech} onClick={() => setTech((o) => !o)}>
                {t("approvals.technical")}
              </button>
            )}
          </p>
        )}
      </Card>
    </div>
  );
}

/** The `approvals.status.*` word of each phase. */
const PHASE_STATUS: Record<
  Exclude<ApprovalPhase, "waiting">,
  "approved" | "failed" | "refused" | "expired" | "running" | "canceled" | "scheduled"
> = {
  running: "running",
  scheduled: "scheduled",
  done: "approved",
  failed: "failed",
  refused: "refused",
  expired: "expired",
  canceled: "canceled",
};

/**
 * The decision, in one bar of buttons: Refuse and Approve ("Aprovar sempre" before them where its kind offers it), what
 * each lets the agent do in its tip (Approve: once, with these values); refusing opens the reason in its place. Pinned
 * to the bottom of the page's pane; the details dialog's footer elsewhere. Nothing while it isn't yours to decide.
 */
function DecisionBar({
  approval: a,
  refusing,
  onRefuse,
  onCancelRefuse,
  also,
  floating,
}: {
  approval: Approval;
  refusing: boolean;
  onRefuse: () => void;
  onCancelRefuse: () => void;
  also?: string[];
  floating?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const p = approvalPhase(a);
  const deciding = useApprovalsDeciding(org.id, [a.id]);
  if (p === "running")
    return (
      <div className={cx("ap-bar", floating && "ap-bar--float")}>
        <p className="ap-bar__text ap-card__running">{t("approvals.running", { context: g.context, name })}</p>
        <WorkSweep color={colorOf(agent)} />
      </div>
    );
  if (p !== "waiting" || !a.canDecide) {
    const line = p === "waiting" ? requesterDecidesLine(t, a) : null;
    return line ? (
      <div className={cx("ap-bar", floating && "ap-bar--float")}>
        <p className="ap-bar__text">{line}</p>
      </div>
    ) : null;
  }
  if (refusing)
    return (
      <div className={cx("ap-bar ap-bar--refuse", floating && "ap-bar--float")}>
        <RefuseBox approval={a} agent={agent} onCancel={onCancelRefuse} />
      </div>
    );
  const note =
    approvalRisk(a) === "high"
      ? t("approvals.holdNote")
      : a.runAt
        ? t("approvals.clickNoteAhead", { when: nextLabel(i18n.language, a.runAt) })
        : t("approvals.review.grants", { name, doing: approvalDoing(t, a, i18n.language) });
  return (
    <div className={cx("ap-bar ap-bar--acts", floating && "ap-bar--float")}>
      <div className="ap-bar__acts">
        <Locked when={deciding}>
          {approveAlwaysOffered(a) && <ApproveAlways approval={a} agent={agent} also={also} />}
          <Button size="sm" onClick={onRefuse}>
            {t("approval.refuse")}
            <Kbd>R</Kbd>
          </Button>
          <ApproveButton approval={a} tip={note} />
        </Locked>
      </div>
    </div>
  );
}

/** A decided request's state at the end of its list row: only its icon (the row's line already says who decided). */
function PhaseMark({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const p = approvalPhase(approval);
  const [icon, key]: [IconName, "approved" | "failed" | "refused" | "expired" | "running" | "canceled" | "scheduled"] =
    p === "done"
      ? ["check", "approved"]
      : p === "scheduled"
        ? ["calendar", "scheduled"]
        : p === "failed"
          ? ["alert", "failed"]
          : p === "refused"
            ? ["close", "refused"]
            : p === "expired"
              ? ["clock", "expired"]
              : p === "running"
                ? ["play", "running"]
                : ["block", "canceled"];
  const label = t(`approvals.status.${key}`);
  return (
    <span className={cx("ap-li__state", `is-${p}`)} role="img" aria-label={label} title={label}>
      <Icon name={icon} size={16} />
    </span>
  );
}

/** Expired: ask the agent, in the same conversation, to ask again if it still makes sense. */
function AskAgain({ approval, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const post = usePostMessage(org.id, approval.channelId, {
    me: { id: me.user.id },
    mentioned: () => [approval.agentId],
    onSent: () => toast.show(t("approvals.againSent"), "info"),
  });
  if (!agent) return null;
  return (
    <Button
      size="sm"
      icon="repeat"
      loading={post.isPending}
      disabled={post.isPending || post.isSuccess}
      onClick={(e) => {
        e.stopPropagation();
        sendHelpers(post).send(
          t("approvals.againBody", { handle: agent.handle, title: approvalTitle(t, approval) }),
          approval.threadId,
        );
      }}
    >
      {t("approvals.again")}
    </Button>
  );
}

/** A request's details over whatever page is open (`DetailsHost`): a routine's run, an audit row. */
export function ApprovalDetailsDialog({ approvalId, onClose }: { approvalId: string; onClose: () => void }) {
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const channels = useChannels(org.id);
  const [refusing, setRefusing] = useState(false);
  const all = approvals.data ?? [];
  const approval = all.find((a) => a.id === approvalId);
  useEffect(() => {
    if (approvals.isSuccess && !approval) onClose();
  }, [approvals.isSuccess, approval, onClose]);
  if (!approval) return null;
  return (
    <ApprovalDetails
      approval={approval}
      channel={channels.data?.find((c) => c.id === approval.channelId)?.name ?? ""}
      refusing={refusing}
      onRefuse={() => setRefusing(true)}
      onCancelRefuse={() => setRefusing(false)}
      onClose={onClose}
    />
  );
}

/** A request in the centered details dialog over another page: the same review as the Approvals page's pane. */
function ApprovalDetails({
  approval: a,
  channel,
  refusing,
  onRefuse,
  onCancelRefuse,
  onClose,
}: {
  approval: Approval;
  channel: string;
  refusing: boolean;
  onRefuse: () => void;
  onCancelRefuse: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = approvalPhase(a);
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      // Esc while a reason is being typed backs out of refusing first.
      onEscapeKeyDown={(e) => {
        if (refusing) {
          e.preventDefault();
          onCancelRefuse();
        }
      }}
      closeLabel={t("approvals.panel.close")}
      className="ap-dialog"
      eyebrow={t("approvals.panel.eyebrow")}
      icon={
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="md"
          state={p === "running" ? "writing" : p === "waiting" ? "waiting" : "idle"}
          running={p === "running"}
          expression={p === "done" ? "happy" : undefined}
        />
      }
      title={
        <>
          {approvalTitle(t, a)} <UndoChip approval={a} />
        </>
      }
      subtitle={
        <span>
          <b className="ap-dialog__who">{name}</b>
          {" · "}
          {[agent?.role, channel ? `#${channel}` : "", relativeTime(t, i18n.language, a.createdAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
      footer={<DecisionBar approval={a} refusing={refusing} onRefuse={onRefuse} onCancelRefuse={onCancelRefuse} />}
    >
      <ReviewBody approval={a} channel={channel} />
    </DetailsDialog>
  );
}

/** What became of a decided request, as one card among the review's: its state, who decided and when, the action it
 * still offers (cancel a scheduled one, ask again), and what the action returned behind a link. */
function Outcome({ approval: a, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [returned, setReturned] = useState(false);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const p = approvalPhase(a);
  if (p === "waiting") return null;
  const who =
    a.decidedByUserId === me.user.id
      ? t("approvals.panel.youLower")
      : (dir.memberById.get(a.decidedByUserId ?? "")?.name ?? "");
  const when = a.decidedAt ? relativeTime(t, i18n.language, a.decidedAt) : "";
  const approvedBy = t("approvals.panel.approvedBy", { name: who, when });
  const [icon, title, subtitle]: [IconName, string, string | undefined] =
    p === "running"
      ? ["play", t("approvals.panel.runningLine", { context: g.context, name }), approvedBy]
      : p === "done"
        ? ["check", t("approvals.panel.done"), approvedBy]
        : p === "failed"
          ? ["alert", t("approvals.panel.failed"), approvedBy]
          : p === "refused"
            ? [
                "close",
                t("approvals.panel.refusedBy", { name: who, when }),
                a.reason ? `“${a.reason}”` : t("approvals.panel.noReason"),
              ]
            : p === "scheduled"
              ? [
                  "calendar",
                  a.runAt ? t("approval.ahead.scheduled", { when: nextLabel(i18n.language, a.runAt) }) : "",
                  approvedBy,
                ]
              : p === "expired"
                ? ["clock", t("approvals.status.expired"), aheadEndLine(t, a) ?? t("approvals.expiredLine")]
                : ["block", t("approvals.status.canceled"), aheadEndLine(t, a) ?? t("approvals.canceledLine")];
  const action =
    p === "scheduled" && a.canCancel ? (
      <CancelAhead id={a.id} />
    ) : p === "expired" && aheadPhase(a) !== "lapsed" ? (
      <AskAgain approval={a} agent={agent} />
    ) : undefined;
  return (
    <Card className={cx("ap-review__card ap-outcome", `ap-outcome--${p}`)}>
      <CardHeader icon={icon} title={title} subtitle={subtitle} action={action} />
      {p === "refused" && a.reason && (
        <p className="ap-outcome__lesson">{t("approvals.lesson", { name, reason: a.reason })}</p>
      )}
      {returned && a.result?.text && (
        <pre className="ap-code ap-review__tech">
          <code>{a.result.text}</code>
        </pre>
      )}
      {a.result?.text && (
        <p className="ac-card__foot ap-review__foot">
          <button type="button" className="ap-link" aria-expanded={returned} onClick={() => setReturned((o) => !o)}>
            {t("approvals.panel.returned")}
          </button>
        </p>
      )}
      {p === "running" && <WorkSweep color={colorOf(agent)} />}
    </Card>
  );
}
