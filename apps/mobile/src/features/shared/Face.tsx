import { opensDetails } from "@agenteschat/client/lib/audience";
import { isOutOfOffice } from "@agenteschat/client/lib/presence";
import { splitAtNames } from "@agenteschat/client/lib/text";
import type { Expression } from "@agenteschat/ui/agent/engine";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import type { Gaze } from "@/agent/AgentAvatar";
import type { AgentLookInput } from "@/agent/looks";
import { type AgentMode, agentLayout, framedByDefault } from "@/agent/poses";
import { AgentAvatar, PersonAvatar, WithPresence } from "@/ui";
import { router } from "@/ui/navigation";
import { usePresenceOf } from "../status/hooks";
import { useDirectory } from "./hooks";
import { agentLook } from "./logic";
import { usePersonPhoto } from "./photo";
import { useSheetIfAny } from "./SheetHost";

/**
 * A person's or an agent's face. Agents are living bodies; long lists pass
 * `live={false}` (a still frame). `presence`: its badge on the corner (ADR 0084), ringed in `ring` (the surface
 * behind; default the page's color).
 */
export function Face({
  who,
  size,
  mode = "idle",
  live = true,
  framed,
  presence = false,
  ring,
}: {
  who: { type: string; id: string | null } | null | undefined;
  size: number;
  mode?: AgentMode;
  live?: boolean;
  /** Agents only: the sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
  presence?: boolean;
  ring?: string;
}) {
  const dir = useDirectory();
  const member = who?.type !== "agent" && who?.id ? dir.memberById.get(who.id) : undefined;
  const photo = usePersonPhoto(member ? (member.avatarUrl ?? member.image) : null);
  if (who?.type === "agent")
    return (
      <AgentFace agentId={who.id} size={size} mode={mode} live={live} framed={framed} presence={presence} ring={ring} />
    );
  const face = <PersonAvatar name={dir.nameOf(who) || "?"} size={size} photo={photo} />;
  if (!presence || !who?.id) return face;
  return (
    <Badged who={{ type: who.type, id: who.id }} size={size} ring={ring} inset={0}>
      {face}
    </Badged>
  );
}

/**
 * An agent's picture on a surface about it: a tap opens its profile and the sheet it sits on gives way. Plain for who
 * has no details to reach (`opensDetails`).
 */
export function OpensAgent({ agentId, children }: { agentId: string; children: ReactNode }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const sheet = useSheetIfAny();
  const agent = dir.anyAgent(agentId);
  if (!agent || !opensDetails(agent)) return <>{children}</>;
  return (
    <Pressable
      onPress={() => {
        sheet?.close();
        router.push(`/agent/${agentId}`);
      }}
      accessibilityRole="button"
      accessibilityLabel={t("profile.of", { name: agent.name })}
      hitSlop={8}
      style={({ pressed }) => pressed && whoStyles.pressed}
    >
      {children}
    </Pressable>
  );
}

/** An agent by id (its look from the directory); with `presence`, asleep while it is out of office. */
export function AgentFace({
  agentId,
  size,
  mode = "idle",
  live = true,
  framed,
  presence = false,
  ring,
  gaze,
  expression,
  bodyless,
}: {
  agentId: string | null | undefined;
  size: number;
  mode?: AgentMode;
  live?: boolean;
  /** The sky tile (default by size, see AgentAvatar). */
  framed?: boolean;
  /** Its presence badge on the corner (ADR 0084). */
  presence?: boolean;
  /** The surface behind the badge (default the page's color). */
  ring?: string;
  /** Where it looks for a moment (see `AgentAvatar`). */
  gaze?: Gaze | undefined;
  /** A face it holds for a moment (a hello, a cheer). */
  expression?: Expression | undefined;
  /** Only its sky in the frame: away on a routine. */
  bodyless?: boolean | undefined;
}) {
  const dir = useDirectory();
  const look = agentLook(agentId ? dir.anyAgent(agentId) : undefined);
  const moment = { gaze, expression, bodyless };
  if (presence && agentId)
    return (
      <PresentAgentFace
        agentId={agentId}
        look={look}
        size={size}
        mode={mode}
        live={live}
        framed={framed}
        ring={ring}
        moment={moment}
      />
    );
  return (
    <AgentAvatar
      agent={look}
      size={size}
      mode={mode}
      live={live}
      framed={framed}
      {...(gaze ? { gaze } : {})}
      {...(expression ? { expression } : {})}
      {...(bodyless ? { bodyless } : {})}
    />
  );
}

function PresentAgentFace({
  agentId,
  look,
  size,
  mode,
  live,
  framed,
  ring,
  moment,
}: {
  agentId: string;
  look: AgentLookInput;
  size: number;
  mode: AgentMode;
  live: boolean;
  framed: boolean | undefined;
  ring: string | undefined;
  moment: { gaze?: Gaze | undefined; expression?: Expression | undefined; bodyless?: boolean | undefined };
}) {
  const status = usePresenceOf().agent(agentId)?.status?.status;
  const asleep = mode === "idle" && isOutOfOffice(status);
  return (
    <Badged who={{ type: "agent", id: agentId }} size={size} ring={ring} inset={agentBadgeInset(look, size, framed)}>
      <AgentAvatar
        agent={look}
        size={size}
        mode={asleep ? "sleep" : mode}
        live={live}
        framed={framed}
        {...(moment.gaze ? { gaze: moment.gaze } : {})}
        {...(moment.expression ? { expression: moment.expression } : {})}
        {...(moment.bodyless ? { bodyless: true } : {})}
      />
    </Badged>
  );
}

/**
 * Where an agent's badge sits in from its box's right edge: in a tile, at the tile's corner; standing on its own
 * (the tiny faces, the big hero), at its body's (`agentLayout`), narrower than the box.
 */
export function agentBadgeInset(look: AgentLookInput, size: number, framed?: boolean): number {
  if (framed ?? framedByDefault(size)) return 0;
  const accessory = Boolean(look.accessory && look.accessory !== "none");
  return Math.round((size - agentLayout(size, accessory).inner) / 2);
}

/** A face with its presence (people's from the people, agents' from their work); none while it loads. */
function Badged({
  who,
  size,
  ring,
  inset,
  children,
}: {
  who: { type: string; id: string };
  size: number;
  ring: string | undefined;
  inset: number;
  children: ReactNode;
}) {
  const of = usePresenceOf();
  const said = who.type === "agent" ? of.agent(who.id)?.presence : of.person(who.id)?.presence;
  // An agent at rest ("away" once its last run is a while back) wears no badge: its badge is amber, the color of what
  // waits on the person, and resting is no news. People's "away" is theirs to say, so it stays.
  const presence = who.type === "agent" && said === "away" ? undefined : said;
  return (
    <WithPresence size={size} presence={presence} inset={inset} {...(ring !== undefined ? { ring } : {})}>
      {children}
    </WithPresence>
  );
}

/**
 * An agent named in a line of text: its still face, the text's size, then its name (the web's `.ac-who`). A child of a
 * `<Text>`; the face is an inline view lifted onto the capitals. A space plus 0.2 of the size before it, 0.4 after, as
 * on the web; `lead` (it opens the text) drops the one before.
 */
export function AgentWho({
  agentId,
  name,
  size = 14,
  lead = false,
}: {
  agentId: string | null | undefined;
  name: string;
  size?: number;
  lead?: boolean;
}) {
  // A view inside a line of text sits on the baseline and iOS drops its margins, so the face touched the name: the
  // room around it is text (a narrow space before, unless it opens the line, and after), and it is lowered to sit on
  // the words' middle (its bottom on the baseline put it a little high next to lowercase text).
  return (
    <RNText style={whoStyles.who}>
      {lead ? "" : NARROW}
      <View style={{ width: size, height: size, transform: [{ translateY: Math.round(size * 0.2) }] }}>
        <AgentFace agentId={agentId} size={size} live={false} />
      </View>
      {NARROW}
      {name}
    </RNText>
  );
}

/** `text` with each agent's name, where it first stands as a word, drawn as `AgentWho`: children for a `<Text>`. */
export function withAgentFaces(
  text: string,
  who: { name: string; agentId: string | null | undefined }[],
  size?: number,
) {
  const parts = splitAtNames(
    text,
    who.map((w) => w.name),
  );
  if (parts.every((p) => typeof p === "string")) return text;
  return parts.map((p, i) =>
    typeof p === "string" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <Fragment key={i}>{p}</Fragment>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: same
      <AgentWho key={i} agentId={who[p]?.agentId} name={who[p]?.name ?? ""} size={size} lead={i === 0} />
    ),
  );
}

/** A narrow no-break space: the gap between an inline face and its name, as text. */
const NARROW = "\u202F";

const whoStyles = StyleSheet.create({
  who: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
});
