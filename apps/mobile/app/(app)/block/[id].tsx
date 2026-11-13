import { useLocalSearchParams } from "expo-router";
import { BlockScreen } from "@/features/blocks/LiveBlock";

/** A live block on a screen of its own, pushed from its message: `/block/<id>?v=<version>`. */
export default function BlockRoute() {
  const { id, v } = useLocalSearchParams<{ id: string; v?: string }>();
  const version = v ? Number(v) : Number.NaN;
  return <BlockScreen id={id} {...(Number.isInteger(version) && version > 0 ? { version } : {})} />;
}
