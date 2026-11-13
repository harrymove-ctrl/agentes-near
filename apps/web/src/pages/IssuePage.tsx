import type { Issue, IssueActivity, IssuePatch, IssuePriority } from "@agenteschat/client";
import {
  ApiError,
  keys,
  useChannels,
  useIssue,
  useIssueAction,
  useIssueActivity,
  useIssueColumns,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { relativeTime, whenAt } from "@agenteschat/client/lib/format";
import { githubLinkLabel, isGithubLink } from "@agenteschat/client/lib/github-link";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { webUrl } from "@agenteschat/client/lib/guards";
import { issueEventText } from "@agenteschat/client/lib/issues";
import { foldSteps } from "@agenteschat/client/lib/work";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  CriteriaPixels,
  cx,
  DatePicker,
  DetailsDialog,
  DetailsSection,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  SavedNote,
  Select,
  TabPanel,
  Tabs,
  useAutoGrow,
  WorkSweep,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { renderIdRef } from "@/chat/IdRef";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, useActors } from "@/components/actors";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { IssueWorkBlock } from "@/components/BackgroundWork";
import { EditInPlace, useFocusAtEnd, useSavedFlash, useSent } from "@/components/EditInPlace";
import { GitHubMark } from "@/components/GitHubMark";
import { IssueFiles, useIssueFileEntries } from "@/components/IssueFiles";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { TaskConversationButton, TaskConversationPanel, TaskConversationSummary } from "@/components/TaskConversation";
import { IssueWhoSeesDialog, WhoSeesButton } from "@/components/WhoSees";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { usePersonalView } from "@/hooks/usePersonalView";
import {
  columnIdOf,
  columnsOf,
  isCustomBoard,
  isOpen,
  PRIORITIES,
  STATUS_ICON,
  STATUSES,
  useAssigneeColor,
  useColumnTitle,
  useStageName,
  useStepText,
} from "@/lib/issues";
import { codeAndBold, Markdown } from "@/lib/markdown";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import { useIssueRealtime } from "@/realtime/context";
import { IssueDeleteButton, IssueDeleteProvider, useIssueDeleting } from "./IssueDelete";
import { PRIORITY_ICON } from "./IssuesToolbar";
import "./issues.css";

/** One issue as a page (`/issues/131`); the board opens the same details in its panel. */
export function IssuePage({ number }: { number: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const issue = useIssue(org.id, number);
  // `?m=`: a link or a notice named a message of its conversation: it opens there.
  const [focus] = useOpenParam("m");
  const [talk, setTalk] = useState(Boolean(focus));
  // Out of reach since it opened (someone changed who sees it): what's on screen goes.
  const i = issue.error instanceof ApiError && issue.error.status === 404 ? undefined : issue.data;
  const navigate = useNavigate();
  return (
    <IssueDeleteProvider onDeleted={() => void navigate({ to: "/org/$orgId/issues", params: { orgId: org.id } })}>
      <div className="page page--full">
        <div className="issue-page__main">
          <div className="issue-page__bar">
            <Link to="/org/$orgId/issues" params={{ orgId: org.id }} className="ac-back">
              <Icon name="chevronLeft" />
              {t("issues.back")}
            </Link>
            {i && (
              <span className="issue-page__tools">
                <IssueDeleteButton issue={i} />
                <TaskConversationButton issue={i} open={talk} onToggle={() => setTalk((v) => !v)} />
              </span>
            )}
          </div>
          {issue.isError && <Alert>{t("issues.notFound")}</Alert>}
          {i && <IssueDetails issue={i} variant="page" onConversation={() => setTalk(true)} />}
        </div>
        {talk && i && (
          <SidePanel className="issue-page__talk" label={t("issues.conversation.title")} onClose={() => setTalk(false)}>
            <TaskConversationPanel issue={i} focusMessageId={focus ?? undefined} onClose={() => setTalk(false)} />
          </SidePanel>
        )}
      </div>
    </IssueDeleteProvider>
  );
}

/** Where an issue came from: "a partir de uma mensagem no #eng" (a link), an agent, a webhook. */
function useIssueSource(i: Issue) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  switch (i.source.type) {
    case "message": {
      const { channelId } = i.source;
      const channel = channels.data?.find((c) => c.id === channelId);
      return (
        <Trans
          i18nKey="issues.fromMessage"
          values={{ channel: channel?.name ?? "" }}
          components={[
            <Link key="l" to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId }} className="ac-link" />,
          ]}
        />
      );
    }
    case "agent":
      return t("issues.fromAgent");
    case "webhook":
      return t("issues.fromWebhook", { provider: i.source.provider });
    default:
      return null;
  }
}

