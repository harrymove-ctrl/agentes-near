import type { Dashboard } from "@agenteschat/client";
import {
  frozenBoard,
  useDashboard,
  useDashboards,
  useDeleteDashboard,
  useSetHomeDashboard,
  useUpdateDashboard,
} from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  MenuItem,
  MenuSeparator,
  PageHeader,
  Textarea,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NewWidgetDialog } from "@/components/dashboards/NewWidgetDialog";
import { ProposalBanner } from "@/components/dashboards/ProposalBanner";
import { OwnerLine, VisibilityChip } from "@/components/dashboards/parts";
import { ShareDashboardDialog } from "@/components/dashboards/ShareDialog";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { BoardActionsPill } from "@/components/widgets/parts";
import { WidgetBoard } from "@/components/widgets/WidgetBoard";
import { WidgetPanel } from "@/components/widgets/WidgetPanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./dashboards.css";

/**
 * One board (ADR 0135 §14): back to Dashboards, its title with Share, Organize and "+", a line with who sees it, who
 * made it, how many widgets and when it was updated, an agent's request to publish it, then its widgets (the
 * 4-column grid, Organize to drag and resize) or an empty state. `?widget=<id>` opens a widget's side panel, so a
 * notification or a link opens it. A home board belongs on Home, unless Início shows another board ("Use on Home",
 * ADR 0135 §18): then it is a page like this one, its menu bringing Início back to it.
 */
