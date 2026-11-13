import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SearchField, SheetScreen } from "@/ui";
import { ChatTargets } from "./ChatTargets";
import { SheetHeader } from "./parts";
import { useOpenDm } from "./useOpenDm";

/** "Chat with…": an agent or a person; tapping opens the direct conversation. */
export function NewChatPicker() {
  const { t } = useTranslation();
  const openDm = useOpenDm();
  const [q, setQ] = useState("");
  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.new.chat")} />
      <SearchField value={q} onChangeText={setQ} placeholder={t("mobile.new.chatSearch")} autoCorrect={false} />
      <ChatTargets
        q={q}
        onAgent={(agentId) => void openDm({ agentId })}
        onPerson={(userId) => void openDm({ userId })}
      />
    </SheetScreen>
  );
}
