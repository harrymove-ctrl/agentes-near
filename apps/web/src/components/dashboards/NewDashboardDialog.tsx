import { editorsInput, useCreateDashboard } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogBody, DialogFooter, Field, Input, Locked } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { AudienceFields, audienceReady, type BoardAudience } from "./parts";
import "@/pages/dashboards.css";

/**
 * New dashboard (ADR 0135 §8, §10): its name (with a line saying an agent builds one when asked in a chat), who sees
 * it and who edits it, with the note on what whoever sees it sees. Creating opens the new, empty board.
 */
export function NewDashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.create.title")}
      description={t("dashboards.create.subtitle")}
      closeLabel={t("common.close")}
      width={620}
      className="db-dialog"
      initialFocus={nameRef}
    >
      {open && <NewDashboardBody nameRef={nameRef} onClose={onClose} />}
    </Dialog>
  );
}

function NewDashboardBody({ nameRef, onClose }: { nameRef: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const id = useId();
  const create = useCreateDashboard(org.id);
  const [title, setTitle] = useState("");
  // Private until the person picks otherwise: nothing reaches others without a choice (ADR 0135 §12).
  const [audience, setAudience] = useState<BoardAudience>({
    audience: "private",
    roleIds: [],
    editPolicy: "owner",
    editRoleIds: [],
  });
  const ready = title.trim().length > 0 && audienceReady(audience);
  const submit = () => {
    if (!ready) return;
    create.mutate(
      {
        title: title.trim(),
        audience: audience.audience,
        roleIds: audience.audience === "roles" ? audience.roleIds : [],
        ...editorsInput(audience),
      },
      {
        onSuccess: (board) => {
          toast.show(t("dashboards.create.created", { title: board.title }), "success");
          onClose();
          void navigate({
            to: "/org/$orgId/dashboards/$dashboardId",
            params: { orgId: org.id, dashboardId: board.id },
          });
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  };
  return (
    <form
      className="db-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Locked when={create.isPending}>
        <DialogBody className="db-dialog__body">
          <Field
            label={t("dashboards.create.name")}
            id={`${id}-name`}
            hint={{
              name: t("common.about", { label: t("dashboards.create.name") }),
              text: t("dashboards.create.askHint"),
            }}
          >
            <Input
              ref={nameRef}
              value={title}
              maxLength={80}
              placeholder={t("dashboards.create.namePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <AudienceFields value={audience} onChange={setAudience} />
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={create.isPending}>
          {t("dashboards.create.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
