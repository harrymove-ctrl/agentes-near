import type { Issue, IssueColumn, IssuePriority } from "@agenteschat/client";
import { useIssueAction, useStartAgentOnTask } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { MAX_UPLOAD_MB } from "@agenteschat/client/lib/files";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AudienceChoice, EVERYONE } from "@agenteschat/client/lib/who-sees";
import {
  Button,
  cx,
  DatePicker,
  DetailsSection,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Locked,
  Menu,
  MenuItem,
  modKey,
  Spinner,
  Switch,
  useAutoGrow,
} from "@agenteschat/ui";
import { type ClipboardEvent, type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { actorFromKey, NO_ACTOR, useActors } from "@/components/actors";
import { useFileDrop } from "@/components/drive/DriveUploads";
import { PendingTile } from "@/components/IssueFiles";
import { useOrg } from "@/components/org-context";
import { WhoSeesButton, WhoSeesDialog } from "@/components/WhoSees";
import { useComposerFiles } from "@/hooks/useComposerFiles";
import { useEdited } from "@/hooks/useEdited";
import { usePersonalView } from "@/hooks/usePersonalView";
import { columnIdOf, columnsOf, PRIORITIES, splitCriteria, useColumnTitle } from "@/lib/issues";
import { useToast } from "@/lib/toast";

/** Description + criteria back into the quick box's text ("-" lines are criteria there). */
const joinCriteria = (description: string, criteria: string[]) =>
  [description.trim(), criteria.map((c) => `- ${c}`).join("\n")].filter(Boolean).join("\n\n");

/**
 * "Nova tarefa". Quick by default: one box (title, text, files) with who, priority, due date and column as
 * small buttons; "Abrir o formulário completo" grows it into the task's own layout (the same buttons under the title,
 * description, criteria as a list, the attachments grid), keeping what was typed. A print pastes (⌘V) anywhere in
 * it, files drop anywhere on it; they go to the Drive at once and are linked to the task when it's created.
 */
export function NewIssueDialog({
  open,
  columnId,
  columns,
  onClose,
}: {
  open: boolean;
  /** The column of A fazer it was asked from (the "+" in its head); else the first. */
  columnId: string | null;
  columns: IssueColumn[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const columnTitle = useColumnTitle();
  const todoColumns = columnsOf(columns, "todo");
  const [column, setColumn] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null | undefined>(undefined);
  if (open && openedWith !== columnId) {
    setOpenedWith(columnId);
    setColumn(columnId);
  }
  if (!open && openedWith !== undefined) setOpenedWith(undefined);
  const chosenColumn = todoColumns.find((c) => c.id === column) ?? todoColumns[0];
  const actors = useActors();
  const action = useIssueAction(org.id);
  const start = useStartAgentOnTask(org.id);
  const [wide, setWide] = useState(false);
  const [title, setTitle] = useState("");
  // The quick box's text; the full form keeps the description and the criteria apart.
  const [text, setText] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState<string[]>([]);
  const [draftCriterion, setDraftCriterion] = useState("");
  const [assignee, setAssignee] = useState(NO_ACTOR);
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [due, setDue] = useState<string | null>(null);
  const [another, setAnother] = useState(false);
  const [audience, setAudience] = useState<AudienceChoice>(EVERYONE);
  // Alone in a personal workspace there is nobody else to see it: "Who sees it" leaves the form while it says
  // everyone, the default (ADR 0159). Anything else always shows.
  const { solo } = usePersonalView();
  const whoSeesShown = !solo || audience.mode !== "everyone";
  const [choosing, setChoosing] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  // The org's Drive: the task has no channel yet.
  const files = useComposerFiles(null, () => textRef.current?.focus());
  const drop = useFileDrop(files.onFiles, open);
  const chosen = actorFromKey(assignee);
  const agent = chosen?.type === "agent" ? actors.dir.agentById.get(chosen.id) : undefined;
  const quickCriteria = wide ? [] : splitCriteria(text).criteria;
  // The text box as tall as its text, also where the engine can't size it from CSS (`field-sizing`, which the Mac
  // app's WebKit lacks); measured again when the form swaps the quick box for the full one (another textarea).
  useAutoGrow(textRef, wide ? `w${description}` : `q${text}`, open);
  const mod = modKey();

  const expand = () => {
    const split = splitCriteria(text);
    setDescription(split.description);
    setCriteria(split.criteria);
    setWide(true);
  };
  const collapse = () => {
    setText(joinCriteria(description, [...criteria, draftCriterion.trim()].filter(Boolean)));
    setDraftCriterion("");
    setWide(false);
  };
  const reset = (keepChoices: boolean) => {
    setTitle("");
    setText("");
    setDescription("");
    setCriteria([]);
    setDraftCriterion("");
    setDue(null);
    files.clear();
    if (!keepChoices) {
      setAssignee(NO_ACTOR);
      setPriority("normal");
      setAudience(EVERYONE);
      setWide(false);
    }
  };
  const close = () => {
    reset(false);
    setAnother(false);
    onClose();
  };
  const ready = title.trim() !== "" && !files.uploading && !action.isPending;
  const unsaved = useEdited(open, [title, text, description, criteria, draftCriterion, due, files.items.length]);
  /** "Pedir" right after creating: when it can't start, the toast says why, with Pedir de novo. */
  const startAgent = (issue: Issue, picked: { id: string; name: string }, again = false) => {
    const g = agentGrammar(picked.name);
    start.mutateAsync({ issueId: issue.id, agentId: picked.id }).then(
      () => again && toast.show(t("issues.asked", g)),
      (error: unknown) =>
        toast.show(
          t("issues.form.notStarted", { number: issue.number, ...g }),
          "error",
          { label: t("issues.form.askAgain"), run: () => startAgent(issue, picked, true) },
          errorText(t, error, i18n.language),
        ),
    );
  };
  const submit = () => {
    if (!ready) return;
    const body = wide
      ? { description: description.trim(), criteria: [...criteria, draftCriterion.trim()].filter(Boolean) }
      : splitCriteria(text);
    action.mutate(
      {
        type: "create",
        input: {
          title: title.trim(),
          description: body.description,
          criteria: body.criteria,
          assignee: chosen?.type === "person" ? chosen : null,
          priority,
          dueDate: due,
          audience,
          ...(files.attached.length ? { attachmentIds: files.attached.map((f) => f.id) } : {}),
        },
      },
      {
        onSuccess: (created) => {
          const issue = created as Issue;
          // New tasks land in the first column of A fazer; another one was chosen.
          if (chosenColumn && chosenColumn.id !== columnIdOf(issue, columns) && chosen?.type !== "agent")
            action.mutate({ type: "update", id: issue.id, patch: { columnId: chosenColumn.id } });
          toast.show(t("issues.form.created", { number: issue.number }));
          // An agent picked here starts right away ("Pedir"): assigned, its run linked, in progress.
          if (chosen?.type === "agent") startAgent(issue, { id: chosen.id, name: agent?.name ?? "" });
          if (another) {
            reset(true);
            // After the form unlocks: a disabled field takes no focus.
            requestAnimationFrame(() => titleRef.current?.focus());
          } else close();
        },
      },
    );
  };
  // A print pasted anywhere in the form (title, text, criteria) becomes an attachment.
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData?.files ?? []);
    if (pasted.length === 0) return;
    e.preventDefault();
    files.onFiles(pasted);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const pick = () => picker.current?.click();
  const agentNote = agent && (
    <p className="issue-agent-note ac-iconline">
      <Icon name="shield" size={14} />
      <span>
        {t(
          files.items.length > 0 || wide ? "issues.form.agentStartsAll" : "issues.form.agentStarts",
          agentGrammar(agent.name),
        )}
      </span>
    </p>
  );
  const priorityLabel = (p: IssuePriority) => t(`issues.priority.${p}`);
  // Who, priority, who sees it, the due date and the column: one strip in both forms, under the title in the full one.
  const props = (
    <div className="ac-props issue-new__props">
      <Menu
        label={t("issues.form.assignee")}
        trigger={
          <Button
            size="sm"
            icon={chosen ? undefined : "person"}
            aria-label={chosen ? `${t("issues.form.assignee")}: ${actors.name(chosen)}` : t("issues.form.assignee")}
          >
            {chosen && <ActorAvatar actor={chosen} name={actors.name(chosen)} size="xs" />}
            {chosen ? actors.name(chosen) : t("issues.form.assignee")}
          </Button>
        }
      >
        {actors.options(true).map((o) => (
          <MenuItem key={o.value} leading={o.leading} onSelect={() => setAssignee(o.value)}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        label={t("issues.form.priority")}
        trigger={
          <Button size="sm" icon="flag" aria-label={`${t("issues.form.priority")}: ${priorityLabel(priority)}`}>
            {priorityLabel(priority)}
          </Button>
        }
      >
        {PRIORITIES.map((p) => (
          <MenuItem key={p} icon="flag" onSelect={() => setPriority(p)}>
            {priorityLabel(p)}
          </MenuItem>
        ))}
      </Menu>
      {whoSeesShown && <WhoSeesButton value={audience} onClick={() => setChoosing(true)} />}
      <DueDate value={due} onChange={setDue} />
      {todoColumns.length > 1 && chosenColumn && (
        <Menu
          label={t("issues.column")}
          trigger={
            <Button size="sm" icon="stageTodo" aria-label={`${t("issues.column")}: ${columnTitle(chosenColumn)}`}>
              {columnTitle(chosenColumn)}
            </Button>
          }
        >
          {todoColumns.map((c) => (
            <MenuItem key={c.id} icon="stageTodo" onSelect={() => setColumn(c.id)}>
              {columnTitle(c)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
  const createButton = (
    <Button type="submit" variant="primary" kbd={[mod, "↵"]} disabled={!ready} loading={action.isPending}>
      {t("issues.form.create")}
    </Button>
  );
  const fileInput = (
    <input
      ref={picker}
      type="file"
      multiple
      hidden
      tabIndex={-1}
      aria-label={t("channel.attach")}
      onChange={(e) => {
        const list = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (list.length > 0) files.onFiles(list);
      }}
    />
  );
  const dropLayer = drop.over && (
    <div className="issue-new__drop" aria-hidden="true">
      <span className="issue-new__drop-in">
        <Icon name="upload" />
        <b>{t("issues.form.drop")}</b>
        <span>{t("issues.form.dropText", { max: MAX_UPLOAD_MB })}</span>
      </span>
    </div>
  );
  const pasteHint = t("issues.form.pasteHint", { keys: mod === "⌘" ? "⌘V" : "Ctrl+V" });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={t("issues.new")}
      subtitle={wide && chosenColumn ? t("issues.newIn", { column: columnTitle(chosenColumn) }) : undefined}
      closeLabel={t("common.close")}
      unsaved={unsaved}
      width={wide ? 1040 : 640}
      className={cx("issue-new", wide && "issue-new--wide")}
      actions={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={wide ? "shrink" : "expand"}
          aria-label={t(wide ? "issues.form.collapse" : "issues.form.expand")}
          title={t(wide ? "issues.form.collapse" : "issues.form.expand")}
          onClick={wide ? collapse : expand}
        />
      }
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        {...drop.props}
      >
        {dropLayer}
        {fileInput}
        <Locked when={action.isPending}>
          {wide ? (
            <DialogBody className="issue-new__wide">
              <div className="issue-new__main">
                <input
                  ref={titleRef}
                  className="issue-new__title issue-new__title--lg"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("issues.form.titleShort")}
                  aria-label={t("issues.form.title")}
                  autoFocus
                />
                {props}
                {agentNote}
                <DetailsSection title={t("issues.description")}>
                  <div className="issue-new__editor">
                    <textarea
                      ref={textRef}
                      className="issue-new__text"
                      rows={4}
                      maxLength={50_000}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={t("issues.form.descriptionPlaceholder")}
                      aria-label={t("issues.description")}
                    />
                    {files.items.some((f) => f.preview) && (
                      <div className="issue-new__images">
                        {files.items
                          .filter((f) => f.preview)
                          .map((f) => (
                            <span key={f.key} className="issue-new__image" data-status={f.status}>
                              <img src={f.preview} alt={f.name} />
                              {f.status === "uploading" && <Spinner size={24} className="issue-new__image-state" />}
                              <span className="issue-new__image-name small">{f.name}</span>
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                  <p className="issue-new__hint small muted">
                    <Icon name="image" size={14} />
                    {pasteHint}
                  </p>
                </DetailsSection>
                <DetailsSection title={t("issues.criteria")} count={criteria.length || undefined}>
                  <ul className="issue-new__criteria">
                    {criteria.map((c, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the list is edited in place, by position
                      <li key={i} className="issue-new__criterion">
                        <span className="issue-new__box" aria-hidden="true" />
                        <input
                          value={c}
                          onChange={(e) => setCriteria((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                          // Enter goes to the new-criterion line; only ⌘↵ or the button creates the task.
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" || e.metaKey || e.ctrlKey) return;
                            e.preventDefault();
                            addRef.current?.focus();
                          }}
                          aria-label={t("issues.criteria")}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon="close"
                          aria-label={t("issues.form.removeCriterion")}
                          onClick={() => setCriteria((all) => all.filter((_, j) => j !== i))}
                        />
                      </li>
                    ))}
                    <li className="issue-new__criterion issue-new__criterion--add">
                      <Icon name="plus" size={16} />
                      <input
                        value={draftCriterion}
                        onChange={(e) => setDraftCriterion(e.target.value)}
                        ref={addRef}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" || e.metaKey || e.ctrlKey) return;
                          e.preventDefault();
                          if (!draftCriterion.trim()) return;
                          setCriteria((all) => [...all, draftCriterion.trim()]);
                          setDraftCriterion("");
                        }}
                        placeholder={t("issues.form.addCriterion")}
                        aria-label={t("issues.form.addCriterion")}
                      />
                    </li>
                  </ul>
                </DetailsSection>
                <DetailsSection title={t("issues.files.title")} count={files.items.length || undefined}>
                  <div className="issue-files__grid">
                    {files.items.map((f) => (
                      <PendingTile key={f.key} file={f} onRemove={() => files.remove(f.key)} />
                    ))}
                    <button type="button" className="issue-files__add" onClick={pick}>
                      <Icon name="upload" />
                      <b>{t("issues.files.add")}</b>
                      <span>{t("issues.files.addHint")}</span>
                    </button>
                  </div>
                </DetailsSection>
              </div>
            </DialogBody>
          ) : (
            <DialogBody className="issue-new__quick">
              <input
                ref={titleRef}
                className="issue-new__title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("issues.form.titleShort")}
                aria-label={t("issues.form.title")}
                autoFocus
              />
              <textarea
                ref={textRef}
                className="issue-new__text"
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("issues.form.quickPlaceholder")}
                aria-label={t("issues.form.description")}
              />
              {files.attachments && (
                <div className="ac-composer__attachments issue-new__files">{files.attachments}</div>
              )}
              {quickCriteria.length > 0 && (
                <p className="issue-new__hint small muted" aria-live="polite">
                  <Icon name="checks" size={14} />
                  {t("issues.form.criteriaFound", { count: quickCriteria.length })}
                </p>
              )}
              {props}
              {agentNote}
            </DialogBody>
          )}
        </Locked>
        <DialogFooter className="issue-new__foot">
          {wide ? (
            <span className="issue-new__grow small muted">{t("issues.form.createHint", { keys: `${mod}↵` })}</span>
          ) : (
            <span className="issue-new__again">
              <Locked when={action.isPending}>
                <Switch id="ni-again" checked={another} onCheckedChange={setAnother} />
              </Locked>
              <label htmlFor="ni-again">{t("issues.form.another")}</label>
            </span>
          )}
          {!wide && <span className="issue-new__grow" />}
          {wide ? (
            <Button type="button" onClick={close}>
              {t("issues.form.cancel")}
            </Button>
          ) : (
            <Locked when={action.isPending}>
              <Button
                type="button"
                variant="ghost"
                iconOnly
                icon="attach"
                aria-label={t("channel.attach")}
                onClick={pick}
              />
            </Locked>
          )}
          {createButton}
        </DialogFooter>
      </form>
      {choosing && (
        <WhoSeesDialog
          title={t("whoSees.taskTitle")}
          value={audience}
          onClose={() => setChoosing(false)}
          onSave={(next) => {
            setAudience(next);
            setChoosing(false);
          }}
        />
      )}
    </Dialog>
  );
}

/** The due date as the app picks dates everywhere (34px, like the small buttons beside it). */
function DueDate({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t, i18n } = useTranslation();
  return (
    <DatePicker
      size="sm"
      value={value}
      onChange={onChange}
      onClear={() => onChange(null)}
      placeholder={t("issues.due")}
      aria-label={t("issues.due")}
      locale={i18n.language}
      labels={{
        previousMonth: t("common.previousMonth"),
        nextMonth: t("common.nextMonth"),
        choose: t("common.chooseDate"),
        clear: t("issues.removeDue"),
      }}
    />
  );
}
