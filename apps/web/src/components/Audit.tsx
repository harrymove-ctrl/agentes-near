import { type AuditRow, useAudit } from "@agenteschat/client";
import {
  AUDIT_HIDDEN,
  AUDIT_SHOWS,
  type AuditMark,
  type AuditShow,
  auditActorName,
  auditApprovalText,
  auditDetailEntries,
  auditHint,
  auditOutcome,
  auditPhrase,
  auditQueryOf,
  auditReason,
  auditReasonKey,
  auditRoutine,
  auditSecretText,
  auditSentence,
  auditStr,
  auditSubLine,
  auditToolSaid,
  auditValueText,
  auditWhere,
  TOOL_CALL,
} from "@agenteschat/client/lib/audit";
import { humanize } from "@agenteschat/client/lib/custom-tools";
import { dayLabel, formatTime, whenAt } from "@agenteschat/client/lib/format";
import {
  Button,
  Chip,
  type ChipProps,
  EmptyState,
  GroupHeading,
  Icon,
  Menu,
  MenuItem,
  Segmented,
  Select,
  Toolbar,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { DetailsLink } from "@/components/details-link";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useEscClose } from "@/hooks/useEscClose";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import "@/components/threads/threads.css";
import "./audit.css";

/**
 * Configurações › Auditoria: the org's audit log as one list by day, a sentence per row (who, what, how it
 * ended; words in `@agenteschat/client/lib/audit`), shortcuts on top; a row opens the same panel as a thread
 * in the chat, with what was sent (secrets masked), why it was refused, the approval and the secret.
 */

const ANY = "any";

