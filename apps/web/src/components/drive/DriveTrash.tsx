import { type TrashedArtifact, useArtifactTrash } from "@agenteschat/client";
import { daysLeft } from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Button, Chip, Dialog, DialogFooter, EmptyState, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import { itemIcon } from "./DriveItems";

/** Few days left: the chip turns to attention. */
const SOON_DAYS = 3;

/**
 * "Lixeira": deleted files for 30 days, who made each, when it was deleted,
 * the days left (attention at 3 or fewer), Restaurar and Apagar para sempre.
 */
export function DriveTrash() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const look = useRightHandLook();
  const trash = useArtifactTrash(org.id);
  const remover = useDeleteArtifact();
  const authorName = useAuthorName();
  const [doomed, setDoomed] = useState<TrashedArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const list = trash.data ?? [];
  const purge = async (a: TrashedArtifact) => {
    setBusy(true);
    try {
      await api.artifacts.purge(org.id, a.id);
      toast.show(t("drive.purged", { title: a.title }));
    } catch (err) {
      toast.show(errorText(t, err), "error");
    } finally {
      setBusy(false);
      setDoomed(null);
      void trash.refetch();
    }
  };
  if (trash.isLoading) return <LoadingList count={3} trailing />;
  if (trash.isError && !trash.data) return <ErrorState error={trash.error} onRetry={() => void trash.refetch()} />;
  if (list.length === 0) {
    return (
      <EmptyState size="page" agent={look} mood="deal" title={t("artifacts.trashEmpty")}>
        {t("drive.trashEmptyText")}
      </EmptyState>
    );
  }
  return (
    <>
      <p className="drive-note ac-iconline">
        <Icon name="clock" size={16} />
        <span>
          {t("drive.trashNote")} {t("drive.trashStorage")}
        </span>
      </p>
      <ul className="drive-list drive-trash">
        {list.map((a) => {
          const left = daysLeft(a.purgeAt);
          const soon = left <= SOON_DAYS;
          return (
            <li key={a.id} className="drive-trash__row ac-mediarow" data-kind={a.kind}>
              <span className="ac-mediarow__face">
                <span className="drive-trash__icon">
                  <Icon name={itemIcon(a)} />
                </span>
              </span>
              <span className="ac-mediarow__head">
                <b className="drive-trash__title">{a.title}</b>
              </span>
              <small className="ac-mediarow__body drive-trash__meta">
                <ActorAvatar size="xs" actor={a.createdBy} name={authorName(a.createdBy)} />
                <span className="drive-trash__by">
                  {t("drive.trashBy", {
                    name: authorName(a.createdBy),
                    when: relativeTime(t, i18n.language, a.deletedAt),
                  })}
                </span>
              </small>
              <span className="ac-mediarow__end ac-mediarow__end--wrap drive-trash__acts">
                <Chip
                  icon="clock"
                  tone={soon ? "waiting" : "neutral"}
                  title={new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(
                    new Date(a.purgeAt),
                  )}
                >
                  {soon ? t("drive.goneIn", { count: left }) : t("drive.daysLeft", { count: left })}
                </Chip>
                <Button
                  size="sm"
                  icon="undo"
                  onClick={() => void remover.restore(a.id).then(() => void trash.refetch())}
                >
                  {t("artifacts.restore")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="trash"
                  aria-label={t("drive.purgeLabel", { title: a.title })}
                  title={t("drive.purge")}
                  onClick={() => setDoomed(a)}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <Dialog
        open={doomed !== null}
        onOpenChange={(o) => !o && setDoomed(null)}
        title={t("drive.purgeTitle", { title: doomed?.title ?? "" })}
        description={t("drive.purgeBody")}
        closeLabel={t("common.close")}
        width={460}
      >
        <DialogFooter>
          <Button onClick={() => setDoomed(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={busy} disabled={busy} onClick={() => doomed && void purge(doomed)}>
            {t("drive.purge")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
