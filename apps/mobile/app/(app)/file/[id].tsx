import { useLocalSearchParams } from "expo-router";
import { DocumentViewer } from "@/features/files/DocumentViewer";

/** A file from a message, full screen (presentation set in `_layout`): `/file/<id>?v=<version>`. */
export default function FileRoute() {
  const { id, v } = useLocalSearchParams<{ id: string; v?: string }>();
  const version = v ? Number(v) : Number.NaN;
  return <DocumentViewer id={id} {...(Number.isInteger(version) && version > 0 ? { version } : {})} />;
}
