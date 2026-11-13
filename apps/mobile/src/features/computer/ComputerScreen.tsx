import {
  type BrowserHandoff,
  browserOnlyWhy,
  controlledBy,
  handoffScreen,
  screenSteps,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { cantShow, cantShowLine, liveSubLine } from "@agenteschat/client/lib/agent-computer";
import { computerName, READY_FLASH_MS, WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { clockAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { computerKind, isPaused } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useNavigation } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { IconButton, type IconName, LineIcon, Text, ToastHost, useToast } from "@/ui";
import { BrowserCard } from "../browser/BrowserCard";
import { HeaderPill } from "../chat/HeaderPill";
import { openSwitchComputer } from "../outages/OutageNotice";
import { useMachineOutages } from "../outages/queries";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { goBack } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { AgentScreen } from "./AgentScreen";
import { Cover } from "./Cover";
import { DockText } from "./EdgeDock";
import { LiveTrail } from "./LiveTrail";
import { offersSwitch, type PhoneStage, phoneStage, setupSub } from "./logic";
import { SetupWait } from "./SetupWait";
import { useAgentComputer, useAgentRun } from "./useAgentComputer";
import { usePickComputer } from "./usePickComputer";

/** How often the screen's state is asked while no page shows; the page has a stream of its own. */
const POLL_MS = 5_000;
const PAGE_POLL_MS = 30_000;

/**
 * An agent's computer full screen on the phone (`/computer/<agentId>`, a full-screen modal): close, "Computador
 * da Ada" and the sub-line on top, then the web dialog's states in its words. The stage is the agent's screen where
 * its computer serves one (`AgentScreen`), and otherwise its page live (the browser card: watch, take control, tap
 * to click, type, the keys). Leaving in control of a take over (✕ or Android's back) hands it back at once; the agent's own request keeps
 * its 2 minutes.
 */
export function ComputerScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  // The app's own toasts: what leaving says shows under the view as it goes.
  const toast = useToast();
  const actions = useBrowserHandoffActions(useOrg().orgId);
  const leave = (held: BrowserHandoff | null) => {
    if (!held) return;
    const agent = dir.agentById.get(agentId);
    const g = agentGrammar(agent?.name ?? "");
    // The toast names the agent: its face leads it.
    const face = agentLook(agent);
    if (held.kind === "takeover") {
      actions.done(held.id).then(
        () => toast({ title: t("browser.now.handedBack", g), agent: face }),
        () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      );
    } else toast({ title: t("agentComputer.closeAsk", g), agent: face });
  };
  return (
    <ToastHost>
      <SheetHostProvider>
        <ComputerView agentId={agentId} onLeave={leave} />
      </SheetHostProvider>
    </ToastHost>
  );
}

/**
 * "Pronto" for a moment when the computer it was waiting for gets ready, then the stage opens by itself. A hold
 * also ends the wait's stage, and the computer isn't ready then.
 */
function useReadyFlash(stage: PhoneStage | null) {
  const [flashing, setFlashing] = useState(false);
  const was = useRef(stage);
  useEffect(() => {
    if (was.current === "preparing" && stage && stage !== "preparing" && stage !== "held") setFlashing(true);
    was.current = stage;
  }, [stage]);
  useEffect(() => {
    if (!flashing) return;
    const id = setTimeout(() => setFlashing(false), READY_FLASH_MS);
    return () => clearTimeout(id);
  }, [flashing]);
  return flashing;
}

function ComputerView({ agentId, onLeave }: { agentId: string; onLeave: (held: BrowserHandoff | null) => void }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const meId = useMeId();
  const { org } = useOrg();
  const dir = useDirectory();
  const navigation = useNavigation();
  // Whether the agent's browser is closed, as the page says (its sub-line is "Ao vivo" alone then).
  const [pageClosed, setPageClosed] = useState(false);
  const [poll, setPoll] = useState<number | false>(POLL_MS);
  const view = useAgentComputer(agentId, poll);
  const run = useAgentRun(agentId);
  const f = view.facts;
  const stage = f ? phoneStage(f) : null;
  useEffect(() => setPoll(stage === "page" ? PAGE_POLL_MS : POLL_MS), [stage]);
  const flashing = useReadyFlash(stage);
  const outages = useMachineOutages();
  const now = useNow(15_000);
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = agentGrammar(name);
  const machine = view.machine;
  const computer = computerName(t, org?.name ?? "", machine, isPersonal(org));
  const manages = can(org, "manage_agents") || (Boolean(meId) && agent?.ownerUserId === meId);
  const pickComputer = usePickComputer(agentId);
  const person = (id: string) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson");
  // What leaving hands back: the agent's browser or screen in this person's hands.
  const mine = f?.handoff && controlledBy(f.handoff, f.userId) ? f.handoff : null;
  const leaving = useRef(() => {});
  useEffect(() => {
    leaving.current = () => onLeave(mine);
  });
  // However the view goes (✕, Android's back, the app moving elsewhere), what it held goes back. `removed` comes
  // after this effect's cleanup, so unsubscribing waits a microtask.
  useEffect(() => {
    const off = navigation.addListener("removed", () => leaving.current());
    return () => queueMicrotask(off);
  }, [navigation]);
  const pausedUntil = f?.edition === "selfhost" && machine && isPaused(machine, now) ? machine.paused : null;

  const pauseBanner = f?.held ? (
    <Banner icon="pause" text={t("agentComputer.state.held", g)} help={t("agentComputer.state.heldHelp")} />
  ) : pausedUntil ? (
    <Banner
      icon="pause"
      text={
        pausedUntil.until
          ? t("agentComputer.state.paused", { computer, time: clockAt(i18n.language, pausedUntil.until) })
          : t("agentComputer.state.pausedPlain", { computer })
      }
      help={t("machines.pausedHint")}
    />
  ) : null;
  // The conversation's own header: close, then the glass pill with the agent's face and sky, "Computador da Ada"
  // and the line of what goes on; what taking control means (ⓘ) beside it.
  const title = t("agentComputer.title", g);
  const top = (line: string, action?: ReactNode, info?: ReactNode) => (
    <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
      <IconButton icon="x" plate label={t("mobile.common.close")} onPress={goBack} />
      <HeaderPill
        lead={<AgentFace agentId={agentId} size={32} framed={false} mode={f?.working ? "run" : "idle"} />}
        title={title}
        subtitle={line || undefined}
        color={agentLook(agent).color}
        working={Boolean(f?.working)}
        label={[title, line].filter(Boolean).join(", ")}
      />
      {info ? <View style={styles.info}>{info}</View> : null}
      {action}
    </View>
  );

  // The agent's screen takes the whole view: there is no page to scroll.
  if (f && view.ready && !view.forbidden && !flashing && stage === "screen") {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AgentScreen
          agentId={agentId}
          view={view}
          run={run}
          canTakeOver={!f.held && !pausedUntil}
          banner={pauseBanner}
          top={top}
        />
      </View>
    );
  }

  // The header's sub-line says only what a cover or a banner doesn't, as on the web: each thing once.
  let sub = "";
  let body: ReactNode;
  if (!f || !view.ready) {
    body = <Cover sky spinner color={agentLook(agent).color} text={t("agentComputer.state.opening", g)} />;
  } else if (view.forbidden) {
    body = (
      <Cover
        icon="lock"
        text={t(can(org, "own_browsers") ? "agentComputer.state.forbidden" : "agentComputer.state.noRole")}
      />
    );
  } else if (flashing) {
    body = <Cover icon="check" text={t("agentComputer.state.ready")} />;
  } else if (stage === "held") {
    body = <Cover icon="pause" text={t("agentComputer.state.held", g)} help={t("agentComputer.state.heldHelp")} />;
  } else if (stage === "preparing" && f.setup) {
    sub = setupSub(t, f.setup);
    body = <SetupWait view={f.setup} said />;
  } else if (stage === "page") {
    const controlled = f.handoff?.status === "active" && Boolean(f.handoff.controllerUserId);
    // A closed browser shows nothing live to watch: "Ao vivo" alone, as on the web.
    sub = pageClosed && !controlled ? t("browser.watch.live") : liveSubLine(t, f, { name, person, nowMs: now });
    body = (
      <>
        {pauseBanner}
        {f.desktop?.reason === "browser_only" ? (
          <Banner icon="lock" text={t("desktop.browserOnly.title")} help={t(browserOnlyWhy(view.desktopQ.data), g)} />
        ) : null}
        <BrowserCard
          agentId={agentId}
          run={run}
          busy={f.working}
          handoff={f.handoff && handoffScreen(f.handoff) === "browser" ? f.handoff : null}
          canTakeOver={!f.held && !pausedUntil}
          surface
          onClosed={setPageClosed}
          style={styles.flush}
        />
      </>
    );
  } else if (stage === "offline" && machine) {
    const since = machine.lastSeenAt ? clockAt(i18n.language, machine.lastSeenAt) : null;
    const outage = outages.outages.find((o) => o.machineId === machine.id);
    if (f.edition === "cloud") {
      sub = t("agentComputer.sub.notAnswering");
      body = (
        <Cover
          art={<ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state="offline" size={96} />}
          text={t("agentComputer.state.notAnsweringHelp")}
        />
      );
    } else {
      sub = since ? t("agentComputer.sub.offline", { time: since }) : t("machines.offline");
      // What it did last (it may go on without the computer): its steps under the box, to see how far it got.
      const steps = screenSteps(run?.work);
      body = (
        <>
          <Cover
            art={<ComputerPortrait kind={computerKind(machine.os)} state="offline" size={96} />}
            text={t("agentComputer.state.offline", { computer })}
            help={t("agentComputer.state.offlineHelpPlain", g)}
            action={
              offersSwitch(f, manages, Boolean(outage)) ? (
                <DockText
                  icon="swap"
                  label={t("mobile.outage.switch")}
                  onPress={() => openSwitchComputer(machine.id)}
                />
              ) : null
            }
          />
          {steps.length > 0 ? <LiveTrail steps={steps} color={agentLook(agent).color} now={now} /> : null}
        </>
      );
    }
  } else if (stage === "joining") {
    // The workspace's computer is ready and this agent gets it at its first hello, or it wakes: a moment more.
    body = <Cover sky spinner color={agentLook(agent).color} text={t("agentComputer.state.opening", g)} />;
  } else if (stage === "noComputer") {
    sub = t("agentComputer.status.noComputer");
    // Who may choose one does it here, on the screen's own capsule, never sent to the website.
    body = (
      <Cover
        art={<AgentFace agentId={agentId} size={44} framed={false} live={false} mode="rest" />}
        text={t("agentComputer.state.noComputer", g)}
        {...(pickComputer ? { help: t("mobile.computer.pickHelp") } : {})}
        action={pickComputer ? <DockText label={t("mobile.computer.pick")} onPress={pickComputer} /> : null}
      />
    );
  } else if (stage === "noScreen") {
    body = (
      <Cover
        icon="eyeoff"
        text={t("agentComputer.state.noScreen", g)}
        help={manages ? t("agentComputer.state.noScreenHelp") : undefined}
      />
    );
  } else {
    // Why, as the entry's line says it; a self-hoster's old program gets what to do.
    const cause = cantShow(f);
    const outdated = f.edition === "selfhost" && cause === "outdated";
    body = (
      <Cover
        icon="eyeoff"
        text={
          outdated
            ? t("agentComputer.state.outdated", { ...g, computer })
            : (cantShowLine(t, cause, { edition: f.edition, computer }) ?? t("agentComputer.state.unavailable", g))
        }
        help={outdated ? undefined : t("agentComputer.state.unavailableHelp")}
        action={<DockText label={t("desktop.retry")} onPress={() => void view.desktopQ.refetch()} />}
      />
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      {top(sub)}
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {body}
      </ScrollView>
    </View>
  );
}

/** A line over the live stage: the agent held, its computer paused, or a request on its screen. */
function Banner({ icon, text, help, tone }: { icon: IconName; text: string; help?: string; tone?: "warn" }) {
  const c = useColors();
  return (
    <View style={[styles.banner, { backgroundColor: c.sunken }]} accessibilityRole="summary">
      <LineIcon variant="small" name={icon} size={18} color={tone === "warn" ? c.amber : c.muted} />
      <View style={styles.grow}>
        <Text variant="small" tone="ink" style={styles.bold}>
          {text}
        </Text>
        {help ? (
          <Text variant="caption" tone="muted">
            {help}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
  info: { marginLeft: "auto" },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  body: { paddingHorizontal: 12, gap: 12 },
  flush: { marginTop: 0 },
  // The text and its help wrap: the icon stays on the first line instead of the block's middle.
  banner: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: 14, padding: 12 },
});
