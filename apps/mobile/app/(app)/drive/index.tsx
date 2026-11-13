import { useLocalSearchParams } from "expo-router";
import { DriveScreen } from "@/features/drive/DriveScreen";
import { isSafeId } from "@/features/shared/logic";

/** The Drive, pushed from Você; `?artifact=<id>` ("Ver no Drive" in the file viewer) outlines that item. */
export default function DriveRoute() {
  const { artifact } = useLocalSearchParams<{ artifact?: string }>();
  return <DriveScreen highlightId={isSafeId(artifact) ? artifact : null} />;
}
