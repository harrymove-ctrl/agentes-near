import { useLocalSearchParams } from "expo-router";
import { WikiScreen } from "@/features/wiki/WikiScreen";

/** The wiki, pushed from Você; `?folder=Processos/Vendas` is the same screen for one folder. */
export default function WikiRoute() {
  const { folder } = useLocalSearchParams<{ folder?: string }>();
  return <WikiScreen key={folder ?? ""} folder={typeof folder === "string" ? folder : ""} />;
}
