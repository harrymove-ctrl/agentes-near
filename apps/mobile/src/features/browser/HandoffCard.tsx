import {
  BROWSER_FPS,
  type BrowserHandoff,
  drivesOnDesktop,
  HANDOFF_OVER,
  handoffIsMine,
  handoffScreen,
  useBrowserHandoff,
  useBrowserHandoffActions,
  useDesktopStatus,
} from "@agenteschat/client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { AskButtons, AskCard, AskFoot, ExpiryLine, useAskStore } from "../chat/asks";
import { IconTile } from "../connectors/ConnectorIcon";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { BrowserCard } from "./BrowserCard";
import { cardStateOf, NOTE_MAX } from "./logic";
import { useOpenHandoffId } from "./open";
import { FrameView, useLiveConnection } from "./parts";

/**
 * An agent's request for help in its browser, in the conversation. While nobody has opened it, it is the
 * request card: what the agent needs, "Ver a tela" showing its page as it is now, Abrir (takes the control
 * right here: the card becomes the agent's browser card) and "Agora não" (tells the agent, with an optional
 * reason). A request on the agent's desktop is the same card, Abrir taking it into the computer's full view (the
 * screen needs its room, ADR 0098), and one line that opens that view once someone helps there. Once someone is
 * in control of the browser it is the agent's browser card; once
 * it ends, one line with how. The state comes from the message (`meta.browserHandoff`) and is refreshed
 * from the server. A push or the inbox opens this card.
 */
export function HandoffCard({ handoff: fromMessage }: { handoff: BrowserHandoff }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const c = useColors();
  const surface = useSurface();
  const openId = useOpenHandoffId();
  const dir = useDirectory();
  const fresh = useBrowserHandoff(orgId, fromMessage.id);
  const h: BrowserHandoff = fresh.data ?? fromMessage;
  const state = cardStateOf(h, meId);
  const desktop = handoffScreen(h) === "desktop";
  // A browser request whose window is on the agent's screen, for someone who may drive the screen: helped there.
  const screenQ = useDesktopStatus(orgId, h.agentId, {
    enabled: !desktop && (state === "waiting" || state === "mine"),
  });
  const opensScreen = drivesOnDesktop(h, screenQ.data);
  // Opened from here (Abrir, a push): the browser card that takes the request's place starts open.
  const [open, setOpen] = useState(false);

  if (state === "done" || state === "failed" || state === "expired" || state === "cancelled" || state === "withdrawn") {
    const ok = state === "done";
    return (
      <View style={[styles.done, surface]}>
        <LineIcon
          name={ok ? "checkc" : state === "failed" ? "x" : "clock"}
          variant="small"
          size={16}
          color={ok ? c.ok : c.muted}
        />
        <Text variant="small" tone="muted" style={styles.grow}>
          {state === "failed" && h.note
            ? t("mobile.browser.card.failedNote", { note: h.note })
            : t(`mobile.browser.card.${state}`, {
                title: h.instructions,
                name: dir.agentById.get(h.agentId)?.name ?? t("channel.unknownAgent"),
              })}
        </Text>
      </View>
    );
  }
  if (opensScreen && (state === "mine" || state === "helping")) {
    const helper = h.controllerUserId ? dir.memberById.get(h.controllerUserId)?.name : undefined;
    return (
      <Pressable
        onPress={() => router.push(`/computer/${h.agentId}`)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.done, surface, pressed && styles.pressed]}
      >
        <LineIcon name="laptop" variant="small" size={15} color={c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {state === "mine"
            ? t("mobile.browser.live.inControl")
            : t("mobile.browser.live.helping", { name: helper ?? t("channel.unknownPerson") })}
        </Text>
      </Pressable>
    );
  }
  if (state === "waiting") {
    return (
      <HandoffAsk handoff={h} desktop={desktop} opensScreen={opensScreen} claim={openId === h.id} onOpened={setOpen} />
    );
  }
  return <BrowserCard agentId={h.agentId} handoff={h} claim={openId === h.id} open={open} onToggle={setOpen} />;
}

