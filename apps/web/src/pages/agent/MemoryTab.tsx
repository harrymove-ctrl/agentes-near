import type { LearnedSkill, Memory, Proposal } from "@agenteschat/client";
import {
  ApiError,
  useDecideProposal,
  useLearnedSkills,
  useMemory,
  useMemoryAction,
  useProposals,
  useSkillAction,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { memoryLine, pendingOnAgent, proposalTitle, proposalWhy } from "@agenteschat/client/lib/proposals";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  Diff,
  diffLines,
  EmptyState,
  Field,
  GroupHeading,
  Icon,
  InfoHint,
  Locked,
  SearchField,
  Segmented,
  Textarea,
  Toolbar,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskAgentButton } from "@/components/AskAgentButton";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useLandOn } from "@/lib/land-on";
import { lookOf } from "@/lib/look";
import { inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import {
  filterMemories,
  KIND_ICON,
  type MemoryTab as Kind,
  memorySource,
  memoryTabOf,
  NoMemories,
  usageLabel,
} from "@/pages/MemoryPage";
import { CardHead, useAgentEdit } from "./context";
import { Cell } from "./Work";

/** A proposal to change this agent's instructions: why, the diff, and Aceitar / Editar antes / Recusar. */
function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { agent } = useAgentEdit();
  const decide = useDecideProposal(org.id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.after);
  const [stale, setStale] = useState(false);
  const g = agentGrammar(agent.name);
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) setStale(true);
    else toast.show(errorText(t, error), "error");
  };
  const accept = () =>
    decide.mutate(
      { id: proposal.id, decision: "accept", text: editing && text !== proposal.after ? text : undefined },
      { onSuccess: () => toast.show(t("agentPage.memory.accepted")), onError },
    );
  const refuse = () =>
    decide.mutate(
      { id: proposal.id, decision: "refuse" },
      { onSuccess: () => toast.show(t("agentPage.memory.refused", g)), onError },
    );
  const canDecide = proposal.canDecide && !proposal.stale;
  return (
    <Card as="article" className="agp-card agp-prop" aria-labelledby={`prop-${proposal.id}`}>
      <CardHeader
        id={`prop-${proposal.id}`}
        icon="document"
        title={proposalTitle(t, proposal, org, () => agent.name)}
        action={
          proposal.stale ? (
            <Chip icon="close">{t("proposals.stale")}</Chip>
          ) : (
            <Chip icon="waiting" tone="waiting">
              {proposal.canDecide
                ? t("approval.waitingYou")
                : proposal.decider.type === "user"
                  ? t("proposals.waitingFor", { name: proposal.decider.name })
                  : t("proposals.waitingAdmin")}
            </Chip>
          )
        }
      />
      <p className="agp-why">
        <b>{t("proposals.why")}:</b> {proposalWhy(t, proposal)}
      </p>
      {editing ? (
        <Locked when={decide.isPending || stale || proposal.stale}>
          <Field label={t("proposals.finalText")} id={`prop-edit-${proposal.id}`}>
            <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </Locked>
      ) : (
        <Diff
          aria-label={t("proposals.changeLabel")}
          addedLabel={t("proposals.added")}
          removedLabel={t("proposals.removed")}
          lines={diffLines(proposal.before.split("\n"), proposal.after.split("\n"))}
        />
      )}
      {(stale || proposal.stale) && <Alert>{t("proposals.staleNote")}</Alert>}
      {canDecide && !stale ? (
        <>
          <div className="agp-row">
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={decide.isPending || !text.trim()}
              onClick={accept}
            >
              {editing ? t("proposals.acceptEdited") : t("proposals.accept")}
            </Button>
            {proposal.target.type !== "skill" && (
              <Button size="sm" icon="edit" disabled={decide.isPending} onClick={() => setEditing((v) => !v)}>
                {editing ? t("proposals.viewDiff") : t("proposals.editFirst")}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={refuse}>
              {t("proposals.refuse")}
            </Button>
          </div>
          <span className="small muted">{t("proposals.refuseNote", g)}</span>
        </>
      ) : (
        !proposal.canDecide && (
          <span className="small muted">
            {proposal.decider.type === "user"
              ? t("agentPage.memory.decides", { who: proposal.decider.name })
              : t("agentPage.memory.adminDecides")}
          </span>
        )
      )}
    </Card>
  );
}

/** A memory's trust in a chip: from outside, verified (a person or an outcome), or not yet. */
function TrustChip({ m }: { m: Memory }) {
  const { t } = useTranslation();
  if (m.lowTrust)
    return (
      <Chip icon="alert" tone="waiting">
        {t("memory.lowTrust")}
      </Chip>
    );
  return m.verified ? (
    <Chip icon="check">{t("memory.verified")}</Chip>
  ) : (
    <Chip icon="info">{t("memory.unverified")}</Chip>
  );
}

/**
 * One thing it learned (Aprendizados): its plain summary first, the technical detail folded under it; where, how
 * sure, how used; Editar (a person's version) or Esquecer.
 */
function LearnedRow({ m }: { m: Memory }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const act = useMemoryAction(org.id, agent.id);
  const [draft, setDraft] = useState<string | null>(null);
  const save = () =>
    draft !== null &&
    act.mutate(
      { type: "edit", id: m.id, text: draft },
      {
        onSuccess: () => {
          setDraft(null);
          toast.show(t("agentPage.memory.saved"));
        },
      },
    );
  return (
    <li className="agp-mem" data-item-id={m.id}>
      {draft === null ? (
        m.summary ? (
          <>
            <span>{inlineWords(m.summary)}</span>
            <details className="agp-mem__details">
              <summary className="small muted">{t("agentPage.memory.details")}</summary>
              <p className="small">{memoryLine(t, m)}</p>
            </details>
          </>
        ) : (
          <span>{memoryLine(t, m)}</span>
        )
      ) : (
        <Locked when={act.isPending}>
          <Field label={t("agentPage.memory.edit")} id={`learned-${m.id}`}>
            <Textarea rows={3} maxLength={8000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
        </Locked>
      )}
      <span className="agp-chips">
        {m.howTo ? (
          <Chip icon="book">{t("agentPage.memory.howTo")}</Chip>
        ) : (
          <Chip icon={KIND_ICON[m.kind]}>{t(`memory.kinds.${m.kind}`)}</Chip>
        )}
        <TrustChip m={m} />
        {m.disputed && (
          <Chip icon="alert" tone="waiting">
            {t("agentPage.memory.disputed")}
          </Chip>
        )}
        <span className="small muted">
          {usageLabel(t, m)} ·{" "}
          {m.channelId ? (
            <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: m.channelId }}>
              {memorySource(t, i18n.language, m)}
            </Link>
          ) : (
            memorySource(t, i18n.language, m)
          )}
        </span>
      </span>
      <span className="agp-row">
        {draft === null ? (
          <>
            {(m.lowTrust || !m.verified) && (
              <Button
                size="sm"
                variant="ghost"
                icon="check"
                title={t("memory.confirmTitle")}
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ type: "confirm", id: m.id }, { onSuccess: () => toast.show(t("memory.confirmed")) })
                }
              >
                {t("memory.confirm")}
              </Button>
            )}
            {/* Tornar do time (ADR 0167): who reviews memory makes it every agent's, its copies archived. */}
            {can(org, "review_memory") && !m.howTo && !m.playbook && m.kind !== "lesson" && (
              <Button
                size="sm"
                variant="ghost"
                icon="members"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ type: "team", id: m.id }, { onSuccess: () => toast.show(t("teamMemory.made")) })
                }
              >
                {t("teamMemory.make")}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon="edit" onClick={() => setDraft(m.text)}>
              {t("agentPage.memory.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { type: "archive", id: m.id, archived: true },
                  { onSuccess: () => toast.show(t("agentPage.memory.forgotten")) },
                )
              }
            >
              {t("agentPage.memory.forget")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={!draft.trim()} loading={act.isPending} onClick={save}>
              {t("agentPage.memory.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t("agentPage.memory.cancel")}
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

/** A skill it made from its how-tos: Ver, Desfazer última mudança, Travar, Dar a outros agentes (Skills), Restaurar. */
function LearnedSkillRow({ s }: { s: LearnedSkill }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const act = useSkillAction(org.id);
  const [open, setOpen] = useState(false);
  return (
    <li className="agp-mem" data-item-id={s.id}>
      <span>
        <b>{s.name}</b> · {s.description}
      </span>
      <span className="agp-chips">
        <Chip icon="book">{t("agentPage.memory.howTo")}</Chip>
        {s.locked && <Chip icon="lock">{t("agentPage.memory.locked")}</Chip>}
        {s.archived && <Chip icon="close">{t("agentPage.memory.archivedSkill")}</Chip>}
        <span className="small muted">{t("agentPage.memory.skillUses", { count: s.useCount ?? 0 })}</span>
      </span>
      {open && <pre className="agp-skill-body">{s.body}</pre>}
      <span className="agp-row">
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? t("agentPage.memory.hide") : t("agentPage.memory.view")}
        </Button>
        {!s.canChange ? null : s.archived ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={act.isPending}
            onClick={() => act.mutate({ type: "restore", id: s.id })}
          >
            {t("agentPage.memory.restore")}
          </Button>
        ) : (
          <>
            {s.canRevert && (
              <Button
                size="sm"
                variant="ghost"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate(
                    { type: "revert", id: s.id },
                    { onSuccess: () => toast.show(t("agentPage.memory.undone")) },
                  )
                }
              >
                {t("agentPage.memory.undoChange")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={act.isPending}
              onClick={() => act.mutate({ type: "update", id: s.id, patch: { locked: !s.locked } })}
            >
              {s.locked ? t("agentPage.memory.unlock") : t("agentPage.memory.lock")}
            </Button>
            {/* Skills is for who manages agents: an owner without it turns the skill on in each agent's own page. */}
            {can(org, "manage_agents") && (
              <Link
                className="agp-more"
                to="/org/$orgId/settings/$section"
                params={{ orgId: org.id, section: "skills" }}
                search={{ skill: s.id }}
              >
                {t("agentPage.memory.share")}
              </Link>
            )}
          </>
        )}
      </span>
    </li>
  );
}

/** Rules people gave it (who, when, the text), each with Remover for its giver, the agent's owner and admins. */
function RulesCard({ rules }: { rules: Memory[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const act = useMemoryAction(org.id, agent.id);
  return (
    <Card as="section" className="agp-card" aria-labelledby="mem-rules">
      <CardHead
        id="mem-rules"
        icon="flag"
        title={t("agentPage.memory.rules")}
        subtitle={t("agentPage.memory.rulesNote")}
      />
      <ul className="agp-list agp-mems">
        {rules.map((m) => (
          <li key={m.id} className="agp-mem" data-item-id={m.id}>
            <span>{memoryLine(t, m)}</span>
            <span className="agp-chips">
              <span className="small muted">
                {t("agentPage.memory.ruleBy", {
                  name: m.origin?.name ?? t("memory.origin.someone"),
                  date: formatShortDate(i18n.language, m.origin?.at ?? m.updatedAt),
                })}
              </span>
            </span>
            {m.removable && (
              <span className="agp-row">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate(
                      { type: "archive", id: m.id, archived: true },
                      { onSuccess: () => toast.show(t("agentPage.memory.ruleRemoved")) },
                    )
                  }
                >
                  {t("agentPage.memory.removeRule")}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * What the agent learned on its own, newest first: what matters to people (preferences, facts, decisions), then how
 * it works (its playbook: how-tos, lessons and notes it keeps for itself, none of them in the chat) and the skills it
 * made.
 */
function LearnedList({ list }: { list: Memory[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g } = useAgentEdit();
  const skills = useLearnedSkills(org.id, agent.id).data ?? [];
  if (list.length === 0 && skills.length === 0)
    return (
      <EmptyState
        size="panel"
        agent={lookOf(agent) ?? true}
        title={t("agentPage.memory.learnedEmptyTitle")}
        actions={<AskAgentButton agent={agent} variant="primary" />}
      >
        {t("agentPage.memory.learnedEmpty")}
      </EmptyState>
    );
  const people = list.filter((m) => !m.playbook);
  const playbook = list.filter((m) => m.playbook);
  const how = t("agentPage.memory.playbook", g);
  return (
    <div className="ac-groups">
      {people.length > 0 && (
        <ul className="agp-list agp-mems">
          {people.map((m) => (
            <LearnedRow key={m.id} m={m} />
          ))}
        </ul>
      )}
      {playbook.length > 0 && (
        <div>
          <GroupHeading
            level={3}
            title={
              <span className="ac-hintline">
                <span>{how}</span>
                <InfoHint name={t("common.about", { label: how })}>{t("agentPage.memory.playbookNote")}</InfoHint>
              </span>
            }
          />
          <ul className="agp-list agp-mems" aria-label={how}>
            {playbook.map((m) => (
              <LearnedRow key={m.id} m={m} />
            ))}
          </ul>
        </div>
      )}
      {skills.length > 0 && (
        <div>
          <GroupHeading level={3} title={t("agentPage.memory.skills")} />
          <ul className="agp-list agp-mems">
            {skills.map((s) => (
              <LearnedSkillRow key={s.id} s={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Memória: proposals waiting, then what the agent knows (facts and decisions, lessons, archived) with search. `item`:
 * the memory or skill a link opened it at.
 */
export function MemoryTab({ item }: { item?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, g } = useAgentEdit();
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const skills = useLearnedSkills(org.id, agent.id).data ?? [];
  const [picked, setKind] = useState<Kind | "learned" | null>(null);
  const [q, setQ] = useState("");
  const list = memory.data ?? [];
  // What a link named: its list shows until the person picks one, and it is landed on. What the agent learned goes
  // to Aprendizados, where it is edited or forgotten.
  const linked = list.find((m) => m.id === item);
  const linkedSkill = skills.some((s) => s.id === item);
  const linkedKind = linked?.learned && !linked.archived ? "learned" : linked ? memoryTabOf(linked) : null;
  const kind = picked ?? linkedKind ?? (linkedSkill ? "learned" : "known");
  const cols = useRef<HTMLDivElement>(null);
  useLandOn(cols, item, Boolean(linked) || linkedSkill);
  const pending = pendingOnAgent(proposals.data ?? [], agent.id);
  const learned = list
    .filter(
      (m) =>
        m.learned &&
        !m.archived &&
        (!q.trim() || `${m.summary ?? ""} ${m.text}`.toLowerCase().includes(q.trim().toLowerCase())),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = (k: Kind | "learned") =>
    k === "learned" ? list.filter((m) => m.learned && !m.archived).length : filterMemories(list, k, "").length;
  const shown = kind === "learned" ? [] : filterMemories(list, kind, q);
  const rules = list.filter((m) => m.kind === "rule" && !m.archived);
  return (
    <>
      <section className="agp-workcard" aria-label={t("agentPage.memory.counts")}>
        <div className="agp-cells">
          <Cell
            icon={<Icon name="book" size={16} />}
            label={t("memory.tabs.known")}
            value={count("known")}
            sub={t("agentPage.memory.verified", { count: list.filter((m) => !m.archived && m.verified).length })}
          />
          <Cell
            icon={<Icon name="agent" size={16} />}
            label={t("agentPage.memory.lessons")}
            value={count("lessons")}
            sub={t("agentPage.memory.fromTeam")}
          />
          <Cell
            icon={<Icon name="document" size={16} />}
            label={t("agentPage.memory.proposals")}
            value={pending.length}
            sub={pending.length ? t("agentPage.memory.waiting") : t("agentPage.memory.noneWaiting")}
          />
        </div>
      </section>
      <div className="agp-cols" ref={cols}>
        <div className="agp-col">
          {pending.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
          {rules.length > 0 && <RulesCard rules={rules} />}
          <Card as="section" className="agp-card" aria-labelledby="mem-known">
            <CardHead
              id="mem-known"
              icon="book"
              title={t("memory.title", g)}
              action={
                <Link
                  className="agp-more"
                  to="/org/$orgId/agents/$agentId/memory"
                  params={{ orgId: org.id, agentId: agent.id }}
                >
                  {t("agentPage.memory.full")}
                  <Icon name="arrowRight" size={14} />
                </Link>
              }
            />
            <Toolbar
              size="sm"
              search={
                <SearchField
                  size="sm"
                  aria-label={t("memory.search")}
                  placeholder={t("memory.searchPlaceholder", g)}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onClear={() => setQ("")}
                  clearLabel={t("filters.clearSearch")}
                />
              }
            >
              <Segmented
                size="sm"
                label={t("memory.tabsLabel")}
                value={kind}
                onValueChange={setKind}
                options={(["known", "lessons", "learned", "archived"] as const).map((k) => ({
                  value: k,
                  label: t(
                    k === "lessons"
                      ? "agentPage.memory.lessons"
                      : k === "learned"
                        ? "agentPage.memory.learned"
                        : `memory.tabs.${k}`,
                  ),
                  count: count(k),
                }))}
              />
            </Toolbar>
            {memory.isLoading ? (
              <LoadingLine width={260} />
            ) : memory.isError && !memory.data ? (
              <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
            ) : kind === "learned" ? (
              <LearnedList list={learned} />
            ) : shown.length === 0 ? (
              <NoMemories agent={agent} q={q} none={list.length === 0} onClear={() => setQ("")} />
            ) : (
              <ul className="agp-list agp-mems">
                {shown.map((m) => (
                  <li key={m.id} className="agp-mem" data-item-id={m.id}>
                    <span>{memoryLine(t, m)}</span>
                    <span className="agp-chips">
                      <Chip icon={KIND_ICON[m.kind]}>{t(`memory.kinds.${m.kind}`)}</Chip>
                      <TrustChip m={m} />
                      {m.pinned && <Chip icon="pin">{t("memory.pinned")}</Chip>}
                      <span className="small muted">
                        {usageLabel(t, m)} · {memorySource(t, i18n.language, m)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="agp-col">
          <p className="page__note">
            <HelpLink slug="memory">{t("memory.how")}</HelpLink>
          </p>
        </div>
      </div>
    </>
  );
}
