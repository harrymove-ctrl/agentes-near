import { type Issue, useStartAgentOnTask } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useToast } from "@/ui";
import { useDirectory, useOrgId } from "../shared/hooks";

/**
 * "Pedir" to an agent picked for a task (Nova tarefa, Responsável), as on the web: when it can't start, an alert says
 * so and why, with Pedir de novo. `created`: the task was just made, so the alert says it exists. `done`: the toast
 * once it starts.
 */
export function useStartAgent() {
  const { t } = useTranslation();
  const toast = useToast();
  const dir = useDirectory();
  const start = useStartAgentOnTask(useOrgId());
  const run = (
    issue: Pick<Issue, "id" | "number">,
    agentId: string,
    options: { created?: boolean; done?: string } = {},
    again = false,
  ) => {
    const g = agentGrammar(dir.nameOf({ type: "agent", id: agentId }));
    start.mutateAsync({ issueId: issue.id, agentId }).then(
      () => {
        const done = again ? t("issues.asked", g) : options.done;
        if (done) toast({ title: done, agentId });
      },
      (error: unknown) =>
        Alert.alert(
          options.created ? t("issues.form.notStarted", { number: issue.number, ...g }) : t("issues.notStarted", g),
          errorText(t, error),
          [
            { text: t("common.close"), style: "cancel" },
            { text: t("issues.form.askAgain"), onPress: () => run(issue, agentId, options, true) },
          ],
        ),
    );
  };
  return { run, pending: start.isPending };
}
