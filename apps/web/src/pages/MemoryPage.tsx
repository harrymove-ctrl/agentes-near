import type { Agent, Memory, MemoryKind } from "@agenteschat/client";
import { useMemory, useMemoryAction, useProposals } from "@agenteschat/client";
import { daysBetween, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  type IconName,
  List,
  PageHeader,
  SearchField,
  Tabs,
  Textarea,
  Toolbar,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskAgentButton } from "@/components/AskAgentButton";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useLandOn } from "@/lib/land-on";
import { lookOf } from "@/lib/look";

export type MemoryTab = "known" | "lessons" | "archived";

/** Where a memory came from, in the app's language ("Escrito por Walter em #eng · 12 out"); else the server's text. */
export function memorySource(t: TFunction, language: string, m: Memory) {
  const o = m.origin;
  if (!o) return m.source;
  const tt = t as unknown as (key: string, options: Record<string, string>) => string;
  const how = tt(`memory.origin.${o.by}`, {
    name: o.name ?? tt("memory.origin.someone", { defaultValue: "a person" }),
    defaultValue: "",
  });
  if (!how) return m.source;
  const where = o.channel
    ? tt("memory.origin.inChannel", { channel: o.channel, defaultValue: ` in #${o.channel}` })
    : "";
  const date = new Date(o.at)
    .toLocaleDateString(language, { day: "numeric", month: "short", timeZone: "UTC" })
    .replace(".", "");
  return `${how}${where} · ${date}`;
}

export function inMemoryTab(m: Memory, tab: MemoryTab) {
  if (tab === "archived") return m.archived;
  if (m.archived) return false;
  return tab === "lessons"
    ? m.kind === "lesson" || m.kind === "preference"
    : m.kind === "fact" || m.kind === "decision";
}

/** The tab that lists a memory; none for a rule in force (rules have their own card on the agent's page). */
export const memoryTabOf = (m: Memory): MemoryTab | null =>
  (["archived", "lessons", "known"] as const).find((tab) => inMemoryTab(m, tab)) ?? null;

export function filterMemories(list: Memory[], tab: MemoryTab, query: string) {
  const q = query.trim().toLowerCase();
  return list.filter((m) => inMemoryTab(m, tab) && (!q || `${m.text} ${m.source}`.toLowerCase().includes(q)));
}

export const KIND_ICON: Record<MemoryKind, IconName> = {
  decision: "check",
  fact: "info",
  preference: "preference",
  lesson: "agent",
  rule: "flag",
};

/** "usado 9 vezes", "nunca usado", "sem uso há 40 dias" (archived and stale). */
export function usageLabel(t: TFunction, m: Memory, now = new Date()) {
  if (m.archived && m.lastUsedAt) return t("memory.unusedFor", { days: daysBetween(m.lastUsedAt, now) });
  return m.uses === 0 ? t("memory.used_zero") : t("memory.used", { count: m.uses });
}

