import { useMe } from "@agenteschat/client";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, CARD_PAD, Card, Icon, PixelOrbit, SCREEN_X, Sky, Text, WorkspaceSky } from "@/ui";
import { router } from "@/ui/navigation";
import { mayCreate } from "../new/logic";
import { AgentFace } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook, firstName, greetingKey } from "../shared/logic";
import { Tile, useSurface } from "../shared/parts";
import { FIRST_AGENT_EXAMPLES } from "./examples";
import { Arrive } from "./HomeEntrance";
import { type FinishedItem, finishedKey, greetingLine } from "./now";

/** The look of an agent still to be born (the new-agent sheet and the empty state). */
export const NEWBORN = { color: "indigo", eyes: "round" } as const;

/** "Bom dia, Walter" (or just "Bom dia"). */
function useGreeting() {
  const { t } = useTranslation();
  const me = useMe();
  const name = firstName(me.data?.user.name ?? "");
  return name ? t(`mobile.home.greeting.${greetingKey()}`, { name }) : t(`mobile.home.hello.${greetingKey()}`);
}

/** The face in the line (what one finished): the size of its text, in its own sky tile. */
const FACE = 18;
/** The orbit before who works: the line's own height, so it reads as a word of it. */
const ORBIT = 16;

/** Opens Agentes (who is working, doing what). */
const openAgents = () => router.navigate("/agents");

/**
 * The workspace's sky behind Conversas' bar, large title and greeting: faint, so the title and the right hand's field
 * lead, and gone before the field.
 */
export function GreetingSky() {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.sky]}>
      <WorkspaceSky fade={0.22} style={StyleSheet.absoluteFill} />
    </View>
  );
}

/**
 * The greeting under Conversas' large title, scrolling away with the list: "Boa noite, Ana", then, only when there
 * is news, one short line: what one finished (its face before its name; opens where it happened), else who works
 * now: the pixel orbit of the one at work and "Ada está trabalhando", or the orbit and how many when several are
 * (opens Agentes; the list below says what each does). One mark, not a pile of faces: the list already shows them.
 * Nobody at work: the greeting alone. `after` follows on the sky (the right hand's field).
 */