export function AuditSection({ agent }: { agent?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const look = useRightHandLook();
  const [show, setShow] = useState<AuditShow>("all");
  const [agentId, setAgentId] = useState(agent ?? ANY);
  const [openId, setOpenId] = useState<string | null>(null);
  const audit = useAudit(org.id, auditQueryOf(show, agentId === ANY ? null : agentId));
  const rows = useMemo(() => audit.data?.pages.flatMap((p) => p.rows) ?? [], [audit.data]);
  const open = rows.find((r) => r.id === openId) ?? null;

  const agentOptions = [
    // A glyph the list centres in the faces' 32px column, so every name starts on one edge.
    { value: ANY, label: t("audit.anyAgent"), leading: <Icon name="members" size={18} className="muted" /> },
    ...dir.agents.map((a) => ({
      value: a.id,
      label: a.name,
      leading: <AgentAvatar agentId={a.id} name={a.name} size="sm" />,
    })),
  ];

  // The rows by day, as the list shows them: each day a group under its heading.
  const days: [string, AuditRow[]][] = [];
  for (const row of rows) {
    const label = dayLabel(t, i18n.language, row.at);
    const last = days.at(-1);
    if (last?.[0] === label) last[1].push(row);
    else days.push([label, [row]]);
  }
  return (
    <section className="audit" aria-label={t("settings.section.audit")}>
      <Toolbar
        label={t("audit.filters")}
        actions={
          show !== "people" && (
            <Select
              size="sm"
              value={agentId}
              onValueChange={setAgentId}
              options={agentOptions}
              aria-label={t("audit.agent")}
              className="audit__agent"
            />
          )
        }
      >
        <Segmented
          label={t("audit.filters")}
          value={show}
          onValueChange={setShow}
          options={AUDIT_SHOWS.map((s) => ({ value: s, label: t(`audit.filter.${s}`) }))}
        />
      </Toolbar>

      {audit.isPending ? (
        <LoadingList count={6} trailing />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : rows.length === 0 ? (
        show === "all" && agentId === ANY ? (
          <EmptyState size="page" agent={look} mood="deal" title={t("audit.emptyTitle")}>
            {t("audit.empty")}
          </EmptyState>
        ) : (
          <EmptyState
            size="panel"
            actions={
              <Button
                onClick={() => {
                  setShow("all");
                  setAgentId(ANY);
                }}
              >
                {t("filters.clearAll")}
              </Button>
            }
          >
            {t("audit.emptyFiltered")}
          </EmptyState>
        )
      ) : (
        <div className="ac-groups">
          {days.map(([label, list]) => (
            <div key={label}>
              <GroupHeading level={3} title={label} />
              <ul className="audit__list">
                {list.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="audit-row"
                      aria-pressed={row.id === openId}
                      onClick={() => setOpenId(row.id)}
                    >
                      <Face row={row} />
                      <span className="audit-row__text">
                        <span className="audit-row__title">
                          <Sentence row={row} />
                        </span>
                        <span className="audit-row__sub">{auditSubLine(t, row)}</span>
                      </span>
                      <OutcomeChip row={row} />
                      <time className="audit-row__time" dateTime={row.at}>
                        {formatTime(i18n.language, row.at)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {audit.hasNextPage && (
        <div className="audit__more">
          <Button loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            {t("audit.loadMore")}
          </Button>
        </div>
      )}
      {open && <AuditPanel row={open} onClose={() => setOpenId(null)} />}
    </section>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Sentence({ row }: { row: AuditRow }) {
  const { t, i18n } = useTranslation();
  const { name, text } = auditSentence(t, row, i18n.language);
  if (!name) return <>{text}</>;
  return (
    <>
      <strong>{name}</strong> {text}
    </>
  );
}

function Face({ row, size = "sm" }: { row: AuditRow; size?: "xs" | "sm" }) {
  const { t } = useTranslation();
  const name = auditActorName(t, row) ?? t("audit.system");
  if (row.actor.type === "system" || !row.actor.id) {
    return (
      <span className={`audit-face audit-face--${size}`} aria-hidden="true">
        <Icon name="settings" size={size === "xs" ? 14 : 16} />
      </span>
    );
  }
  return <ActorAvatar actor={{ type: row.actor.type, id: row.actor.id }} name={name} size={size} />;
}

/** Each mark of the shared outcome (`auditOutcome`) as this app's icon. */
const MARK_ICON: Record<AuditMark, ChipProps["icon"]> = {
  check: "check",
  block: "block",
  clock: "clock",
  stop: "stop",
  alert: "alert",
  waiting: "waiting",
};

function OutcomeChip({ row }: { row: AuditRow }) {
  const { t } = useTranslation();
  const look = auditOutcome(t, row);
  if (!look) return null;
  const tone = look.mood === "done" || look.mood === "waiting" ? look.mood : undefined;
  const mood = look.mood === "refused" || look.mood === "failed" ? `audit-chip--${look.mood}` : undefined;
  return (
    <Chip icon={MARK_ICON[look.mark]} tone={tone} className={mood}>
      {look.text}
    </Chip>
  );
}

// ── The panel (same as a thread's beside its channel) ───────────────────────

function AuditPanel({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  useEscClose(onClose);
  const name = auditActorName(t, row) ?? t("audit.system");
  const reason = auditReason(t, row);
  const isCall = row.action === TOOL_CALL;
  const where = auditWhere(t, row);
  const connector = auditStr(row.details.connector);
  const look = auditOutcome(t, row);

  const facts: [string, ReactNode][] = [];
  if (isCall) {
    const behind = auditStr(row.details.behind);
    const routine = auditRoutine(row);
    if (behind === "person" && row.onBehalfOf) {
      facts.push([
        t("audit.panel.asked"),
        <span key="asked" className="audit-panel__who">
          <ActorAvatar actor={{ type: "person", id: row.onBehalfOf.id }} name={row.onBehalfOf.name ?? ""} size="xs" />
          {row.onBehalfOf.name ?? t("audit.removed")}
        </span>,
      ]);
    } else if (behind === "routine") {
      facts.push([
        t("audit.panel.asked"),
        routine ? t("audit.panel.routine", { name: routine }) : t("audit.behind.routineAny"),
      ]);
    } else if (behind === "unattended") {
      facts.push([
        t("audit.panel.asked"),
        <span key="nobody" className="muted">
          {t("audit.panel.nobody")}
        </span>,
      ]);
    }
  }
  if (where && row.channel) {
    facts.push([
      t("audit.panel.where"),
      <Link key="where" to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: row.channel.id }}>
        {where}
      </Link>,
    ]);
  }
  if (connector) facts.push([t("audit.panel.via"), connector]);
  if (row.approval) facts.push([t("audit.panel.approval"), auditApprovalText(t, row.approval)]);
  if (row.secret) facts.push([t("audit.panel.secret"), auditSecretText(t, row.secret)]);
  facts.push([t("audit.panel.when"), whenAt(t, i18n.language, row.at)]);

  const input = isCall ? (row.details.input as Record<string, unknown> | undefined) : undefined;
  const changeDetails = isCall ? undefined : auditDetailEntries(row.details);
  const reasonKey = auditReasonKey(row);
  const said = auditToolSaid(row);

  return (
    <SidePanel className="audit-panel" label={t("audit.panel.label")} onClose={onClose}>
      <header className="channel__header thread-head thread-head--panel">
        <span className="thread-head__who" aria-hidden="true">
          <Face row={row} />
        </span>
        <div className="thread-head__text">
          <h1 className="channel__title thread-title">
            <span className="thread-title__text">{auditHint(t, row) ?? auditPhrase(t, row)}</span>
          </h1>
          <span className="channel__topic thread-head__meta">
            <span className="thread-head__where">{name}</span>
            <span>·</span>
            <span>{whenAt(t, i18n.language, row.at)}</span>
          </span>
        </div>
        <Menu
          align="end"
          label={t("audit.panel.more")}
          trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("audit.panel.more")} />}
        >
          <MenuItem
            icon="copy"
            onSelect={async () => {
              await navigator.clipboard?.writeText(row.id);
              toast.show(t("audit.panel.copied"));
            }}
          >
            {t("audit.panel.copyLink")}
          </MenuItem>
        </Menu>
        <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
      </header>

      <div className="thread-panel__page audit-panel__body">
        <p className="audit-panel__lead">
          <Sentence row={row} />
        </p>
        {look && (
          <div>
            <OutcomeChip row={row} />
          </div>
        )}
        {reason && (
          <div className={`audit-panel__reason ac-iconline audit-panel__reason--${reasonKey}`}>
            <Icon name={reasonKey === "refused" ? "block" : reasonKey === "failed" ? "alert" : "info"} size={16} />
            <span>
              <strong>{t(`audit.panel.reason.${reasonKey}`)}:</strong> {reason}
            </span>
          </div>
        )}
        <dl className="audit-panel__facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {input && Object.keys(input).length > 0 && (
          <div className="audit-panel__sent">
            <h4>{t("audit.panel.sent")}</h4>
            <KeyValues entries={Object.entries(input)} />
            <p className="audit-panel__hint">{t("audit.panel.sentHint")}</p>
          </div>
        )}
        {changeDetails && changeDetails.length > 0 && (
          <div className="audit-panel__sent">
            <h4>{t("audit.panel.details")}</h4>
            <KeyValues entries={changeDetails} />
          </div>
        )}
        <details className="audit-panel__tech">
          <summary>
            <Icon name="chevronRight" size={14} />
            {t("audit.panel.tech")}
          </summary>
          <dl>
            <dt>{t("audit.panel.techAction")}</dt>
            <dd>{row.action}</dd>
            {isCall && row.target.id && (
              <>
                <dt>{t("audit.panel.techTool")}</dt>
                <dd>{row.target.id}</dd>
              </>
            )}
            {auditStr(row.details.kind) && (
              <>
                <dt>{t("audit.panel.techKind")}</dt>
                <dd>{auditStr(row.details.kind)}</dd>
              </>
            )}
            {said && (
              <>
                <dt>{t("audit.panel.techSaid")}</dt>
                <dd>{said}</dd>
              </>
            )}
            {row.runId && (
              <>
                <dt>{t("audit.panel.techRun")}</dt>
                <dd>{row.runId}</dd>
              </>
            )}
            <dt>{t("audit.panel.techId")}</dt>
            <dd>{row.id}</dd>
          </dl>
        </details>
      </div>

      {(row.channel || row.approval?.status === "pending") && (
        <footer className="audit-panel__foot">
          {row.approval?.status === "pending" && (
            <Button asChild variant="primary" icon="waiting">
              <DetailsLink item={{ kind: "approval", id: row.approval.id }}>
                {t("audit.panel.openApproval")}
              </DetailsLink>
            </Button>
          )}
          {row.channel && (
            <Button asChild icon="message">
              <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: row.channel.id }}>
                {t("audit.panel.openConversation")}
              </Link>
            </Button>
          )}
        </footer>
      )}
    </SidePanel>
  );
}

function KeyValues({ entries }: { entries: [string, unknown][] }) {
  const { t } = useTranslation();
  return (
    <dl className="audit-kv">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{humanize(k)}</dt>
          <dd>
            {v === AUDIT_HIDDEN ? (
              <span className="audit-kv__hidden">
                <Icon name="lock" size={14} />
                {t("audit.panel.hidden")}
              </span>
            ) : (
              auditValueText(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
