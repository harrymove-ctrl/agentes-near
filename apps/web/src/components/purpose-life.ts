import { type PurposeKind, SCENE_ACTIVITIES, SCENE_FACES } from "@agenteschat/client/lib/purpose-scene";
import { playAgentReaction, prefersReducedMotion } from "@agenteschat/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The wake's step from one agent to the next (ADR 0162). */
export const WAKE_STEP_MS = 70;
/** A pill lights this long after its agent wakes. */
export const LIGHT_AFTER_MS = 60;
/** The calm loop: the next pill works this often. */
const WORK_EVERY_MS = 2500;

/** The engine's key for an agent of a card's drawing (its reactions, its seed). */
export const sceneAgentKey = (kind: PurposeKind, i: number) => `purpose-${kind}-${i}`;

/**
 * What a purpose card's agents and pills are doing (ADR 0162), shared by its drawing (`PurposeScene`) and its cluster
 * of pills. Nothing here changes a size or a place: only who is awake, which pill is pointed at, which one works.
 */
export interface PurposeLife {
  /** The wake is running: each pill lights a beat after its agent, z's pop off the agents. */
  waking: boolean;
  awake: (agent: number) => boolean;
  /** The agent pointed at, through its pill or itself. */
  hot: number | null;
  /** The agent whose pill shows the work sweep, the agent bobbing. */
  working: number | null;
  hasPill: (agent: number) => boolean;
  /** An agent's place in the wake. */
  wakeOrder: (agent: number) => number;
  point: (agent: number | null) => void;
}

/** The wake's order: the pills' agents as they light up, then the drawing's other agents. */
function wakeOrderOf(kind: PurposeKind): number[] {
  const pills = SCENE_ACTIVITIES[kind].map((a) => a.agent);
  const rest = SCENE_FACES[kind].flatMap((f, i) => ("look" in f && !pills.includes(i) ? [i] : []));
  return [...pills, ...rest];
}

/**
 * At rest the agents doze. Pointing at a pill (or its agent) wakes that agent with one hop. Choosing the card wakes them
 * in a quick wave (a hop each, `WAKE_STEP_MS` apart) while the pills light in place; then one pill at a time works,
 * every `WORK_EVERY_MS`, waiting while one is pointed at. Unchosen, they doze again. Reduced motion: no wave, no
 * hops, no loop; chosen is simply awake and lit.
 */
export function usePurposeLife(kind: PurposeKind, chosen: boolean): PurposeLife {
  const order = useMemo(() => wakeOrderOf(kind), [kind]);
  const [woken, setWoken] = useState<ReadonlySet<number>>(() => new Set(chosen ? order : []));
  const [waking, setWaking] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  // The wake starts in the same render as the choice, so each pill's light keeps its delay.
  const [seen, setSeen] = useState(chosen);
  if (seen !== chosen) {
    setSeen(chosen);
    setWaking(chosen && !prefersReducedMotion());
  }
  const hotNow = useRef(hot);
  hotNow.current = hot;
  const was = useRef(chosen);
  useEffect(() => {
    const before = was.current;
    was.current = chosen;
    if (!chosen) {
      setWoken(new Set());
      setWaking(false);
      setWorking(null);
      return;
    }
    const still = prefersReducedMotion();
    if (before || still) setWoken(new Set(order));
    if (still) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!before) {
      order.forEach((agent, n) => {
        timers.push(
          setTimeout(() => {
            setWoken((s) => new Set(s).add(agent));
            playAgentReaction(sceneAgentKey(kind, agent), "up");
          }, n * WAKE_STEP_MS),
        );
      });
      timers.push(setTimeout(() => setWaking(false), LIGHT_AFTER_MS + order.length * WAKE_STEP_MS + 500));
    }
    const pills = SCENE_ACTIVITIES[kind];
    let n = 0;
    const loop = setInterval(() => {
      if (hotNow.current === null) setWorking(pills[n++ % pills.length]?.agent ?? null);
    }, WORK_EVERY_MS);
    return () => {
      for (const t of timers) clearTimeout(t);
      clearInterval(loop);
    };
  }, [chosen, kind, order]);
  const point = useCallback(
    (agent: number | null) => {
      setHot(agent);
      if (agent !== null && !prefersReducedMotion()) playAgentReaction(sceneAgentKey(kind, agent), "up");
    },
    [kind],
  );
  return useMemo(
    () => ({
      waking: chosen && waking,
      awake: (agent: number) => (chosen && woken.has(agent)) || hot === agent,
      hot,
      working: chosen ? working : null,
      hasPill: (agent: number) => SCENE_ACTIVITIES[kind].some((a) => a.agent === agent),
      wakeOrder: (agent: number) => Math.max(0, order.indexOf(agent)),
      point,
    }),
    [chosen, waking, woken, hot, working, kind, order, point],
  );
}