export function Greeting({
  working,
  finished,
  onFinishedPress,
  after,
  arrive = { armed: false, play: false },
}: {
  working: readonly string[];
  /** The newest thing an agent finished (null: nothing new). */
  finished: FinishedItem | null;
  /** Tapped what finished (it opens there and is taken off). */
  onFinishedPress?: (f: FinishedItem) => void;
  /** Under it, on the sky: the way to ask the right hand (`RightHandAsk`). */
  after?: ReactNode;
  /** Conversas' arrival after the splash (`useHomeEntrance`): the greeting's words rise first, `after` on its own. */
  arrive?: { armed: boolean; play: boolean };
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const greeting = useGreeting();
  const line = greetingLine(finished, working.length);
  // One at work: its name; several: the count. The orbit takes the first one's tones.
  const firstWorking = working[0] ? dir.agentById.get(working[0]) : undefined;
  const workingText =
    line.kind !== "working"
      ? ""
      : line.working === 1 && firstWorking
        ? t("mobile.chats.workingOne", { name: firstWorking.name })
        : t("mobile.chats.workingNowLine", { count: line.working });
  const finishedName = line.kind === "finished" ? (dir.agentById.get(line.finished.agentId)?.name ?? "") : "";
  const finishedText =
    line.kind === "finished" ? t(finishedKey(line.finished), { what: line.finished.what ?? "" }) : "";
  const openFinished = (f: FinishedItem) => {
    onFinishedPress?.(f);
    router.push(f.href ?? `/agent/${f.agentId}`);
  };
  const workingPart = (
    <View style={styles.part}>
      <PixelOrbit color={agentLook(firstWorking).color} size={ORBIT} />
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
        {workingText}
      </Text>
    </View>
  );
  return (
    <View style={styles.mini}>
      <Arrive {...arrive} rise={12} duration={520}>
        <Text variant="body" tone="ink2" numberOfLines={1}>
          {greeting}
        </Text>
        {/* Nobody at work and nothing new: the greeting alone (no line of sleeping faces). */}
        {line.kind === "idle" ? null : (
          <View style={styles.line}>
            {line.kind === "finished" ? (
              <Pressable
                onPress={() => openFinished(line.finished)}
                accessibilityRole="button"
                accessibilityLabel={`${finishedName} ${finishedText}`}
                hitSlop={13}
                style={({ pressed }) => [styles.part, styles.shrink, pressed && styles.pressed]}
              >
                <AgentFace agentId={line.finished.agentId} size={FACE} framed />
                <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
                  {finishedName ? (
                    <Text variant="footnote" tone="ink2" style={styles.bold}>
                      {`${finishedName} `}
                    </Text>
                  ) : null}
                  {finishedText}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={openAgents}
                accessibilityRole="button"
                accessibilityLabel={workingText}
                hitSlop={13}
                style={({ pressed }) => [styles.shrink, pressed && styles.pressed]}
              >
                {workingPart}
              </Pressable>
            )}
          </View>
        )}
      </Arrive>
      {after ? <View style={styles.after}>{after}</View> : null}
    </View>
  );
}

/**
 * Conversas with nothing in it yet: the sky with an agent about to
 * be born, one primary "Criar meu primeiro agente", and examples of what an agent can do (each opens "Novo
 * agente" with "o que faz" filled in). Who can't create agents gets the place's line instead.
 */
export function FirstAgentEmpty() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const { org } = useOrg();
  const newAgent = (what?: string) =>
    router.push(what ? { pathname: "/new-agent", params: { what } } : { pathname: "/new-agent" });
  if (!mayCreate(org, "agent")) return <FirstUse place="agents" acts={false} />;
  return (
    <View>
      <View style={[styles.empty, surface]}>
        <View style={styles.emptySky}>
          <Sky color="indigo" depth={0.9} surface="raised" style={StyleSheet.absoluteFill} />
          <AgentAvatar agent={NEWBORN} size={78} />
        </View>
        <Text variant="display2" style={styles.center} accessibilityRole="header">
          {t("mobile.chats.first.title")}
        </Text>
        <Text variant="small" tone="muted" style={[styles.center, styles.emptyText]}>
          {t("mobile.homeNow.first.subtitle")}
        </Text>
        <View style={styles.acts}>
          <Button
            variant="primary"
            wide
            icon="plus"
            label={t("mobile.homeNow.first.create")}
            onPress={() => newAgent()}
          />
        </View>
      </View>
      <View style={styles.ideas}>
        <Text variant="label" style={styles.ideasTitle}>
          {t("mobile.homeNow.first.examples")}
        </Text>
        <Card>
          {FIRST_AGENT_EXAMPLES.map((ex, i) => (
            <Pressable
              key={ex.key}
              onPress={() => newAgent(t(`mobile.chats.first.example.${ex.key}.what`))}
              accessibilityRole="button"
              style={({ pressed }) => [styles.idea, pressed && { backgroundColor: c.sunken }]}
            >
              {i > 0 ? <View style={[styles.sep, { backgroundColor: c.line2 }]} /> : null}
              <Tile icon={ex.icon} size={IDEA_TILE} />
              <View style={styles.grow}>
                <Text variant="callout" style={styles.bold}>
                  {t(`mobile.chats.first.example.${ex.key}.title`)}
                </Text>
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                  {t(`mobile.chats.first.example.${ex.key}.hint`)}
                </Text>
              </View>
              <Icon name="right" size={16} color={c.faint} />
            </Pressable>
          ))}
        </Card>
      </View>
    </View>
  );
}

/** The empty state's card: its padding, which the sky runs past to the card's edges. */
const EMPTY_PAD = CARD_PAD;
/** An example's row: its inset, the tile and the gap to the words (the hairline starts at the words). */
const IDEA_INSET = 14;
const IDEA_TILE = 36;
const IDEA_GAP = 12;

const styles = StyleSheet.create({
  sky: { opacity: 0.5 },
  // At the screen's sides, as the field under it and the list.
  mini: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 16 },
  line: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  after: { marginTop: 16 },
  part: { flexDirection: "row", alignItems: "center", gap: 8 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
  empty: {
    marginHorizontal: 16,
    marginTop: 6,
    borderRadius: 20,
    overflow: "hidden",
    padding: EMPTY_PAD,
    paddingTop: 0,
  },
  emptySky: {
    height: 150,
    marginHorizontal: -EMPTY_PAD,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  center: { textAlign: "center" },
  emptyText: { marginTop: 6, marginBottom: 20 },
  acts: { gap: 8 },
  ideas: { paddingHorizontal: 16, paddingTop: 20 },
  ideasTitle: { paddingHorizontal: 4, paddingBottom: 8 },
  idea: {
    flexDirection: "row",
    alignItems: "center",
    gap: IDEA_GAP,
    paddingHorizontal: IDEA_INSET,
    paddingVertical: 12,
    minHeight: 56,
  },
  // Between rows, inset to the text, as every list's hairline.
  sep: {
    position: "absolute",
    top: 0,
    left: IDEA_INSET + IDEA_TILE + IDEA_GAP,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
