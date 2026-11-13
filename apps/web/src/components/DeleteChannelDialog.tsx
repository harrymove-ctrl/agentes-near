import type { Channel } from "@agenteschat/client";
import { useDeleteChannel } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { matchesName } from "@agenteschat/client/lib/text";
import { AffixInput, Button, Dialog, DialogBody, DialogFooter, Field, Icon, Locked } from "@agenteschat/ui";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * "Apagar canal" (owners and admins, never #general): what goes and what stays, then its name typed to confirm. Leaves
 * the channel's page when it was open.
 */
export function DeleteChannelDialog({
  channel,
  onClose,
  onDeleted,
}: {
  channel: Pick<Channel, "id" | "name" | "visibility"> | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const remove = useDeleteChannel(org.id);
  const [typed, setTyped] = useState("");
  const name = channel?.name ?? "";
  const ready = Boolean(channel) && matchesName(typed.replace(/^#/, ""), name);
  const close = () => {
    setTyped("");
    remove.reset();
    onClose();
  };
  const confirm = () => {
    if (!channel || !ready || remove.isPending) return;
    remove.mutate(
      { channelId: channel.id, name: typed },
      {
        onSuccess: () => {
          toast.show(t("channel.deleteDone", { channel: name }));
          if (router.state.location.pathname.includes(`/c/${channel.id}`))
            void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
          onDeleted?.();
          close();
        },
      },
    );
  };
  return (
    <Dialog
      open={channel !== null}
      onOpenChange={(open) => !open && close()}
      title={t("channel.deleteTitle", { channel: name })}
      closeLabel={t("common.close")}
      width={460}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Locked when={remove.isPending}>
          <DialogBody>
            <ul className="agp-delete">
              <li className="ac-iconline">
                <Icon name="trash" size={16} />
                <span>{t("channel.deleteGoes")}</span>
              </li>
              {channel?.visibility === "private" && (
                <li className="ac-iconline">
                  <Icon name="issues" size={16} />
                  <span>{t("channel.deleteIssues")}</span>
                </li>
              )}
              <li className="ac-iconline">
                <Icon name="archive" size={16} />
                <span>{t("channel.deleteOrArchive")}</span>
              </li>
            </ul>
            <Field
              label={t("channel.deleteTypeName", { channel: name })}
              id="channel-delete-name"
              error={remove.error ? errorText(t, remove.error) : undefined}
            >
              <AffixInput
                prefix="#"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="danger"
            icon="trash"
            disabled={!ready || remove.isPending}
            loading={remove.isPending}
          >
            {t("channel.delete")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
