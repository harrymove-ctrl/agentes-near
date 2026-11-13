import {
  type AgentProposalCard,
  type BrowserHandoff,
  browserHandoffOf,
  handoffIsMine,
  handoffScreen,
  type LiveConsult,
  type LiveRun,
  type Message,
  type SecretRequest,
  useApproval,
  useBrowserHandoff,
  useCardProposals,
} from "@agenteschat/client";
import { agentProposalOf, proposalStatus } from "@agenteschat/client/lib/action-cards";
import { questionWaitsOn } from "@agenteschat/client/lib/agent-questions";
import { askKindWords } from "@agenteschat/client/lib/approval-words";
import { timeLeft } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isOpen, messageProposalCards, proposalTarget, proposerOf } from "@agenteschat/client/lib/proposals";
import { secretLabel } from "@agenteschat/client/lib/secret-requests";
import { LinearGradient } from "expo-linear-gradient";
import {
  type ComponentRef,
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Sky } from "@/sky/Sky";
import {
  CHROME_MAX_SCALE,
  EventPill,
  EventPillAction,
  EventPillText,
  Fuse,
  Icon,
  type IconName,
  Text,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { SparkCheck } from "@/ui/SparkCheck";
import { approvalTitleText } from "../approvals/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook, fuseRemaining } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import {
  type AskKind,
  type AskStore,
  type AwayAsk,
  approvalMayWait,
  cardShows,
  type Measurable,
  mayAsk,
  type PendingAsk,
  secretRequestOf,
  timerDelay,
} from "./ask-store";
import { LineStop } from "./LiveRows";
import { approvalIdOf, lineStops, markedParts, markName, parseInline, questionOf, workingEntries } from "./logic";
import { useCardTop, useOwnTop } from "./look";
import { Spans } from "./MessageSpans";

/**
 * A request in the conversation (an approval, a secret, a question, help in the agent's browser or on its
 * computer, a proposal) is one card for all: what it asks in a small label with its state, the agent's own
 * words, the thing it is about in a well (whole under "Ver …"), then a strip with when it expires and the
 * decision. Decided, it is one quiet line (`AskDone`). While one waits out of view, the line above the composer
 * says so and takes the person to it. What waits and what shows is kept in `ask-store.ts`.
 */

const AskStoreContext = createContext<AskStore | null>(null);

export function AskStoreProvider({ store, children }: { store: AskStore; children: ReactNode }) {
  return <AskStoreContext.Provider value={store}>{children}</AskStoreContext.Provider>;
}

/** The conversation's requests (null outside a conversation: a card elsewhere reports nothing). */
export const useAskStore = () => useContext(AskStoreContext);

/** The first request waiting out of view, redrawn only when that changes. */
export function useAwayAsk(store: AskStore): AwayAsk | null {
  return useSyncExternalStore(store.subscribe, store.getAway, store.getAway);
}

/** Whether `at` has passed, turning true right at that moment: one timer to it, no polling. */
export function useExpired(at: string | null | undefined): boolean {
  const ms = at ? Date.parse(at) : Number.NaN;
  const [now, setNow] = useState(Date.now);
  const expired = Number.isFinite(ms) && now >= ms;
  useEffect(() => {
    if (!Number.isFinite(ms) || expired) return;
    let timer: ReturnType<typeof setTimeout>;
    // A time farther away than a timer reaches is waited for in steps.
    const wait = () => {
      timer = setTimeout(() => (Date.now() >= ms ? setNow(Date.now()) : wait()), timerDelay(ms, Date.now()));
    };
    wait();
    return () => clearTimeout(timer);
  }, [ms, expired]);
  return expired;
}

// ── Which requests wait here ─────────────────────────────────────────────────

/**
 * Reads which of the conversation's requests wait on the person, from every loaded message (not only the
 * rows on screen, which the list unmounts as they scroll away), with the same queries the cards use. The scan
 * reads keys only; a message's probe draws again only when the message or its place changes, not on every
 * word an agent streams.
 */
export function AskProbes({ messages }: { messages: Message[] }) {
  const asking = useMemo(() => messages.flatMap((m, order) => (mayAsk(m) ? [{ m, order }] : [])), [messages]);
  return (
    <>
      {asking.map(({ m, order }) => (
        <AskProbe key={m.id} message={m} order={order} />
      ))}
    </>
  );
}

