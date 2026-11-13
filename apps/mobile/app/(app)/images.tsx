import { useLocalSearchParams } from "expo-router";
import { ImageViewer } from "@/features/files/ImageViewer";

/**
 * A message's pictures, full screen over the conversation (presentation set in `_layout`):
 * `/images?files=<id>@<version>,…&at=<index>`, with `from` when a stack of pictures opened it.
 */
export default function ImagesRoute() {
  const { files, at, from } = useLocalSearchParams<{ files?: string; at?: string; from?: string }>();
  return <ImageViewer files={files} at={at} from={from} />;
}
