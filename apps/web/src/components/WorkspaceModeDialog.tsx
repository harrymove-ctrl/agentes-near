import type { OrgSettings, WorkspaceMode } from "@agenteschat/client";
import { useUpdateSettings } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { modeSwitchLines } from "@agenteschat/client/lib/personal-view";
import { Button, Dialog, DialogBody, DialogFooter, Field, Input, Locked, OptionList } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DeletionLine } from "@/components/DeleteWorkspace";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * Switching a workspace between team and personal (ADR 0159 §4), for who configures it. Going to a team's it says what
 * comes into sight and asks the workspace's name; going to personal it says what changes and, with other members,
 * that they see it too. What stays is said apart. Only the view changes: every agent, conversation, file and
 * permission stays as it is, and every member's apps reshape on the server's `org.mode`.
 */
export function WorkspaceModeDialog({
  open,
  to,
  onClose,
  onSwitched,
}: {
  open: boolean;
  /** The mode it switches to. */
  to: WorkspaceMode;
  onClose: () => void;
  /** Once the server switched it, with the workspace's settings (the name it has now). */
  onSwitched?: (settings: OrgSettings) => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const update = useUpdateSettings(org.id);
  const others = useDirectory(org.id).members.filter((m) => m.userId !== me.user.id).length;
  const [name, setName] = useState(org.name);
  const nameField = useRef<HTMLInputElement>(null);
  const team = to === "team";
  const words = team ? "toTeam" : "toPersonal";
  // Each opening starts from the workspace's name as it is now.
  useEffect(() => {
    if (open) setName(org.name);
  }, [open, org.name]);
  const named = name.trim();
  const ready = !team || named.length > 0;
  const submit = () => {
    if (!ready || update.isPending) return;
    const patch = team ? { mode: to, ...(named !== org.name ? { name: named } : {}) } : { mode: to };
    update.mutate(patch, {
      onSuccess: (settings) => {
        toast.show(team ? t("personalMode.toTeam.done", { name: settings.name }) : t("personalMode.toPersonal.done"));
        onSwitched?.(settings);
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t(`personalMode.${words}.title`)}
      description={t(`personalMode.${words}.lead`)}
      closeLabel={t("common.close")}
      width={480}
      initialFocus={team ? nameField : undefined}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={update.isPending}>
          <DialogBody>
            <ul className="deletion-lines">
              {modeSwitchLines(to, others).map((line) => (
                <DeletionLine key={line.key} icon={line.icon}>
                  {t(line.key, { count: line.count })}
                </DeletionLine>
              ))}
            </ul>
            <p className="small muted deletion-note">{t(`personalMode.${words}.stays`)}</p>
            {team && (
              <Field label={t("personalMode.toTeam.name")}>
                <Input
                  ref={nameField}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={update.isPending}>
            {t(`personalMode.${words}.confirm`)}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Before inviting someone to a personal workspace (ADR 0159 §4): family or friends keep it personal; people from work
 * switch it to a team's first (only who may configure it can), then the invitation goes on. `onGo` does what inviting
 * was about to do (open the invite dialog, copy the link). The roles and who may invite stay as they are.
 */
export function InviteModeQuestion({ open, onClose, onGo }: { open: boolean; onClose: () => void; onGo: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const switches = can(org, "configure");
  const [choice, setChoice] = useState<"family" | "work">("family");
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (open) setChoice("family");
  }, [open]);
  return (
    <>
      <Dialog
        open={open && !switching}
        onOpenChange={(o) => !o && onClose()}
        title={t("personalMode.invite.title")}
        description={t("personalMode.invite.lead")}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          <OptionList
            value={choice}
            onValueChange={setChoice}
            aria-label={t("personalMode.invite.title")}
            options={[
              {
                value: "family",
                title: t("personalMode.invite.family"),
                description: t("personalMode.invite.familyText"),
              },
              {
                value: "work",
                title: t("personalMode.invite.work"),
                description: t(switches ? "personalMode.invite.workText" : "personalMode.invite.workLocked"),
                disabled: !switches,
              },
            ]}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => (choice === "work" ? setSwitching(true) : onGo())}>
            {t("common.continue")}
          </Button>
        </DialogFooter>
      </Dialog>
      <WorkspaceModeDialog
        open={switching}
        to="team"
        onClose={() => {
          setSwitching(false);
          onClose();
        }}
        onSwitched={onGo}
      />
    </>
  );
}