const AskProbe = memo(function AskProbe({ message: m, order }: { message: Message; order: number }) {
  const meId = useMeId();
  const approvalId = approvalIdOf(m.meta);
  const question = questionOf(m.meta);
  const secret = secretRequestOf(m.meta);
  const handoff = browserHandoffOf(m.meta);
  const proposal = agentProposalOf(m.meta);
  const changes = messageProposalCards(m.meta);
  const asked: PendingAsk | null =
    question?.status === "open" && questionWaitsOn(question, meId)
      ? { id: question.id, kind: "question", agentId: question.agentId, what: question.text, messageId: m.id, order }
      : null;
  return (
    <>
      {/* An approval expires in a day: an older message's can't wait any more, so it isn't asked for. */}
      {approvalId && approvalMayWait(m.createdAt, Date.now()) ? (
        <ApprovalProbe id={approvalId} messageId={m.id} order={order} />
      ) : null}
      {question ? <Report id={question.id} ask={asked} /> : null}
      {secret ? <SecretProbe request={secret} messageId={m.id} order={order} /> : null}
      {/* The card's own copy says when a request ended (the server keeps it, and live events patch it): only an
          open one is asked about. */}
      {handoff?.status === "pending" ? (
        <HandoffProbe id={handoff.id} fallback={handoff} messageId={m.id} order={order} />
      ) : null}
      {proposal && m.author.id ? (
        <ProposalProbe card={proposal} agentId={m.author.id} messageId={m.id} order={order} />
      ) : null}
      {changes.map((ids) => (
        <ChangeProposalProbe key={ids.join(",")} ids={ids} messageId={m.id} order={order} />
      ))}
    </>
  );
});

