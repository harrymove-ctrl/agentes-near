import { initialsOf } from "@agenteschat/tokens/names";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { Image, Text as RNText, StyleSheet } from "react-native";
import type { PhotoSource } from "@/lib/photo";
import { useTheme } from "@/ui/theme";
import { initialText } from "@/ui/type-scale";

export interface PersonAvatarProps {
  name: string;
  size: number;
  /** The person's photo; while it loads, or if it fails, the initial shows. */
  photo?: PhotoSource | null;
}

/**
 * A person: their photo, or a neutral tile with the first letter (agents are the ones with color). The web's tile
 * shape for everyone: a rounded square, radius 30% of the side, as the agents' own.
 */
export function PersonAvatar({ name, size, photo }: PersonAvatarProps) {
  const { scheme } = useTheme();
  const dark = scheme === "dark";
  // The first of the web's initials: an emoji before the name gives way to it, and no character is cut in half.
  const initial = Array.from(initialsOf(name))[0] ?? "?";
  const [failed, setFailed] = useState(false);
  const uri = photo?.uri;
  // A new photo gets a new chance.
  useEffect(() => {
    if (uri) setFailed(false);
  }, [uri]);
  return (
    <LinearGradient
      colors={dark ? ["#3a3a37", "#2a2a28"] : ["#e9e9e5", "#d4d4cf"]}
      start={{ x: 0.3, y: 0 }}
      end={{ x: 0.7, y: 1 }}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
    >
      <RNText
        allowFontScaling={false}
        style={{ ...initialText(size), fontWeight: "600", color: dark ? "#efefec" : "#2a2a28" }}
      >
        {initial}
      </RNText>
      {photo && !failed ? (
        <Image
          source={photo}
          onError={() => setFailed(true)}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { borderRadius: size * 0.3 }]}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </LinearGradient>
  );
}
