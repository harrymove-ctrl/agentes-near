import { useTranslation } from "react-i18next";
import { TabStack } from "@/ui";

/** Atividade: a stack whose root has the native large title. */
export default function ActivityStack() {
  const { t } = useTranslation();
  return <TabStack title={t("mobile.activity.title")} />;
}
