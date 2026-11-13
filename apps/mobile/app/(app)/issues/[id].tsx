import { Redirect, useLocalSearchParams } from "expo-router";
import { IssueScreen } from "@/features/issues/IssueScreen";
import { issueNumberOf } from "@/features/issues/logic";
import { isSafeId } from "@/features/shared/logic";

/** One issue by its number (`/issues/134`); `m=<id>`: its conversation opens at that message. */
export default function IssueRoute() {
  const { id, m } = useLocalSearchParams<{ id: string; m?: string }>();
  const number = issueNumberOf(id);
  if (number === null) return <Redirect href="/issues" />;
  return <IssueScreen key={number} number={number} focusId={isSafeId(m) ? m : null} />;
}
