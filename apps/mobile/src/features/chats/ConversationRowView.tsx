import { previewBody } from "@agenteschat/client/lib/message-body";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Link } from "expo-router";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { TAB_BADGE } from "@/lib/nav";
import { useOrg } from "@/providers/org";
import { Count, LIST_AVATAR, LIST_PREVIEW, LineIcon, ListRow, PixelOrbit, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { workTitle } from "../agents/work";
import type { RowAction } from "../categories/menus";
import { agentIntro } from "../chat/intent";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { usePresenceOf } from "../status/hooks";
import { type ConversationRow, type LastLine, rowBadge, threadRowLines } from "./logic";
import type { AgentRowState } from "./now";

/** The avatar column. */
const AVATAR = LIST_AVATAR;
/** The orbit before what an agent does: the preview line's own height, so it reads as a word of it. */
const ORBIT = 16;

/**
 * One conversation in the list, in the shared
 * `ListRow`: the agent's living body (moving while it works), a person's face, or the tile of a channel;
 * the name and the time; the last line ("Nome: …", one line, cut where it runs out: the conversation has the
 * rest, and the list stays one row per conversation). An agent's row says what matters instead
 * (`agent`): it waits on your ok (amber, "espera seu ok · PR #128"), it waits for its offline computer
 * (dozing, "Esperando o MacBook Air"), or what it is doing with the pixel orbit. Unread: bold name, darker time and preview, the count. Threads and missions
 * add a faint line with what and where ("Missão · #canal"): a mission shows its agent, its state
 * and items ("Esperando você · 4 de 9 itens") and what waits on you in it; a thread shows the face and the
 * line of its last reply. `live`: the agent moves (the first rows only). A DM's face carries the presence badge
 * (ADR 0084; no status emoji in the list); an agent with a line says it in place of its last message.
 */
export const ConversationRowView = memo(function ConversationRowView({
  row: r,
  divider = false,
  live = false,
  agent,
  onHold,
  holdLabel,
  onStart,
  meta,
  fresh = false,
  onOpen,
  pinned = false,
  holdActions,
}: {
  row: ConversationRow;
  /** A hairline above (every row but the first). */
  divider?: boolean;
  live?: boolean;
  /** An agent DM: it waits on you, or what it is doing (from `agentRowState`). */
  agent?: AgentRowState;
  /** A row on the home: its menu (Fixar no topo, a channel's Mover para…), given the row. */
  onHold?: (row: ConversationRow) => void;
  /** On top of its section ("Fixar no topo"): said to screen readers; the order shows it, no mark. */
  pinned?: boolean;
  /** What the long press does, for screen readers. */
  holdLabel?: string;
  /** An agent with no conversation yet (`channelId: ""`): opens one with it, given the agent (stable, memoized row). */
  onStart?: (agentId: string) => void;
  /** In the time's place: the right hand's label (ADR 0137). */
  meta?: string;
  /** Not opened yet on this phone: the dot. */
  fresh?: boolean;
  /** Told when the row opens its conversation. */
  onOpen?: () => void;
  /** The long press's actions for iOS's own menu under the preview (`onHold`'s sheet elsewhere). */
  holdActions?: (row: ConversationRow) => RowAction[];
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const presenceOf = usePresenceOf();
  const { org } = useOrg();
  const lastText = (last: LastLine | null) => {
    if (!last) return { who: "", text: "" };
    const who = last.name || (last.author ? dir.nameOf(last.author) : "");
    return { who, text: previewBody(t, last.text, last.meta ?? null, last.mediaKind) };
  };
  const agentDm = r.kind === "dm" && r.with.type === "agent";
  /**
   * A DM with nothing in it yet: who the agent is (as its first conversation says), or a word to start. A personal
   * workspace's agent is there for its person, not on a team (ADR 0159).
   */
  const introLine = (): string => {
    if (r.kind !== "dm") return "";
    const a = agentDm ? dir.agentById.get(r.with.id) : undefined;
    if (!a) return t("mobile.chats.sayHi", { name: r.with.name });
    const intro = agentIntro(a);
    return intro.kind === "what"
      ? intro.text
      : intro.kind === "role"
        ? t(modeKey(org, "mobile.chat.intent.roleIntro"), { role: intro.role })
        : t("mobile.chat.intent.noIntro");
  };
  const agentState = agentDm ? (agent ?? null) : null;
  // Presence and line (ADR 0084): the agent's from its work, the person's as they set it.
  const agentShown = r.kind === "dm" && agentDm ? presenceOf.agent(r.with.id) : null;
  const personShown = r.kind === "dm" && !agentDm ? presenceOf.person(r.with.id) : null;
  const agentLine = agentShown?.line ?? null;
  const presenceWord = agentShown
    ? t(`presence.${agentShown.presence}`)
    : personShown
      ? t(`presence.${personShown.presence}`)
      : null;
  // Waiting for its offline computer: dozing, no working orbit (its run only waits).
  const away = agentState?.kind === "computer";
  const working = r.kind === "channel" || away ? false : r.working || agentState?.kind === "working";
  const leading =
    r.kind === "dm" ? (
      agentDm ? (
        <AgentFace
          agentId={r.with.id}
          size={AVATAR - 2}
          mode={away ? "rest" : working ? "run" : "idle"}
          live={live}
          presence
        />
      ) : (
        <Face who={{ type: r.with.type, id: r.with.id }} size={AVATAR} live={false} presence />
      )
    ) : r.kind === "mission" && r.mission ? (
      <AgentFace agentId={r.mission.agentId} size={AVATAR - 2} mode={working ? "run" : "idle"} live={live} />
    ) : r.kind === "thread" || r.kind === "mission" ? (
      <Face who={r.face} size={r.face.type === "agent" ? AVATAR - 2 : AVATAR} live={live} />
    ) : (
      <Tile icon="hash" size={AVATAR} />
    );
  // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
  const name = r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title || t("mobile.chat.thread");
  // Whose orbit: the DM's agent, or the mission's.
  const orbitAgent = r.kind === "dm" ? r.with.id : r.kind === "mission" ? r.mission?.agentId : null;
  const orbitColor = agentLook(orbitAgent ? dir.agentById.get(orbitAgent) : undefined).color;
  const lines = r.kind === "thread" || r.kind === "mission" ? threadRowLines(r, dir.nameOf) : null;
  // The faint line of a thread or mission: what it is and where ("Missão · #canal").
  const placeLine = lines
    ? [t(lines.kind === "mission" ? "mobile.chats.mission" : "mobile.chats.thread"), lines.where]
        .filter(Boolean)
        .join(" · ")
    : null;
  const own = rowBadge(r);
  const badge = lines ? lines.badge : own.count;
  const mention = !lines && own.mention;

  let line: ReactNode;
  let label: string;
  if (lines?.state && lines.progress) {
    const progress = t("mobile.chats.missionProgress", lines.progress);
    const state = t(`mobile.chats.missionState.${lines.state}`);
    const lead = lines.state === "working" || lines.state === "waiting";
    label = `${state} · ${progress}`;
    line = (
      <View style={styles.work}>
        {/* The state is words in the state's color: the orbit for work, amber for what waits on you; no icon. */}
        {lines.state === "working" ? <PixelOrbit color={orbitColor} size={ORBIT} /> : null}
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text
            variant="small"
            tone={lead ? "ink2" : "muted"}
            style={[LIST_PREVIEW, lead ? styles.em : null, lines.state === "waiting" ? { color: c.amber } : null]}
          >
            {state}
          </Text>
          {` · ${progress}`}
        </Text>
      </View>
    );
  } else if (agentState?.kind === "waiting") {
    const verb = t(`mobile.homeNow.rowWait.${agentState.wait}`);
    label = [verb, agentState.title].filter(Boolean).join(" · ");
    line = (
      <View style={styles.work}>
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text variant="small" style={[LIST_PREVIEW, styles.em, { color: c.amber }]}>
            {verb}
          </Text>
          {agentState.title ? ` · ${agentState.title}` : ""}
        </Text>
      </View>
    );
  } else if (agentState?.kind === "computer") {
    label = t("mobile.outage.rowWaiting", { computer: agentState.computer });
    line = (
      <View style={styles.work}>
        <LineIcon name="clock" size={15} color={c.muted} variant="small" text={LIST_PREVIEW} />
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {label}
        </Text>
      </View>
    );
  } else if (agentLine && working) {
    // Its own line, or the one picked for its run, in place of the last message while it works (a line kept with
    // `minutes` after the run ended doesn't hide its reply).
    label = agentLine.text;
    line = (
      <View style={styles.work}>
        {working ? <PixelOrbit color={orbitColor} size={ORBIT} /> : null}
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.em, styles.shrink]}>
          {agentLine.text}
        </Text>
      </View>
    );
  } else if (working && r.kind !== "mission") {
    const doing = agentState?.kind === "working" ? workTitle(t, agentState.work) : "";
    label = doing ? t("mobile.homeNow.doingLabel", { what: doing }) : t("mobile.chats.working");
    line = (
      <View style={styles.work}>
        <PixelOrbit color={orbitColor} size={ORBIT} />
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.em, styles.shrink]}>
          {doing || t("mobile.chats.working")}
        </Text>
      </View>
    );
  } else {
    const last = lastText(r.last);
    const text =
      r.kind === "channel" ? last.text || r.topic || t("mobile.chats.channelEmpty") : r.last ? last.text : introLine();
    // In a DM the other side's own words need no "Ada:" before them (the row is already Ada's).
    const theirs = r.kind === "dm" && r.last?.author?.type === r.with.type && r.last.author.id === r.with.id;
    const lead = theirs ? "" : last.who;
    label = lead ? `${lead}: ${text}` : text;
    line = (
      <Text variant="small" tone={r.unread > 0 ? "ink2" : "muted"} numberOfLines={1} style={LIST_PREVIEW}>
        {lead ? (
          <Text variant="small" tone="ink2" style={[LIST_PREVIEW, styles.em]}>
            {`${lead}: `}
          </Text>
        ) : null}
        {text}
      </Text>
    );
  }
  if (r.kind === "thread" && r.closed) label = `${t("mobile.chats.closed")}, ${label}`;

  const starts = Boolean(onStart && r.kind === "dm");
  const href = r.channelId
    ? chatHref(r.channelId, r.kind === "thread" || r.kind === "mission" ? r.threadId : null)
    : null;
  const open = () => {
    onOpen?.();
    if (onStart && r.kind === "dm") onStart(r.with.id);
    else if (href) router.push(href);
  };
  // iOS's own long press: the conversation itself in the system preview (tapping it opens it), with the row's
  // actions (Pin to the top, a channel's Move to…) in the system menu under it. An agent with no conversation yet
  // peeks at its profile instead, with Talk first; a tap on its row still starts the conversation. Android keeps the
  // plain press and the long press's sheet.
  const peekHref = starts && r.kind === "dm" ? (`/agent/${r.with.id}` as const) : href;
  const peeks = Platform.OS === "ios" && peekHref !== null;
  const a11y = [
    name,
    meta ?? null,
    presenceWord,
    personShown?.status?.text ?? null,
    placeLine,
    label,
    r.at ? when.short(r.at) : null,
    r.unread > 0 ? t("mobile.chats.unreadLabel", { count: r.unread }) : null,
    mention ? t("shell.unreadMentions", { count: badge }) : null,
    pinned ? t("sidebarPins.pinned") : null,
    lines?.kind === "mission" && badge > 0
      ? t("mobile.tabs.withCount", { label: t("mobile.home.waiting"), count: badge })
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  const row = (press: () => void) => (
    <ListRow
      onPress={press}
      {...(onHold && !peeks
        ? {
            onLongPress: () => onHold(r),
            delayLongPress: 380,
            accessibilityActions: [{ name: "menu", label: holdLabel ?? name }],
            onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
              if (e.nativeEvent.actionName === "menu") onHold(r);
            },
          }
        : {})}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      divider={divider}
      unread={r.unread > 0}
      leading={leading}
      title={name}
      time={meta ?? (r.at ? when.short(r.at) : null)}
      pinned={pinned}
      dot={fresh && badge === 0}
      over={
        // A closed thread isn't marked here: it goes to the end of its list, and screen readers hear it.
        placeLine ? (
          <Text variant="footnote" tone="faint" numberOfLines={1}>
            {placeLine}
          </Text>
        ) : null
      }
      sub={line}
      trailing={
        badge > 0 ? (
          <Count
            value={badge}
            max={99}
            inverted
            {...(mention ? { fill: TAB_BADGE.background, color: TAB_BADGE.text } : {})}
          />
        ) : null
      }
    />
  );
  if (!peeks || !peekHref) return row(open);
  const actions = holdActions?.(r) ?? [];
  return (
    <Link href={peekHref} asChild>
      <Link.Trigger>
        {/* A row that starts a conversation keeps its own press; the link only serves its preview. */}
        <RowTrigger row={row} onOpen={onOpen} own={starts ? open : undefined} />
      </Link.Trigger>
      <Link.Preview />
      {starts || actions.length > 0 ? (
        <Link.Menu>
          {starts ? (
            <Link.MenuAction icon="bubble.left" onPress={open}>
              {t("mobile.agent.talk")}
            </Link.MenuAction>
          ) : null}
          {actions.map((a) => (
            <Link.MenuAction key={a.key} icon={a.symbol} onPress={a.run}>
              {a.label}
            </Link.MenuAction>
          ))}
        </Link.Menu>
      ) : null}
    </Link>
  );
});

/**
 * The row under the link's trigger: the link's press opens the conversation, after the row's own `onOpen`; `own`
 * replaces it (a row that starts a conversation, whose link is only its preview).
 */
function RowTrigger({
  row,
  onOpen,
  own,
  onPress,
}: {
  row: (press: () => void) => ReactNode;
  onOpen?: (() => void) | undefined;
  own?: (() => void) | undefined;
  onPress?: () => void;
}) {
  return row(
    own ??
      (() => {
        onOpen?.();
        onPress?.();
      }),
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  work: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  em: { fontWeight: "500" },
});
