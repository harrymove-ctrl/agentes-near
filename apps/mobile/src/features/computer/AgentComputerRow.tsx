import {
  asksPicture,
  isWaitingHandoff,
  PICTURE_IDLE_MS,
  useBrowserHandoffActions,
  useDesktopPicture,
} from "@agenteschat/client";
import { entryLine, entryState, pictureWhen } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Image } from "expo-image";
import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, GroupedFooter, GroupedHeader, PressScale, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useDirectory, useNow } from "../shared/hooks";
import { phoneEntryButton } from "./logic";
import { useSetupWait } from "./SetupWait";
import { useAgentComputer } from "./useAgentComputer";

/** Opens an agent's computer full screen. */
export const openComputer = (agentId: string) => router.push(`/computer/${agentId}`);

/**
 * The agent's computer on its profile, beside Chat: a named secondary button as wide as Chat ("Computador"), so what
 * it does is read, never guessed from a square. Only for whoever may watch the computer, the wait included; nothing
 * while that loads; a screen reader hears the entry's status line after the word. On a request of the agent's for
 * this person it says "Ajudar" and helps (takes control, then opens): the word is the signal, no dot. It never opens a stream.
 */
export function AgentComputerButton({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const actions = useBrowserHandoffActions(orgId);
  const view = useAgentComputer(agentId);
  const wait = useSetupWait(view.setup);
  const f = view.facts;
  // A request's minutes left move on too. While the computer is on its way, the time every other line reads.
  const requestNow = useNow(f?.handoff && isWaitingHandoff(f.handoff) ? 15_000 : 60_000);
  // Only for whoever may watch it; nothing while that loads, never one edition's words before the other's.
  if (view.forbidden || !view.ready || !f) return null;
  const now = wait.now ?? requestNow;
  const state = entryState(f, now);
  const line = entryLine(t, state, {
    edition: f.edition,
    locale: i18n.language,
    computer: computerName(t, org?.name ?? "", view.machine, isPersonal(org)),
    lastSeenAt: view.machine?.lastSeenAt ?? null,
    person: (id) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson"),
    step: null,
    emailPromised: wait.emailed,
    now: new Date(now),
  });
  const helps = phoneEntryButton(state) === "help";
  // The press gives its own haptic (`Button`).
  const open = () => openComputer(agentId);
  const help = async () => {
    if (state.kind !== "needsYou") return;
    try {
      await actions.takeControl(state.handoff.id);
      openComputer(agentId);
    } catch (err) {
      toast({
        title: (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
        icon: "x",
      });
    }
  };
  return (
    <Button
      variant="secondary"
      wide
      label={helps ? t("agentComputer.help") : t("agentComputer.button")}
      // The entry's status line ("Ligado · trabalhando agora"), which the one word can't carry.
      {...(line ? { hint: line } : {})}
      onPress={helps ? () => void help() : open}
    />
  );
}

/**
 * A recent picture of the agent's screen on its profile's Today, as the web's entry shows one: only while its
 * computer runs and the profile is on screen, for whoever may watch it, never a stream. A tap opens the computer;
 * under it, how old the picture is. Nothing otherwise (the button beside Chat stays the way in).
 */
export function AgentComputerPicture({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const focused = useIsFocused();
  const view = useAgentComputer(agentId, focused ? PICTURE_IDLE_MS : false);
  const asks = !view.forbidden && asksPicture(focused, view.desktopQ.data ?? null);
  const shot = useDesktopPicture(orgId, agentId, { enabled: asks, working: Boolean(view.facts?.working) });
  const now = useNow(60_000);
  const picture = asks ? shot.data?.picture : null;
  if (!picture) return null;
  const g = agentGrammar(dir.agentById.get(agentId)?.name ?? "");
  return (
    <>
      <GroupedHeader>{t("agentComputer.button")}</GroupedHeader>
      {/* The press gives its own haptic (`PressScale`). */}
      <PressScale
        onPress={() => openComputer(agentId)}
        accessibilityRole="button"
        accessibilityLabel={t("agentComputer.openOf", g)}
      >
        <Image
          source={{ uri: `data:image/jpeg;base64,${picture.data}` }}
          contentFit="cover"
          contentPosition="left top"
          style={styles.picture}
          accessible={false}
        />
      </PressScale>
      <GroupedFooter>{pictureWhen(t, i18n.language, picture.capturedAt, new Date(now))}</GroupedFooter>
    </>
  );
}

const styles = StyleSheet.create({
  picture: { width: "100%", aspectRatio: 16 / 10, borderRadius: 14 },
});
