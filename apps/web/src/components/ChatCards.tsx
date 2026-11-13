import type { AgentQuestion, MemoryUpdate, Proposal, SecretRequest, SecretToVaultInput } from "@agenteschat/client";
import {
  useCardProposals,
  useDecideProposal,
  useDecideProposals,
  useModelLabel,
  useSaveSecretToVault,
} from "@agenteschat/client";
import { questionWaitsOn } from "@agenteschat/client/lib/agent-questions";
import { formatTime, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { can } from "@agenteschat/client/lib/permissions";
import {
  appLabel,
  cardHead,
  cardOutcome,
  cardProposalIds,
  chosenRows,
  firstChange,
  isOpen,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposerOf,
  rowStatus,
  settingLineText,
  staleCount,
} from "@agenteschat/client/lib/proposals";
import { sealSecret, secretAad } from "@agenteschat/client/lib/secret-box";
import {
  latestSecret,
  secretClosedBy,
  secretLabel,
  secretRefusalKey,
  secretValueProblem,
  secretWhere,
} from "@agenteschat/client/lib/secret-requests";
import { secretEndedAt, secretOutcome } from "@agenteschat/client/lib/secret-words";
import {
  Button,
  Chip,
  CodeInput,
  diffLines,
  EventPillAction,
  Field,
  Icon,
  Input,
  MessageText,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { inPlaceClick } from "@/lib/navigate";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";
import { AgentAvatar } from "./AgentAvatar";
import { useOpenAgentPanel } from "./agent-panel-context";
import { SiteIcon } from "./browser/SiteIcon";
import { useOrg } from "./org-context";
import { ProseDiff } from "./ProseDiff";
import {
  RequestCard,
  RequestChoices,
  RequestDone,
  RequestKeys,
  RequestTile,
  showRequest,
  useExpired,
} from "./RequestCard";
import { savesToVault, VaultSaveBlock, type VaultSaveChoice, vaultSaveDefaults } from "./vault/VaultSave";
import "./proposals.css";

/** How long a failed "Save to the Vault" keeps the typed value for Retry (ADR 0144), at most. */
const VAULT_RETRY_MS = 2 * 60_000;

/** The host of a site the request names (`https://host`), or null. */
const hostOf = (site: string | null | undefined) => {
  if (!site) return null;
  try {
    return new URL(site).host || null;
  } catch {
    return null;
  }
};

/**
 * "Memória atualizada" in the chat (`memory.updated`): what the agent
 * remembered, forgot or updated because a person asked, a link to what it
 * knows (its page's Memória tab in the panel beside the conversation), and "Desfazer"
 * (`POST …/memories/{id}/revert`) for who may still undo it. A proposed change shows the proposal inline instead.
 */
export function MemoryChangeCard({ update, agentId }: { update: MemoryUpdate; agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const openPanel = useOpenAgentPanel();
  if (update.action === "proposed") {
    const ids = cardProposalIds(update);
    if (ids.length > 1) return <ProposalGroup proposalIds={ids} />;
    return ids[0] ? <InlineProposal proposalId={ids[0]} /> : null;
  }
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className="ac-approval ac-approval--done ac-memory-card"
      role="group"
      aria-label={t("memoryCard.group", { name })}
    >
      <div className="ac-approval__head">
        <span className="ac-approval__who">
          <b>{t(`memoryCard.${update.action}`, { name })}</b>
        </span>
        <Chip icon="check">{t("memoryCard.chip")}</Chip>
      </div>
      <p className={update.action === "forgot" ? "ac-approval__title struck" : "ac-approval__title"}>{update.text}</p>
      {update.action === "updated" && update.previousText && (
        <p className="small muted" style={{ margin: 0 }}>
          {t("memoryCard.was", { text: update.previousText })}
        </p>
      )}
      {/* The memory itself, where it is fixed or forgotten. */}
      <div className="ac-approval__actions ac-acts">
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/org/$orgId/agents/$agentId/memory"
            params={{ orgId: org.id, agentId }}
            search={{ item: update.itemId }}
            onClick={openPanel ? (e) => inPlaceClick(e, () => openPanel(agentId, "memory", update.itemId)) : undefined}
          >
            {t("memoryCard.open", g)}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** What a role or access proposal changes: "Papel: Dev → Revisora", or a chip per app turned on or off. */
export function SettingChange({ p }: { p: Proposal }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const modelLabel = useModelLabel();
  if (p.target.type === "agent_role")
    return <span className="proposal-change">{t("proposals.roleLine", { from: p.before, to: p.after })}</span>;
  // The right hand's settings (ADR 0137): "Modelo: Haiku → Sonnet", a line each.
  if (p.target.type === "agent_settings")
    return (
      <span className="proposal-change">
        {(p.settings ?? [])
          .map((l) => {
            const line = settingLineText(t, i18n.language, l, {
              model: (id) => modelLabel(id) ?? id,
              person: (id) => dir.memberById.get(id)?.name,
              channel: () => undefined,
              role: dir.roleName,
            });
            return `${line.field}: ${line.from} → ${line.to}`;
          })
          .join(" · ")}
      </span>
    );
  return (
    <span className="proposal-change proposal-change--apps">
      {(p.access ?? []).map((l) => (
        <Chip key={l.id} icon={l.on ? "plus" : "dash"}>
          {t(l.on ? "proposals.accessOn" : "proposals.accessOff", { app: appLabel(t, l) })}
        </Chip>
      ))}
    </span>
  );
}

export const isText = (p: Proposal) => p.target.type === "agent_instructions" || p.target.type === "org_context";
/** What shows a diff: a text, or a skill's, which is taken as proposed (it has no Editar). */
const hasDiff = (p: Proposal) => isText(p) || p.target.type === "skill";

/**
 * A proposal the agent made in the chat (`message.meta.proposalId`, or a card of one): the Propostas diff with
 * Aceitar / Editar / Recusar; a role or an app is taken as proposed, so it has no Editar.
 */
export function InlineProposal({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [p] = useCardProposals(org.id, [proposalId]);
  const decide = useDecideProposal(org.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  if (!p) return null;
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const name = agentName(proposerOf(p));
  const target = proposalTarget(t, p, agentName, org);
  const text = draft ?? p.after;
  const pending = p.status === "pending" && !p.stale;
  const onError = (e: unknown) =>
    toast.show(
      e instanceof Error && "status" in e && e.status === 409
        ? t(isText(p) ? "proposals.staleError" : "proposals.staleErrorAgent")
        : t("common.unknownError"),
      "error",
    );
  const edited = draft !== null && draft !== p.after;
  const diff = (
    <ProseDiff label={t("proposals.changeLabel")} lines={diffLines(p.before.split("\n"), text.split("\n"))} />
  );

  // Waiting: a request card, the change behind "Ver a mudança" (a text is edited there before accepting).
  if (pending) {
    const before = new Set(p.before.split("\n"));
    const firstNew = hasDiff(p)
      ? p.after
          .split("\n")
          .find((line) => line.trim() && !before.has(line))
          ?.trim()
      : undefined;
    return (
      <RequestCard
        id={p.id}
        kind="proposal"
        agent={dir.anyAgent(proposerOf(p))}
        label={t("inlineProposal.group", { name })}
        mine={p.canDecide}
        waitingFor={rowStatus(t, p) ?? undefined}
        lead={proposalTitle(t, p, org, agentName)}
        object={{
          logo: (
            <RequestTile>
              <Icon name={p.target.type === "agent_access" ? "layers" : "file"} size={16} />
            </RequestTile>
          ),
          title: target,
          detail: p.target.type === "agent_role" ? t("proposals.roleLine", { from: p.before, to: p.after }) : firstNew,
          ...(hasDiff(p) ? { more: t("ask.seeChange") } : {}),
        }}
        details={
          hasDiff(p) ? (
            <>
              {editing ? (
                <Field label={t("proposals.finalText")} id={`inline-prop-${p.id}`}>
                  <Textarea rows={6} value={text} onChange={(e) => setDraft(e.target.value)} />
                </Field>
              ) : (
                diff
              )}
              <div className="ac-acts">
                {p.canDecide && isText(p) && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                    {editing ? t("proposals.viewDiff") : t("inlineProposal.edit")}
                  </Button>
                )}
                <ProposalsLink agentId={p.agentId} />
              </div>
            </>
          ) : undefined
        }
        // A new role reads in the well; the apps are chips, under it. Neither has anything to open.
        body={
          p.target.type === "agent_access" ? (
            <div className="rq__field">
              <SettingChange p={p} />
            </div>
          ) : undefined
        }
        actions={
          p.canDecide ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={decide.isPending || (isText(p) && !text.trim())}
                loading={decide.isPending && decide.variables?.decision === "accept"}
                onClick={() =>
                  decide.mutate(
                    { id: p.id, decision: "accept", text: edited ? (draft ?? undefined) : undefined },
                    { onError },
                  )
                }
              >
                {edited ? t("proposals.acceptEdited") : t("proposals.accept")}
              </Button>
              <Button
                size="sm"
                disabled={decide.isPending}
                loading={decide.isPending && decide.variables?.decision === "refuse"}
                onClick={() => decide.mutate({ id: p.id, decision: "refuse" }, { onError })}
              >
                {t("proposals.refuse")}
              </Button>
            </>
          ) : undefined
        }
        what={target}
        locked={decide.isPending}
      />
    );
  }

  // Decided, or overtaken by a newer text: one line, the change as it was behind "Ver a mudança".
  return (
    <ProposalDone
      label={t("inlineProposal.group", { name })}
      what={<b>{proposalTitle(t, p, org, agentName)}</b>}
      rows={[p]}
    >
      {hasDiff(p) ? diff : <SettingChange p={p} />}
      <div className="ac-acts">
        <ProposalsLink agentId={p.agentId} />
      </div>
    </ProposalDone>
  );
}

/** A decided proposal's line: what it was, how it ended and when the last row was decided; the rest when asked for. */
function ProposalDone({
  label,
  what,
  rows,
  children,
}: {
  label: string;
  what: ReactNode;
  rows: Proposal[];
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const outcome = cardOutcome(t, rows);
  // A row overtaken by a newer text was never decided.
  const at = rows
    .flatMap((p) => p.decidedAt ?? [])
    .sort()
    .at(-1);
  return (
    <RequestDone
      done={outcome.accepted}
      label={label}
      more={{ label: t("ask.seeChange"), content: children }}
      time={at ? whenAt(t, i18n.language, at) : undefined}
    >
      {outcome.label}: {what}
    </RequestDone>
  );
}

function ProposalsLink({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: agentId }}>
        {t("inlineProposal.open")}
      </Link>
    </Button>
  );
}

/**
 * One change proposed for several agents (or several changes for one): each change shown once, then a row per
 * agent and kind of change with its switch, and "Aceitar para todos" / "Aceitar para N" and Recusar on the rows
 * the viewer may decide and left on. Each row applies on its own, so one that went stale never stops the rest.
 */
export function ProposalGroup({ proposalIds }: { proposalIds: string[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const rows = useCardProposals(org.id, proposalIds);
  const decide = useDecideProposals(org.id);
  const toast = useToast();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [first] = rows;
  if (!first) return null;
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const proposer = agentName(proposerOf(first));
  const head = cardHead(t, rows, proposer, agentName, org);
  const agents = new Set(rows.map((p) => p.agentId)).size;
  const { chosen, all } = chosenRows(rows, off);
  const decides = rows.some((p) => isOpen(p) && p.canDecide);
  const toggle = (id: string, on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = (decision: "accept" | "refuse") =>
    decide.mutate(
      { ids: chosen.map((p) => p.id), decision },
      {
        onSuccess: ({ failed }) => {
          const stale = staleCount(failed);
          const agentRows = failed.some((f) => rows.find((p) => p.id === f.id && !isText(p)));
          if (stale > 0)
            toast.show(t(agentRows ? "proposals.staleSomeAgent" : "proposals.staleSome", { count: stale }), "error");
          if (failed.length > stale) toast.show(t("common.unknownError"), "error");
        },
      },
    );

  const label = t("inlineProposal.groupMany", { name: proposer, count: agents });
  const who = <Trans i18nKey={head.key} values={head.values} components={{ b: <b /> }} {...TYPED_VALUES} />;
  const rowList = (list: Proposal[]) => (
    <ul className="proposal-rows">
      {list.map((p) => {
        const name = p.target.type === "org_context" ? org.name : agentName(p.agentId);
        const status = rowStatus(t, p);
        return (
          <li key={p.id} className="proposal-row ac-mediarow ac-mediarow--row">
            <span className="ac-mediarow__face">
              {p.target.type === "org_context" ? (
                <Icon name="layers" size={20} />
              ) : (
                <AgentAvatar agentId={p.agentId} size="sm" name={name} />
              )}
            </span>
            <span className="ac-mediarow__head">
              <b className="proposal-row__name">{name}</b>
            </span>
            <span className="ac-mediarow__end">
              {status && <span className="proposal-row__status">{status}</span>}
              {isOpen(p) && (
                <Switch
                  checked={p.canDecide && !off.has(p.id)}
                  disabled={!p.canDecide || decide.isPending}
                  onCheckedChange={(on) => toggle(p.id, on)}
                  aria-label={t("proposals.include", { name })}
                />
              )}
            </span>
            {!isText(p) && (
              <span className="ac-mediarow__body">
                <SettingChange p={p} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
  const groups = proposalSections(rows);

  // Waiting: a request card like every other, the rows and their switches above its decision.
  if (rows.some(isOpen)) {
    const tt = t as unknown as (key: string, options: Record<string, unknown>) => string;
    const texts = groups.flatMap((g) => (g.kind === "text" && g.lines.length > 0 ? [g] : []));
    const firstLine = firstChange(texts[0]?.lines);
    return (
      <RequestCard
        id={first.id}
        kind="proposal"
        agent={dir.anyAgent(proposerOf(first))}
        label={label}
        mine={decides}
        lead={who}
        object={
          firstLine
            ? {
                logo: (
                  <RequestTile>
                    <Icon name="file" size={16} />
                  </RequestTile>
                ),
                title: firstLine.text,
                more: t("ask.seeChange"),
              }
            : undefined
        }
        details={
          texts.length > 0 ? (
            <>
              {texts.map((g) => (
                <ProseDiff key={g.rows[0]?.id} label={t("proposals.changeLabel")} lines={g.lines} />
              ))}
              <div className="ac-acts">
                <ProposalsLink agentId={first.agentId} />
              </div>
            </>
          ) : undefined
        }
        body={rowList(groups.flatMap((g) => g.rows))}
        actions={
          decides ? (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={decide.isPending || chosen.length === 0}
                loading={decide.isPending && decide.variables?.decision === "accept"}
                onClick={() => run("accept")}
              >
                {all ? t("proposals.acceptAll") : t("proposals.acceptSome", { count: chosen.length })}
              </Button>
              <Button
                size="sm"
                disabled={decide.isPending || chosen.length === 0}
                loading={decide.isPending && decide.variables?.decision === "refuse"}
                onClick={() => run("refuse")}
              >
                {t("proposals.refuse")}
              </Button>
            </>
          ) : undefined
        }
        what={tt(head.key, head.values).replace(/<\/?b>/g, "")}
        locked={decide.isPending}
      />
    );
  }

  // Decided, or overtaken by a newer text.
  return (
    <ProposalDone label={label} what={who} rows={rows}>
      {groups.map((section) => (
        <div key={section.rows[0]?.id} className="proposal-section">
          {section.kind === "text" && section.lines.length > 0 && (
            <ProseDiff label={t("proposals.changeLabel")} lines={section.lines} />
          )}
          {rowList(section.rows)}
        </div>
      ))}
      <div className="ac-acts">
        <ProposalsLink agentId={first.agentId} />
      </div>
    </ProposalDone>
  );
}

/**
 * An agent's question (`ask_user`): neutral card in the thread with the
 * choices as a list, one a line with its number key, and "Outra resposta" (or
 * "Responder" without choices) opening a field in the card. The field answers this question wherever the card shows (a thread
 * in the panel, a consultation, a channel whose composer posts elsewhere), so
 * it never depends on which composer is on screen.
 */
export function QuestionCard({ question }: { question: AgentQuestion }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const live = useLiveStore();
  const fresh = useLive((s) => s.questions[question.id]);
  const current = fresh?.status === "open" && question.status !== "open" ? question : (fresh ?? question);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const reopen = useRef<HTMLButtonElement>(null);
  // Refused because it ended (someone answered, its run stopped): the card closes here, even if no event came.
  const [ended, setEnded] = useState(false);
  const refused = (err: unknown, fallback: "question.failed" | "question.skipFailed") => {
    if ((err as { status?: number }).status !== 409) return setError(t(fallback));
    setText("");
    setEnded(true);
    live.answered({ ...current, status: "answered", answer: null, answeredByUserId: null });
  };
  const answer = useMutation({
    mutationFn: (input: { choice: string } | { text: string }) => api.questions.answer(org.id, question.id, input),
    // Errors are explained on the card.
    meta: { silent: true },
    onMutate: () => setError(null),
    onSuccess: (res, input) =>
      live.answered({ ...res, answer: res.answer ?? ("choice" in input ? input.choice : input.text) }),
    onError: (err) => refused(err, "question.failed"),
  });
  const skip = useMutation({
    mutationFn: () => api.questions.dismiss(org.id, question.id),
    meta: { silent: true },
    onMutate: () => setError(null),
    onSuccess: (res) => live.answered(res),
    onError: (err) => refused(err, "question.skipFailed"),
  });
  const busy = answer.isPending || skip.isPending;
  const agent = dir.anyAgent(question.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const done = current.status === "answered";
  const who = current.answeredByUserId === me.user.id ? null : dir.memberById.get(current.answeredByUserId ?? "")?.name;
  // Open: a request card, the choices a list in its body, each with its number key, and "Outra resposta" the list's
  // last line, opening a field to write one. For someone else, it says who it waits for and nothing else.
  if (!done) {
    const mine = questionWaitsOn(current, me.user.id);
    const choices = current.choices ?? [];
    const send = () => {
      if (text.trim() && !busy) answer.mutate({ text: text.trim() });
    };
    const pick = (choice: string | undefined) => {
      if (choice !== undefined && !busy) answer.mutate({ choice });
    };
    const picking = (choice: string) =>
      answer.isPending && "choice" in answer.variables && answer.variables.choice === choice;
    const errorLine = error ? (
      <p className="rq__error" role="alert">
        {error}
      </p>
    ) : null;
    const field = writing && (
      <div className="rq__field">
        <Textarea
          rows={2}
          autoGrow
          autoFocus
          value={text}
          placeholder={t("question.placeholder")}
          aria-label={t("question.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
    );
    return (
      <RequestCard
        id={question.id}
        kind="question"
        agent={agent}
        label={t("question.group", { agent: name })}
        mine={mine}
        waitingFor={t("ask.waitingFor", {
          name: dir.memberById.get(current.requestedForUserId ?? "")?.name ?? t("channel.unknownPerson"),
        })}
        lead={current.text}
        body={
          (mine && choices.length > 0) || field || errorLine ? (
            <>
              {mine && choices.length > 0 && (
                <RequestChoices
                  choices={choices.map((label) => ({ label, busy: picking(label) }))}
                  onPick={(i) => pick(choices[i])}
                  disabled={busy}
                  other={
                    writing ? undefined : { label: t("ask.otherAnswer"), onClick: () => setWriting(true), ref: reopen }
                  }
                />
              )}
              {field}
              {errorLine}
            </>
          ) : undefined
        }
        actions={
          mine &&
          (writing ? (
            <>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!text.trim() || skip.isPending || (answer.isPending && !("text" in answer.variables))}
                loading={answer.isPending && "text" in answer.variables}
              >
                {t("channel.send")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setWriting(false);
                  setText("");
                  setError(null);
                  // The button leaves with the field: focus goes back to the one that opened it.
                  requestAnimationFrame(() => reopen.current?.focus());
                }}
              >
                {t("common.cancel")}
              </Button>
            </>
          ) : choices.length > 1 ? (
            <RequestKeys count={choices.length} />
          ) : choices.length === 0 ? (
            <Button ref={reopen} variant="primary" size="sm" onClick={() => setWriting(true)}>
              {t("question.answer")}
            </Button>
          ) : undefined)
        }
        end={
          mine && (
            <Button variant="ghost" size="sm" disabled={busy} loading={skip.isPending} onClick={() => skip.mutate()}>
              {t("question.skip")}
            </Button>
          )
        }
        what={current.text}
        onSubmit={writing ? send : undefined}
        locked={busy}
      />
    );
  }
  // Answered: the question stays in the open as the agent's words; one line says who answered and what. Closed
  // with no answer (its run stopped, or it expired): it says so instead.
  const answerText = current.answer ?? "";
  return (
    <>
      {/* A row's name and time stay on its own words: this one follows them. */}
      <MessageText opens={false} closes={false}>
        {current.text}
      </MessageText>
      <RequestDone done label={t("question.group", { agent: name })}>
        {current.withdrawn ? (
          t("question.withdrawn", agentGrammar(name))
        ) : current.dismissed ? (
          who ? (
            t("question.dismissed", { name: who })
          ) : (
            t("question.dismissedByYou")
          )
        ) : current.answer === null ? (
          t(ended ? "question.alreadyAnswered" : "question.closed")
        ) : who ? (
          <Trans
            i18nKey="question.answered"
            values={{ name: who, answer: answerText }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        ) : (
          <Trans
            i18nKey="question.answeredByYou"
            values={{ answer: answerText }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        )}
      </RequestDone>
    </>
  );
}

/**
 * An agent asks for a secret for its computer (`request_secret`, ADR 0027).
 * Only the person asked sees the field; the value is sealed here, in the
 * browser, to the key the computer made, so it never reaches our server, the
 * chat or the agent. Everyone else sees who was asked.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const live = useLiveStore();
  const current = latestSecret(
    useLive((s) => s.secrets[request.id]),
    request,
  );
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // "Save to the Vault" (ADR 0144): a site's password or a variable, saved after it went to the computer.
  const [keep, setKeep] = useState<VaultSaveChoice>(() => vaultSaveDefaults(request));
  // How the save went: saved, failed (Retry while the value is kept), or dropped (failed, and the value is gone).
  const [vaultSave, setVaultSave] = useState<"saved" | "failed" | "dropped" | null>(null);
  const store = useSaveSecretToVault(org.id);
  // A save that failed keeps what it sent, for Retry, while the card is on screen and for two minutes at most. The
  // mutations themselves forget the typed value as soon as they end (`reset`, `gcTime: 0`).
  const retryable = useRef<SecretToVaultInput | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      retryable.current = null;
      clearTimeout(retryTimer.current);
    },
    [],
  );
  const codeDigits = current.codeDigits ?? null;
  const agent = dir.anyAgent(request.agentId);
  const agentName = agent?.name ?? t("channel.unknownAgent");
  const mine = current.requestedForUserId === me.user.id;
  const person = dir.memberById.get(current.requestedForUserId)?.name ?? t("channel.unknownPerson");
  // Past its deadline it closes as expired, even before the server's event says so.
  const expired = useExpired(current.status === "pending" ? current.expiresAt : null);
  const pending = current.status === "pending" && !expired;
  // It ended (an event, its deadline, a refusal): what was typed goes with the field.
  useEffect(() => {
    if (!pending) setValue("");
  }, [pending]);
  // Refused: the computer can't take it now and the card goes on, or the request ended and the card says how.
  const failed = async (err: unknown) => {
    const away = secretRefusalKey(err);
    if (away) return setError(t(away, { agent: agentName, time: formatTime(i18n.language, current.expiresAt) }));
    if ((err as { status?: number }).status !== 409) return setError(t("secret.failed"));
    const fresh = await api.secrets.get(org.id, current.id).catch(() => null);
    const closed = secretClosedBy(err, current, fresh);
    if (closed) return live.secretAnswered(closed);
    if (fresh) live.secretAnswered(fresh);
    setError(t(fresh ? "secret.changed" : "secret.failed"));
  };
  // The newer card, when this conversation shows it; else where it is.
  const showNewer = async () => {
    const id = current.supersededBy;
    if (!id) return;
    if (document.querySelector(`[data-ask-id="${id}"]`)) return showRequest(document.body, id, true);
    const newer = await api.secrets.get(org.id, id).catch(() => null);
    if (newer?.messageId) {
      await navigate({ href: messagePath(org.id, { ...newer, id: newer.messageId }) });
    }
  };
  const forgetRetry = () => {
    retryable.current = null;
    clearTimeout(retryTimer.current);
  };
  // Delivered but not saved: the value went where it was asked, so the toast says only the Vault failed, and retries.
  function saveToVault(input: SecretToVaultInput) {
    store.mutate(
      { ...input, requestId: current.id },
      {
        onSuccess: () => {
          forgetRetry();
          setVaultSave("saved");
        },
        onError: () => {
          if (!retryable.current) {
            retryable.current = input;
            retryTimer.current = setTimeout(() => {
              forgetRetry();
              setVaultSave((v) => (v === "failed" ? "dropped" : v));
            }, VAULT_RETRY_MS);
          }
          setVaultSave("failed");
          toast.show(t("vault.card.notSaved"), "warning", { label: t("common.retry"), run: retrySave });
        },
        onSettled: () => store.reset(),
      },
    );
  }
  function retrySave() {
    if (retryable.current) saveToVault(retryable.current);
  }
  const deliver = useMutation({
    meta: { silent: true },
    gcTime: 0,
    mutationFn: async ({ text }: { text: string; choice: VaultSaveChoice | null }) => {
      if (!current.publicKey) throw Object.assign(new Error("closed"), { status: 409 });
      const aad = secretAad({ requestId: current.id, orgId: org.id, name: current.name, target: current.target });
      return api.secrets.deliver(org.id, current.id, await sealSecret(current.publicKey, text, aad));
    },
    onMutate: () => setError(null),
    onSuccess: (res, { text, choice }) => {
      setValue("");
      live.secretAnswered(res);
      if (choice)
        saveToVault({
          value: text,
          // A site's username always goes: empty means none, even when the agent suggested one (ADR 0144 §6).
          ...(current.target.kind === "site" ? { username: choice.username.trim() } : {}),
          scope: choice.scope,
          allAgents: choice.allAgents,
          agentIds: choice.allAgents ? [] : choice.agentIds,
        });
    },
    onError: failed,
  });
  const decline = useMutation({
    meta: { silent: true },
    mutationFn: () => api.secrets.decline(org.id, current.id),
    onMutate: () => setError(null),
    onSuccess: (res) => live.secretAnswered(res),
    onError: failed,
  });
  const savable = mine && savesToVault(current);
  const submit = () => {
    const problem = secretValueProblem(value);
    if (problem) return setError(t(problem));
    if (codeDigits && value.length !== codeDigits) return setError(t("vault.card.codeShort", { count: codeDigits }));
    // Sent (or refused): the typed value leaves the mutation at once.
    deliver.mutate({ text: value, choice: savable && keep.on ? keep : null }, { onSettled: () => deliver.reset() });
  };
  const where = secretWhere(t, current, agentName);
  const label = secretLabel(t, current, agentName);
  const until = t("secret.until", { time: formatTime(i18n.language, current.expiresAt) });
  // Waiting: a request card; only the person asked gets the field (the whole card is its form).
  if (pending) {
    const host = hostOf(current.site);
    return (
      <RequestCard
        id={current.id}
        kind="secret"
        agent={agent}
        label={t("secret.group", { agent: agentName })}
        mine={mine}
        waitingFor={t("ask.waitingFor", { name: person })}
        lead={current.purpose}
        object={{
          logo: <RequestTile>{host ? <SiteIcon host={host} /> : <Icon name="lock" size={16} />}</RequestTile>,
          title: label,
          detail: current.username
            ? t("common.joinSentences", { a: where, b: t("secret.account", { username: current.username }) })
            : where,
        }}
        body={
          mine ? (
            <>
              <div className="rq__field">
                {codeDigits ? (
                  // A verification code (ADR 0144): one box per digit, typed by the agent's browser, never saved.
                  <CodeInput
                    length={codeDigits}
                    value={value}
                    onChange={setValue}
                    label={label}
                    boxLabel={(n, total) => t("vault.card.codeBox", { n, total })}
                    invalid={Boolean(error)}
                    disabled={deliver.isPending}
                  />
                ) : (
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    placeholder={t("secret.placeholder")}
                    aria-label={label}
                    invalid={Boolean(error)}
                    onChange={(e) => setValue(e.target.value)}
                    data-1p-ignore
                  />
                )}
              </div>
              {error ? (
                <p className="rq__error" role="alert">
                  {error}
                </p>
              ) : (
                <p className="rq__note ac-iconline">
                  <Icon name="lock" size={14} />
                  <span>
                    {codeDigits && host ? t("vault.card.codeWhere", { agent: agentName, host }) : t("secret.private")}
                  </span>
                </p>
              )}
              {savable && (
                <VaultSaveBlock
                  request={current}
                  value={keep}
                  onChange={setKeep}
                  canManageTeam={can(org, "manage_credentials")}
                  disabled={deliver.isPending}
                />
              )}
            </>
          ) : undefined
        }
        actions={
          mine ? (
            <>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={deliver.isPending}
                disabled={decline.isPending}
              >
                {t("secret.send")}
              </Button>
              <Button
                type="button"
                size="sm"
                loading={decline.isPending}
                disabled={deliver.isPending}
                onClick={() => decline.mutate()}
              >
                {t("secret.decline")}
              </Button>
            </>
          ) : undefined
        }
        end={until}
        what={label}
        onSubmit={mine ? submit : undefined}
        locked={deliver.isPending || decline.isPending}
      />
    );
  }
  // Closed: one line, how it ended and which secret, never its value; what it was for behind "Ver detalhes".
  const ended = secretEndedAt(current);
  return (
    <>
      <RequestDone
        done={current.status === "delivered"}
        label={t("secret.group", { agent: agentName })}
        more={{ label: t("approval.seeDetails"), content: `${current.purpose}\n${where}` }}
        action={
          current.supersededBy ? (
            <EventPillAction onClick={() => void showNewer()}>{t("secret.seeNewer")}</EventPillAction>
          ) : undefined
        }
        time={ended ? whenAt(t, i18n.language, ended) : undefined}
      >
        <b>{label}</b> · {secretOutcome(t, current, mine, person, agentName)}
        {vaultSave === "saved" && ` · ${t("vault.card.saved")}`}
      </RequestDone>
      {(vaultSave === "failed" || vaultSave === "dropped") && (
        <div className="vlt-save__failed">
          <p className="rq__note ac-iconline">
            <Icon name="alert" size={14} />
            <span>{t("vault.card.notSaved")}</span>
          </p>
          {vaultSave === "failed" && (
            <Button size="sm" variant="ghost" loading={store.isPending} onClick={retrySave}>
              {t("common.retry")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="rq__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