/**
 * An issue opened from the board or the list: the task's own page inside the shared details dialog ("#131" and its
 * title on its bar, which never scrolls away, its actions behind ⋯), wide and always full height so changing tabs
 * never makes it jump.
 */
export function IssueDialog({
  issue: i,
  onClose,
  focusMessageId,
}: {
  issue: Issue;
  onClose: () => void;
  /** A message of its conversation to open at (the board's `?m=`). */
  focusMessageId?: string;
}) {
  const { t } = useTranslation();
  // "Conversa 5" (variant B): the conversation as the dialog's right column.
  const focus = focusMessageId;
  const [talk, setTalk] = useState(Boolean(focus));
  return (
    <IssueDeleteProvider onDeleted={onClose}>
      <DetailsDialog
        more={<IssueMore issue={i} onConversation={() => setTalk((v) => !v)} />}
        side={
          talk ? <TaskConversationPanel issue={i} focusMessageId={focus} onClose={() => setTalk(false)} /> : undefined
        }
        open
        onOpenChange={(o) => !o && onClose()}
        closeLabel={t("issues.close")}
        size="lg"
        fill
        titleHidden
        eyebrow={<IssueBarTitle issue={i} />}
        title={i.title}
        // Esc in a text being edited in place saves it and stays: the dialog closes on the next Esc.
        onEscapeKeyDown={(e) => {
          const el = document.activeElement;
          if (el instanceof HTMLElement && el.closest("[data-inplace]")) {
            e.preventDefault();
            el.blur();
          }
        }}
      >
        <IssueDetails issue={i} variant="dialog" onConversation={() => setTalk(true)} />
      </DetailsDialog>
    </IssueDeleteProvider>
  );
}

/**
 * The dialog's actions behind one ⋯ beside the ×, so "#131" and the title keep the bar: its conversation, its own
 * page, and, after a divider, Excluir tarefa for who may. The conversation also opens from its section in the body.
 */
