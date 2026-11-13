import type { Actor, AgentPresence } from "@agenteschat/client";
import { agentStateIn } from "@agenteschat/client";
import { isOutOfOffice } from "@agenteschat/client/lib/presence";
import { splitAtNames } from "@agenteschat/client/lib/text";
import {
  type AgentAppearance,
  type AgentState,
  Avatar,
  type AvatarProps,
  PixelSpinner,
  type PixelSpinnerSize,
} from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import { opensItsBlock } from "@/lib/inline";
import { lookOf } from "@/lib/look";
import { useStreams } from "@/realtime/context";

type AgentAvatarProps = Omit<AvatarProps, "kind" | "running" | "state" | "appearance" | "presence"> & {
  /** A real agent: its look from the directory, its live state from the run store. */
  agentId?: string;
  /** An agent object at hand (an onboarding preset, the customizer's draft). */
  agent?: { id?: string; appearance?: unknown } | null;
  /** Overrides the look (the customizer's preview and choices). */
  appearance?: AgentAppearance;
  channelId?: string;
  state?: AgentState;
  /** Shows the "running" halo (a preview without a live run). */
  running?: boolean;
  /** Out of office (its plan or budget is spent): asleep while none of its runs works. */
  asleep?: boolean;
  /**
   * Its presence badge (ADR 0084): `true` reads it live (from its work, offline with no AI), a value draws that one.
   * Only where presence matters (the sidebar, member lists, profile cards, messages), never on the tiny receipts.
   */
  presence?: boolean | AgentPresence | null;
};

/**
 * The only way `apps/web` draws an agent: the living symbol with the agent's
 * appearance (color, eyes, accessory) and, for a real agent, the live run
 * state (looks around while it thinks, dash eyes while words arrive).
 * `channelId` limits the state to one conversation; `state` overrides it.
 */
export function AgentAvatar(props: AgentAvatarProps) {
  const id = props.agentId ?? props.agent?.id;
  if (id && props.presence === true) return <PresentAgentAvatar {...props} agentId={id} />;
  const given = typeof props.presence === "string" ? props.presence : null;
  if (id) return <LiveAgentAvatar {...props} presence={given} agentId={id} />;
  const { agent, appearance, state, running, asleep: _s, channelId: _c, agentId: _a, presence: _p, ...rest } = props;
  return (
    <Avatar
      kind="agent"
      appearance={appearance ?? lookOf(agent)}
      state={state ?? (running ? "thinking" : undefined)}
      presence={given}
      {...rest}
    />
  );
}

/** An agent named in a line of text: its face at the text's size, then its name (`.ac-who`). */
export function AgentWho({
  agentId,
  name,
  appearance,
}: {
  agentId?: string;
  name: string;
  appearance?: AgentAppearance;
}) {
  return (
    <span className="ac-who" ref={markLead}>
      <AgentAvatar agentId={agentId} size="xs" name={name} appearance={appearance} />
      <b>{name}</b>
    </span>
  );
}

/**
 * Anyone named in a line of text: an agent's face or a person's, at the text's size, then their name (`.ac-who`).
 * `faceOnly` where the words after it say who, or say what it is (a calendar item's title after its owner's face).
 * `size` draws a face larger than the text (`--who-face` sets its box); an agent at `work` moves, or rests stopped.
 */
export function ActorWho({
  actor,
  name,
  faceOnly,
  size = "xs",
  work,
}: {
  actor: Actor;
  name: string;
  faceOnly?: boolean;
  size?: "xs" | "sm";
  work?: "running" | "stalled";
}) {
  return (
    <span className="ac-who" ref={markLead}>
      {actor.type === "agent" && work ? (
        <AgentAvatar
          agentId={actor.id}
          size={size}
          name={name}
          running={work === "running"}
          state={work === "running" ? "writing" : undefined}
          expression={work === "stalled" ? "closed" : undefined}
        />
      ) : (
        <ActorAvatar actor={actor} size={size} name={name} />
      )}
      {!faceOnly && <b>{name}</b>}
    </span>
  );
}

const markLead = (el: HTMLElement | null) => {
  el?.toggleAttribute("data-lead", opensItsBlock(el));
};

