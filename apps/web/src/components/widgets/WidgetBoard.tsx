import type { Dashboard, HomeTile, Widget } from "@agenteschat/client";
import { type BoardItem, boardItems, layoutOf, resizeItem, useRefreshWidget, useSaveLayout } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  Card,
  CardHorizon,
  CardMore,
  cx,
  Dialog,
  DialogBody,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  useCardCut,
  WidgetCard,
} from "@agenteschat/ui";
import { layoutToSize, nextSize, sizeToLayout } from "@agenteschat/ui/widgets/spec";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "@/hooks/useNow";
import { type GridMove, useGridDrag } from "@/lib/grid-drag";
import { useToast } from "@/lib/toast";
import { useWidgetAgent, WidgetFace, WidgetFoot, widgetTitle } from "./parts";
import { RemoveWidgetDialog } from "./RemoveWidgetDialog";
import "./widgets.css";

/** The grip of a card in Organize: the board's drag on it (Space or Enter picks the card up, the arrows move it). */
export type GripProps = ButtonHTMLAttributes<HTMLButtonElement> & { "data-grip"?: string };

/** A fixed tile's controls in Organize: it moves (dragged, or by its grip's keys) but keeps its size. */
export interface TileOrganize {
  grip: GripProps;
}

/** A fixed tile of a home board: what it shows, or a function of Organize (null outside it) that draws it. */
export type BoardTileSlot = ReactNode | ((organize: TileOrganize | null) => ReactNode);

type TileKey = "waiting" | "working";

export interface WidgetBoardProps {
  orgId: string;
  board: Dashboard;
  /** "Organize": drag to reorder, cycle the size, remove. */
  arranging: boolean;
  /** Home's fixed tiles ("Waiting on you", "Working now"), placed by the board's `tiles`. */
  tiles?: Partial<Record<TileKey, BoardTileSlot>>;
  /** The fixed tiles' names, for what a screen reader hears while one moves. */
  tileNames?: Partial<Record<TileKey, string>>;
  /**
   * Início showing another board ("Use on Home", ADR 0135 §18): the person's own home board, whose fixed tiles sit
   * among this board's widgets. Their places are saved on it (the person's alone), the widgets' order on the board
   * (when the person edits it).
   */
  homeTiles?: { boardId: string; tiles: HomeTile[] };
  onOpen: (widgetId: string) => void;
  /** "Change when it updates" (else it opens the widget, whose panel changes it). */
  onChangeSchedule?: (widgetId: string) => void;
}

/**
 * A board's grid (ADR 0135): 4 columns, each widget S (1×1), M (2×1) or L (2×2), a home board's fixed tiles among
 * them; a widget is added from the header's "+", not from a tile on the board. Each card has Update now and its
 * menu (Open, Update now, Ask for a change, Change when it updates, Remove), a failure's Resolve, and in Organize:
 * drag with a mouse or a finger (`useGridDrag`: the card lifts, the others slide out of its way, a pixel well marks
 * where it lands), the grip's keys, the size button, remove. Every change is saved at once (`useSaveLayout`,
 * optimistic) and the cells slide to their new places; a remove asks first (`RemoveWidgetDialog`).
 */
