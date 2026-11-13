import type { Dashboard, HomeTile } from "@agenteschat/client";
import { frozenBoard, useHomeBoard } from "@agenteschat/client";
import { GroupHeading } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { NewWidgetDialog } from "@/components/dashboards/NewWidgetDialog";
import { useOrg } from "@/components/org-context";
import { useOpenParam } from "@/lib/open-param";
import { BoardActionsPill } from "./parts";
import { BoardTile, type TileOrganize, WidgetBoard } from "./WidgetBoard";
import { WidgetPanel } from "./WidgetPanel";
import "./widgets.css";

/** A fixed tile's content: its title, how many it holds, the action at its head's end, its rows. */
export interface MuralTile {
  title: string;
  count: number;
  action?: ReactNode;
  body: ReactNode;
  /** False when the body draws its own sky (the calm state): no horizon under it. */
  horizon?: boolean;
}

/** Where Home's fixed tiles start, until the person's home board has come (ADR 0135 §9). */
const DEFAULT_TILES: HomeTile[] = [
  { key: "waiting", position: 0, w: 2, h: 1 },
  { key: "working", position: 3, w: 2, h: 1 },
];

/**
 * Home as a mural (ADR 0135, on ADR 0108): "Waiting on you" and "Working now" are fixed tiles of the person's home
 * board, among their widgets, in its 4 columns. "Organize" drags and resizes; the header's "+" asks an agent for a
 * widget or pins a chart from the chat; a widget opens in its side panel (`?widget=<id>`). "See all" opens Dashboards.
 * With a board chosen for Início ("Use on Home", ADR 0135 §18) the head takes its title and its widgets follow the
 * fixed tiles; "+" and Organize change that board, when the person edits it.
 */
export function HomeMural({ orgId, waiting, working }: { orgId: string; waiting: MuralTile; working: MuralTile }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const home = useHomeBoard(orgId);
  const [arranging, setArranging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [widgetId, setWidgetId] = useOpenParam("widget");
  const own = withTiles(frozenBoard(home.own ?? placeholder(orgId), org));
  const chosen = home.chosen && frozenBoard(home.chosen, org);
  // While a chosen board loads, only the own home's fixed tiles; its widgets stay in "My Home".
  const tilesBoard = home.chosenId ? { ...own, widgets: [] } : own;
  const ownEditable = own.canEdit;
  const editable = chosen ? chosen.canEdit || ownEditable : ownEditable;
  const title = home.chosenId ? (chosen?.title ?? home.chosenTitle ?? "") : t("widgets.home");
  const count = home.chosenId ? (chosen?.widgets.length ?? 0) : own.widgets.length;
  const tile = (it: MuralTile) => (organize: TileOrganize | null) => (
    <BoardTile title={it.title} count={it.count} action={it.action} horizon={it.horizon} organize={organize}>
      {it.body}
    </BoardTile>
  );
  const fixed = {
    tiles: { waiting: tile(waiting), working: tile(working) },
    tileNames: { waiting: waiting.title, working: working.title },
  };
  return (
    <section className="home-sec home-mural" aria-label={title}>
      <GroupHeading
        title={title}
        count={count > 0 ? count : undefined}
        aside={
          <span className="home-sec__acts">
            <Link className="home-sec__more" to="/org/$orgId/dashboards" params={{ orgId }}>
              {t("dashboards.seeAll")}
            </Link>
            {editable && (
              <BoardActionsPill
                label={title}
                arranging={arranging}
                onArrange={() => setArranging((v) => !v)}
                onAdd={!chosen || chosen.canEdit ? () => setAdding(true) : undefined}
              />
            )}
          </span>
        }
      />
      {/* One grid: the fixed tiles among the widgets of what Início shows, so either moves anywhere in it. */}
      {chosen ? (
        <WidgetBoard
          orgId={orgId}
          board={chosen}
          arranging={arranging && (chosen.canEdit || ownEditable)}
          {...fixed}
          homeTiles={{ boardId: own.id, tiles: own.tiles }}
          onOpen={(id) => setWidgetId(id)}
        />
      ) : (
        <WidgetBoard
          orgId={orgId}
          board={tilesBoard}
          arranging={arranging && ownEditable}
          {...fixed}
          onOpen={(id) => setWidgetId(id)}
        />
      )}
      <WidgetPanel orgId={orgId} widgetId={widgetId} onClose={() => setWidgetId(null)} />
      <NewWidgetDialog
        orgId={orgId}
        open={adding}
        onClose={() => setAdding(false)}
        dashboardId={chosen ? chosen.id : null}
      />
    </section>
  );
}

/** A home board always has both fixed tiles: one it lacks takes its default place. */
function withTiles(board: Dashboard): Dashboard {
  const missing = DEFAULT_TILES.filter((d) => !board.tiles.some((x) => x.key === d.key));
  return missing.length ? { ...board, tiles: [...board.tiles, ...missing] } : board;
}

/** The home board before it has come: only its fixed tiles, nothing to edit yet. */
function placeholder(orgId: string): Dashboard {
  const at = new Date(0).toISOString();
  return {
    id: `home:${orgId}`,
    kind: "home",
    title: "",
    about: "",
    audience: "private",
    roleIds: [],
    editPolicy: "owner",
    pinned: false,
    position: 0,
    owner: null,
    ownerUserId: null,
    mine: true,
    widgetCount: 0,
    thumbs: [],
    viewerCount: 1,
    canEdit: false,
    canManage: false,
    proposal: null,
    createdAt: at,
    updatedAt: at,
    widgets: [],
    tiles: DEFAULT_TILES,
  };
}