/** The request while it waits: the request card. */
function HandoffAsk({
  handoff: h,
  desktop,
  opensScreen,
  claim,
  onOpened,
}: {
  handoff: BrowserHandoff;
  desktop: boolean;
  /** Helped on the agent's whole screen (`drivesOnDesktop`): Abrir goes to the computer's full view. */
  opensScreen: boolean;
  claim: boolean;
  onOpened: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const asks = useAskStore();
  const actions = useBrowserHandoffActions(orgId);
  const agent = dir.agentById.get(h.agentId);
  const name = agent?.name ?? "";
  // Whose it is goes by ids (the same rule as the line above the composer); a name only says who, once it loads.
  // Someone else's: who it waits for in the header when known, no buttons here.
  const mine = meId !== null && handoffIsMine(h, meId, agent?.ownerUserId, org);
  const asked = h.requestedForUserId ? dir.memberById.get(h.requestedForUserId)?.name : undefined;
  // It ended meanwhile: the card settles on its own (`useBrowserHandoffMutations`), with nothing to tell.
  const failed = (err: unknown) => {
    if ((err as { code?: string }).code !== HANDOFF_OVER) toast({ title: t("mobile.app.failed"), icon: "x" });
  };

  // `Button` gives the press's haptic: none more here, or a press taps twice.
  const take = async () => {
    onOpened(true);
    try {
      await actions.takeControl(h.id);
      asks?.settle(h.id);
      if (opensScreen) router.push(`/computer/${h.agentId}`);
    } catch (err) {
      failed(err);
    }
  };
  // A push or the inbox opened this request: it takes the control once (first one wins), when it is the person's.
  const claimed = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request, when it opened the conversation
  useEffect(() => {
    if (!claim || !mine || claimed.current || h.status !== "pending") return;
    claimed.current = true;
    onOpened(true);
    actions.takeControl(h.id).then(
      () => {
        if (opensScreen) router.push(`/computer/${h.agentId}`);
      },
      () => {},
    );
  }, [claim, opensScreen, mine, h.id, h.status]);

  const notNow = useNotNow(h, () => asks?.settle(h.id));

  return (
    <AskCard
      id={h.id}
      kind={desktop ? "desktop" : "browser"}
      agentId={h.agentId}
      waitsFor={mine ? "you" : asked ? t("ask.waitingFor", { name: asked }) : null}
      lead={h.instructions}
      well={{
        tile: <IconTile name={desktop ? "laptop" : "globe"} size={20} bare />,
        title: name,
        detail: null,
        more: desktop ? null : { label: t("ask.seeScreen"), content: <ScreenPeek agentId={h.agentId} /> },
      }}
      expiry={h.expiresAt ? <ExpiryLine createdAt={h.createdAt} expiresAt={h.expiresAt} /> : null}
      foot={
        <AskFoot>
          {mine ? (
            <AskButtons
              primary={
                <Button variant="primary" size="card" wide label={t("mobile.browser.card.open")} onPress={take} />
              }
              secondary={<Button variant="secondary" size="card" wide label={t("approval.notNow")} onPress={notNow} />}
            />
          ) : null}
        </AskFoot>
      }
    />
  );
}

/** The agent's page as it is now, to look at before taking it (watching only: taps do nothing). */
function ScreenPeek({ agentId }: { agentId: string }) {
  const c = useColors();
  // A small look before taking it: a frame a second is enough (ADR 0040 §7.1).
  const live = useLiveConnection(agentId, true, BROWSER_FPS.preview);
  return (
    <View style={[styles.peek, { backgroundColor: c.sunken }]}>
      {live.frame ? (
        <FrameView frame={live.frame} enabled={false} onInput={live.sendInput} />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  // A line that wraps keeps its icon on the first.
  done: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 20,
  },
  peek: { aspectRatio: 16 / 10, borderRadius: 12, overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.85 },
});

/**
 * "Agora não" on a request for help: the agent hears it couldn't be done now, with the reason if one is given. The
 * chat's card and the agent's computer ask it the same way.
 */
export function useNotNow(h: BrowserHandoff | null, onDone?: () => void) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const actions = useBrowserHandoffActions(orgId);
  const name = (h && dir.agentById.get(h.agentId)?.name) ?? "";
  const g = genderOf(name);
  // Pressed through a `Button`, which gives the press's haptic.
  return () => {
    if (!h) return;
    sheet.open(
      <PromptForm
        title={t("mobile.browser.failed.title")}
        intro={t(`mobile.browser.failed.intro${g}`, { name })}
        placeholder={t("mobile.browser.failed.placeholder")}
        submitLabel={t("mobile.browser.failed.send")}
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          try {
            await actions.failed(h.id, text.trim().slice(0, NOTE_MAX) || undefined);
            onDone?.();
          } catch (err) {
            // It ended meanwhile: the card settles on its own (`useBrowserHandoffMutations`), with nothing to tell.
            if ((err as { code?: string }).code !== HANDOFF_OVER) toast({ title: t("mobile.app.failed"), icon: "x" });
          }
        }}
      />,
    );
  };
}
