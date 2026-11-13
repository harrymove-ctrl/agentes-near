import { keys } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { matchesName } from "@agenteschat/client/lib/text";
import { Button, Dialog, DialogBody, DialogFooter, Field, Icon, Input, Locked } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * Deleting agents for good from a removal card (ADR 0082, as from their page): who, what goes and what stays, then
 * the name typed to confirm (for several, how many). `onConfirm` decides the card's rows; the card shows a failure.
 */
export function DeleteAgentsDialog({
  names,
  pending,
  onConfirm,
  onClose,
}: {
  names: string[] | null;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const count = names?.length ?? 0;
  const target = count === 1 ? (names?.[0] ?? "") : String(count);
  const ready = count > 0 && matchesName(typed, target) && !pending;
  const close = () => {
    setTyped("");
    onClose();
  };
  return (
    <Dialog
      open={names !== null}
      onOpenChange={(open) => !open && close()}
      title={t("rightHand.remove.deleteTitle", { count })}
      closeLabel={t("common.close")}
      width={460}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onConfirm();
        }}
      >
        <Locked when={pending}>
          <DialogBody>
            <p>
              <b>{names?.join(", ")}</b>
            </p>
            <ul className="agp-delete">
              <li className="ac-iconline">
                <Icon name="trash" size={16} />
                <span>{t("agentPage.delete.goes")}</span>
              </li>
              <li className="ac-iconline">
                <Icon name="message" size={16} />
                <span>{t("agentPage.delete.stays")}</span>
              </li>
            </ul>
            <Field label={t("agentPage.delete.typeName", { name: target })} id="agp-delete-names">
              <Input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" icon="trash" disabled={!ready} loading={pending}>
            {t("agentPage.delete.button")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Deleting an agent for good (ADR 0082), from its page or, archived, from Equipe: what goes and what stays, then its
 * name typed to confirm. `onDeleted` runs after the toast,
 * before the dialog closes.
 */
export function DeleteAgentDialog({
  agent,
  onClose,
  onDeleted,
}: {
  agent: { id: string; name: string } | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const purge = useMutation({ mutationFn: (id: string) => api.agents.purge(org.id, id) });
  const g = agentGrammar(agent?.name ?? "");
  const ready = Boolean(agent) && matchesName(typed, agent?.name ?? "");
  const close = () => {
    setTyped("");
    purge.reset();
    onClose();
  };
  const confirm = () => {
    if (!agent || !ready || purge.isPending) return;
    purge.mutate(agent.id, {
      onSuccess: () => {
        toast.show(t("agentPage.delete.done", g));
        void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
        onDeleted?.();
        close();
      },
    });
  };
  return (
    <Dialog
      open={agent !== null}
      onOpenChange={(open) => !open && close()}
      title={t("agentPage.delete.title", g)}
      closeLabel={t("common.close")}
      width={460}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Locked when={purge.isPending}>
          <DialogBody>
            <ul className="agp-delete">
              <li className="ac-iconline">
                <Icon name="trash" size={16} />
                <span>{t("agentPage.delete.goes")}</span>
              </li>
              <li className="ac-iconline">
                <Icon name="message" size={16} />
                <span>{t("agentPage.delete.stays")}</span>
              </li>
            </ul>
            <Field
              label={t("agentPage.delete.typeName", g)}
              id="agp-delete-name"
              error={purge.error ? errorText(t, purge.error) : undefined}
            >
              <Input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
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
            disabled={!ready || purge.isPending}
            loading={purge.isPending}
          >
            {t("agentPage.delete.button")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
