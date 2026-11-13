import type { MarkId } from "@agenteschat/ui/brand/marks";
import { Image } from "expo-image";
import { Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { LOGO_SIZES, type LogoSize, MARK_GRADIENT, markShapes, STACK_RING, stackChips } from "./provider-marks";
import { useTheme } from "./theme";
import { initialText } from "./type-scale";

const INITIAL_SIZE = { xs: 9, chip: 10, sm: 13, tile: 18, hero: 24 } as const;

/** The phone's own copies of the image marks (assets/images/brands/README.md). */
const MARK_IMAGES: Partial<Record<MarkId, number>> = {
  gemini: require("../../assets/images/brands/gemini.png"),
  soniox: require("../../assets/images/brands/soniox.png"),
  vscode: require("../../assets/images/brands/vscode.png"),
};

export interface ProviderLogoProps {
  /** A provider, plan, brain or mission executor id (`anthropic`, `zai`, `claude_code`…). */
  id: string;
  /** `xs`: the bare mark beside text; `chip`: a 20 pt tile, for `ProviderStack`; `sm`: 30 pt; `tile`: 48 pt; `hero`: 64 pt raised. */
  size?: LogoSize;
  /** Can't be used now (not installed, signed out, computer offline): dimmed, in its own colors. */
  off?: boolean;
  /** Accessible name. Without it the logo is hidden from screen readers: the text next to it names the provider. */
  label?: string;
}

/**
 * The web's `ProviderLogo` on the phone: a maker's official mark (`brand/marks.ts`) in its brand colors on a
 * neutral tile, one-color marks in ink; an id without a mark shows its initial.
 */
export function ProviderLogo({ id, size = "tile", off = false, label }: ProviderLogoProps) {
  const { colors, scheme, shadows } = useTheme();
  const drawn = markShapes(id, scheme, colors.ink2);
  const [box, drawing] = LOGO_SIZES[size];
  const tile = size !== "xs" || !drawn;
  return (
    <View
      {...(label
        ? { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label }
        : { accessible: false, importantForAccessibility: "no-hide-descendants" as const })}
      style={[
        { width: box, height: box, alignItems: "center", justifyContent: "center", opacity: off ? 0.5 : 1 },
        tile ? { borderRadius: Math.round(box / 3), backgroundColor: colors.sunken } : null,
        // A page's head: raised off the grouped gray (sunken would sink into it).
        size === "hero" ? { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` } : null,
      ]}
    >
      {drawn?.image ? (
        <Image source={MARK_IMAGES[drawn.key]} contentFit="contain" style={{ width: drawing, height: drawing }} />
      ) : drawn ? (
        <Svg width={drawing} height={drawing} viewBox="0 0 24 24">
          {drawn.gradient ? (
            <Defs>
              <LinearGradient id={MARK_GRADIENT} x1="0" y1="12" x2="24" y2="12" gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor={drawn.gradient[0]} />
                <Stop offset="1" stopColor={drawn.gradient[1]} />
              </LinearGradient>
            </Defs>
          ) : null}
          {drawn.shapes.map((shape) => (
            <Path key={shape.d} d={shape.d} fill={shape.fill} />
          ))}
        </Svg>
      ) : (
        // A fixed box: the letter doesn't grow with the text size setting.
        <Text
          allowFontScaling={false}
          style={{ ...initialText(box, INITIAL_SIZE[size]), fontWeight: "600", color: colors.muted }}
        >
          {id.trim().charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

/**
 * The web's `ProviderStack`: several makers in one line, as 20 pt tiles overlapping, each ringed in the surface
 * color. Hidden from screen readers unless given `label`.
 */
export function ProviderStack({ ids, label }: { ids: readonly string[]; label?: string }) {
  const { colors } = useTheme();
  const [box] = LOGO_SIZES.chip;
  return (
    <View
      {...(label
        ? { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label }
        : { accessible: false, importantForAccessibility: "no-hide-descendants" as const })}
      style={{ flexDirection: "row" }}
    >
      {stackChips(ids).map((chip) => (
        <View
          key={chip.id}
          style={{
            marginLeft: chip.marginLeft,
            borderRadius: Math.round(box / 3),
            boxShadow: `0px 0px 0px ${STACK_RING}px ${colors.surface}`,
          }}
        >
          <ProviderLogo id={chip.id} size="chip" />
        </View>
      ))}
    </View>
  );
}

/**
 * A group of makers in one tile the size of the others (`sm`): four marks 2 × 2 (the plans of code, the API key's
 * makers). Hidden from screen readers unless given `label`: the row's words name the group. `off`: dimmed, as
 * `ProviderLogo`'s.
 */
export function ProviderQuad({ ids, label, off = false }: { ids: readonly string[]; label?: string; off?: boolean }) {
  const { colors, scheme } = useTheme();
  const [box] = LOGO_SIZES.sm;
  const cell = 10;
  return (
    <View
      {...(label
        ? { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label }
        : { accessible: false, importantForAccessibility: "no-hide-descendants" as const })}
      style={{
        width: box,
        height: box,
        borderRadius: Math.round(box / 3),
        backgroundColor: colors.sunken,
        flexDirection: "row",
        flexWrap: "wrap",
        alignContent: "center",
        justifyContent: "center",
        gap: 2,
        paddingHorizontal: (box - cell * 2 - 2) / 2,
        opacity: off ? 0.5 : 1,
      }}
    >
      {ids.slice(0, 4).map((id) => {
        const drawn = markShapes(id, scheme, colors.ink2);
        if (drawn?.image)
          return (
            <Image
              key={id}
              source={MARK_IMAGES[drawn.key]}
              contentFit="contain"
              style={{ width: cell, height: cell }}
            />
          );
        return (
          <Svg key={id} width={cell} height={cell} viewBox="0 0 24 24">
            {drawn?.gradient ? (
              <Defs>
                <LinearGradient
                  id={`${MARK_GRADIENT}-${id}`}
                  x1="0"
                  y1="12"
                  x2="24"
                  y2="12"
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0" stopColor={drawn.gradient[0]} />
                  <Stop offset="1" stopColor={drawn.gradient[1]} />
                </LinearGradient>
              </Defs>
            ) : null}
            {drawn?.shapes.map((shape) => (
              <Path
                key={shape.d}
                d={shape.d}
                fill={shape.fill === `url(#${MARK_GRADIENT})` ? `url(#${MARK_GRADIENT}-${id})` : shape.fill}
              />
            ))}
          </Svg>
        );
      })}
    </View>
  );
}
