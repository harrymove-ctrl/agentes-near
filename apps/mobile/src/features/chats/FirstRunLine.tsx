import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { LIST_AVATAR, ListRow } from "@/ui";
import { useOpenDm } from "../new/useOpenDm";
import { useFirstRun } from "../right-hand/FirstRun";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";

/**
 * While the right hand's first-run checklist has a row left (ADR 0155 §6), Conversas has one line back to it, as
 * Início on the web: never a second list that could disagree with the card. One row of the list, on its ruler (the
 * right hand's face in the 52 column, a chevron since it opens the conversation), saying who is doing it and how far
 * it got: "Atlas está montando o time · 2 de 5"; in a personal workspace (ADR 0159), the person's agents instead.
 */
export function FirstRunLine() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const openDm = useOpenDm();
  const lodi = dir.agents.find(isRightHand);
  const run = useFirstRun(lodi);
  if (!lodi || !run.ready || run.state !== "open") return null;
  const text = t(modeKey(org, "mobile.chats.firstRunLine"), {
    name: lodi.name,
    done: run.steps.filter((s) => run.done.has(s)).length,
    total: run.steps.length,
  });
  return (
    <ListRow
      leading={<AgentFace agentId={lodi.id} size={LIST_AVATAR - 2} />}
      title={text}
      // A long name still leaves the count in sight: the line may take two.
      titleLines={2}
      chevron
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={() => void openDm({ agentId: lodi.id })}
    />
  );
}
