import type { WorkspaceMode } from "@agenteschat/client";
import { type PurposeKind, SCENE_ACTIVITIES, SCENE_FACES } from "@agenteschat/client/lib/purpose-scene";
import { type AgentAppearance, cx, OptionList } from "@agenteschat/ui";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { PurposeScene, type PurposeYou } from "@/components/PurposeScene";
import { LIGHT_AFTER_MS, type PurposeLife, usePurposeLife, WAKE_STEP_MS } from "@/components/purpose-life";

const PURPOSES = ["personal", "team"] as const satisfies readonly WorkspaceMode[];

/**
 * "What will you use agentes.chat for?" (ADR 0159, 0162): two cards one over the other, one radio each. On the left the
 * drawing; on the right the title, one line, then a cluster of pills, each an agent of the drawing and what it does.
 * The cluster is decorative (the card's name stays its title and line) and its layout never moves: at rest the pills
 * are dim and their agents doze; pointing at one brightens it and wakes its agent; choosing the card wakes the agents in
 * a wave and lights the pills in place, then one at a time shows its work.
 */
export function PurposeCards({
  value,
  onValueChange,
  you,
}: {
  value: WorkspaceMode | null;
  onValueChange: (value: WorkspaceMode | null) => void;
  you: PurposeYou;
}) {
  const { t } = useTranslation();
  const lives: Record<PurposeKind, PurposeLife> = {
    personal: usePurposeLife("personal", value === "personal"),
    team: usePurposeLife("team", value === "team"),
  };
  return (
    <OptionList<WorkspaceMode | "">
      aria-label={t("onboarding.purpose.title")}
      layout="cards"
      className="onb-purpose"
      value={value ?? ""}
      onValueChange={(v) => onValueChange(v || null)}
      options={PURPOSES.map((mode) => ({
        value: mode,
        leading: <PurposeScene kind={mode} chosen={value === mode} you={you} life={lives[mode]} />,
        title: t(`onboarding.purpose.${mode}`),
        description: (
          <>
            <span>{t(`onboarding.purpose.${mode}Line`)}</span>
            <PurposeCluster kind={mode} lit={value === mode} life={lives[mode]} />
          </>
        ),
      }))}
    />
  );
}

/** The pills: one size, wrapping in their order, in a box reserved for two lines. */
function PurposeCluster({ kind, lit, life }: { kind: PurposeKind; lit: boolean; life: PurposeLife }) {
  const { t } = useTranslation();
  const faces = SCENE_FACES[kind];
  return (
    <span className="onb-cluster" data-lit={lit || undefined} data-waking={life.waking || undefined} aria-hidden="true">
      {SCENE_ACTIVITIES[kind].map(({ agent, key }, n) => {
        const face = faces[agent];
        return (
          <span
            key={key}
            className={cx("onb-pill", life.hot === agent && "is-hot", life.working === agent && "is-working")}
            style={{ "--d": `${LIGHT_AFTER_MS + n * WAKE_STEP_MS}ms` } as CSSProperties}
            onPointerEnter={() => life.point(agent)}
            onPointerLeave={() => life.point(null)}
          >
            {face && "look" in face && (
              <AgentAvatar
                name={`purpose-pill-${kind}-${agent}`}
                appearance={face.look as AgentAppearance}
                size="xs"
                state={life.awake(agent) ? "idle" : "sleeping"}
              />
            )}
            <span className="onb-pill__words">{t(`onboarding.purpose.activities.${key}`)}</span>
            <span className="onb-pill__bar" />
          </span>
        );
      })}
    </span>
  );
}