export function WidgetBoard({
  orgId,
  board,
  arranging,
  tiles,
  tileNames,
  homeTiles,
  onOpen,
  onChangeSchedule,
}: WidgetBoardProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useSaveLayout(orgId);
  const [removing, setRemoving] = useState<Widget | null>(null);
  const now = useNow(60_000);
  const helpId = useId();
  const fixed = homeTiles ? homeTiles.tiles : board.kind === "home" ? board.tiles : [];
  const items = boardItems(
    board.widgets,
    fixed.filter((x) => tiles?.[x.key]),
  );
  const fresh = useArrivals(board.widgets);
  const editable = board.canEdit;
  // The fixed tiles are the person's own: they move even on a board on Início that the person only sees.
  const organizing = arranging && (editable || Boolean(homeTiles));

  const failed = (e: unknown) => toast.show(errorText(t, e, i18n.language), "error");
  const commit = (next: BoardItem[]) => {
    const layout = layoutOf(next);
    if (!homeTiles) {
      save.mutate({ dashboardId: board.id, home: board.kind === "home", ...layout }, { onError: failed });
      return;
    }
    save.mutate(
      { dashboardId: homeTiles.boardId, home: true, widgets: [], tiles: layout.tiles ?? [] },
      { onError: failed },
    );
    if (editable) save.mutate({ dashboardId: board.id, widgets: layout.widgets }, { onError: failed });
  };
  const nameOf = (item: BoardItem) =>
    item.type === "widget" ? widgetTitle(t, item.widget) : (tileNames?.[item.id] ?? "");
  const grid = useGridDrag<BoardItem>({
    items,
    enabled: organizing,
    onDrop: ({ order }: GridMove) => {
      const byId = new Map(items.map((x) => [x.id, x]));
      const next = order.flatMap((id) => byId.get(id) ?? []);
      if (next.length !== items.length) return false;
      commit(next);
      return true;
    },
    words: {
      picked: (x) => t("widgets.organize.picked", { title: nameOf(x) }),
      moved: (x, position, total) => t("widgets.organize.moved", { title: nameOf(x), position, total }),
      dropped: (x, position, total) => t("widgets.organize.dropped", { title: nameOf(x), position, total }),
      canceled: (x) => t("widgets.organize.canceled", { title: nameOf(x) }),
    },
  });
  /** The cards in the order on screen (a move waiting for the data counts). */
  const shown = grid.entries.flatMap((e) => (e.kind === "item" ? [e.item] : []));
  const gripOf = (item: BoardItem): GripProps => ({
    ...grid.grip(item),
    "aria-describedby": helpId,
    "aria-roledescription": t("widgets.organize.role"),
  });

  const cell = (item: BoardItem, state: "hidden" | "landing" | "picked" | undefined, child: ReactNode) => (
    <div
      key={item.id}
      className={cx("wb-cell", state === "picked" && "is-picked")}
      data-w={item.w}
      data-h={item.h}
      data-item={item.id}
      data-slot={item.id}
      hidden={state === "hidden" || undefined}
      data-landing={state === "landing" || undefined}
      {...grid.cell(item)}
    >
      {child}
    </div>
  );

  return (
    <>
      {organizing && (
        <>
          <p id={helpId} className="ac-visually-hidden">
            {t("widgets.organize.help")}
          </p>
          <p className="ac-visually-hidden" aria-live="assertive">
            {grid.live}
          </p>
        </>
      )}
      <div
        ref={grid.root}
        className="wgrid"
        data-arrange={organizing || undefined}
        data-moving={grid.active || undefined}
      >
        {grid.entries.map((entry) => {
          if (entry.kind === "spot")
            return (
              <div
                key={entry.key}
                className="wb-spot"
                data-spot
                data-w={entry.w}
                data-h={entry.h}
                style={entry.style}
                aria-hidden="true"
              />
            );
          const { item, state } = entry;
          if (item.type === "tile") {
            const slot = tiles?.[item.id];
            const organize = organizing ? { grip: gripOf(item) } : null;
            return cell(item, state, typeof slot === "function" ? slot(organize) : slot);
          }
          return cell(
            item,
            state,
            <BoardWidget
              orgId={orgId}
              widget={item.widget}
              boardKind={board.kind}
              editable={editable}
              organizing={organizing}
              grip={organizing ? gripOf(item) : undefined}
              isNew={fresh.has(item.id)}
              now={now}
              onOpen={() => onOpen(item.id)}
              onChangeSchedule={() => (onChangeSchedule ?? onOpen)(item.id)}
              onSize={() => {
                grid.animateNext();
                commit(resizeItem(shown, item.id, sizeToLayout(nextSize(layoutToSize({ w: item.w, h: item.h })))));
              }}
              onRemove={() => setRemoving(item.widget)}
            />,
          );
        })}
      </div>
      <RemoveWidgetDialog
        orgId={orgId}
        widget={removing}
        boardKind={board.kind}
        onClose={() => setRemoving(null)}
        onRemoving={() => grid.animateNext()}
      />
    </>
  );
}

