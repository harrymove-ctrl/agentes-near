import type { ArchivedChannel } from "@agenteschat/client";
import { useArchivedChannels } from "@agenteschat/client";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { Button, Dialog, DialogBody, EmptyState, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useRestoreChannel } from "@/components/entity-menus";
import { useOrg } from "@/components/org-context";

/**
 * "Canais arquivados": the archived channels the viewer may bring back (their creator or who manages channels), each
 * with Restaurar, which opens it again as it was. The way back once the archive's Desfazer is gone.
 */
export function ArchivedChannelsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const list = useArchivedChannels(org.id, open);
  const restore = useRestoreChannel();
  const channels = list.data ?? [];
  const back = (c: ArchivedChannel) => restore.run(c, onClose);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("channel.archivedTitle")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogBody>
        {list.isSuccess && channels.length === 0 ? (
          <EmptyState size="panel" icon="archive" title={t("channel.archivedNone")} />
        ) : (
          <ul className="archived-channels" aria-label={t("channel.archivedTitle")}>
            {channels.map((c) => (
              <li key={c.id} className="archived-channels__row ac-mediarow ac-mediarow--row">
                <span className="ac-mediarow__face">
                  <Icon name={c.visibility === "private" ? "lock" : "channel"} size={16} />
                </span>
                <span className="ac-mediarow__head">
                  <b>#{c.name}</b>
                </span>
                <span className="ac-mediarow__body small muted">
                  {t("channel.archivedOn", { date: formatShortDate(i18n.language, c.archivedAt) })}
                </span>
                <span className="ac-mediarow__end">
                  <Button
                    size="sm"
                    icon="undo"
                    aria-label={t("channel.restoreName", { channel: c.name })}
                    disabled={restore.pending}
                    onClick={() => back(c)}
                  >
                    {t("channel.restore")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
    </Dialog>
  );
}
