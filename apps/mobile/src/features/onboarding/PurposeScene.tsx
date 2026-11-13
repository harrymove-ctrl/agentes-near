import {
  type PurposeKind,
  SCENE_COLOR,
  SCENE_FACES,
  SCENE_H,
  SCENE_LINES,
  SCENE_W,
} from "@agenteschat/client/lib/purpose-scene";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { PersonAvatar } from "@/agent/PersonAvatar";
import type { PhotoSource } from "@/lib/photo";
import { CardHorizon } from "@/sky/CardHorizon";
import { useTheme } from "@/ui";

/** A pixel portrait of someone on the team (anyone), as the web's. */
const TEAMMATE = require("../../../assets/images/onboarding-teammate.jpg");

/** The air between the drawing and the card's edges. */
const PAD = 6;

/**
 * The drawing of an answer to "what will you use agentes.chat for?" (ADR 0159), as the web's `PurposeScene`, from the
 * same numbers (`@agenteschat/client/lib/purpose-scene`): you in the middle of your agents, each joined to you, or on
 * top of a small org chart, over the cards' horizon at its foot. The answer not chosen rests: its agents sleep and its
 * lines fade. Decorative: the card's words say it.
 */
export function PurposeScene({
  kind,
  chosen,
  width,
  you,
}: {
  kind: PurposeKind;
  chosen: boolean;
  /** The card's width: the stage scales to it. */
  width: number;
  /** Who is signing up: their account's name and photo (Google's), else their initial. */
  you: { name: string; photo: PhotoSource | null };
}) {
  const { colors: c } = useTheme();
  const k = Math.min(1, (width - 2 * PAD) / SCENE_W);
  const stage = { w: SCENE_W * k, h: SCENE_H * k };
  return (
    <View
      style={{ width, height: stage.h + 2 * PAD }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Rising out of the card's own ground: the chosen card's is sunken. */}
      <CardHorizon
        width={width}
        room={72}
        minRoom={40}
        surface={chosen ? c.sunken : c.raised}
        color={SCENE_COLOR[kind]}
      />
      <View style={[styles.stage, { left: (width - stage.w) / 2, top: PAD, width: stage.w, height: stage.h }]}>
        <Svg width={stage.w} height={stage.h} viewBox={`0 0 ${SCENE_W} ${SCENE_H}`} style={StyleSheet.absoluteFill}>
          {SCENE_LINES[kind].map((d) => (
            <Path
              key={d}
              d={d}
              fill="none"
              stroke={c.ink}
              strokeOpacity={chosen ? 0.42 : 0.18}
              // About a point and a half on screen, whatever the scale.
              strokeWidth={1.3 / k}
              strokeLinecap="round"
            />
          ))}
        </Svg>
        {SCENE_FACES[kind].map((f) => {
          const size = Math.round(f.size * k);
          const at = { left: f.x * k - size / 2, top: f.y * k - size / 2 };
          return (
            <View key={`${f.x}:${f.y}`} style={[styles.face, at]}>
              {"look" in f ? (
                <AgentAvatar
                  agent={{ ...f.look, id: `purpose-${kind}-${f.x}-${f.y}` }}
                  size={size}
                  framed
                  mode={chosen ? "idle" : "sleep"}
                />
              ) : "you" in f ? (
                <PersonAvatar name={you.name} size={size} photo={you.photo} />
              ) : (
                <Image source={TEAMMATE} style={{ width: size, height: size, borderRadius: size * 0.3 }} />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { position: "absolute" },
  face: { position: "absolute" },
});
