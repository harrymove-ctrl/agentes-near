import { useTranslation } from "react-i18next";
import { TabStack } from "@/ui";

/** Agentes: a stack whose root has the native large title. */
export default function AgentsStack() {
  const { t } = useTranslation();
  return <TabStack title={t("mobile.agents.title")} />;
}
