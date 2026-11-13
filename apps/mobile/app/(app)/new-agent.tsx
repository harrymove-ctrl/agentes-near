import { useLocalSearchParams } from "expo-router";
import { NewAgentScreen } from "@/features/agents/NewAgentScreen";

/**
 * "Criar agente" in steps; `?what=` (the examples of an empty Conversas) starts from scratch with that text;
 * `?proposal=` (an agent's proposal card, ADR 0081) starts on Revisar with its draft; `?import=1` (Configurações ›
 * Importar e exportar) opens on bringing agents from another app; `?channel=` (a channel's Adicionar sheet) starts the
 * agent in that channel.
 */
export default function NewAgentRoute() {
  const {
    what,
    proposal,
    import: fromApp,
    channel,
  } = useLocalSearchParams<{ what?: string; proposal?: string; import?: string; channel?: string }>();
  return (
    <NewAgentScreen
      initialWhat={typeof what === "string" ? what.slice(0, 500) : ""}
      proposalId={typeof proposal === "string" && proposal ? proposal : null}
      channelId={typeof channel === "string" && channel ? channel : null}
      startImport={fromApp === "1"}
    />
  );
}
