import type { Issue, IssueColumn, IssuePatch, IssueStatus } from "@agenteschat/client";
import { keys, useIssueAction, useIssueColumnAction } from "@agenteschat/client";
import {
  Button,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  MenuHeading,
  MenuItem,
  MenuNote,
  MenuSeparator,
  OptionList,
  useDragScroll,
} from "@agenteschat/ui";
import { type Query, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import {
  BOARD,
  columnIdOf,
  columnsOf,
  isCustomBoard,
  STAGE_COLUMNS_MAX,
  STATUS_ICON,
  useColumnTitle,
  useStageName,
} from "@/lib/issues";
import { useToast } from "@/lib/toast";
import type { DragEntry, IssueDrag } from "./issue-drag";

/** The issue lists in the cache (every search): a move shows in all of them at once. */
const isList = (q: Query) => q.queryKey[3] === "list";

/**
 * Changes an issue optimistically: `shown` lands on every list in the cache at once, `patch` goes to the server, and
 * an error puts the lists back as they were (the server's answer refreshes them anyway).
 */
export function usePatchIssue() {
  const { org } = useOrg();
  const qc = useQueryClient();
  const action = useIssueAction(org.id);
  return (issue: Issue, patch: IssuePatch, shown: Partial<Issue>, onDone?: () => void) => {
    const filters = { queryKey: keys.issues(org.id), predicate: isList };
    void qc.cancelQueries(filters);
    const before = qc.getQueriesData<Issue[]>(filters);
    qc.setQueriesData<Issue[]>(filters, (list) => list?.map((i) => (i.id === issue.id ? { ...i, ...shown } : i)));
    action.mutate(
      { type: "update", id: issue.id, patch },
      {
        onError: () => {
          for (const [key, data] of before) qc.setQueryData(key, data);
        },
        onSuccess: onDone,
      },
    );
  };
}

/**
 * Moves an issue to a column at a rank, optimistically (the card lands at
 * once; the server's answer or an error puts the truth back). Says where it
 * went with "Desfazer" when the column changed.
 */
export function useMoveIssue(columns: IssueColumn[]) {
  const { t } = useTranslation();
  const toast = useToast();
  const patch = usePatchIssue();
  const title = useColumnTitle();
  const stageName = useStageName();
  const custom = isCustomBoard(columns);
  const apply = (issue: Issue, column: IssueColumn, boardRank: number, onDone?: () => void) =>
    patch(issue, { columnId: column.id, boardRank }, { columnId: column.id, status: column.stage, boardRank }, onDone);
  return (issue: Issue, column: IssueColumn, boardRank: number) => {
    const fromId = columnIdOf(issue, columns);
    const from = columns.find((c) => c.id === fromId);
    const wasRank = issue.boardRank;
    apply(issue, column, boardRank, () => {
      if (!from || from.id === column.id) return;
      const detail =
        from.stage !== column.stage && custom
          ? t("issues.movedStage", { stage: stageName(column.stage), number: issue.number })
          : t("issues.movedDetail", { number: issue.number, title: issue.title });
      toast.show(
        t("issues.movedTo", { column: title(column) }),
        "info",
        {
          label: t("issues.undo"),
          run: () => apply({ ...issue, columnId: column.id, status: column.stage, boardRank }, from, wasRank),
        },
        detail,
      );
    });
  };
}

/** A group of the board or the list: a column (grouped by stage), an assignee or a priority. */
export interface IssueGroup {
  id: string;
  name: string;
  /** Its cards, in the order they show. */
  items: Issue[];
  /** Before its name: the stage's icon, a face, the priority's mark. */
  lead: ReactNode;
  /** What it says while a card moves and it has none: what a drop there does. */
  dropText: string;
}

/** The board's empty space, where a press and a drag slide it sideways: never a card, a word or a button. */
const BOARD_SPACE =
  ".issues-boardwrap, .issues-board, .issues-stage, .issues-stage__head, .issues-stage__cols, .issues-col, .issues-col__head, .issues-col__grow, .issues-col__cards";

/** How a card shows while one moves: under the pointer (hidden), flying home (landing), picked with Space. */
export type CardState = Extract<DragEntry<Issue>, { kind: "card" }>["state"];

/**
 * The cards of one group as they show now: each card in its slot (hidden while it is under the pointer), the well
 * where a moving card would land, or what an empty group says (only while a card moves: what a drop there does).
 */
function ColumnCards({
  group: g,
  dnd,
  renderCard,
}: {
  group: IssueGroup;
  dnd: IssueDrag<Issue>;
  renderCard: (issue: Issue, group: string, state: CardState) => ReactNode;
}) {
  const { t } = useTranslation();
  const entries = dnd.entries(g.id);
  const shown = entries.some((e) => e.kind === "spot" || e.state !== "hidden");
  return (
    <div className="issues-col__cards" data-drop={g.id}>
      {entries.map((e) =>
        e.kind === "spot" ? (
          <div key={e.key} className="issue-spot" data-spot style={e.style} aria-hidden="true" />
        ) : (
          <div
            key={e.item.id}
            className="issues-col__slot"
            data-slot={e.item.id}
            hidden={e.state === "hidden" || undefined}
            data-landing={e.state === "landing" || undefined}
          >
            {renderCard(e.item, g.id, e.state)}
          </div>
        ),
      )}
      {!shown && dnd.active && (
        <p className="issues-col__drop" aria-hidden="true">
          {g.dropText}
        </p>
      )}
      {!shown && !dnd.active && <p className="issues-col__empty">{t("issues.columnEmpty")}</p>}
    </div>
  );
}

/**
 * The board. Grouped by stage: the org's columns, each in a fixed stage, with stage headers only when the board is
 * customized, each column's menu, and "+" in the head of A fazer's columns (`onNew`, for who may create tasks).
 * Grouped by assignee or priority: one column each. Cards move between and inside columns (`useIssueDrag`).
 */
export function Board({
  groups,
  stages,
  columns,
  dnd,
  renderCard,
  onNew,
}: {
  groups: IssueGroup[];
  /** Grouped by stage: the stages with their columns (each column one of `groups`); else null. */
  stages: { stage: IssueStatus; columns: IssueColumn[] }[] | null;
  columns: IssueColumn[];
  dnd: IssueDrag<Issue>;
  renderCard: (issue: Issue, group: string, state: CardState) => ReactNode;
  /** "Nova tarefa" in that column of A fazer; none for who may not create tasks. */
  onNew?: (columnId: string) => void;
}) {
  const stageName = useStageName();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ afterId: string | null } | null>(null);
  const [deleting, setDeleting] = useState<IssueColumn | null>(null);
  const grouped = stages !== null && isCustomBoard(columns);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const wrap = useRef<HTMLDivElement>(null);
  useDragScroll(wrap, BOARD_SPACE);
  const column = (g: IssueGroup, head: ReactNode, stage?: IssueStatus) => (
    <section
      key={g.id}
      className={cx("issues-col", dnd.over === g.id && "is-over", stage === "canceled" && "is-canceled")}
      aria-label={g.name}
      data-col
    >
      {head}
      <ColumnCards group={g} dnd={dnd} renderCard={renderCard} />
    </section>
  );

  return (
    <>
      {/* As Trello's: the board fills the window under the page's head (under a tall one, a window's height the page
          scrolls down to), its scrollbar along the window's bottom, each column scrolling on its own (`.page-split`,
          over-pages.css); a press on its empty space and a drag slides it. */}
      <div className="issues-boardframe page-split">
        <div ref={wrap} className="issues-boardwrap" data-scroll-restoration-id="issues-board">
          <div className={cx("issues-board", grouped && "is-grouped")}>
            {stages ? (
              stages.map(({ stage, columns: cols }) => (
                <section
                  key={stage}
                  className="issues-stage"
                  style={{ "--n": cols.length } as CSSProperties}
                  // A named region only when it groups columns (a plain board names each column).
                  aria-label={grouped ? stageName(stage) : undefined}
                >
                  {grouped && (
                    <div className="issues-stage__head">
                      <Icon name={STATUS_ICON[stage]} size={16} />
                      <h2>{stageName(stage)}</h2>
                      <span>{cols.reduce((n, c) => n + dnd.count(c.id), 0)}</span>
                    </div>
                  )}
                  <div className="issues-stage__cols">
                    {cols.map((col, k) => {
                      const g = byId.get(col.id);
                      if (!g) return null;
                      return column(
                        g,
                        <ColumnHead
                          column={col}
                          siblings={cols}
                          index={k}
                          count={dnd.count(col.id)}
                          showIcon={!grouped}
                          renaming={renaming === col.id}
                          onRename={() => setRenaming(col.id)}
                          onRenamed={() => setRenaming(null)}
                          onAddAfter={() => setAdding({ afterId: col.id })}
                          onDelete={() => setDeleting(col)}
                          onNew={onNew && col.stage === "todo" ? () => onNew(col.id) : undefined}
                        />,
                        stage,
                      );
                    })}
                  </div>
                </section>
              ))
            ) : (
              <section className="issues-stage" style={{ "--n": groups.length } as CSSProperties}>
                <div className="issues-stage__cols">
                  {groups.map((g) =>
                    column(
                      g,
                      <div className="issues-col__head">
                        {g.lead}
                        <h2>{g.name}</h2>
                        <span className="tabular" data-count={g.id}>
                          {dnd.count(g.id)}
                        </span>
                      </div>,
                    ),
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
      {stages && (
        <AddColumnDialog
          open={adding !== null}
          afterId={adding?.afterId ?? null}
          columns={columns}
          onClose={() => setAdding(null)}
        />
      )}
      {stages && deleting && (
        <DeleteColumnDialog
          column={deleting}
          columns={columns}
          issues={groups.flatMap((g) => g.items)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

/**
 * A column's head: its stage icon (plain board), name (or the rename field), count, then at its end "+" (a new task in
 * it, A fazer's columns only) and "…", 8 apart. A long name wraps, its first line on the buttons' middle.
 */
function ColumnHead({
  column: col,
  siblings,
  index,
  count,
  showIcon,
  renaming,
  onRename,
  onRenamed,
  onAddAfter,
  onDelete,
  onNew,
}: {
  column: IssueColumn;
  siblings: IssueColumn[];
  index: number;
  count: number;
  showIcon: boolean;
  renaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
  onAddAfter: () => void;
  onDelete: () => void;
  onNew?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const title = useColumnTitle();
  const stageName = useStageName();
  const action = useIssueColumnAction(org.id);
  const name = title(col);
  const only = siblings.length === 1;
  const save = (value: string) => {
    onRenamed();
    const v = value.trim();
    if (!v || v === name) return;
    const was = col.name;
    action.mutate(
      { type: "update", columnId: col.id, name: v },
      {
        onSuccess: () =>
          toast.show(
            t("issues.columns.renamed", { name: v }),
            "info",
            // A default column has no name of its own to go back to.
            was
              ? { label: t("issues.undo"), run: () => action.mutate({ type: "update", columnId: col.id, name: was }) }
              : undefined,
          ),
      },
    );
  };
  return (
    <div className="issues-col__head">
      {showIcon && <Icon name={STATUS_ICON[col.stage]} size={16} />}
      {renaming ? (
        <Input
          className="issues-col__rename"
          defaultValue={name}
          maxLength={40}
          aria-label={t("issues.columns.nameLabel")}
          autoComplete="off"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onRenamed();
            }
          }}
          onBlur={(e) => save(e.currentTarget.value)}
        />
      ) : (
        <>
          <h2>{name}</h2>
          <span className="tabular" data-count={col.id}>
            {count}
          </span>
          <span className="issues-col__grow" />
          {onNew && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="plus"
              aria-label={t("issues.newIn", { column: name })}
              title={t("issues.newIn", { column: name })}
              onClick={onNew}
            />
          )}
          {col.stage !== "canceled" && (
            <Menu
              align="end"
              label={t("issues.columns.options", { name })}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="more"
                  aria-label={t("issues.columns.options", { name })}
                />
              }
            >
              <MenuHeading>{col.name ? `${name} · ${stageName(col.stage)}` : stageName(col.stage)}</MenuHeading>
              {index === 0 && <MenuNote>{t(`issues.columns.entry.${col.stage}`)}</MenuNote>}
              <MenuItem icon="edit" onSelect={onRename}>
                {t("issues.columns.rename")}
              </MenuItem>
              <MenuItem icon="layers" onSelect={onAddAfter}>
                {t("issues.columns.addAfter")}
              </MenuItem>
              <MenuItem
                icon="chevronLeft"
                disabled={index === 0}
                onSelect={() => action.mutate({ type: "update", columnId: col.id, index: index - 1 })}
              >
                {t("issues.columns.moveLeft")}
              </MenuItem>
              <MenuItem
                icon="chevronRight"
                disabled={index === siblings.length - 1}
                onSelect={() => action.mutate({ type: "update", columnId: col.id, index: index + 1 })}
              >
                {t("issues.columns.moveRight")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon="trash" danger disabled={only} onSelect={onDelete}>
                {t("issues.columns.delete")}
              </MenuItem>
              {only && <MenuNote>{t("issues.columns.onlyOne")}</MenuNote>}
            </Menu>
          )}
        </>
      )}
    </div>
  );
}

/** "Nova coluna": a name and one question, the stage. */
export function AddColumnDialog({
  open,
  afterId,
  columns,
  onClose,
}: {
  open: boolean;
  afterId: string | null;
  columns: IssueColumn[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const title = useColumnTitle();
  const stageName = useStageName();
  const action = useIssueColumnAction(org.id);
  const after = afterId ? columns.find((c) => c.id === afterId) : undefined;
  const [name, setName] = useState("");
  const [stage, setStage] = useState<IssueStatus | null>(null);
  // Opening again (another "Adicionar coluna depois"): start from that column's stage.
  const [openedFor, setOpenedFor] = useState<string | null | undefined>(undefined);
  if (open && openedFor !== afterId) {
    setOpenedFor(afterId);
    setName("");
    setStage(after?.stage ?? null);
  }
  if (!open && openedFor !== undefined) setOpenedFor(undefined);
  const where = !stage
    ? t("issues.columns.whereNone")
    : after && after.stage === stage
      ? t("issues.columns.whereAfter", { name: title(after) })
      : t("issues.columns.whereEnd", { stage: stageName(stage) });
  // A stage at its most columns takes no more: said before the person types, never as the server's refusal.
  const full = stage !== null && columnsOf(columns, stage).length >= STAGE_COLUMNS_MAX;
  const ready = Boolean(name.trim() && stage) && !full;
  const create = () => {
    if (!stage || !name.trim()) return;
    const before = new Set(columns.map((c) => c.id));
    const chosen = stage;
    action.mutate(
      { type: "add", name: name.trim(), stage: chosen, afterId: after?.stage === chosen ? after.id : null },
      {
        onSuccess: (next) => {
          const made = next.find((c) => !before.has(c.id));
          onClose();
          toast.show(
            t("issues.columns.created", { name: name.trim() }),
            "info",
            made
              ? {
                  label: t("issues.undo"),
                  run: () => {
                    const to = columnsOf(next, made.stage).find((c) => c.id !== made.id);
                    if (to) action.mutate({ type: "delete", columnId: made.id, moveTo: to.id });
                  },
                }
              : undefined,
            t("issues.columns.createdDetail", { stage: stageName(chosen) }),
          );
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("issues.columns.newTitle")}
      description={where}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Locked when={action.isPending}>
          <DialogBody>
            <Field label={t("issues.columns.name")} id="ic-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                autoComplete="off"
                placeholder={t("issues.columns.namePlaceholder")}
              />
            </Field>
            <div className="issues-stagepick">
              <span className="ac-field__label" id="ic-stage">
                {t("issues.columns.stageQuestion")}
              </span>
              <OptionList
                layout="tiles"
                aria-labelledby="ic-stage"
                value={stage ?? ("" as IssueStatus)}
                onValueChange={setStage}
                options={BOARD.map((s) => ({
                  value: s,
                  leading: <Icon name={STATUS_ICON[s]} size={16} />,
                  title: stageName(s),
                  description: t(`issues.columns.stageHint.${s}`),
                }))}
              />
            </div>
            <p className="issues-explain ac-iconline">
              <Icon name={full ? "alert" : "arrowRight"} size={16} />
              <span>
                {full && stage
                  ? t("issues.columns.stageFull", { stage: stageName(stage), max: STAGE_COLUMNS_MAX })
                  : t(`issues.columns.stageExplain.${stage ?? "in_progress"}`)}
              </span>
            </p>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("issues.columns.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || action.isPending} loading={action.isPending}>
            {t("issues.columns.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir a coluna X?": where its tasks go, grouped by stage; says when they change stage. */
function DeleteColumnDialog({
  column: col,
  columns,
  issues,
  onClose,
}: {
  column: IssueColumn;
  columns: IssueColumn[];
  issues: Issue[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const title = useColumnTitle();
  const stageName = useStageName();
  const action = useIssueColumnAction(org.id);
  const issueAction = useIssueAction(org.id);
  const others = columns.filter((c) => c.id !== col.id && c.stage !== "canceled");
  const [dest, setDest] = useState(() => columnsOf(others, col.stage)[0]?.id ?? others[0]?.id ?? "");
  // All of its tasks (not only the filtered ones on screen).
  const all = qc.getQueriesData<Issue[]>({ queryKey: keys.issues(org.id), predicate: isList });
  const inIt = [...new Map(all.flatMap(([, list]) => list ?? []).map((i) => [i.id, i])).values()].filter(
    (i) => columnIdOf(i, columns) === col.id,
  );
  const items = inIt.length > 0 ? inIt : issues.filter((i) => columnIdOf(i, columns) === col.id);
  const n = items.length;
  const to = columns.find((c) => c.id === dest);
  const name = title(col);
  const remove = () => {
    if (!to) return;
    const sibling = columnsOf(columns, col.stage);
    const prev = sibling[sibling.indexOf(col) - 1];
    const before = new Set(columns.filter((c) => c.id !== col.id).map((c) => c.id));
    action.mutate(
      { type: "delete", columnId: col.id, moveTo: to.id },
      {
        onSuccess: () => {
          onClose();
          toast.show(
            t("issues.columns.deleted", { name }),
            "info",
            {
              label: t("issues.undo"),
              // Back as it was: the column in its place, its tasks in it again.
              run: () =>
                action.mutate(
                  { type: "add", name, stage: col.stage, afterId: prev?.id ?? null },
                  {
                    onSuccess: (next) => {
                      const made = next.find((c) => !before.has(c.id));
                      if (!made) return;
                      if (!prev) action.mutate({ type: "update", columnId: made.id, index: 0 });
                      for (const i of items)
                        issueAction.mutate({
                          type: "update",
                          id: i.id,
                          patch: { columnId: made.id, boardRank: i.boardRank },
                        });
                    },
                  },
                ),
            },
            n > 0 ? t("issues.columns.deletedDetail", { count: n, name: title(to) }) : undefined,
          );
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("issues.columns.deleteTitle", { name })}
      description={n > 0 ? t("issues.columns.deleteBody", { count: n }) : t("issues.columns.deleteEmpty")}
      closeLabel={t("common.close")}
      width={480}
    >
      {n > 0 && (
        <Locked when={action.isPending}>
          <DialogBody>
            <div className="issues-dests" role="radiogroup" aria-label={t("issues.columns.destinations")}>
              {BOARD.map((s) => {
                const cs = columnsOf(others, s);
                if (cs.length === 0) return null;
                return (
                  <div key={s} className="issues-dests__stage">
                    <span>
                      <Icon name={STATUS_ICON[s]} size={14} />
                      {stageName(s)}
                    </span>
                    <div className="issues-dests__row">
                      {cs.map((c) => (
                        // biome-ignore lint/a11y/useSemanticElements: a choice button in a radio group
                        <button
                          key={c.id}
                          type="button"
                          role="radio"
                          aria-checked={dest === c.id}
                          className="issues-dest"
                          onClick={() => setDest(c.id)}
                        >
                          {title(c)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {to && to.stage !== col.stage && (
              <p className="issues-explain ac-iconline">
                <Icon name="arrowRight" size={16} />
                <span>
                  {t("issues.columns.stageChange", {
                    count: n,
                    from: stageName(col.stage),
                    to: stageName(to.stage),
                  })}
                </span>
              </p>
            )}
          </DialogBody>
        </Locked>
      )}
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t("issues.columns.cancel")}
        </Button>
        <Button
          variant="danger"
          icon="trash"
          disabled={!to || action.isPending}
          loading={action.isPending}
          onClick={remove}
        >
          {n > 0 && to ? t("issues.columns.deleteMove", { name: title(to) }) : t("issues.columns.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
