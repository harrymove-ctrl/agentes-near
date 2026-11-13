import type { Memory } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { useMeId, useWhen } from "../shared/hooks";
import { dayWord, memoryOrigin } from "./logic";

/** Where a memory came from, in the person's words ("Aprendeu numa conversa · 12 out"). */
export function useMemoryOriginText() {
  const { t } = useTranslation();
  const meId = useMeId();
  const when = useWhen();
  const date = (iso: string) =>
    new Intl.DateTimeFormat(when.locale, { day: "numeric", month: "short" }).format(new Date(iso)).replace(".", "");
  const dayText = (iso: string) => {
    const d = dayWord(iso);
    return d.kind === "date"
      ? t("mobile.intentAgents.knows.when.date", { date: date(iso) })
      : t(`mobile.intentAgents.knows.when.${d.kind}`);
  };
  return (m: Memory) => {
    const o = memoryOrigin(m, meId);
    switch (o.kind) {
      case "saidDm":
        return t("mobile.intentAgents.knows.saidDm", { when: dayText(o.at) });
      case "saidChannel":
        return o.channel
          ? t("mobile.intentAgents.knows.saidChannel", { channel: o.channel, date: date(o.at) })
          : t("mobile.intentAgents.knows.saidSomewhere", { date: date(o.at) });
      case "wrote":
        return t("mobile.intentAgents.knows.wrote", { date: date(o.at) });
      case "learned":
        return t("mobile.intentAgents.knows.learned", { date: date(o.at) });
    }
  };
}
