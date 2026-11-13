import { Redirect, useLocalSearchParams } from "expo-router";
import { FileShareSheet } from "@/features/files/ShareSheet";
import { isSafeId } from "@/features/shared/logic";
import { goBack } from "@/features/shared/parts";

/** Compartilhar a file (`?id=`), as a form sheet over the file or the Drive (presentation set in `_layout`). */
export default function FileShareRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!isSafeId(id)) return <Redirect href="/drive" />;
  return <FileShareSheet id={id} onClose={goBack} />;
}