/** `text` with the agent's name, where it first stands as a word, drawn as `AgentWho`. */
export function withAgentFace(text: string, name: string, agentId?: string): ReactNode {
  return withAgentFaces(text, [{ name, agentId }]);
}

/** `text` with each agent's name, where it first stands as a word, drawn as `AgentWho` ("Atlas respondeu à Ada"). */
export function withAgentFaces(text: string, who: { name: string; agentId?: string }[]): ReactNode {
  const parts = splitAtNames(
    text,
    who.map((w) => w.name),
  );
  if (parts.every((p) => typeof p === "string")) return text;
  return (
    <>
      {parts.map((p, i) => {
        if (typeof p === "string") return p;
        const w = who[p];
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
        return <AgentWho key={i} agentId={w?.agentId} name={w?.name ?? ""} />;
      })}
    </>
  );
}

/** A real agent with its live presence badge; out of office, asleep while nothing of its runs. */
function PresentAgentAvatar(props: AgentAvatarProps & { agentId: string }) {
  const { t } = useTranslation();
  const shown = useAgentPresence(props.agentId);
  return (
    <LiveAgentAvatar
      {...props}
      asleep={props.asleep ?? isOutOfOffice(shown?.line)}
      presence={shown?.presence ?? null}
      presenceLabel={shown ? t(`presence.${shown.presence}`) : undefined}
    />
  );
}

function LiveAgentAvatar({
  agentId,
  agent,
  appearance,
  channelId,
  state,
  running,
  presence,
  asleep,
  ...rest
}: Omit<AgentAvatarProps, "presence"> & { agentId: string; presence: AgentPresence | null }) {
  const live = useStreams((s) => agentStateIn(s, agentId, channelId));
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const known = dir.anyAgent(agentId);
  const idle = running ? "thinking" : asleep ? "sleeping" : "idle";
  return (
    <Avatar
      kind="agent"
      state={state ?? (live === "idle" ? idle : live)}
      appearance={appearance ?? lookOf(known ?? agent)}
      initials={dir.agentInitials(agentId)}
      presence={presence}
      {...rest}
    />
  );
}

/**
 * The working indicator for an agent's work (the pixel orbit in its own
 * tones); the neutral one is `Icon name="spinner"` / `PixelSpinner` alone.
 */
export function AgentSpinner({
  agentId,
  size = 14,
  label,
}: {
  agentId: string | null | undefined;
  size?: PixelSpinnerSize;
  label?: string;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  return <PixelSpinner size={size} color={agent ? colorOf(agent) : undefined} label={label} />;
}

/**
 * Anyone's avatar by actor: agents get the living symbol with their look,
 * people their photo or initials.
 */
export function ActorAvatar({
  actor,
  name,
  ...rest
}: Omit<AvatarProps, "kind" | "running" | "state" | "imageUrl" | "appearance" | "presence"> & {
  actor: { type: "agent" | "person"; id: string };
  /** The live presence badge (ADR 0084). */
  presence?: boolean;
}) {
  if (actor.type === "agent") return <AgentAvatar agentId={actor.id} name={name} {...rest} />;
  return <PersonAvatar id={actor.id} name={name} {...rest} />;
}

type PersonAvatarProps = Omit<AvatarProps, "kind" | "imageUrl" | "presence"> & {
  id: string;
  /** The live presence badge (ADR 0084): as others see them (a hidden person reads offline), yours as you chose. */
  presence?: boolean;
};

/** A workspace member's face: the uploaded photo (or the sign-in one) or initials. */
export function PersonAvatar({ id, presence, ...rest }: PersonAvatarProps) {
  if (presence) return <PresentPersonAvatar id={id} {...rest} />;
  return <MemberAvatar id={id} presence={null} {...rest} />;
}

function PresentPersonAvatar({ id, ...rest }: Omit<PersonAvatarProps, "presence">) {
  const { t } = useTranslation();
  const shown = usePersonPresence(id);
  return (
    <MemberAvatar
      id={id}
      presence={shown?.presence ?? null}
      presenceLabel={shown ? t(`presence.${shown.presence}`) : undefined}
      {...rest}
    />
  );
}

function MemberAvatar({ id, name, ...rest }: Omit<AvatarProps, "kind" | "imageUrl"> & { id: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return <Avatar kind="person" name={name} imageUrl={dir.memberById.get(id)?.image} {...rest} />;
}
