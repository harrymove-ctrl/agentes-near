import { Diff, type DiffLine } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/lib/markdown";

/**
 * A change to words in Markdown (an agent's instructions, the workspace's context), as GitHub shows a rendered one:
 * each run of lines drawn as the Instructions tab draws them, added on green, removed on red, long unchanged runs
 * folded to the line beside each change.
 */
export function ProseDiff({ lines, label }: { lines: DiffLine[]; label: string }) {
  const { t } = useTranslation();
  return (
    <Diff
      aria-label={label}
      addedLabel={t("proposals.added")}
      removedLabel={t("proposals.removed")}
      lines={lines}
      prose={{
        render: (text) => <Markdown source={text} variant="message" />,
        folded: (count) => t("proposals.sameLines", { count }),
      }}
    />
  );
}