/** An agent's memory: "O que a Ada sabe". `item`: the memory a link opened it at. */
export function MemoryPage({ agentId, item }: { agentId: string; item?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(agentId);
  if (dir.loading) {
    return (
      <div className="page page--mid">
        <LoadingPage rows={5} />
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="page page--mid">
        <EmptyState icon="agent">{t("agent.notFound")}</EmptyState>
      </div>
    );
  }
  return <MemoryView agent={agent} item={item} />;
}

/**
 * Nothing to show of an agent's memory: its own face and a way to teach it when it holds `none` at all, a way out of
 * the search, or one line for a tab with nothing in it while the others have.
 */
export function NoMemories({
  agent,
  q,
  none,
  onClear,
}: {
  agent: Agent;
  q: string;
  none: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  if (q.trim())
    return (
      <EmptyState
        size="inline"
        actions={
          <Button size="sm" onClick={onClear}>
            {t("filters.clearSearch")}
          </Button>
        }
      >
        {t("memory.emptySearch", { q })}
      </EmptyState>
    );
  if (!none) return <EmptyState size="inline">{t("memory.emptyTab")}</EmptyState>;
  return (
    <EmptyState
      size="panel"
      agent={lookOf(agent) ?? true}
      title={t("memory.emptyTitle", { name: agent.name })}
      actions={<AskAgentButton agent={agent} variant="primary" />}
    >
      {t(modeKey(org, "memory.emptyText"))}
    </EmptyState>
  );
}

function MemoryView({ agent, item }: { agent: Agent; item?: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const action = useMemoryAction(org.id, agent.id);
  const g = agentGrammar(agent.name);
  const [picked, setTab] = useState<MemoryTab | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Memory | null>(null);
  const all = memory.data ?? [];
  // The memory a link named: its tab shows until the person picks one, and it is landed on.
  const linked = all.find((m) => m.id === item);
  const tab = picked ?? (linked && memoryTabOf(linked)) ?? "known";
  const page = useRef<HTMLDivElement>(null);
  useLandOn(page, item, Boolean(linked));
  const items = filterMemories(all, tab, q);
  const count = (x: MemoryTab) => all.filter((m) => inMemoryTab(m, x)).length;
  const pendingProposals = (proposals.data ?? []).filter((p) => p.agentId === agent.id && p.status === "pending");

  return (
    <div className="page page--full" ref={page}>
      <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }} className="ac-back">
        <Icon name="chevronLeft" />
        {t("memory.back", g)}
      </Link>
      <PageHeader
        title={t("memory.title", g)}
        meta={t(modeKey(org, "memory.subtitle"), g)}
        actions={
          pendingProposals.length > 0 && (
            <Button asChild>
              <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: agent.id }}>
                <Icon name="waiting" />
                {t("memory.proposals", { count: pendingProposals.length })}
              </Link>
            </Button>
          )
        }
      />

      <div className="tabs-bar">
        <Tabs
          value={tab}
          onValueChange={setTab}
          label={t("memory.tabsLabel")}
          items={[
            { value: "known", label: t("memory.tabs.known"), count: count("known") },
            { value: "lessons", label: t("memory.tabs.lessons"), count: count("lessons") },
            { value: "archived", label: t("memory.tabs.archived"), count: count("archived") },
          ]}
        >
          {null}
        </Tabs>
        <Toolbar
          search={
            <SearchField
              aria-label={t("memory.search")}
              placeholder={t("memory.searchPlaceholder", g)}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
            />
          }
        />
      </div>

      <List role="tabpanel" aria-label={t(`memory.tabs.${tab}`)}>
        {items.map((m) => (
          <article
            key={m.id}
            className="memory-item"
            data-item-id={m.id}
            aria-label={`${t(`memory.kinds.${m.kind}`)}: ${memoryLine(t, m)}`}
          >
            <div className="row">
              <Chip icon={KIND_ICON[m.kind]}>{t(`memory.kinds.${m.kind}`)}</Chip>
              {m.pinned && <Chip icon="pin">{t("memory.pinned")}</Chip>}
              {m.verified ? (
                <Chip icon="check" tone="done" title={t("memory.verifiedTitle")}>
                  {t("memory.verified")}
                </Chip>
              ) : (
                <Chip icon="info" title={t("memory.unverifiedTitle")}>
                  {t("memory.unverified")}
                </Chip>
              )}
              {m.lowTrust && (
                <Chip icon="alert" tone="waiting">
                  {t("memory.lowTrust")}
                </Chip>
              )}
              <span className="memory-item__used">{usageLabel(t, m)}</span>
            </div>
            <p className="memory-item__text">{memoryLine(t, m)}</p>
            {m.supersedes && (
              <p className="small muted" style={{ margin: 0 }}>
                {t("memory.supersedes")} <span className="struck">{m.supersedes}</span>
              </p>
            )}
            <div className="row">
              <span className="memory-item__source small muted">
                {m.editedByUserId === me.user.id
                  ? t("memory.editedByYou", { when: relativeTime(t, i18n.language, m.updatedAt) })
                  : memorySource(t, i18n.language, m)}
              </span>
              {/* A row of ghosts: their words 16px apart, the last one on the item's padding line. */}
              <div className="ac-acts">
                {(m.lowTrust || !m.verified) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("memory.confirmTitle")}
                    disabled={action.isPending}
                    onClick={() => action.mutate({ type: "confirm", id: m.id })}
                  >
                    {t("memory.confirm")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                  {t("memory.edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => action.mutate({ type: "pin", id: m.id, pinned: !m.pinned })}
                >
                  {m.pinned ? t("memory.unpin") : t("memory.pin")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => action.mutate({ type: "archive", id: m.id, archived: !m.archived })}
                >
                  {m.archived ? t("memory.restore") : t("memory.archive")}
                </Button>
              </div>
            </div>
          </article>
        ))}
        {memory.isError && !memory.data && <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />}
        {memory.isSuccess && items.length === 0 && (
          <NoMemories agent={agent} q={q} none={all.length === 0} onClear={() => setQ("")} />
        )}
      </List>
      <p className="page__note">
        <HelpLink slug="memory">{t("memory.how")}</HelpLink>
      </p>

      <EditMemoryDialog
        memory={editing}
        onClose={() => setEditing(null)}
        onSave={(text) => {
          if (editing) action.mutate({ type: "edit", id: editing.id, text }, { onSuccess: () => setEditing(null) });
        }}
      />
    </div>
  );
}

function EditMemoryDialog({
  memory,
  onClose,
  onSave,
}: {
  memory: Memory | null;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  useEffect(() => setText(memory?.text ?? ""), [memory]);
  return (
    <Dialog
      open={memory !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("memory.editTitle", { kind: memory ? t(`memory.kindsLower.${memory.kind}`) : "" })}
      closeLabel={t("common.close")}
      unsaved={memory !== null && text !== memory.text}
      width={520}
    >
      <DialogBody>
        <Field
          label={t("memory.text")}
          id="edit-text"
          hint={{
            name: t("common.about", { label: t("memory.text") }),
            text: t("memory.editHelp", { source: memory ? `${memorySource(t, i18n.language, memory)}.` : "" }),
          }}
        >
          <Textarea rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