export function DashboardPage({ dashboardId }: { dashboardId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const query = useDashboard(org.id, dashboardId);
  const [widgetId, setWidgetId] = useOpenParam("widget");
  const board = query.data;
  const list = useDashboards(org.id);
  // A person's home board is their Home page: its widgets open there, unless Início shows another board (ADR 0135
  // §18); then "My Home" is a page like any board's.
  const homeElsewhere = Boolean(list.data?.homeDashboardId);
  const redirectHome = board?.kind === "home" && list.data !== undefined && !homeElsewhere;
  useEffect(() => {
    if (!redirectHome) return;
    void navigate({
      to: "/org/$orgId/home",
      params: { orgId: org.id },
      search: (widgetId ? { widget: widgetId } : {}) as never,
      replace: true,
    });
  }, [redirectHome, navigate, org.id, widgetId]);
  if (query.isLoading)
    return (
      <div className="page page--list dashboards">
        <LoadingCards count={3} />
      </div>
    );
  if (!board) {
    const missing = ["dashboard.not_found", "dashboard.forbidden"].includes(errorCode(query.error) ?? "");
    return (
      <div className="page page--list dashboards">
        <BackCrumb />
        {missing ? (
          <EmptyState icon="grid" title={t("dashboards.errors.notFound")} />
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }
  if (board.kind === "home" && !homeElsewhere) return null;
  return <Board board={frozenBoard(board, org)} widgetId={widgetId} onWidget={setWidgetId} />;
}

function BackCrumb() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Link to="/org/$orgId/dashboards" params={{ orgId: org.id }} className="db-crumb">
      <Icon name="chevronLeft" size={16} />
      {t("dashboards.back")}
    </Link>
  );
}

function Board({
  board,
  widgetId,
  onWidget,
}: {
  board: Dashboard;
  widgetId: string | null;
  onWidget: (id: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const now = useNow(60_000);
  const [arranging, setArranging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateDashboard(org.id);
  const toast = useToast();
  const count = board.widgets.length;
  const empty = count === 0;
  // The empty state's agent: who made the board when an agent did, else the first one.
  const artAgent = dir.anyAgent(board.owner?.kind === "agent" ? board.owner.id : (dir.agents[0]?.id ?? ""));
  const setPinned = (pinned: boolean) =>
    update.mutate({ dashboardId: board.id, pinned }, { onError: (error) => toast.show(errorText(t, error), "error") });
  // "Use on Home" (ADR 0135 §18): anyone who sees the board may show it on their own Início; on "My Home" it
  // brings Início back to it.
  const isHome = board.kind === "home";
  const title = isHome ? t("dashboards.home") : board.title;
  const list = useDashboards(org.id);
  const setHome = useSetHomeDashboard(org.id);
  const onHome = isHome ? !list.data?.homeDashboardId : list.data?.homeDashboardId === board.id;
  const toggleHome = () =>
    setHome.mutate(onHome || isHome ? null : board.id, {
      onSuccess: () => {
        if (!onHome) toast.show(t("dashboards.onHomeDone"));
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  return (
    <div className="page page--list dashboards db-page">
      <div className="db-head">
        <BackCrumb />
        <PageHeader
          title={title}
          meta={board.about || t("dashboards.subtitle")}
          actions={
            <>
              {board.canManage && !isHome && (
                <Button
                  size="sm"
                  icon={board.audience === "workspace" ? "globe" : "lock"}
                  onClick={() => setSharing(true)}
                >
                  {t("dashboards.share.action")}
                </Button>
              )}
              {board.canEdit && (
                <BoardActionsPill
                  label={title}
                  arranging={arranging}
                  onArrange={empty ? undefined : () => setArranging((a) => !a)}
                  onAdd={() => setAdding(true)}
                />
              )}
              <Menu
                label={t("widgets.menu.label")}
                align="end"
                trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("widgets.menu.label")} />}
              >
                {!(isHome && onHome) && (
                  <MenuItem icon="home" onSelect={toggleHome}>
                    {onHome ? t("dashboards.stopOnHome") : t("dashboards.useOnHome")}
                  </MenuItem>
                )}
                {board.canEdit && !isHome && (
                  <MenuItem icon="edit" onSelect={() => setRenaming(true)}>
                    {t("dashboards.rename")}
                  </MenuItem>
                )}
                {board.canManage && !isHome && (
                  <MenuItem icon="pin" onSelect={() => setPinned(!board.pinned)}>
                    {board.pinned ? t("dashboards.unpin") : t("dashboards.pinTop")}
                  </MenuItem>
                )}
                {board.canManage && !isHome && <MenuSeparator />}
                {board.canManage && !isHome && (
                  <MenuItem icon="trash" danger onSelect={() => setDeleting(true)}>
                    {t("dashboards.delete.action")}
                  </MenuItem>
                )}
              </Menu>
            </>
          }
        >
          <div className="db-meta">
            <VisibilityChip board={board} />
            <OwnerLine owner={board.owner} mine={board.mine} />
            <span className="db-dot" aria-hidden="true">
              ·
            </span>
            <span>{t("dashboards.meta.widgets", { count })}</span>
            <span className="db-dot" aria-hidden="true">
              ·
            </span>
            <span>
              {t("dashboards.meta.updated", { when: relativeTime(t, i18n.language, board.updatedAt, new Date(now)) })}
            </span>
          </div>
        </PageHeader>
      </div>
      <ProposalBanner board={board} />
      {empty ? (
        <EmptyState
          size="page"
          agent={lookOf(artAgent) ?? true}
          title={t("dashboards.empty.title")}
          actions={
            board.canEdit && (
              <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                {t("widgets.add.label")}
              </Button>
            )
          }
        >
          {t(board.canEdit ? "dashboards.empty.text" : "dashboards.empty.viewer")}
        </EmptyState>
      ) : (
        <WidgetBoard
          orgId={org.id}
          board={board}
          arranging={arranging}
          onOpen={(id) => onWidget(id)}
          onChangeSchedule={(id) => onWidget(id)}
        />
      )}
      <WidgetPanel orgId={org.id} widgetId={widgetId} onClose={() => onWidget(null)} />
      <NewWidgetDialog
        orgId={org.id}
        open={adding}
        onClose={() => setAdding(false)}
        dashboardId={isHome ? null : board.id}
      />
      <ShareDashboardDialog board={board} open={sharing} onClose={() => setSharing(false)} />
      <RenameDialog board={board} open={renaming} onClose={() => setRenaming(false)} />
      <DeleteDialog board={board} open={deleting} onClose={() => setDeleting(false)} />
    </div>
  );
}

/** Rename: the board's title and what it is for. */
function RenameDialog({ board, open, onClose }: { board: Dashboard; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.rename")}
      closeLabel={t("common.close")}
      width={440}
    >
      {open && <RenameBody board={board} onClose={onClose} />}
    </Dialog>
  );
}

function RenameBody({ board, onClose }: { board: Dashboard; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateDashboard(org.id);
  const [title, setTitle] = useState(board.title);
  const [about, setAbout] = useState(board.about);
  const ready = title.trim().length > 0;
  return (
    <form
      className="db-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        update.mutate(
          { dashboardId: board.id, title: title.trim(), about: about.trim() },
          { onSuccess: onClose, onError: (error) => toast.show(errorText(t, error), "error") },
        );
      }}
    >
      <Locked when={update.isPending}>
        <DialogBody className="db-dialog__body">
          <Field label={t("dashboards.create.name")}>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label={t("dashboards.about")}>
            <Textarea
              rows={2}
              value={about}
              maxLength={280}
              placeholder={t("dashboards.aboutPlaceholder")}
              onChange={(e) => setAbout(e.target.value)}
            />
          </Field>
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={update.isPending}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Delete: the board, its widgets and their routines (ADR 0135 §8: its owner and admins). */
function DeleteDialog({ board, open, onClose }: { board: Dashboard; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const remove = useDeleteDashboard(org.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.delete.title", { title: board.title })}
      description={t("common.joinSentences", { a: t("dashboards.delete.text"), b: t("common.cantUndo") })}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(board.id, {
              onSuccess: () => {
                toast.show(t("dashboards.delete.done", { title: board.title }));
                onClose();
                void navigate({ to: "/org/$orgId/dashboards", params: { orgId: org.id } });
              },
              onError: (error) => toast.show(errorText(t, error), "error"),
            })
          }
        >
          {t("dashboards.delete.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
