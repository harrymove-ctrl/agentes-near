import type { Proposal } from "@agenteschat/client";
import { ApiError, useDecideProposal, useDecideProposals, useProposals } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  isOpen,
  proposalTarget,
  proposalTitle,
  proposalWhy,
  proposerOf,
  sortProposals,
  staleCount,
} from "@agenteschat/client/lib/proposals";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Alert,
  Button,
  Card,
  Chip,
  diffLines,
  EmptyState,
  Field,
  Icon,
  Locked,
  PageHeader,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ApprovalsTabs } from "@/components/ApprovalsTabs";
import { isText, SettingChange } from "@/components/ChatCards";
import { useOrg } from "@/components/org-context";
import { ProseDiff } from "@/components/ProseDiff";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";

/** Proposals: list + detail with evidence and a neutral before/after diff. */
export function ProposalsPage({ agentId }: { agentId?: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const look = useRightHandLook();
  const dir = useDirectory(org.id);
  const proposals = useProposals(org.id);
  const decide = useDecideProposal(org.id);
  const [selected, setSelected] = useState<string | null>(null);
  // A stale row asks nothing of anyone and repeats what newer rows say: only the one open here stays, with its note.
  const list = useMemo(
    () => sortProposals((proposals.data ?? []).filter((p) => !p.stale || p.id === selected)),
    [proposals.data, selected],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [staleError, setStaleError] = useState<string | null>(null);
  const toast = useToast();
  const onDecideError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409)
      setStaleError(t(current && !isText(current) ? "proposals.staleErrorAgent" : "proposals.staleError"));
    else toast.show(errorText(t, error, i18n.language), "error");
  };

  const preferred = list.find((p) => p.agentId === agentId && p.status === "pending") ?? list[0];
  const current = list.find((p) => p.id === selected) ?? preferred;
  // Pin the initial choice so deciding doesn't jump to another proposal.
  useEffect(() => {
    if (!selected && preferred) setSelected(preferred.id);
  }, [selected, preferred]);
  // Switching proposals (or a new version of one) resets the editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the proposal id on purpose
  useEffect(() => {
    setStaleError(null);
    setEditing(false);
    setDraft(current?.after ?? "");
  }, [current?.id, current?.after]);

  const backAgent = agentId ? dir.agentById.get(agentId) : undefined;
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const targetLabel = (p: Proposal) => proposalTarget(t, p, agentName, org);
  const tt = t as unknown as (key: string, options: Record<string, string>) => string;
  const titleOf = (p: Proposal) => proposalTitle(t, p, org, agentName);
  const whereOf = (e: Proposal["evidence"][number]) =>
    e.type ? tt(`proposals.evidence.${e.type}`, { defaultValue: e.where }) : e.where;
  const statusText = (p: Proposal) =>
    p.stale
      ? t("proposals.stale")
      : p.status === "pending"
        ? p.canDecide
          ? t("approval.waitingYou")
          : p.decider.type === "user"
            ? t("proposals.waitingFor", { name: p.decider.name })
            : t("proposals.waitingAdmin")
        : p.status === "accepted"
          ? t("proposals.accepted")
          : t("proposals.refused");
  const decisionText = (p: Proposal) => {
    const when = p.decidedAt ? whenAt(t, i18n.language, p.decidedAt) : t("common.now");
    const mine = p.decidedBy?.userId === me.user.id;
    const name = p.decidedBy?.name ?? "";
    if (p.status === "accepted")
      return mine ? t("proposals.acceptedByYou", { when }) : t("proposals.acceptedBy", { name, when });
    return mine ? t("proposals.refusedByYou", { when }) : t("proposals.refusedBy", { name, when });
  };

  return (
    <div className="page page--full">
      {backAgent && (
        <Link
          to="/org/$orgId/agents/$agentId/memory"
          params={{ orgId: org.id, agentId: backAgent.id }}
          className="ac-back"
        >
          <Icon name="chevronLeft" />
          {t("memory.title", agentGrammar(backAgent.name))}
        </Link>
      )}
      <PageHeader title={t("approvals.title")} meta={t(modeKey(org, "proposals.subtitle"), { org: org.name })} />
      <ApprovalsTabs value="proposals" actions={<DecideAll proposals={list} />} />

      {proposals.isSuccess && list.length === 0 && (
        <EmptyState size="page" agent={look} mood="deal" title={t("proposals.emptyTitle")}>
          {t("proposals.empty")}
        </EmptyState>
      )}

      {current && (
        <div className="proposals page-split">
          <nav className="proposals__list" data-scroll-restoration-id="proposals-list" aria-label={t("proposals.list")}>
            {list.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ac-navcard"
                aria-current={p.id === current.id ? "true" : undefined}
                onClick={() => setSelected(p.id)}
              >
                <span className="row">
                  <AgentAvatar agentId={proposerOf(p)} size="sm" name={agentName(proposerOf(p))} />
                  <span style={{ fontWeight: 600 }}>{agentName(proposerOf(p))}</span>
                  <span className="small muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                    {relativeTime(t, i18n.language, p.createdAt)}
                  </span>
                </span>
                <span style={{ fontSize: 14, lineHeight: "20px" }}>{titleOf(p)}</span>
                <span className="muted" style={{ fontSize: 12, lineHeight: "16px" }}>
                  {statusText(p)}
                </span>
              </button>
            ))}
          </nav>

          <Card
            as="article"
            className="proposals__detail"
            data-scroll-restoration-id="proposals-detail"
            aria-labelledby="prop-title"
          >
            <div className="row">
              <AgentAvatar agentId={proposerOf(current)} size="sm" name={agentName(proposerOf(current))} />
              <span className="small muted">
                <Trans
                  i18nKey="proposals.proposes"
                  values={{ agent: agentName(proposerOf(current)), target: targetLabel(current) }}
                  components={{ b: <b style={{ color: "var(--ink)" }} /> }}
                />
              </span>
              {current.stale ? (
                <Chip icon="close">{t("proposals.stale")}</Chip>
              ) : current.status === "pending" ? (
                <Chip icon="waiting" tone="waiting">
                  {statusText(current)}
                </Chip>
              ) : current.status === "accepted" ? (
                <Chip icon="check" tone="done">
                  {decisionText(current)}
                </Chip>
              ) : (
                <Chip icon="close">{decisionText(current)}</Chip>
              )}
            </div>
            <h2 id="prop-title" className="ac-card__title">
              {titleOf(current)}
            </h2>

            <section aria-label={t("proposals.why")} className="section section--tight">
              <span className="ac-eyebrow">{t("proposals.why")}</span>
              <p style={{ margin: 0 }}>{proposalWhy(t, current)}</p>
              <ul className="evidence">
                {current.evidence.map((e) => (
                  <li key={`${e.where}-${e.what}`} className="ac-iconline">
                    <Icon name="message" size={16} />
                    <span>
                      {whereOf(e)} <span className="muted">· {e.what}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label={t("proposals.changeLabel")} className="section section--tight">
              <div className="ac-actline proposal-change__head">
                <span className="ac-eyebrow">{t("proposals.change", { target: targetLabel(current) })}</span>
                {current.status === "pending" && current.canDecide && isText(current) && (
                  <span className="ac-acts">
                    <Button variant="ghost" size="sm" disabled={decide.isPending} onClick={() => setEditing((v) => !v)}>
                      {editing ? t("proposals.viewDiff") : t("proposals.editFirst")}
                    </Button>
                  </span>
                )}
              </div>
              {!isText(current) && current.target.type !== "skill" ? (
                <SettingChange p={current} />
              ) : editing && current.status === "pending" ? (
                <Field
                  label={
                    current.target.type === "org_context" ? t("proposals.finalTextContext") : t("proposals.finalText")
                  }
                  id="prop-edit"
                >
                  <Locked when={decide.isPending || current.stale}>
                    <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  </Locked>
                </Field>
              ) : (
                <ProseDiff
                  label={t("proposals.changeLabel")}
                  lines={diffLines(current.before.split("\n"), (editing ? draft : current.after).split("\n"))}
                />
              )}
            </section>

            {staleError && <Alert>{staleError}</Alert>}
            {current.stale && (
              <p className="small muted" style={{ margin: 0 }}>
                {t(isText(current) ? "proposals.staleNote" : "proposals.staleNoteAgent")}
              </p>
            )}
            {current.status === "pending" && current.canDecide && !current.stale && (
              <div className="proposals__actions">
                <Button
                  variant="primary"
                  disabled={decide.isPending || (isText(current) && !draft.trim())}
                  onClick={() =>
                    decide.mutate(
                      {
                        id: current.id,
                        decision: "accept",
                        text: editing && draft !== current.after ? draft : undefined,
                      },
                      { onError: onDecideError },
                    )
                  }
                >
                  {editing ? t("proposals.acceptEdited") : t("proposals.accept")}
                </Button>
                <Button
                  disabled={decide.isPending}
                  loading={decide.isPending && decide.variables?.decision === "refuse"}
                  onClick={() => decide.mutate({ id: current.id, decision: "refuse" }, { onError: onDecideError })}
                >
                  {t("proposals.refuse")}
                </Button>
                <span className="small muted" style={{ flex: "1 1 200px" }}>
                  {t("proposals.refuseNote", agentGrammar(agentName(proposerOf(current))))}
                </span>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * "Aceitar todas" / "Recusar todas", small, at the tabs' right: the waiting proposals this person may decide, two or
 * more. A press asks once in the same spot, then decides them oldest first, each on its own, so one gone stale never
 * stops the rest, and says which didn't go.
 */
function DecideAll({ proposals }: { proposals: Proposal[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideProposals(org.id);
  const toast = useToast();
  const [asking, setAsking] = useState<"accept" | "refuse" | null>(null);
  const open = proposals.filter((p) => isOpen(p) && p.canDecide).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (open.length < 2) return null;
  const count = open.length;
  const run = (decision: "accept" | "refuse") => {
    setAsking(null);
    decide.mutate(
      { ids: open.map((p) => p.id), decision },
      {
        onSuccess: ({ failed }) => {
          const stale = staleCount(failed);
          const agentRows = failed.some((f) => open.find((p) => p.id === f.id && !isText(p)));
          if (stale > 0)
            toast.show(t(agentRows ? "proposals.staleSomeAgent" : "proposals.staleSome", { count: stale }), "error");
          if (failed.length > stale) toast.show(errorText(t, failed[0]?.error, i18n.language), "error");
        },
      },
    );
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of buttons, not form fields
    <div className="proposals-all" role="group" aria-label={t("proposals.all.label")}>
      {asking ? (
        <>
          <span className="proposals-all__ask">
            {t(asking === "accept" ? "proposals.all.acceptAsk" : "proposals.all.refuseAsk", { count })}
          </span>
          <Button size="sm" variant="primary" onClick={() => run(asking)}>
            {t(asking === "accept" ? "proposals.all.acceptGo" : "proposals.all.refuseGo", { count })}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
            {t("common.cancel")}
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            disabled={decide.isPending}
            loading={decide.isPending && decide.variables?.decision === "accept"}
            onClick={() => setAsking("accept")}
          >
            {t("proposals.all.accept")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            loading={decide.isPending && decide.variables?.decision === "refuse"}
            onClick={() => setAsking("refuse")}
          >
            {t("proposals.all.refuse")}
          </Button>
        </>
      )}
    </div>
  );
}
