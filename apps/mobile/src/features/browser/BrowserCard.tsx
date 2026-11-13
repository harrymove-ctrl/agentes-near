import {
  asksPicture,
  BROWSER_FPS,
  type BrowserHandoff,
  browserFrameDataUrl,
  browserSteps,
  type DesktopViewState,
  handoffFuse,
  handoffTimeLeft,
  isOpenHandoff,
  type LiveRun,
  profileLiveKey,
  rememberHeldPlace,
  useAgentBrowserHandoff,
  useAgentScreenControl,
  useBrowserHandoffActions,
  useBrowserProfileMutations,
  useBrowserScreen,
  useBrowserStuck,
  useDesktopPicture,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isBlankPage } from "@agenteschat/client/lib/sites";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { useAppActive } from "@/lib/useAppActive";
import { Sky } from "@/sky/Sky";
import { Button, Fuse, Icon, PixelOrbit, Text, useToast } from "@/ui";
import { ScreenWatch, type ScreenWatchHandle } from "../computer/ScreenWatch";
import { useColors, useDirectory, useEdition, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { framesWanted, pageGapKey, pageNoteOf, siteOf, skyBehind, stepText, waitsForPage } from "./logic";
import { AddressBar, browserTyping, FrameView, TypeBar, useLiveConnection } from "./parts";
import { useFinishHandoff } from "./useFinishHandoff";

/** The log's last lines under the page (the design shows three). */
const LOG_LINES = 3;

/**
 * The agent's browser as its card in the conversation, under a "Céu" header: a thin sky in the agent's
 * color on top, the site's letter and host, and what the agent does now. Open, the same card shows the page live with the last steps; Assumir (or Abrir on a request)
 * turns it into control right there: the request as the title, Pronto in the header, the app's own
 * field ("Digite aqui", Senha for saved passwords) and Não consegui; a take over ends with Devolver.
 * Pronto and Devolver hand back at once, with a note if the person leaves one. Nothing leaves the conversation. The
 * page streams only while the card is open, the agent works or I'm in control; while someone else is, it stays theirs.
 */
export function BrowserCard({
  agentId,
  run,
  busy = false,
  handoff: given,
  open: openProp,
  onToggle,
  claim = false,
  computer,
  surface = false,
  canTakeOver = true,
  onClosed,
  style,
  profile,
}: {
  agentId: string;
  /** A shared browser profile (ADR 0110) instead of the agent's browser: "Fazer login" from the computer's page. */
  profile?: { id: string; name: string };
  /** The agent's run in its browser (what it does now, the log). */
  run?: LiveRun | null;
  /** At work with no run to show here (its profile): closed, the card still shows its small live picture. */
  busy?: boolean;
  /** A request for help this card answers (the request's own message). */
  handoff?: BrowserHandoff | null;
  /** Controlled open state (the conversation opens the card from the working line); else its own. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** Opened from a push or the inbox: open and take the control once. */
  claim?: boolean;
  /** The computer the browser runs on (its profile): what an idle card says. */
  computer?: string | null;
  /**
   * The agent's computer full screen: always open, nothing to fold; Take control also opens a closed browser,
   * and in control an empty or closed one gets an address to open (the phone has no other way to a site). The
   * view's own head names it and says what goes on: the card keeps only the request or the site, and one action.
   */
  surface?: boolean;
  /** Take control may show: no hold or pause (the server still decides who may). */
  canTakeOver?: boolean;
  /** Whether the agent's browser is closed (the full-screen view's sub-line says so). */
  onClosed?: (closed: boolean) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const raised = useSurface("e2");
  // The Cloud's computer is always on: when it doesn't answer, it says so.
  const cloud = useEdition() === "cloud";
  const now = useNow(15_000);
  const actions = useBrowserHandoffActions(orgId);
  const profileActions = useBrowserProfileMutations(orgId);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = surface || (openProp ?? ownOpen);
  const setOpen = (next: boolean) => {
    if (onToggle) onToggle(next);
    else setOwnOpen(next);
  };

  const agent = dir.agentById.get(agentId);
  const name = profile?.name ?? agent?.name ?? "";
  const g = genderOf(name);
  const color = agentLook(agent).color;
  // A take over has no message of its own: the agent's open request, while this card is open.
  const ofAgent = useAgentBrowserHandoff(orgId, agentId, open && !given && !profile);
  const handoff = given ?? (ofAgent.data && isOpenHandoff(ofAgent.data) ? ofAgent.data : null);
  // Watching is for everyone behind its work; driving it only for admins, its owner and who it asked (ADR 0040).
  const control = useAgentScreenControl(orgId, agentId, !given && !profile);
  const mayDrive = Boolean(profile) || given !== null || control.data !== false;
  // Open, or closed while the agent works in it (its small live picture); a finished one keeps the last frame.
  // The person in control keeps watching even closed: their watching is what keeps their control.
  const holding = Boolean(meId) && handoff?.status === "active" && handoff.controllerUserId === meId;
  const working = Boolean(run) || busy;
  const watching = open || working || holding;
  // Its browser on the agent's screen, which this person may watch: the card shows that whole screen instead of the
  // browser's frames (ADR 0058 §7), only while open with the app in front, and lingering a little after.
  const active = useAppActive();
  const screen = useBrowserScreen(orgId, agentId, {
    enabled: !surface && !profile,
    userId: meId ?? "",
    shown: open && active,
    poll: open || working,
    holdsBrowser: holding,
  });
  const onScreen = screen.desktop;
  const [pageState, setPageState] = useState<DesktopViewState>("connecting");
  const watchRef = useRef<ScreenWatchHandle>(null);
  // The screen's view stays loaded while its stream lingers after the card folds, so a quick reopen reuses the page
  // and its socket; once gone, the next one opens afresh: nothing to drive until it says it's live.
  const screenMounted = onScreen && (open || screen.connect);
  useEffect(() => {
    if (!screenMounted) setPageState("connecting");
  }, [screenMounted]);
  // Closed, the card's picture is a thumbnail: a frame a second is plenty, on mobile data too (ADR 0040 §7.1).
  // Open, the page at the stream's own rate (several views of one agent get the most any of them needs).
  const live = useLiveConnection(
    profile ? profileLiveKey(profile.id) : agentId,
    framesWanted({
      watching,
      profile: Boolean(profile),
      holding,
      settled: screen.settled,
      desktop: onScreen,
    }),
    open ? undefined : BROWSER_FPS.preview,
  );
  // Closed on the agent's screen: a recent picture of it, never a stream.
  const shot = useDesktopPicture(orgId, agentId, {
    enabled: onScreen && active && asksPicture(!open && working, screen.status.data ?? null),
    working,
  });
  const picture = onScreen && !open ? shot.data?.picture : null;
  const controller =
    live.handoff?.controllerUserId ??
    live.controllerUserId ??
    handoff?.controllerUserId ??
    // The desktop's controller holds the browser only while the browser is on that screen.
    (screen.status.data?.browserOnDesktop ? screen.status.data.controllerUserId : null) ??
    null;
  const mine = Boolean(meId) && controller === meId;
  const waiting = handoff?.status === "pending";
  const steps = browserSteps(run?.work);
  const host = siteOf(live.frame?.metadata.url, steps);
  const doing = steps.at(-1);
  const helper = controller && !mine ? dir.nameOf({ type: "person", id: controller }) : "";
  const closed = !onScreen && live.unavailable === "closed";
  useEffect(() => onClosed?.(closed), [closed, onClosed]);
  // Assumir and Parar need a live page to drive; full screen, Assumir also opens a closed browser (there is
  // an address to open a site there).
  const ready = onScreen ? open && pageState === "live" : watching && Boolean(live.frame) && !live.unavailable;
  const canTake = canTakeOver && (ready || (surface && closed));
  const goShown = surface && mine && (closed || !live.frame || isBlankPage(live.frame.metadata.url));
  // Opening or reconnecting for too long says so, with Try again (as on the web). Only while the app's socket is
  // open: without a network no page can come, and the agent's browser isn't the one to blame.
  const [attempt, setAttempt] = useState(0);
  const waitingForPage =
    !onScreen &&
    watching &&
    live.online &&
    !live.hidden &&
    waitsForPage(live.unavailable) &&
    !(live.frame && !live.unavailable);
  const stuck = useBrowserStuck(waitingForPage, attempt);
  const note = pageNoteOf(live.unavailable, live.hidden, mine, stuck);
  // biome-ignore lint/correctness/useExhaustiveDependencies: said each time, also when a try that failed fails again
  useEffect(() => {
    if (mine && live.lost) toast({ title: t(live.lost.words), icon: "x" });
  }, [live.lost]);
  // Full screen its header says who is in control, so the page says only why it hides, as the web's does.
  const hiddenNote = surface
    ? t("browser.inCard.hiddenHelp", agentGrammar(name))
    : t("mobile.browser.live.hidden", { name: helper });
  const sky = !onScreen && !live.frame && skyBehind(note);
  const doneLabel = handoff?.kind === "takeover" ? t("mobile.browser.live.handBack") : t("mobile.browser.live.done");

  // A push or the inbox opened this request: the card opens and takes the control (first one wins).
  const claimed = useRef(false);
  useEffect(() => {
    if (!claim || claimed.current || !handoff || handoff.status !== "pending") return;
    claimed.current = true;
    setOwnOpen(true);
    onToggle?.(true);
    actions.takeControl(handoff.id).catch(() => {});
  }, [claim, handoff, actions, onToggle]);

  const failedToast = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  // Its buttons give the press's own haptic (`Button`): none more here, or a press taps twice.
  const answer = async () => {
    setOpen(true);
    if (handoff?.status !== "pending") return;
    try {
      await actions.takeControl(handoff.id);
    } catch {
      failedToast();
    }
  };
  const takeover = async () => {
    setOpen(true);
    try {
      if (profile) {
        await profileActions.takeover.mutateAsync(profile.id);
        return;
      }
      // From a run's card: bound to that run, so the card stays in this conversation while the run waits.
      const h = await actions.takeover(agentId, run?.runId);
      if (h.kind === "takeover" && h.runId && run) {
        rememberHeldPlace({ runId: h.runId, agentId, channelId: run.channelId, threadId: run.threadId });
      }
    } catch (err) {
      if ((err as { status?: number }).status === 409) toast({ title: t("browser.card.busy"), icon: "x" });
      else failedToast();
    }
  };
  const finishing = useFinishHandoff(handoff, name, doneLabel);
  const couldnt = finishing.couldnt;
  // A profile's control has no task to report on: Devolver just hands it back.
  const handBack = () => {
    if (!profile) return finishing.handBack();
    void profileActions.handback.mutateAsync(profile.id).then(successHaptic, failedToast);
  };
  const stop = () => {
    tapHaptic();
    Alert.alert(t(`mobile.browser.card.stopAsk${g}`, { name }), undefined, [
      { text: t("mobile.common.cancel"), style: "cancel" },
      {
        text: t("browser.watch.stop"),
        style: "destructive",
        onPress: () => void actions.stop(agentId).catch(failedToast),
      },
    ]);
  };
  // Who may drive it restarts the browser, then watches again (this card's own watch may be what was refused);
  // someone who only watches watches again.
  const retry = () => {
    setAttempt((n) => n + 1);
    if (onScreen) {
      watchRef.current?.retry();
      void screen.status.refetch();
      return;
    }
    if (mayDrive && !profile) void actions.restart(agentId).catch(failedToast).finally(live.retry);
    else live.retry();
  };

  // ── The header: what the card says it is ──
  // A take over asks nothing: its title is the site, as while watching.
  const asked = (mine || waiting) && handoff?.instructions ? handoff.instructions : "";
  // Nothing going on (its profile, the agent idle): the agent's browser and where it runs, not "in the browser".
  const idle = !working && !handoff && !host;
  const title =
    asked || host || (surface ? "" : idle ? t("browser.inCard.group", agentGrammar(name)) : t("browser.watch.title"));
  const hasAction = Boolean(mine && handoff) || waiting || (!controller && canTake);
  const left = waiting ? handoffTimeLeft(t, handoff, now) : null;
  const subtitle = mine
    ? host
      ? t("mobile.browser.card.inControlAt", { host })
      : t("mobile.browser.live.inControl")
    : waiting
      ? left !== null
        ? t("mobile.browser.card.needsFor", { name, time: left })
        : t("mobile.browser.card.needs", { name })
      : helper
        ? t("mobile.browser.live.helping", { name: helper })
        : closed
          ? t(`mobile.browser.live.unavailable.closed${g}`, { name })
          : doing
            ? t("mobile.browser.card.doing", { name, doing: stepText(t, doing) })
            : idle && computer
              ? t("browser.now.ready", { computer })
              : t(`mobile.browser.card.where${g}`, { name });

  return (
    <View style={[styles.card, raised, style]}>
      <Sky color={color} surface="raised" depth={0.95} fade={0} style={styles.sky} />
      {surface && !title && !hasAction ? null : (
        <Pressable
          onPress={
            surface
              ? undefined
              : () => {
                  tapHaptic();
                  setOpen(!open);
                }
          }
          accessibilityRole={surface ? undefined : "button"}
          accessibilityState={surface ? undefined : { expanded: open }}
          accessibilityLabel={surface ? title : `${title}. ${subtitle}`}
          style={({ pressed }) => [styles.head, pressed && !surface && styles.pressed]}
        >
          {!open ? (
            // Closed: the page's small live picture.
            <View style={[styles.thumb, { backgroundColor: c.sunken, borderColor: c.line }]}>
              {onScreen ? (
                picture ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${picture.data}` }}
                    style={StyleSheet.absoluteFill}
                    resizeMode="contain"
                    fadeDuration={0}
                  />
                ) : (
                  <Icon name="globe" size={18} color={c.faint} />
                )
              ) : live.frame ? (
                <Image
                  source={{ uri: browserFrameDataUrl(live.frame) ?? undefined }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                  fadeDuration={0}
                />
              ) : (
                <Icon name={live.hidden ? "eyeoff" : "globe"} size={18} color={c.faint} />
              )}
            </View>
          ) : null}
          <View style={styles.grow}>
            {title ? (
              <Text variant="footnote" tone="ink" numberOfLines={asked ? 2 : 1} style={styles.semibold}>
                {title}
              </Text>
            ) : null}
            {surface ? null : (
              <View style={styles.subRow}>
                {working && !mine && !waiting && !helper && !closed ? <PixelOrbit color={color} size={10} /> : null}
                <Text variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
                  {subtitle}
                </Text>
              </View>
            )}
            {!open && !mine && !waiting ? (
              <Text variant="caption" tone="faint" numberOfLines={1} style={styles.hint}>
                {t("mobile.browser.card.expandHint")}
              </Text>
            ) : null}
          </View>
          {mine && handoff ? (
            <Button
              variant="secondary"
              size="sm"
              icon="check"
              label={doneLabel}
              loading={finishing.finishing}
              onPress={handBack}
            />
          ) : waiting ? (
            <Button variant="primary" size="sm" label={t("mobile.browser.card.open")} onPress={answer} />
          ) : (
            <View style={styles.acts}>
              {!controller && canTake ? (
                <>
                  {mayDrive ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      label={surface ? t("desktop.takeover") : t("mobile.browser.live.takeOver")}
                      onPress={takeover}
                    />
                  ) : null}
                  {ready && !surface && !profile ? (
                    <Pressable
                      onPress={stop}
                      accessibilityRole="button"
                      accessibilityLabel={t("mobile.browser.card.stop")}
                      hitSlop={8}
                      style={({ pressed }) => [styles.icon, pressed && { backgroundColor: c.sunken }]}
                    >
                      <Icon name="stop" size={16} color={c.muted} />
                    </Pressable>
                  ) : null}
                </>
              ) : null}
              {surface ? null : (
                <View style={open ? styles.flip : undefined}>
                  <Icon name="chev" size={13} color={c.faint} />
                </View>
              )}
            </View>
          )}
        </Pressable>
      )}

      {/* One place in the tree for the screen, open or folded, so folding parks it (out of the layout) instead of
          closing it. */}
      {screenMounted ? (
        <ScreenWatch
          ref={watchRef}
          agentId={agentId}
          connect={screen.connect}
          parked={!open}
          onState={(state) => {
            setPageState(state);
            screen.report(state);
          }}
          style={[styles.screen, !mine && !helper && steps.length === 0 && styles.pageLast]}
        />
      ) : null}
      {open ? (
        <>
          {onScreen ? null : (
            <View
              style={[
                styles.page,
                // Nothing under the page (no controls, note or steps): it keeps the card's margin at the bottom too.
                !mine && !(helper && !live.hidden) && steps.length === 0 && styles.pageLast,
                sky ? null : { backgroundColor: c.sunken },
              ]}
            >
              {sky ? (
                <Sky color={color} surface="raised" depth={0.95} fade={0} style={StyleSheet.absoluteFill} />
              ) : null}
              {live.frame ? <FrameView frame={live.frame} enabled={mine} onInput={live.sendInput} /> : null}
              {live.frame?.metadata.emulated ? (
                <View style={[styles.emu, raised]}>
                  <Text variant="caption" tone="ink" style={styles.semibold}>
                    {t(`browser.live.emulated.${live.frame.metadata.emulated}`, {
                      size: `${live.frame.metadata.deviceWidth}×${live.frame.metadata.deviceHeight}`,
                    })}
                  </Text>
                  {mine ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      label={t("browser.live.normalSize")}
                      disabled={profile ? profileActions.open.isPending : actions.opening}
                      onPress={() =>
                        void (
                          profile
                            ? profileActions.open.mutateAsync({ profileId: profile.id, url: { go: "normalSize" } })
                            : actions.open(agentId, { go: "normalSize" })
                        ).catch(failedToast)
                      }
                    />
                  ) : null}
                </View>
              ) : null}
              {!live.frame || live.unavailable ? (
                <View style={[styles.center, live.frame ? styles.overlay : null]}>
                  <View style={sky ? [styles.onSky, raised] : styles.lines}>
                    {note.spin ? (
                      <ActivityIndicator color={c.muted} />
                    ) : note.say === "hidden" ? (
                      <Icon name="eyeoff" size={18} color={c.muted} />
                    ) : null}
                    <Text variant="small" tone="ink" style={[styles.semibold, styles.centerText]}>
                      {note.say === "starting"
                        ? t(`mobile.browser.card.starting${g}`, { name })
                        : note.say === "hidden"
                          ? hiddenNote
                          : t(pageGapKey(note.say, g, cloud), { name })}
                    </Text>
                    {note.help && (note.help !== "stuckHelp" || mayDrive) ? (
                      <Text variant="caption" tone="muted" style={styles.centerText}>
                        {t(`mobile.browser.live.${note.help}${g}`, { name })}
                      </Text>
                    ) : null}
                    {note.say === "stuck" ? (
                      <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={retry} />
                    ) : null}
                  </View>
                </View>
              ) : null}
            </View>
          )}
          {mine ? (
            <View style={styles.control}>
              {goShown ? (
                <AddressBar
                  name={name}
                  cloud={cloud}
                  onOpen={(url) =>
                    profile
                      ? profileActions.open.mutateAsync({ profileId: profile.id, url })
                      : actions.open(agentId, url)
                  }
                />
              ) : null}
              <TypeBar
                {...browserTyping(live.sendInput, () =>
                  toast({ title: t("desktop.clipboard.tooLong", agentGrammar(name)), icon: "x" }),
                )}
              />
              {/* A profile goes back to its agents, not to one. A take over asked for nothing: it only hands back. */}
              <View style={styles.ways}>
                {profile ? null : (
                  <Pressable
                    onPress={finishing.leaveNote}
                    accessibilityRole="button"
                    hitSlop={8}
                    style={({ pressed }) => [styles.way, pressed && styles.pressedWord]}
                  >
                    <Text variant="small" tone="muted" style={styles.medium}>
                      {t("browser.inCard.addNote")}
                    </Text>
                  </Pressable>
                )}
                {handoff?.kind === "ask" ? (
                  <Pressable
                    onPress={couldnt}
                    accessibilityRole="button"
                    hitSlop={8}
                    style={({ pressed }) => [styles.way, pressed && styles.pressedWord]}
                  >
                    <Text variant="small" tone="muted" style={styles.medium}>
                      {t("mobile.browser.live.couldnt")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : helper ? (
            live.hidden ? null : (
              <Text variant="small" tone="muted" style={styles.note}>
                {t("mobile.browser.live.watchOnly", { name: helper })}
              </Text>
            )
          ) : steps.length > 0 ? (
            <View style={styles.log}>
              {steps.slice(-LOG_LINES).map((s, i, shown) => (
                <View
                  key={s.id}
                  style={[styles.step, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
                >
                  <Text
                    variant="caption"
                    tone={i === shown.length - 1 ? "ink" : "muted"}
                    numberOfLines={1}
                    style={[styles.grow, i === shown.length - 1 && styles.semibold]}
                  >
                    {stepText(t, s)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
      {waiting && handoff?.expiresAt ? (
        <Fuse color={color} remaining={handoffFuse(handoff, now)} style={styles.fuse} />
      ) : null}
    </View>
  );
}

/**
 * An agent's run in its browser as a row of the conversation. While the agent waits on a request for
 * help, that request's own card (on its message) is the browser: this one steps aside.
 */
export function BrowserRunCard({
  run,
  open,
  onToggle,
}: {
  run: LiveRun;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const orgId = useOrgId();
  const ofAgent = useAgentBrowserHandoff(orgId, run.agentId);
  const asked = ofAgent.data && isOpenHandoff(ofAgent.data) && ofAgent.data.kind === "ask";
  if (asked) return null;
  return <BrowserCard agentId={run.agentId} run={run} open={open} onToggle={onToggle} />;
}

/** The card's corners, and the page inside it 8 pt in, concentric with them. */
const CARD = 20;
const PAGE_INSET = 8;

const styles = StyleSheet.create({
  card: { marginTop: 12, borderRadius: CARD, overflow: "hidden" },
  sky: { height: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  subRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  acts: { flexDirection: "row", alignItems: "center", gap: 4 },
  icon: { width: 30, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  thumb: {
    width: 96,
    height: 60,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: { marginTop: 2 },
  flip: { transform: [{ rotate: "180deg" }] },
  page: { aspectRatio: 16 / 10, marginHorizontal: PAGE_INSET, borderRadius: CARD - PAGE_INSET, overflow: "hidden" },
  // The whole screen, its own shape (ScreenWatch sets it): never cropped.
  screen: { marginHorizontal: PAGE_INSET, borderRadius: CARD - PAGE_INSET },
  pageLast: { marginBottom: PAGE_INSET },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  lines: { alignItems: "center", gap: 8 },
  onSky: { alignItems: "center", gap: 4, maxWidth: 420, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14 },
  centerText: { textAlign: "center" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.35)" },
  emu: {
    position: "absolute",
    bottom: 8,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 10,
    paddingRight: 4,
    minHeight: 28,
    borderRadius: 999,
  },
  control: { padding: 10, gap: 8 },
  ways: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 16 },
  way: { paddingVertical: 4 },
  note: { paddingHorizontal: 12, paddingVertical: 10 },
  log: { paddingHorizontal: 12, paddingVertical: 6 },
  step: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
  fuse: { marginTop: 0 },
  pressed: { opacity: 0.7 },
  pressedWord: { opacity: 0.6 },
});
