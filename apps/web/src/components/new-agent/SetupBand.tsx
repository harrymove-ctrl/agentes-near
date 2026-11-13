import type { Agent } from "@agenteschat/client";
import { useCatalog } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  type AgentColor,
  gradientOf,
  Icon,
  PixelSky,
  ProviderLogo,
  playAgentReaction,
  prefersReducedMotion,
} from "@agenteschat/ui";
import { type CSSProperties, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { agentCoverOptions, facePool } from "@/components/Sky";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { useScrollEdges } from "@/lib/scroll-edges";
import "./new-agent-card.css";

/** How long its sky takes to go from night to day once it can think. */
const DAWN_MS = 1600;
/** A few pixel stars, the same every time. */
const STARS = Array.from({ length: 16 }, (_, i) => ({
  left: (i * 37 + 11) % 97,
  top: (i * 53 + 7) % 70,
  delay: (i % 6) * 0.4,
}));

/**
 * The band on top of a new agent's checklist in its chat (ADR 0164): its sky (the agent page's cover), at night with
 * the agent asleep until it can think, then a dawn; to its right, what it still needs (an AI, the apps its card chose)
 * joined to it by pixel trails that light up as each one is done. Drawn by the app, never a message.
 */
export function SetupBand({
  agent,
  ready,
  thinks,
  needsAi,
  apps,
}: {
  agent: Agent;
  /** What it reads has loaded: a change after this is one that just happened (the dawn, a trail lighting up). */
  ready: boolean;
  /** It can think (its AI is ready or waiting for its computer). */
  thinks: boolean;
  /** Its AI is one of the things the checklist asks for here. */
  needsAi: boolean;
  /** The apps its card chose (catalog ids), each with whether it may use it now. */
  apps: { id: string; granted: boolean }[];
}) {
  const { t } = useTranslation();
  const catalog = useCatalog();
  const mark = useAgentThinks(agent)?.mark ?? null;
  const host = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLSpanElement>(null);
  const path = useRef<HTMLSpanElement>(null);
  const color = (agent.appearance?.color ?? "sky") as AgentColor;
  // Night until it can think; a dawn when it starts to while the band is in sight (never one on first load).
  const seen = useRef<boolean | null>(null);
  const dawnAt = useRef<number | null>(null);
  const lit = useRef<Set<string>>(new Set());
  const fresh = useRef<Set<string>>(new Set());
  if (ready && seen.current === null) {
    seen.current = thinks;
    lit.current = new Set(apps.filter((a) => a.granted).map((a) => a.id));
  }
  if (ready && seen.current === false && thinks && dawnAt.current === null) dawnAt.current = performance.now();
  fresh.current = new Set(apps.filter((a) => a.granted && !lit.current.has(a.id)).map((a) => a.id));
  const reactKey = `band:${agent.id}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once it starts to think (the dawn), its hop
  useEffect(() => {
    if (dawnAt.current !== null && !prefersReducedMotion()) {
      const timer = setTimeout(() => playAgentReaction(reactKey, "up"), DAWN_MS / 2);
      return () => clearTimeout(timer);
    }
  }, [reactKey, thinks]);
  useEffect(() => {
    for (const id of fresh.current) lit.current.add(id);
  });
  const night = () => {
    if (thinks && dawnAt.current === null) return 0;
    if (!thinks) return 1;
    if (prefersReducedMotion()) return 0;
    return Math.max(0, 1 - (performance.now() - (dawnAt.current ?? 0)) / DAWN_MS);
  };
  // On a phone too narrow for every slot, the path scrolls sideways and fades where more is past its edge.
  useScrollEdges(path, [apps.length, needsAi], "x");
  const def = (id: string) => (catalog.data?.connectors ?? []).find((d) => d.id === id) ?? null;
  const slots = [
    ...(needsAi
      ? [
          {
            key: "ai",
            done: thinks,
            title: t("newAgentCard.band.ai"),
            icon: thinks && mark ? <ProviderLogo id={mark} size="sm" /> : <Icon name="bolt" />,
          },
        ]
      : []),
    ...apps.map((a) => {
      const d = def(a.id);
      const name = d ? connectorName(t, d) : a.id;
      return { key: a.id, done: a.granted, title: name, icon: <ConnectorIcon def={d} label={name} /> };
    }),
  ];
  return (
    <div
      className="nac-band"
      ref={host}
      // Not `data-day`: that marks the conversation's day dividers, which its floating date reads as a date.
      data-lit={thinks || undefined}
      style={{ "--trail": thinks ? gradientOf(color)[1] : "#fff" } as CSSProperties}
      role="img"
      aria-label={thinks ? t("newAgentCard.band.label", agentGrammar(agent.name)) : t("newAgentCard.band.asleep")}
    >
      <PixelSky
        options={agentCoverOptions(color, {
          night,
          // The top of the chat's setup card, whose face is the raised surface.
          surface: "--surface-raised",
          clear: () => [face.current, ...Array.from(host.current?.querySelectorAll(".nac-band__slot") ?? [])],
          pool: facePool(host, () => [face.current]),
        })}
      />
      <span className="nac-band__stars" aria-hidden="true">
        {STARS.map((s) => (
          <i
            key={`${s.left}-${s.top}`}
            style={{ left: `${s.left}%`, top: `${s.top}%`, animationDelay: `${s.delay}s` }}
          />
        ))}
      </span>
      <span className="nac-band__agent" ref={face}>
        <AgentAvatar
          agentId={agent.id}
          name={agent.name}
          size="xl"
          framed={false}
          state={thinks ? undefined : "sleeping"}
          reactionKey={reactKey}
        />
        {!thinks && (
          <span className="nac-band__zz" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>
      <span className="nac-band__path" aria-hidden="true" ref={path}>
        {slots.map((s) => (
          <span key={s.key} className="nac-band__step">
            <span
              className="nac-band__trail"
              data-lit={s.done || undefined}
              data-fresh={
                (s.done && (s.key === "ai" ? dawnAt.current !== null : fresh.current.has(s.key))) || undefined
              }
            >
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <i key={i} />
              ))}
            </span>
            <span className="nac-band__slot" data-done={s.done || undefined} title={s.title}>
              {s.icon}
              {s.done && (
                <span className="nac-band__check">
                  <Icon name="check" size={14} />
                </span>
              )}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}