function IssueMore({ issue: i, onConversation }: { issue: Issue; onConversation: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const { ask, mayDelete } = useIssueDeleting();
  return (
    <Menu
      label={t("issues.moreOptions")}
      align="end"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="more"
          aria-label={t("issues.moreOptions")}
          title={t("issues.moreOptions")}
        />
      }
    >
      <MenuItem icon="message" onSelect={onConversation}>
        {t("issues.conversation.button")}
      </MenuItem>
      <MenuItem
        icon="external"
        onSelect={() =>
          void navigate({ to: "/org/$orgId/issues/$number", params: { orgId: org.id, number: String(i.number) } })
        }
      >
        {t("issues.openPage")}
      </MenuItem>
      {mayDelete(i) && (
        <>
          <MenuSeparator />
          <MenuItem icon="trash" danger onSelect={() => ask(i)}>
            {t("issues.delete.action")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/** "#131 Confirmação do agendamento por WhatsApp" on the dialog's bar, the title edited in place there. */
function IssueBarTitle({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const [saved, flashSaved] = useSavedFlash();
  return (
    <div className="issue-bartitle">
      <span className="issue-bartitle__number tabular">#{i.number}</span>
      <IssueTitle issue={i} onSaved={flashSaved} />
      <SavedNote shown={saved} label={t("common.saved")} className="issue-bartitle__saved" />
    </div>
  );
}

/**
 * An issue's details, the same on its page and in the dialog (whose bar has the title): who made it and from where, the
 * title, its fields and links as one strip, then tabs (the agent's work, live steps or "stalled" with "Pedir para
 * continuar"; "Pedir a um agente"; description, criteria and who checked them; sub-issues; discussion). The title, the
 * description and the criteria are edited where they are, saved on leaving the field ("Salvo" by the source line).
 */
export function IssueDetails({
  issue: i,
  variant,
  onConversation,
}: {
  issue: Issue;
  variant: "page" | "dialog";
  /** Opens its conversation beside the details (ADR 0145). */
  onConversation: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const from = useIssueSource(i);
  const activity = useIssueActivity(org.id, i.id);
  // Comments, files and events arrive live while it's open (every tab reads this one list).
  useIssueRealtime(org.id, i);
  const list = activity.data ?? [];
  const [tab, setTab] = useState<"details" | "files" | "history">("details");
  const files = useIssueFileEntries(i, list);
  const [saved, flashSaved] = useSavedFlash();
  // The files it was created with show under the description (prints, logs): the rest are in "Anexos".
  const createdFiles = list.find((a) => a.event === "created")?.attachments ?? [];
  return (
    <div className="issue-details">
      <header className="issue-details__head">
        <span className="small muted tabular">
          {variant === "page"
            ? t("issues.createdBy", { number: i.number, name: actors.name(i.createdBy) })
            : t("issues.createdByShort", { name: actors.name(i.createdBy) })}
          {from && <> {from}</>}
          <SavedNote shown={saved} label={t("common.saved")} className="issue-details__saved" />
        </span>
        {variant === "page" && <IssueTitle issue={i} onSaved={flashSaved} />}
      </header>
      <PropsLine issue={i} />
      <Tabs
        value={tab}
        onValueChange={setTab}
        label={t("issues.tabs.label")}
        items={[
          { value: "details", label: t("issues.tabs.details") },
          { value: "files", label: t("issues.tabs.files"), count: files.length || undefined },
          { value: "history", label: t("issues.tabs.history") },
        ]}
      >
        <TabPanel value="details">
          <WorkBox issue={i} />
          <IssueWorkBlock issue={i} />
          {i.assignee?.type !== "agent" && isOpen(i) && <AskAgent issue={i} />}
          <DetailsSection title={t("issues.description")}>
            <IssueDescription issue={i} hasFiles={createdFiles.length > 0} onSaved={flashSaved} />
            {createdFiles.length > 0 && (
              <div className="artifact-cards issue-description__files">
                {createdFiles.map((f) => (
                  <ArtifactCard key={f.id} artifact={{ id: f.id }} />
                ))}
              </div>
            )}
          </DetailsSection>
          <IssueCriteria issue={i} onSaved={flashSaved} />
          <IssueSubIssues issue={i} />
          <DetailsSection title={t("issues.conversation.button")}>
            <TaskConversationSummary issue={i} onOpen={onConversation} />
          </DetailsSection>
        </TabPanel>
        <TabPanel value="files">
          <IssueFiles issue={i} activity={list} />
        </TabPanel>
        <TabPanel value="history">
          <History activity={list} loaded={activity.isSuccess} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

/** The title, edited in place: Enter, Esc or leaving the field saves it (an empty one keeps the old title). */
function IssueTitle({ issue: i, onSaved }: { issue: Issue; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useSent<string>(i.title);
  const title = sent.pending ?? i.title;
  const ref = useFocusAtEnd<HTMLInputElement>(draft !== null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (!next || next === title) return;
    sent.send(next);
    action.mutate({ type: "update", id: i.id, patch: { title: next } }, { onSuccess: onSaved, onError: sent.clear });
  };
  if (draft !== null)
    return (
      <input
        ref={ref}
        className="issue-inplace__title"
        value={draft}
        maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
        aria-label={t("issues.form.title")}
        data-inplace=""
      />
    );
  return (
    <EditInPlace label={t("issues.edit.title")} onEdit={() => setDraft(title)}>
      <h1 className="issue-details__title">{codeAndBold(title)}</h1>
    </EditInPlace>
  );
}

/** The description, edited in place in the creation's box: leaving it, Esc or ⌘↵ saves it. */
function IssueDescription({ issue: i, hasFiles, onSaved }: { issue: Issue; hasFiles: boolean; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const wikiLink = useWikiLinkRenderer();
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useSent<string>(i.description);
  const description = sent.pending ?? i.description;
  const ref = useFocusAtEnd<HTMLTextAreaElement>(draft !== null);
  // As tall as its text where the engine can't size it from CSS (`field-sizing`, which the Mac app's WebKit lacks).
  useAutoGrow(ref, draft ?? "", draft !== null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next === description.trim()) return;
    sent.send(next);
    action.mutate(
      { type: "update", id: i.id, patch: { description: next } },
      { onSuccess: onSaved, onError: sent.clear },
    );
  };
  if (draft !== null)
    return (
      <>
        <div className="issue-new__editor" data-inplace="">
          <textarea
            ref={ref}
            className="issue-new__text"
            rows={4}
            value={draft}
            maxLength={50_000}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key !== "Escape" && !(e.key === "Enter" && (e.metaKey || e.ctrlKey))) return;
              e.preventDefault();
              e.currentTarget.blur();
            }}
            placeholder={t("issues.form.descriptionPlaceholder")}
            aria-label={t("issues.description")}
          />
        </div>
        <p className="issue-new__hint small muted">{t("issues.edit.hint")}</p>
      </>
    );
  return (
    <EditInPlace label={t("issues.edit.description")} onEdit={() => setDraft(description)}>
      {description ? (
        <div className="issue-description">
          <Markdown source={description} variant="message" wikiLink={wikiLink} idRef={renderIdRef} />
        </div>
      ) : (
        // With the files it was created with and no text, the files say it all; the pencil still opens the box.
        !hasFiles && <p className="small muted">{t("issues.noDescription")}</p>
      )}
    </EditInPlace>
  );
}

/**
 * Acceptance criteria: checked as before, and edited where they are: the pencil on a row turns it into a field
 * (an empty one removes it), "Adicionar critério" at the end adds one. The whole list goes to the server at once.
 */
function IssueCriteria({ issue: i, onSaved }: { issue: Issue; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const color = useAssigneeColor();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = useState("");
  const ref = useFocusAtEnd<HTMLInputElement>(editing !== null);
  // What was just sent shows until the task comes back with it; a new one has no id yet.
  const sent = useSent<{ id?: string; text: string }[]>(i.criteria.map((c) => `${c.id}:${c.text}`).join("\n"));
  const shown = sent.pending
    ? sent.pending.map((c, k) => {
        const kept = i.criteria.find((x) => x.id === c.id);
        return { id: c.id ?? `new-${k}`, text: c.text, done: kept?.done ?? false, doneBy: kept?.doneBy ?? null };
      })
    : i.criteria;
  const done = shown.filter((c) => c.done).length;
  const saveList = (list: { id?: string; text: string }[]) => {
    sent.send(list);
    action.mutate({ type: "update", id: i.id, patch: { criteria: list } }, { onSuccess: onSaved, onError: sent.clear });
  };
  const current = shown.map((c) => (c.id.startsWith("new-") ? { text: c.text } : { id: c.id, text: c.text }));
  const commit = () => {
    if (!editing) return;
    const { id, text } = editing;
    setEditing(null);
    const next = text.trim();
    if (next === shown.find((c) => c.id === id)?.text) return;
    saveList(next ? current.map((c) => (c.id === id ? { id, text: next } : c)) : current.filter((c) => c.id !== id));
  };
  const remove = (id: string) => {
    setEditing(null);
    saveList(current.filter((c) => c.id !== id));
  };
  const add = () => {
    const text = adding.trim();
    if (!text) return;
    setAdding("");
    saveList([...current, { text }]);
  };
  return (
    <DetailsSection
      title={t("issues.criteria")}
      actions={
        shown.length > 0 ? (
          <span className="issue-details__count tabular">
            {t("issues.criteriaCount", { done, total: shown.length })}
          </span>
        ) : undefined
      }
    >
      {shown.length > 0 && <CriteriaPixels done={shown.map((c) => c.done)} color={color(i)} />}
      {shown.map((c) =>
        editing?.id === c.id ? (
          <div key={c.id} className="issue-new__criterion issue-criterion--edit" data-inplace="">
            <span className="issue-new__box" aria-hidden="true" />
            <input
              ref={ref}
              value={editing.text}
              maxLength={500}
              onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== "Escape") return;
                e.preventDefault();
                e.currentTarget.blur();
              }}
              aria-label={t("issues.criteria")}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              aria-label={t("issues.form.removeCriterion")}
              title={t("issues.form.removeCriterion")}
              // Keeps the field focused, so leaving it doesn't save the row first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => remove(c.id)}
            />
          </div>
        ) : (
          <div key={c.id} className="issue-criterion" data-done={c.done || undefined}>
            <Checkbox
              id={`crit-${c.id}`}
              checked={c.done}
              disabled={c.id.startsWith("new-")}
              onCheckedChange={(v) => action.mutate({ type: "criterion", id: i.id, criterionId: c.id, done: v })}
            />
            <label htmlFor={`crit-${c.id}`}>{c.text}</label>
            {c.done && c.doneBy?.type === "agent" && (
              <span className="issue-criterion__by" title={t("issues.checkedBy", { name: actors.name(c.doneBy) })}>
                <ActorAvatar actor={c.doneBy} name={actors.name(c.doneBy)} size="xs" />
                {actors.name(c.doneBy)}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="edit"
              aria-label={t("issues.edit.criterion", { text: c.text })}
              title={t("issues.edit.criterionShort")}
              className="issue-criterion__pen"
              disabled={c.id.startsWith("new-")}
              onClick={() => setEditing({ id: c.id, text: c.text })}
            />
          </div>
        ),
      )}
      <div className="issue-new__criterion issue-new__criterion--add" data-inplace="">
        <Icon name="plus" size={16} />
        <input
          value={adding}
          maxLength={500}
          onChange={(e) => setAdding(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
          placeholder={t("issues.form.addCriterion")}
          aria-label={t("issues.form.addCriterion")}
        />
      </div>
    </DetailsSection>
  );
}

/** An issue's sub-issues, with their state and who has them. */
function IssueSubIssues({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const subs = i.subIssues ?? [];
  if (subs.length === 0) return null;
  return (
    <DetailsSection title={t("issues.subIssues", { count: subs.length })}>
      <ul className="issue-subl">
        {subs.map((s) => (
          <li key={s.id}>
            <Link to="/org/$orgId/issues/$number" params={{ orgId: org.id, number: String(s.number) }}>
              <span className="issue-subl__num">#{s.number}</span>
              <span className="issue-subl__tx">{s.title}</span>
              {s.assignee && (
                <span className="issue-subl__who">
                  <ActorAvatar actor={s.assignee} name={actors.name(s.assignee)} size="xs" />
                  {actors.name(s.assignee)}
                </span>
              )}
              <Chip icon={STATUS_ICON[s.status]}>{t(`issues.status.${s.status}`)}</Chip>
            </Link>
          </li>
        ))}
      </ul>
    </DetailsSection>
  );
}

/** The assigned agent's work: live steps (with Parar) or stalled (with "Pedir para continuar"). */
function WorkBox({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const color = useAssigneeColor();
  const stepText = useStepText();
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.issues(org.id) }),
  });
  const w = i.work;
  if (!w || !i.assignee || i.assignee.type !== "agent") return null;
  const name = actors.name(i.assignee);
  const g = agentGrammar(name);
  const stalled = w.state === "stalled";
  const waiting = w.state === "waiting_approval" || w.state === "waiting_input";
  const when = relativeTime(t, i18n.language, w.since);
  const last = w.steps.at(-1);
  const lines = foldSteps(w.steps, stepText);
  return (
    <section className={cx("issue-work", stalled && "is-stalled")} aria-label={t("issues.work.label", g)}>
      <div className="issue-work__head ac-iconline">
        <AgentAvatar
          agentId={i.assignee.id}
          name={name}
          size="sm"
          running={w.state === "running"}
          state={w.state === "running" ? "writing" : "idle"}
          expression={stalled ? "closed" : undefined}
        />
        <span className="issue-work__text">
          <b>
            {stalled
              ? t("issues.work.stalledTitle", { ...g, when })
              : waiting
                ? t("issues.work.waitingTitle", g)
                : t("issues.work.runningTitle", g)}
          </b>
          <small>{stalled ? t("issues.work.stalledText", g) : t("issues.work.started", { when })}</small>
        </span>
        {w.state === "running" && w.runId && (
          <span className="issue-work__tail">
            <Button
              size="sm"
              variant="ghost"
              icon="stop"
              loading={stop.isPending}
              onClick={() => w.runId && stop.mutate(w.runId)}
            >
              {t("issues.work.stop")}
            </Button>
          </span>
        )}
      </div>
      {stalled ? (
        <>
          {last && <p className="issue-work__last">{t("issues.work.lastStep", { step: stepText(last) })}</p>}
          {w.reason && <p className="issue-work__last">{t(`issues.work.reason.${w.reason}`)}</p>}
          <div className="issue-work__actions">
            <Button
              size="sm"
              variant="primary"
              icon="play"
              loading={action.isPending}
              onClick={() =>
                action.mutate(
                  { type: "ask", id: i.id, agentId: i.assignee?.id ?? "" },
                  { onSuccess: () => toast.show(t("issues.work.resumed", g)) },
                )
              }
            >
              {t("issues.work.continue")}
            </Button>
          </div>
        </>
      ) : (
        lines.length > 0 && (
          <ol className="issue-work__steps">
            {lines.map(({ step: s, text, count }, k) => {
              const current = k === lines.length - 1;
              return (
                <li key={`${s.at}-${s.tool}`} className={cx(current && "is-current")}>
                  <span className="issue-work__dot" aria-hidden="true">
                    <Icon name={s.outcome === "refused" ? "close" : current ? "play" : "check"} size={14} />
                  </span>
                  <span>{count > 1 ? `${text} ${t("chat.work.times", { count })}` : text}</span>
                  <time dateTime={s.at}>{whenAt(t, i18n.language, s.at)}</time>
                </li>
              );
            })}
          </ol>
        )
      )}
      {!stalled && <WorkSweep color={color(i) ?? "sky"} waiting={waiting} />}
    </section>
  );
}

/** The agents offered by "Pedir a um agente", the ones that answer me (as the server asks): a developer first. */
function useAgentChoices() {
  const { dir } = useActors();
  const agents = dir.agents.filter(canTalk);
  const dev = agents.find((a) => /dev|engenh|program|cód/i.test(`${a.role} ${a.name}`)) ?? agents[0];
  return dev ? [dev, ...agents.filter((a) => a.id !== dev.id)] : [];
}

function AskAgent({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const { avatar } = useActors();
  const [agent, ...others] = useAgentChoices();
  if (!agent) return null;
  const ask = (a: { id: string; name: string }) => {
    const g = agentGrammar(a.name);
    action.mutate(
      { type: "ask", id: issue.id, agentId: a.id },
      { onSuccess: () => toast.show(t("issues.asked", { context: g.context, name: a.name })) },
    );
  };
  const g = agentGrammar(agent.name);
  return (
    <section aria-label={t("issues.askSection")} className="issue-ask">
      <div className="issue-ask__row ac-mediarow ac-mediarow--row">
        <span className="ac-mediarow__face">{avatar({ type: "agent", id: agent.id }, "sm")}</span>
        <span className="ac-mediarow__head">
          <b>{t("issues.askTitle", { context: g.context, name: agent.name })}</b>
        </span>
        <span className="ac-mediarow__body small muted">{t("issues.askText", g)}</span>
      </div>
      <div className="issue-ask__actions">
        <Locked when={action.isPending}>
          <Button variant="agent" icon="agent" size="sm" loading={action.isPending} onClick={() => ask(agent)}>
            {t("issues.askButton", { context: g.context, name: agent.name })}
          </Button>
          {others.slice(0, 3).map((a) => (
            <button key={a.id} type="button" className="issue-ask__other" onClick={() => ask(a)}>
              {avatar({ type: "agent", id: a.id }, "xs")}
              {a.name}
            </button>
          ))}
        </Locked>
      </div>
    </section>
  );
}

/** "Histórico": what happened to the task, oldest first: its events and a line for each comment. */
function History({ activity, loaded }: { activity: IssueActivity[]; loaded: boolean }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const actors = useActors();
  return (
    <section className="issue-history" aria-label={t("issues.tabs.history")}>
      {loaded && activity.length === 0 && <p className="small muted">{t("issues.noActivity")}</p>}
      {activity.map((a) =>
        a.kind === "event" ? (
          <div key={a.id} className="issue-event ac-iconline small muted">
            <Icon name={a.event === "agent_asked" ? "agent" : "waiting"} size={16} />
            <span>
              <b className="issue-event__who">{actors.name(a.author)}</b> {issueEventText(t, a)}
              {a.auto && (
                <Chip icon="repeat" className="issue-event__auto" title={t("issues.autoHint")}>
                  {t("issues.auto")}
                </Chip>
              )}{" "}
              · {whenAt(t, i18n.language, a.createdAt)}
              {/* Asked an agent to implement it: the work conversation is in the asker's DM (only they open it). */}
              {a.event === "agent_asked" && a.textParams?.threadId && a.author.id === me.user.id && (
                <>
                  {" · "}
                  <Link
                    to="/org/$orgId/threads/$threadId"
                    params={{ orgId: org.id, threadId: a.textParams.threadId }}
                    className="ac-link"
                  >
                    {t("issues.openConversation")}
                  </Link>
                </>
              )}
            </span>
          </div>
        ) : (
          <div key={a.id} className="issue-event ac-iconline small muted">
            <Icon name="message" size={16} />
            <span>
              <b className="issue-event__who">{actors.name(a.author)}</b>{" "}
              {t(a.attachments?.length ? "issues.history.commentedFiles" : "issues.history.commented")} ·{" "}
              {whenAt(t, i18n.language, a.createdAt)}
            </span>
          </div>
        ),
      )}
    </section>
  );
}

/** What a task's fields offer and how each changes it, for the strip at its top. */
function useIssueFields(i: Issue) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useIssueAction(org.id);
  const columns = useIssueColumns(org.id).data ?? [];
  const title = useColumnTitle();
  const stageName = useStageName();
  const custom = isCustomBoard(columns);
  const update = (patch: IssuePatch) => action.mutate({ type: "update", id: i.id, patch });
  return {
    column: {
      value: columnIdOf(i, columns) ?? undefined,
      // Every column (also the keyboard way to move a card), under its stage's name only on a customized board: on
      // the plain one each column is its stage, and the name over it said it twice.
      options: STATUSES.flatMap((s) =>
        columnsOf(columns, s).map((c) => ({
          value: c.id,
          label: title(c),
          ...(custom ? { group: stageName(s) } : {}),
          leading: <Icon name={STATUS_ICON[s]} size={16} />,
        })),
      ),
      onChange: (v: string) => update({ columnId: v, boardRank: -Date.now() }),
      // Until the board's columns load, the task's stage: the select never shows an empty box.
      placeholder: stageName(i.status),
    },
    who: {
      value: actorKey(i.assignee),
      options: actors.options(true, actorKey(i.assignee)),
      onChange: (v: string) => update({ assignee: actorFromKey(v) }),
    },
    priority: {
      value: i.priority,
      options: PRIORITIES.map((p) => ({
        value: p,
        label: t(`issues.priority.${p}`),
        leading: <Icon name={PRIORITY_ICON[p]} size={16} />,
      })),
      onChange: (v: string) => update({ priority: v as IssuePriority }),
    },
    due: {
      value: i.dueDate,
      onChange: (v: string) => update({ dueDate: v }),
      onClear: () => update({ dueDate: null }),
      placeholder: t("issues.noDue"),
      locale: i18n.language,
      labels: {
        previousMonth: t("common.previousMonth"),
        nextMonth: t("common.nextMonth"),
        choose: t("common.chooseDate"),
        clear: t("issues.removeDue"),
      },
    },
  };
}

/**
 * Whether a task shows "Who sees it": always, but alone in a personal workspace only once it says anything but
 * everyone (ADR 0159): nobody else is there to see it.
 */
function useWhoSeesShown(i: Issue) {
  const { solo } = usePersonalView();
  return !solo || (i.audience?.mode ?? "everyone") !== "everyone";
}

/**
 * The task's fields as one strip under who made it, at every width: Coluna, Responsável, Prioridade, Prazo and Quem
 * vê, each its icon or face and its value (its name on hover and to a screen reader), then after a hairline its pull
 * requests, labels and GitHub link. With no link yet, "GitHub" opens the field to paste one.
 */
function PropsLine({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const f = useIssueFields(i);
  const [choosing, setChoosing] = useState(false);
  const whoSees = useWhoSeesShown(i);
  const prop = (label: string, control: ReactNode) => (
    <span className="issue-prop" title={label}>
      {control}
    </span>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled row of controls that change at once, not a form's fieldset
    <div className="ac-props issue-props" role="group" aria-label={t("issues.details")}>
      {prop(
        t("issues.column"),
        <Select
          size="sm"
          aria-label={t("issues.column")}
          value={f.column.value}
          onValueChange={f.column.onChange}
          options={f.column.options}
          placeholder={f.column.placeholder}
        />,
      )}
      {prop(
        t("issues.form.assignee"),
        <Select
          size="sm"
          aria-label={t("issues.form.assignee")}
          value={f.who.value}
          onValueChange={f.who.onChange}
          options={f.who.options}
        />,
      )}
      {prop(
        t("issues.form.priority"),
        <Select
          size="sm"
          aria-label={t("issues.form.priority")}
          value={f.priority.value}
          onValueChange={f.priority.onChange}
          options={f.priority.options}
        />,
      )}
      {prop(
        t("issues.due"),
        <DatePicker
          size="sm"
          short
          aria-label={t("issues.due")}
          {...f.due}
          footer={
            i.dueDate && (
              <Link to="/org/$orgId/calendar" params={{ orgId: org.id }} className="ac-link">
                {t("issues.seeCalendar")}
              </Link>
            )
          }
        />,
      )}
      {whoSees &&
        prop(
          t("whoSees.label"),
          <WhoSeesButton select value={i.audience ?? { mode: "everyone" }} onClick={() => setChoosing(true)} />,
        )}
      {choosing && <IssueWhoSeesDialog issue={i} onClose={() => setChoosing(false)} />}
      <span className="ac-props__sep" aria-hidden="true" />
      {i.pullRequests.map((pr) => (
        <a
          key={pr.number}
          href={webUrl(pr.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="issue-link"
          title={pr.openedBy ? t("issues.prBy", { number: pr.number, name: actors.name(pr.openedBy) }) : undefined}
        >
          <GitHubMark />
          {t("issues.pr", { number: pr.number })}
        </a>
      ))}
      {i.labels.map((l) => (
        <span key={l} className="ac-chip issue-label">
          {l}
        </span>
      ))}
      <GithubLink issue={i} />
    </div>
  );
}

/** The GitHub issue or pull request the task is about: a chip that opens it and its ×, or "GitHub" to paste one. */
function GithubLink({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const save = (githubUrl: string | null) =>
    action.mutate(
      { type: "update", id: i.id, patch: { githubUrl } },
      {
        onSuccess: () => {
          setText("");
          setOpen(false);
        },
      },
    );
  const submit = () => {
    const url = text.trim();
    if (action.isPending) return;
    if (!url) return setInvalid(false);
    setInvalid(!isGithubLink(url));
    if (isGithubLink(url)) save(url);
  };
  if (i.githubUrl) {
    return (
      <span className="issue-github">
        <a href={webUrl(i.githubUrl)} target="_blank" rel="noopener noreferrer" className="ac-chip issue-github__chip">
          <GitHubMark />
          <span className="ac-chip__text">{githubLinkLabel(i.githubUrl)}</span>
        </a>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("issues.github.remove")}
          title={t("issues.github.remove")}
          disabled={action.isPending}
          onClick={() => save(null)}
        />
      </span>
    );
  }
  return (
    <Popover
      label={t("issues.github.add")}
      side="bottom"
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setInvalid(false);
      }}
      className="issue-github__pop"
      trigger={
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          aria-label={t("issues.github.add")}
          title={t("issues.github.add")}
        >
          GitHub
        </Button>
      }
    >
      <Locked when={action.isPending}>
        <Field
          className="issue-github__field"
          label={t("issues.github.label")}
          id={`is-github-${i.id}`}
          error={invalid ? t("issues.github.invalid") : undefined}
        >
          <Input
            type="url"
            inputMode="url"
            spellCheck={false}
            value={text}
            placeholder={t("issues.github.placeholder")}
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              submit();
            }}
          />
        </Field>
        <span className="issue-github__acts">
          <Button size="sm" variant="primary" loading={action.isPending} onClick={submit}>
            {t("common.save")}
          </Button>
        </span>
      </Locked>
    </Popover>
  );
}
