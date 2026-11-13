import { useTranslation } from "react-i18next";
import { TabStack } from "@/ui";

/** Threads (threads and missions): a stack whose root has the native large title. */
export default function ThreadsStack() {
  const { t } = useTranslation();
  return <TabStack title={t("mobile.threads.title")} />;
}
