import { useTranslation } from "react-i18next";
import { TabStack } from "@/ui";

/** Buscar, the search tab (iOS 26: the round button apart in the tab bar): a stack whose root has the large title. */
export default function SearchStack() {
  const { t } = useTranslation();
  return <TabStack title={t("mobile.find.title")} />;
}