/** One widget on the board, with its agent's name and color, its actions and its footer. */
function BoardWidget({
  orgId,
  widget,
  boardKind,
  editable,
  organizing,
  grip,
  isNew,
  now,
  onOpen,
  onChangeSchedule,
  onSize,
  onRemove,
}: {
  orgId: string;
  widget: Widget;
  boardKind: Dashboard["kind"];
  editable: boolean;
  organizing: boolean;
  grip?: GripProps;
  isNew: boolean;
  now: number;
  onOpen: () => void;
  onChangeSchedule: () => void;
  onSize: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { name, color } = useWidgetAgent(widget.agentId);
  const refresh = useRefreshWidget(orgId);
  const busy = widget.status === "building" || widget.status === "updating" || refresh.isPending;
  const update = () =>
    refresh.mutate(widget.id, { onError: (e) => toast.show(errorText(t, e, i18n.language), "error") });
  const size = layoutToSize(widget.layout);
  const board = useBoardLabels();
  const removeLabel = t(boardKind === "home" ? "widgets.menu.removeHome" : "widgets.menu.removeBoard");
  return (
    <WidgetCard
      className={cx(isNew && "wg--new")}
      data-widget={widget.id}
      title={widgetTitle(t, widget)}
      spec={widget.spec}
      status={widget.status}
      color={color}
      size={{ w: widget.layout.w, h: widget.layout.h }}
      locale={i18n.language}
      buildingText={t("widgets.status.building", { name })}
      face={<WidgetFace agentId={widget.agentId} name={name} />}
      onOpen={onOpen}
      board={board}
      footer={
        <WidgetFoot
          widget={widget}
          name={name}
          color={color}
          now={now}
          resolving={refresh.isPending && widget.status === "failed"}
          onResolve={editable ? update : undefined}
        />
      }
      actions={
        <>
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="refresh"
              aria-label={t("widgets.menu.refresh")}
              title={t("widgets.menu.refresh")}
              disabled={busy}
              onClick={update}
            />
          )}
          <Menu
            align="end"
            label={t("widgets.menu.label")}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="more"
                aria-label={t("widgets.menu.label")}
                title={t("widgets.menu.label")}
              />
            }
          >
            <MenuItem icon="expand" onSelect={onOpen}>
              {t("widgets.menu.open")}
            </MenuItem>
            {editable && (
              <MenuItem icon="refresh" disabled={busy} onSelect={update}>
                {t("widgets.menu.refresh")}
              </MenuItem>
            )}
            {editable && (
              <MenuItem icon="message" onSelect={onOpen}>
                {t("widgets.menu.change", { name })}
              </MenuItem>
            )}
            {editable && (
              <MenuItem icon="repeat" onSelect={onChangeSchedule}>
                {t("widgets.menu.schedule")}
              </MenuItem>
            )}
            {editable && <MenuSeparator />}
            {editable && (
              <MenuItem icon="trash" danger onSelect={onRemove}>
                {removeLabel}
              </MenuItem>
            )}
          </Menu>
        </>
      }
      organize={
        organizing
          ? {
              sizeLabel: t("widgets.organize.size"),
              sizeText: t(`widgets.sizes.${size}`),
              removeLabel,
              dragLabel: t("widgets.organize.drag"),
              onSize,
              onRemove,
              grip,
            }
          : null
      }
    />
  );
}

/** "See more" on a board's cards, and what a cut hides for screen readers. */
function useBoardLabels() {
  const { t } = useTranslation();
  return useMemo(
    () => ({ seeMore: t("widgets.seeMore"), hidden: (count: number) => t("widgets.seeMoreHidden", { count }) }),
    [t],
  );
}

/**
 * A fixed tile of a board (Home's "Waiting on you", "Working now"): a card like a widget's, its title and count, an
 * action at the head's end; in Organize, "Fixed" and the grip (the board's drag) in their place. Like a widget, its
 * height is capped: rows past it fade out under "See more", which opens the tile whole in a dialog; with room to
 * spare under its rows (nothing at work), the horizon at its foot.
 */
export function BoardTile({
  title,
  count,
  action,
  horizon = true,
  organize,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  /** False when the body draws its own sky. */
  horizon?: boolean;
  organize: TileOrganize | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const labels = useBoardLabels();
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const capped = !organize;
  const cut = useCardCut(body, capped);
  const badge = count !== undefined && count > 0 && <span className="wg__badge">{count}</span>;
  return (
    <Card
      as="section"
      className="wg wg--fixed"
      aria-label={title}
      data-organize={organize ? "" : undefined}
      data-capped={capped || undefined}
      data-cut={cut.cut || undefined}
    >
      <div className="wg__head">
        <h2 className="wg__title">
          {title}
          {badge}
        </h2>
        {organize ? (
          <span className="wg__arr">
            <span className="wg__badge">{t("widgets.organize.fixed")}</span>
            <button
              type="button"
              className="wg__grip"
              aria-label={t("widgets.organize.drag")}
              title={t("widgets.organize.drag")}
              {...organize.grip}
            >
              <Icon name="grip" size={16} />
            </button>
          </span>
        ) : (
          action
        )}
      </div>
      <div ref={body} className="wg__body">
        {children}
        {cut.cut && (
          <CardMore
            label={labels.seeMore}
            hiddenLabel={cut.hidden ? labels.hidden(cut.hidden) : undefined}
            hidden={cut.hidden}
            onOpen={() => setOpen(true)}
          />
        )}
      </div>
      {capped && horizon && <CardHorizon content={body} />}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={
          <span className="wg-whole__title">
            {title}
            {badge}
          </span>
        }
        closeLabel={t("common.close")}
        actions={action}
        className="wg-whole"
      >
        <DialogBody className="wg-whole__body">{children}</DialogBody>
      </Dialog>
    </Card>
  );
}

/** Widgets that arrived after the board first drew (they grow in once). */
function useArrivals(widgets: readonly Widget[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const ids = widgets.map((w) => w.id).join(",");
  useEffect(() => {
    const now = new Set(ids ? ids.split(",") : []);
    if (!seen.current) {
      seen.current = now;
      return;
    }
    const added = [...now].filter((id) => !seen.current?.has(id));
    seen.current = now;
    if (!added.length) return;
    setFresh((s) => new Set([...s, ...added]));
    const timer = setTimeout(() => setFresh((s) => new Set([...s].filter((id) => !added.includes(id)))), 600);
    return () => clearTimeout(timer);
  }, [ids]);
  return fresh;
}
