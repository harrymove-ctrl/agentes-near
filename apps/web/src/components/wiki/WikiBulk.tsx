import { useWikiBulk, useWikiTrash, type WikiBulkFailed, type WikiBulkTarget } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Checkbox, Dialog, DialogBody, DialogFooter, EmptyState, Icon, PageHeader } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/** What a bulk delete reaches, for its confirmation: a folder, an import or a selection. */
export type WikiBulkWhat = { kind: "folder"; name: string } | { kind: "import"; name: string } | { kind: "pages" };

/** "N ficaram": pages a bulk change left as they were, and why. */
const keptLine = (t: TFunction, kept: number) => (kept > 0 ? ` ${t("wiki.bulk.kept", { count: kept })}` : "");

/** Pages a bulk change couldn't reach, by title, with the first reason. */
const failedLine = (t: TFunction, failed: WikiBulkFailed) =>
  failed.length
    ? t("wiki.bulk.failed", {
        count: failed.length,
        titles: failed
          .slice(0, 4)
          .map((f) => f.title)
          .join(", "),
        reason: t(
          failed[0]?.code === "wiki.restore_slug_taken" ? "errors.wiki.restoreSlugTaken" : "common.unknownError",
        ),
      })
    : "";

/**
 * "Apagar" for many pages: the confirmation says how many and where they go (the Lixeira, for 30 days), and the
 * button waits for the answer.
 */
