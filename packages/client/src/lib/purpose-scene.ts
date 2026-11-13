/*
 * The drawings of the onboarding's first question (ADR 0159), the same on the web and the phone: on a 240 × 172 stage
 * (scaled to the card), the person signing up in the middle of six agents, each joined to them ("For me"), or on top
 * of a small org chart of people and agents ("For my team"). Pure numbers: each app draws the faces with
 * its own avatars, the lines in its own vector layer.
 */

export type PurposeKind = "personal" | "team";

export const SCENE_W = 240;
export const SCENE_H = 172;

/** A look as the agent engine draws it. */
export interface SceneLook {
  color: "sky" | "indigo" | "violet" | "rose" | "amber" | "green" | "teal" | "graphite";
  eyes: "round" | "dots" | "wide" | "happy" | "sleepy";
  accessory: string;
}

/** A face on the stage, by its center: an agent, the person signing up, or someone on their team. */
export type SceneFace = { x: number; y: number; size: number } & (
  | { look: SceneLook }
  | { you: true }
  | { teammate: true }
);

/** For me: you in the middle and six agents around you. */
const ME: SceneFace[] = [
  { x: 120, y: 86, size: 60, you: true },
  { x: 30, y: 86, size: 36, look: { color: "green", eyes: "round", accessory: "cap" } },
  { x: 70, y: 30, size: 36, look: { color: "amber", eyes: "wide", accessory: "headphones" } },
  { x: 170, y: 30, size: 36, look: { color: "rose", eyes: "happy", accessory: "flower" } },
  { x: 210, y: 86, size: 36, look: { color: "teal", eyes: "happy", accessory: "bow" } },
  { x: 170, y: 142, size: 36, look: { color: "sky", eyes: "dots", accessory: "beanie" } },
  { x: 70, y: 142, size: 36, look: { color: "violet", eyes: "round", accessory: "antenna" } },
];

/** For a team: you on top; an agent, someone on the team and an agent under you; two agents under that person. */
const TEAM: SceneFace[] = [
  { x: 120, y: 28, size: 40, you: true },
  { x: 46, y: 89, size: 34, look: { color: "amber", eyes: "round", accessory: "headset" } },
  { x: 120, y: 89, size: 34, teammate: true },
  { x: 194, y: 89, size: 34, look: { color: "green", eyes: "wide", accessory: "antenna" } },
  { x: 88, y: 145, size: 30, look: { color: "rose", eyes: "happy", accessory: "scarf" } },
  { x: 152, y: 145, size: 30, look: { color: "teal", eyes: "dots", accessory: "cap" } },
];

export const SCENE_FACES: Record<PurposeKind, readonly SceneFace[]> = { personal: ME, team: TEAM };

/** An org chart's line from a parent's foot down to a bar at `bar`, across, and down to a child's head; round turns. */
function elbow(from: SceneFace, to: SceneFace, bar: number): string {
  const top = from.y + from.size / 2;
  const end = to.y - to.size / 2;
  if (to.x === from.x) return `M${from.x} ${top}V${end}`;
  const r = 6;
  const dir = to.x > from.x ? 1 : -1;
  return `M${from.x} ${top}V${bar - r}Q${from.x} ${bar} ${from.x + dir * r} ${bar}H${to.x - dir * r}Q${to.x} ${bar} ${to.x} ${bar + r}V${end}`;
}

/** The lines, as SVG paths on the stage: for me, from you to each agent; for a team, from each lead to who is under. */
export const SCENE_LINES: Record<PurposeKind, readonly string[]> = {
  personal: ME.slice(1).map((a) => `M${ME[0]?.x} ${ME[0]?.y}L${a.x} ${a.y}`),
  team: (() => {
    const [lead, a, person, b, c, d] = TEAM as [SceneFace, SceneFace, SceneFace, SceneFace, SceneFace, SceneFace];
    return [
      elbow(lead, person, 60),
      elbow(lead, a, 60),
      elbow(lead, b, 60),
      elbow(person, c, 118),
      elbow(person, d, 118),
    ];
  })(),
};

/** Each answer's color: its horizon. */
export const SCENE_COLOR: Record<PurposeKind, "violet" | "sky"> = { personal: "violet", team: "sky" };

/** What a card's agents do, as the cluster of pills under its line (ADR 0162). */
export type PurposeActivity =
  | "agenda"
  | "home"
  | "bills"
  | "studies"
  | "travel"
  | "support"
  | "finance"
  | "reports"
  | "sales";

/**
 * Each pill's agent (its index in `SCENE_FACES`) and words (`onboarding.purpose.activities.<key>`), in the order they
 * light up: round the ring from the top-left for me, down the tree for a team. An agent may have no pill.
 */
export const SCENE_ACTIVITIES: Record<PurposeKind, readonly { agent: number; key: PurposeActivity }[]> = {
  personal: [
    { agent: 2, key: "agenda" },
    { agent: 3, key: "home" },
    { agent: 4, key: "bills" },
    { agent: 5, key: "studies" },
    { agent: 6, key: "travel" },
  ],
  team: [
    { agent: 1, key: "support" },
    { agent: 3, key: "finance" },
    { agent: 4, key: "reports" },
    { agent: 5, key: "sales" },
  ],
};