/** Puts the request in the store while it waits on the person; takes it out when it doesn't (or unmounts). */
function Report({ id, ask }: { id: string; ask: PendingAsk | null }) {
  const store = useAskStore();
  const key = ask ? `${ask.kind}|${ask.agentId}|${ask.what}|${ask.messageId}|${ask.order}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the request's fields
  useEffect(() => {
    if (!store) return;
    if (ask) store.put(ask);
    else store.drop(id);
  }, [store, id, key]);
  useEffect(() => () => store?.drop(id), [store, id]);
  return null;
}

function ApprovalProbe({ id, messageId, order }: { id: string; messageId: string; order: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const a = useApproval(orgId, id).data;
  const expired = useExpired(a?.expiresAt);
  const ask =
    a && a.status === "pending" && a.canDecide && !expired
      ? { id, kind: "approval" as const, agentId: a.agentId, what: approvalTitleText(t, a), messageId, order }
      : null;
  return <Report id={id} ask={ask} />;
}

function SecretProbe({ request: s, messageId, order }: { request: SecretRequest; messageId: string; order: number }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const expired = useExpired(s.expiresAt);
  const waits = s.status === "pending" && !expired && s.requestedForUserId === meId;
  const agent = dir.anyAgent(s.agentId)?.name ?? t("channel.unknownAgent");
  const what = secretLabel(t, s, agent);
  const ask = waits ? { id: s.id, kind: "secret" as const, agentId: s.agentId, what, messageId, order } : null;
  return <Report id={s.id} ask={ask} />;
}

function HandoffProbe({
  id,
  fallback,
  messageId,
  order,
}: {
  id: string;
  fallback: BrowserHandoff;
  messageId: string;
  order: number;
}) {
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const h = useBrowserHandoff(orgId, id).data ?? fallback;
  const expired = useExpired(h.expiresAt);
  // The same rule as its card (`HandoffCard`): by ids, never by a name that may not have loaded.
  const mine = meId !== null && handoffIsMine(h, meId, dir.agentById.get(h.agentId)?.ownerUserId, org);
  const ask =
    h.status === "pending" && h.kind === "ask" && !expired && mine
      ? {
          id,
          kind: handoffScreen(h) === "desktop" ? ("desktop" as const) : ("browser" as const),
          agentId: h.agentId,
          what: h.instructions,
          messageId,
          order,
        }
      : null;
  return <Report id={id} ask={ask} />;
}

/** An agent's proposal of a new agent: who may create agents decides it until it expires. */
function ProposalProbe({
  card,
  agentId,
  messageId,
  order,
}: {
  card: AgentProposalCard;
  agentId: string;
  messageId: string;
  order: number;
}) {
  const { org } = useOrg();
  const expired = useExpired(card.expiresAt);
  const ask =
    !expired && proposalStatus(card) === "open" && can(org, "create_agents")
      ? { id: messageId, kind: "agent" as const, agentId, what: card.params.draft.name, messageId, order }
      : null;
  return <Report id={messageId} ask={ask} />;
}

/**
 * A proposal card of the agent's (a change to the context or to agents' instructions, roles or apps, for one agent or
 * several): one request while any of its rows waits on the person. Its id is the card's (`InstructionProposals`).
 */
function ChangeProposalProbe({ ids, messageId, order }: { ids: string[]; messageId: string; order: number }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const rows = useCardProposals(orgId, ids);
  const open = rows.find((p) => isOpen(p) && p.canDecide);
  const id = ids.join(",");
  const agentName = (a: string) => dir.anyAgent(a)?.name ?? t("channel.unknownAgent");
  const ask = open
    ? {
        id,
        kind: "proposal" as const,
        agentId: proposerOf(open),
        what: proposalTarget(t, open, agentName, org ?? ""),
        messageId,
        order,
      }
    : null;
  return <Report id={id} ask={ask} />;
}

// ── What shows ───────────────────────────────────────────────────────────────

/** What the conversation tells the requests' watch about its list. */
export interface AskView {
  /** The view the list fills: the band is measured from its frame in the window. */
  frame: () => Measurable | null;
  /** The band inside that frame, from its top and from its bottom (the header, the composer); null until placed. */
  insets: () => { top: number; bottom: number } | null;
  /** Whether the list draws this message's row now: a card it doesn't draw is out of view. */
  drawn: (messageId: string) => boolean;
}

/**
 * Which waiting requests are out of view, for the line above the composer (the web's rule): a request shows while
 * 40 points of its card do, between the floating header and the composer. A look is asked for on a scroll (one a
 * frame), on layout and when the list's size changes; it measures only the waiting requests' cards, and the store
 * publishes only when the set changes. Nothing runs while no request waits. Returns the call that asks for a look.
 */
export function useAskWatch(store: AskStore, view: AskView): () => void {
  const viewRef = useRef(view);
  viewRef.current = view;
  const frame = useRef<number | null>(null);
  const look = useRef(0);
  const watch = useCallback(() => {
    if (frame.current !== null || !store.hasWaiting()) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      look.current += 1;
      lookAtAsks(store, viewRef.current, look.current, () => look.current);
    });
  }, [store]);
  // A request came, or its card was drawn or went.
  useEffect(() => store.watch(watch), [store, watch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `view.insets` changes when the band's edges move
  useEffect(() => {
    watch();
  }, [watch, view.insets]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return watch;
}

/** One look at the waiting requests' cards against the list's band; a newer look drops an older one's answers. */
function lookAtAsks(store: AskStore, view: AskView, look: number, latest: () => number) {
  const waiting = store.waiting();
  const insets = view.insets();
  const box = view.frame();
  if (waiting.length === 0 || !insets || !box) return;
  box.measureInWindow((_x, y, _width, height) => {
    if (look !== latest() || !(height > 0)) return;
    const band = { top: y + insets.top, bottom: y + height - insets.bottom };
    const hidden: string[] = [];
    let left = waiting.length;
    const counted = () => {
      left -= 1;
      if (left === 0 && look === latest()) store.setHidden(hidden);
    };
    for (const ask of waiting) {
      const card = store.cardOf(ask.id);
      if (card) {
        card.measureInWindow((_cx, cy, _cw, ch) => {
          if (!cardShows(cy, ch, band)) hidden.push(ask.id);
          counted();
        });
        continue;
      }
      // No card: out of view when the list doesn't draw its row; a row it draws gets its card in a moment.
      if (!view.drawn(ask.messageId)) hidden.push(ask.id);
      counted();
    }
  });
}

// ── The card ─────────────────────────────────────────────────────────────────

/** The small amber square that breathes while a request waits on the person. */
export function WaitMark({ size = 8 }: { size?: number }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const fade = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    fade.value = withRepeat(withSequence(withTiming(0.55, { duration: 800 }), withTiming(1, { duration: 800 })), -1);
  }, [reduced, fade]);
  const style = useAnimatedStyle(() => ({ opacity: fade.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, height: size, borderRadius: 2, backgroundColor: c.amber }, style]}
    />
  );
}

export interface AskWell {
  /** The app or thing it goes through: its mark alone, 20 points (no tile inside the card). */
  tile: ReactNode;
  title: string;
  detail?: string | null;
  /**
   * "Ver o e-mail" / "Ver detalhes" / "Ver a mudança" / "Ver a tela" and what it opens; `open` and `onToggle` when its
   * owner keeps that state (a run of approvals, open still once its card reshapes).
   */
  more?: { label: string; content: ReactNode; open?: boolean; onToggle?: () => void } | null;
}

/** Each kind of request by its icon on the card's top line, quiet (no "waiting for you" mark); Atividade's too. */
export const ASK_ICON: Record<AskKind, IconName> = {
  approval: "shield",
  secret: "key",
  question: "help",
  browser: "globe",
  desktop: "laptop",
  proposal: "pen",
  agent: "agent",
  team: "members",
  firstTask: "target",
};

/**
 * The request card, the same as Atividade's and Conversas' waiting cards (`WaitingCard`): the app's card with its cut
 * corner, the kind on top with its icon and, at its right, who else decides (`waitsFor`: "esperando Ana", "Aguardando
 * um admin"; no "waiting for you" mark: the card itself is the ask). Then
 * the agent's words (`lead`), what will happen drawn small edge to edge (`preview`: an email as it will go, the values
 * it runs with), and the thing it is about on its name line, edge to edge between hairlines (`well`: its mark alone,
 * its title, its details and, with `more`, "Ver …" opening the rest in the preview's place, or under the line with
 * no preview). `body` sits under it (a secret's field); `foot` holds the decision (`AskFoot`) and, at its end, the fuse
 * to `expiry` (`ExpiryLine`) while the person decides. In a conversation the card tells it where it is (`id`), for the
 * line above the composer.
 */
export function AskCard({
  id,
  kind,
  kindNote,
  agentId,
  waitsFor,
  lead,
  well,
  preview,
  body,
  expiry,
  foot,
}: {
  id: string;
  kind: AskKind;
  /** Said after the kind on the top line ("sai da empresa" for a request that leaves the workspace). */
  kindNote?: string | undefined;
  agentId: string;
  waitsFor: "you" | (string & {}) | null;
  lead: string;
  well?: AskWell | null;
  /** What will happen, drawn small over the name line (an approval's email or values); "Ver …" opens it whole. */
  preview?: ReactNode;
  body?: ReactNode;
  /** Its deadline (`ExpiryLine`), at the foot's end while the person decides. */
  expiry?: ReactNode;
  foot?: ReactNode;
}) {
  const ownTop = useCardTop(12);
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const reduced = useReducedMotion();
  const store = useAskStore();
  // The asking agent's sky, faint across the card's top: the same card as Atividade's and the home's (`WaitingCard`).
  const sky = agentLook(dir.agentById.get(agentId)).color;
  const slot = useRef<ComponentRef<typeof View>>(null);
  const [openHere, setOpen] = useState(false);
  const open = well?.more?.open ?? openHere;
  const toggle = () => {
    tapHaptic();
    if (well?.more?.onToggle) well.more.onToggle();
    else setOpen((o) => !o);
  };
  useLayoutEffect(() => {
    const card = slot.current;
    if (!store || !card) return;
    return store.register(id, card);
  }, [store, id]);
  const more = well?.more;
  // The thing it is about, edge to edge: its mark and its title on one line, its details under them across the whole
  // width (from the title's column to the card's edge), then "Ver …" on their edge, never a column beside the words.
  const line = well ? (
    <>
      <View style={styles.lineTop}>
        <View style={styles.lineMark}>{well.tile}</View>
        <Text variant="subhead" tone="ink" style={[styles.semibold, styles.grow]}>
          {well.title}
        </Text>
      </View>
      {well.detail ? (
        <Text variant="footnote" tone="faint" style={styles.lineDetail}>
          <Spans inline={parseInline(well.detail)} />
        </Text>
      ) : null}
      {more ? (
        <View style={styles.lineMore}>
          <Text variant="footnote" tone="muted" style={styles.semibold} numberOfLines={1}>
            {more.label}
          </Text>
          <View style={open ? styles.flip : undefined}>
            <Icon name="chev" size={13} color={c.faint} />
          </View>
        </View>
      ) : null}
    </>
  ) : null;
  const opened =
    open && more ? (
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(220)}
        // In the preview's place it keeps the preview's hairline; under the name line, that line's own is enough.
        style={[styles.edge, styles.exact, preview ? { borderTopColor: c.line } : styles.noTop]}
      >
        {more.content}
      </Animated.View>
    ) : null;
  const kindWords = askKindWords(t, kind, waitsFor === "you");
  return (
    // A plain view the conversation measures (never flattened away), around the card that fades in.
    <View ref={slot} collapsable={false} style={ownTop}>
      <Animated.View entering={reduced ? undefined : FadeIn.duration(300)} style={[styles.card, surface]}>
        <View style={styles.clip}>
          <Sky color={sky} depth={0.55} fade={0.15} surface="raised" style={styles.sky} />
          <View style={styles.head}>
            <Icon name={ASK_ICON[kind]} size={13} color={c.muted} />
            <Text variant="footnote" tone="muted" numberOfLines={1} style={[styles.medium, styles.grow]}>
              {kindNote ? `${kindWords} · ${kindNote}` : kindWords}
            </Text>
            {waitsFor && waitsFor !== "you" ? (
              <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
                {waitsFor}
              </Text>
            ) : null}
          </View>
          {lead ? (
            <Text variant={well ? "body" : "title"} tone="ink" style={well ? styles.lead : undefined}>
              <Spans inline={parseInline(lead)} />
            </Text>
          ) : null}
          {/* With a preview, "Ver …" opens the whole in its place; without one, under the name line. */}
          {preview && !open ? (
            <View style={[styles.edge, styles.preview, { borderTopColor: c.line }]}>
              {preview}
              <LinearGradient pointerEvents="none" colors={[`${c.raised}00`, c.raised]} style={styles.fade} />
            </View>
          ) : null}
          {preview ? opened : null}
          {line ? (
            more ? (
              <Pressable
                onPress={toggle}
                accessibilityRole="button"
                accessibilityHint={more.label}
                accessibilityState={{ expanded: open }}
                style={({ pressed }) => [styles.edge, styles.line, { borderColor: c.line }, pressed && styles.pressed]}
              >
                {line}
              </Pressable>
            ) : (
              <View style={[styles.edge, styles.line, { borderColor: c.line }]}>{line}</View>
            )
          ) : null}
          {preview ? null : opened}
          {body ? <View style={styles.body}>{body}</View> : null}
          {foot}
          {waitsFor === "you" && expiry ? <View style={styles.expiryRow}>{expiry}</View> : null}
        </View>
      </Animated.View>
    </View>
  );
}

/** The card's decision, under what it asks: its buttons (and a hint under them). */
export function AskFoot({ children }: { children?: ReactNode }) {
  return <View style={styles.foot}>{children}</View>;
}

/**
 * The decision: the main action wide (dark) and the other beside it, or under it when both don't fit their words
 * (a narrow phone, a larger text size): each keeps a least width that grows with the text, and the row wraps.
 */
export function AskButtons({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(2, Math.max(1, fontScale));
  return (
    <View style={styles.buttons}>
      <View style={[styles.primary, { flexBasis: 128 * scale }]}>{primary}</View>
      {secondary ? <View style={[styles.secondary, { flexBasis: 96 * scale }]}>{secondary}</View> : null}
    </View>
  );
}

/**
 * The amber fuse burning to the expiry and the time left ("23 h para decidir"; "expira em 23 h" read aloud), at the
 * card's foot; without a start, the time alone.
 */
export function ExpiryLine({ createdAt, expiresAt }: { createdAt?: string | null; expiresAt: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow(15_000);
  const left = timeLeft(t, expiresAt, new Date(now));
  return (
    <View
      style={styles.expiry}
      accessible
      accessibilityLabel={left ? t("approval.expiresDetail", { time: left }) : t("approval.expired")}
    >
      {createdAt ? (
        <View style={styles.fuse}>
          <Fuse color="amber" remaining={fuseRemaining(createdAt, expiresAt, now)} />
        </View>
      ) : null}
      <Text
        variant="footnote"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[styles.expiryText, { color: c.amber }]}
      >
        {left ? t("approvals.left", { time: left }) : t("approval.expired")}
      </Text>
    </View>
  );
}

/**
 * A decided request: no card, one pill (`EventPill`) in the conversation where the message's text starts, as every
 * automatic event: a check in green when it went through, an × when it didn't, its words (what `markName` wraps in
 * bold) and `time`, when it was decided. `more` is an action ("See details", with a chevron) that opens the rest under
 * the pill; `actions` go before it (a request approved ahead still to run: "Cancel").
 */
export function AskDone({
  done,
  words,
  time,
  more,
  actions,
  celebrate,
}: {
  done: boolean;
  words: string;
  time?: string;
  /**
   * You approved it just now: the check bursts once in the agent's tones (its color), the decision's weight. Never on
   * an old pill scrolling in.
   */
  celebrate?: string | null;
  /** `card`: what opens is a card of its own (the request as it was), drawn without the text's rule beside it. */
  more?: { label: string; content: ReactNode; card?: boolean } | null;
  actions?: ReactNode;
}) {
  const ownTop = useOwnTop(8);
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  // A card turning into this pill fades into it (an old one fades as it scrolls in, as the cards do).
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={[styles.done, ownTop]}>
      <EventPill
        mark={done && celebrate ? <SparkCheck size={14} color={c.ok} tone={celebrate} /> : done ? "check" : "x"}
        markColor={done ? c.ok : c.faint}
        time={time}
        actions={[
          actions,
          more ? (
            <EventPillAction key="more" label={more.label} expanded={open} onPress={() => setOpen((o) => !o)} />
          ) : null,
        ]}
        below={
          more && open ? (
            <Animated.View entering={reduced ? undefined : FadeIn.duration(220)}>
              {more.card ? more.content : <EventPillText>{more.content}</EventPillText>}
            </Animated.View>
          ) : null
        }
      >
        {pillWords(words, c.ink2)}
      </EventPill>
    </Animated.View>
  );
}

/**
 * A request still waiting for someone, as one pill like the decided ones (`AskDone`), never a card: its sentence in
 * ink. Waiting for the viewer (`forMe`), the breathing square as its mark and what it asks for as an
 * `EventPillAction primary` ("Connect", "Continue now"), the other actions plain; for someone else, `mark` quiet and no
 * main action. What the sentence leaves out (the agent's why, an address, a command, who may press) goes `below`, in
 * `EventPillText`.
 */
export function AskWaiting({
  forMe,
  mark,
  words,
  actions,
  below,
}: {
  forMe: boolean;
  /** The quiet icon while it waits for someone else ("pause", "shield"). */
  mark: IconName;
  words: string;
  actions?: ReactNode;
  below?: ReactNode;
}) {
  const ownTop = useOwnTop(8);
  const c = useColors();
  const reduced = useReducedMotion();
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={[styles.done, ownTop]}>
      <EventPill
        waiting
        mark={
          forMe ? (
            <View style={styles.waitMark}>
              <WaitMark />
            </View>
          ) : (
            mark
          )
        }
        actions={actions}
        below={below}
      >
        {pillWords(words, c.ink)}
      </EventPill>
    </Animated.View>
  );
}

/** A pill's sentence: what `markName` wraps in bold, in `color`. */
function pillWords(words: string, color: string) {
  return markedParts(words).map((p, i) =>
    p.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <RNText key={i} style={[styles.semibold, { color }]}>
        {p.text}
      </RNText>
    ) : (
      p.text
    ),
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────

/**
 * The line above the composer while a request waits out of view (waiting beats working): the agent's face,
 * the breathing square, "Ada espera sua aprovação · Enviar e-mail", "+1" when more wait, and Ver, which
 * scrolls to it. While one agent works here with its live row out of view, the working line's "Parar" stays at its
 * end (a row on screen carries its own).
 */
export function AskBar({
  away,
  onSee,
  runs,
  consults,
  canStop,
  onStop,
}: {
  away: AwayAsk;
  onSee: () => void;
  /** The work going on here, as the working line gets it: its stop follows the same rule. */
  runs: LiveRun[];
  consults: LiveConsult[];
  canStop: (run: LiveRun) => boolean;
  onStop: (run: LiveRun) => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const { colors: c, shadows } = useTheme();
  const reduced = useReducedMotion();
  const { ask, more } = away;
  const agent = dir.agentById.get(ask.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const color = agentLook(agent).color;
  const what = ask.what.replace(/\s+/g, " ").trim();
  // The name is marked to draw in ink; the string's own tags only say where it goes.
  const sentence = t(`ask.bar.${ask.kind}`, {
    name: markName(name),
    what,
    interpolation: { escapeValue: false },
  }).replace(/<\/?b>/g, "");
  const parts = markedParts(sentence);
  const plain = parts.map((p) => p.text).join("");
  const stops = lineStops(
    workingEntries(runs, consults, (id) => dir.agentById.get(id)?.name ?? ""),
    runs,
    canStop,
  );
  // "See" scrolls to the card: no haptic.
  const see = onSee;
  return (
    <View style={styles.dock}>
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(160)}
        style={[styles.pill, { backgroundColor: c.glassSolid, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      >
        <Sky color={color} surface="raised" depth={0.95} fade={0} style={[StyleSheet.absoluteFill, styles.band]} />
        <View style={[styles.tok, { backgroundColor: c.glassSolid }]}>
          <AgentFace agentId={ask.agentId} size={18} mode="idle" />
        </View>
        <WaitMark />
        <Pressable
          onPress={see}
          accessibilityRole="button"
          accessibilityLabel={`${plain}. ${t("ask.bar.see")}`}
          style={({ pressed }) => [styles.words, pressed && styles.pressed]}
        >
          {/* The name in ink, what it waits for in amber: the one state the app colors, "espera você". */}
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE} style={{ color: c.amber }}>
            {parts.map((p, i) =>
              p.bold ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
                <RNText key={i} style={[styles.semibold, { color: c.ink }]}>
                  {p.text}
                </RNText>
              ) : (
                p.text
              ),
            )}
          </Text>
        </Pressable>
        {more > 0 ? (
          <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {t("ask.bar.more", { count: more })}
          </Text>
        ) : null}
        <View style={[styles.sep, { backgroundColor: c.line }]} />
        <Pressable
          onPress={see}
          accessibilityElementsHidden
          importantForAccessibility="no"
          hitSlop={8}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text
            variant="caption"
            tone="ink"
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.semibold, styles.see, { textDecorationColor: c.line2 }]}
          >
            {t("ask.bar.see")}
          </Text>
        </Pressable>
        <LineStop runs={stops} onStop={onStop} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The app's card (`useSurface`) with its cut corner at the bottom left, as the waiting cards.
  card: { borderRadius: 20, borderBottomLeftRadius: 6 },
  clip: {
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  // Across the top, at half strength, under the kind line (as `WaitingCard`).
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 56, opacity: 0.5 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  lead: { lineHeight: 22 },
  // Edge to edge across the card (its 16-point sides), a hairline above.
  edge: { marginHorizontal: -16, paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth },
  // What will happen, drawn small: as tall as a preview gets, fading at its foot.
  preview: { maxHeight: 152, overflow: "hidden", paddingVertical: 10 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 40 },
  // The name line: its mark, its title and details, "Ver …" under them; a hairline under it too, over the decision. The
  // mark stands on the title's line (20 points), not in the middle of a tall detail.
  line: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  lineTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  lineMark: { flexShrink: 0, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  lineMore: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", marginLeft: 30, height: 22 },
  // Under the title, on its column (the mark and its gap), to the card's edge.
  lineDetail: { marginLeft: 30, marginTop: 1 },
  // The deadline at the foot's end, right-aligned under the decision.
  expiryRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  pressed: { opacity: 0.7 },
  flip: { transform: [{ rotate: "180deg" }] },
  exact: { gap: 10, paddingVertical: 12 },
  noTop: { borderTopWidth: 0 },
  body: { gap: 8 },
  foot: { marginTop: 4, gap: 10 },
  buttons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  primary: { flexGrow: 1.5, flexShrink: 1, minWidth: 0 },
  secondary: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  expiry: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  fuse: { width: 36, height: 6 },
  expiryText: { flexShrink: 1, fontWeight: "500", fontVariant: ["tabular-nums"] },
  // A decided request: its pill on the conversation itself, from where the message's text starts; the body sets its top.
  done: { alignSelf: "stretch" },
  // The breathing square centered in the pill's 14-point mark.
  waitMark: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  // The bar: the working line's shape and width (WorkingLine, the composer's edges), so one replaces the other
  // without moving.
  dock: { paddingBottom: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  band: { opacity: 0.55 },
  tok: { padding: 1.5, borderRadius: 7 },
  words: { flex: 1, minWidth: 0 },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginHorizontal: 2 },
  see: { paddingHorizontal: 4, textDecorationLine: "underline" },
});