export function WikiBulkDeleteDialog({
  target,
  count,
  what,
  onClose,
  onDone,
}: {
  target: WikiBulkTarget;
  count: number;
  what: WikiBulkWhat;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const bulk = useWikiBulk(org.id);
  const title =
    what.kind === "folder"
      ? t("wiki.bulk.deleteFolderTitle", { folder: what.name, count })
      : what.kind === "import"
        ? t("wiki.bulk.deleteImportTitle", { name: what.name, count })
        : t("wiki.bulk.deleteTitle", { count });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !bulk.isPending && onClose()}
      title={title}
      description={t("wiki.bulk.deleteText")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button disabled={bulk.isPending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          icon="trash"
          loading={bulk.isPending}
          disabled={bulk.isPending || count === 0}
          onClick={() =>
            bulk.mutate(
              { type: "delete", target },
              {
                onSuccess: (r) => {
                  toast.show(`${t("wiki.bulk.deleted", { count: r.count })}${keptLine(t, r.kept)}`);
                  onDone?.();
                  onClose();
                },
                onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
              },
            )
          }
        >
          {t("wiki.bulk.deleteGo", { count })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Which agents read the chosen pages: all of them, or only some (none is a choice too). People's access stays. */
export function WikiBulkAgentsDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const bulk = useWikiBulk(org.id);
  const [all, setAll] = useState(true);
  const uid = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !bulk.isPending && onClose()}
      title={t("wiki.bulk.agentsTitle", { count: ids.length })}
      description={t("wiki.bulk.agentsText")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogBody>
        <div className="wiki-bulk-agents">
          <label className="wiki-bulk-agents__row" htmlFor={`${uid}-all`}>
            <Checkbox id={`${uid}-all`} checked={all} disabled={bulk.isPending} onCheckedChange={setAll} />
            <Icon name="agent" size={16} />
            <span>{t("wiki.audienceAgentsAll")}</span>
          </label>
          {dir.agents.map((a) => (
            <label key={a.id} className="wiki-bulk-agents__row" data-off={all || undefined} htmlFor={`${uid}-${a.id}`}>
              <Checkbox
                id={`${uid}-${a.id}`}
                checked={all || picked.has(a.id)}
                disabled={all || bulk.isPending}
                onCheckedChange={(on) => {
                  const next = new Set(picked);
                  if (on) next.add(a.id);
                  else next.delete(a.id);
                  setPicked(next);
                }}
              />
              <AgentAvatar agentId={a.id} name={a.name} size="sm" />
              <span>{a.name}</span>
            </label>
          ))}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button disabled={bulk.isPending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={bulk.isPending}
          disabled={bulk.isPending}
          onClick={() =>
            bulk.mutate(
              { type: "agents", ids, agentIds: all ? null : [...picked] },
              {
                onSuccess: (r) => {
                  toast.show(
                    [t("wiki.bulk.agentsSaved", { count: r.count }), failedLine(t, r.failed)].filter(Boolean).join(" "),
                    r.failed.length ? "error" : undefined,
                  );
                  onDone?.();
                  onClose();
                },
                onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
              },
            )
          }
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The wiki's Lixeira: pages deleted in the last 30 days, newest first. Restore one or many, delete some for good, or
 * empty it (with a confirmation).
 */
export function WikiTrash() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const trash = useWikiTrash(org.id);
  const bulk = useWikiBulk(org.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Deleting for good always asks first: the chosen pages, or the whole trash.
  const [purging, setPurging] = useState<string[] | "all" | null>(null);
  const writes = can(org, "edit_wiki");
  const pages = trash.data ?? [];
  const busy = bulk.isPending;
  const restore = (ids: string[]) =>
    bulk.mutate(
      { type: "restore", ids },
      {
        onSuccess: (r) => {
          setPicked(new Set());
          const done = r.count;
          toast.show(
            [done ? t("wiki.trash.restored", { count: done }) : "", failedLine(t, r.failed), keptLine(t, r.kept).trim()]
              .filter(Boolean)
              .join(" "),
            r.failed.length ? "error" : undefined,
          );
        },
        onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
      },
    );
  const purge = (ids?: string[]) =>
    bulk.mutate(
      { type: "purge", ids },
      {
        onSuccess: (r) => {
          setPicked(new Set());
          setPurging(null);
          toast.show(`${t("wiki.trash.purged", { count: r.count })}${keptLine(t, r.kept)}`);
        },
        onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
      },
    );
  const all = pages.length > 0 && picked.size === pages.length;
  return (
    <div className="wiki-home wiki-trash">
      <PageHeader
        title={t("wiki.trash.title")}
        meta={t("wiki.trash.text")}
        actions={
          writes && pages.length > 0 ? (
            <Button variant="ghost" icon="trash" disabled={busy} onClick={() => setPurging("all")}>
              {t("wiki.trash.empty")}
            </Button>
          ) : null
        }
      />
      {trash.isError && !trash.data ? (
        <ErrorState error={trash.error} onRetry={() => void trash.refetch()} />
      ) : trash.isLoading ? (
        <LoadingList count={4} avatar={false} />
      ) : pages.length === 0 ? (
        <EmptyState size="panel" icon="trash" title={t("wiki.trash.none")} />
      ) : (
        <>
          {writes && (
            <div className="wiki-trash__bar">
              <Checkbox
                checked={all ? true : picked.size > 0 ? "indeterminate" : false}
                disabled={busy}
                aria-label={t("wiki.bulk.selectAll")}
                onCheckedChange={(on) => setPicked(on ? new Set(pages.map((p) => p.id)) : new Set())}
              />
              <span className="small muted">
                {picked.size ? t("wiki.bulk.selected", { count: picked.size }) : t("wiki.bulk.selectAll")}
              </span>
              <span className="wiki-trash__acts">
                <Button size="sm" icon="undo" disabled={busy || picked.size === 0} onClick={() => restore([...picked])}>
                  {t("wiki.trash.restoreMany", { count: picked.size })}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || picked.size === 0}
                  onClick={() => setPurging([...picked])}
                >
                  {t("wiki.trash.purge")}
                </Button>
              </span>
            </div>
          )}
          <ul className="wiki-trash__list">
            {pages.map((p) => (
              <li key={p.id} className="wiki-trash__row">
                {writes && (
                  <Checkbox
                    checked={picked.has(p.id)}
                    disabled={busy}
                    aria-label={p.title}
                    onCheckedChange={(on) => {
                      const next = new Set(picked);
                      if (on) next.add(p.id);
                      else next.delete(p.id);
                      setPicked(next);
                    }}
                  />
                )}
                <Icon name="document" size={16} />
                <span className="wiki-trash__t">
                  <b>{p.title}</b>
                  <small>
                    {[
                      p.folder || t("wiki.root"),
                      p.deletedAt
                        ? t("wiki.trash.deletedWhen", { when: relativeTime(t, i18n.language, p.deletedAt) })
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                {writes && (
                  <Button size="sm" disabled={busy} onClick={() => restore([p.id])}>
                    {t("wiki.trash.restore")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {purging && (
        <Dialog
          open
          onOpenChange={(o) => !o && !busy && setPurging(null)}
          title={t("wiki.trash.emptyTitle", { count: purging === "all" ? pages.length : purging.length })}
          description={t("wiki.trash.emptyText")}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button disabled={busy} onClick={() => setPurging(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={() => purge(purging === "all" ? undefined : purging)}
            >
              {purging === "all" ? t("wiki.trash.empty") : t("wiki.trash.purge")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
