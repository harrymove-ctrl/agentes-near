import type { Issue } from "@agenteschat/client";
import { useIssue, useIssueAction } from "@agenteschat/client";
import { canDeleteIssue, deleteIssueText } from "@agenteschat/client/lib/issues";
import { Button, Dialog, DialogFooter } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

const AskDelete = createContext<(issue: Issue) => void>(() => {});

/** How to ask for a task's deletion (`IssueDeleteProvider` confirms it), and whether I may. */
export function useIssueDeleting() {
  const { org, me } = useOrg();
  const ask = useContext(AskDelete);
  return { ask, mayDelete: (issue: Issue) => canDeleteIssue(org, issue, me.user.id) };
}

/** "Excluir tarefa" on the task's own page and dialog, for who may. */
export function IssueDeleteButton({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { ask, mayDelete } = useIssueDeleting();
  if (!mayDelete(issue)) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon="trash"
      aria-label={t("issues.delete.action")}
      title={t("issues.delete.action")}
      onClick={() => ask(issue)}
    />
  );
}

/** "Excluir tarefa" for what's under it, one confirmation for the whole board (`onDeleted`: where the page goes next). */
export function IssueDeleteProvider({ children, onDeleted }: { children: ReactNode; onDeleted: () => void }) {
  const [asked, setAsked] = useState<Issue | null>(null);
  const close = useCallback(() => setAsked(null), []);
  return (
    <AskDelete.Provider value={setAsked}>
      {children}
      {asked && <ConfirmDelete issue={asked} onClose={close} onDeleted={onDeleted} />}
    </AskDelete.Provider>
  );
}

function ConfirmDelete({ issue, onClose, onDeleted }: { issue: Issue; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const action = useIssueAction(org.id);
  // The board's row doesn't carry its steps: the task's own read does.
  const full = useIssue(org.id, issue.number).data ?? issue;
  const working = issue.work && issue.work.state !== "stalled" && issue.assignee ? actors.name(issue.assignee) : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !action.isPending && onClose()}
      title={t("issues.delete.title", { number: issue.number })}
      description={deleteIssueText(t, full, working)}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button disabled={action.isPending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "delete", id: issue.id },
              {
                onSuccess: () => {
                  onClose();
                  onDeleted();
                  toast.show(t("issues.delete.done", { number: issue.number }));
                },
              },
            )
          }
        >
          {t("issues.delete.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
