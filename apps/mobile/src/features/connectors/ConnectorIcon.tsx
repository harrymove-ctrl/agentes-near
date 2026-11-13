import type { ConnectorDef } from "@agenteschat/client";
import { type AgentPresetColor, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { appHeaders, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { Icon, type IconName, Text, useTheme } from "@/ui";
import { useColors } from "../shared/hooks";
import { brandOf, iconUri, monogram, ownMarkUri, serverIconUri } from "./logic";

/**
 * A service's mark on a tile, as the web draws it: a one-color brand icon tinted in the brand's color (the ink for
 * near-black brands), else a mark in its own colors (the web's `/brands/` files, or the icon a server connected by
 * address gave as `image`, loaded with the session), else a monogram. `check`: a small check on the corner once it
 * is connected (no tags).
 */
export function ConnectorIcon({
  def,
  label,
  size = 44,
  check = false,
  image,
  bare = false,
}: {
  def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  label: string;
  size?: number;
  check?: boolean;
  image?: string | null;
  /** The mark alone, no tile around it (a request card's name line): a monogram keeps its color tile. */
  bare?: boolean;
}) {
  const c = useColors();
  const uri = def ? iconUri(serverUrl(), def.iconUrl) : null;
  const mark = def ? ownMarkUri(serverUrl(), def.iconUrl) : null;
  // Stable per URL, so the image isn't fetched again on every render. The web's own files are public: no session.
  const own = useMemo(() => {
    if (mark) return { uri: mark };
    const at = uri ? null : serverIconUri(serverUrl(), image);
    return at ? { uri: at, headers: appHeaders(lastCookie()) } : null;
  }, [uri, mark, image]);
  // A saved call keeps the icon its server had then, and a newer icon deletes that file: the monogram instead.
  const [failed, setFailed] = useState<string | null>(null);
  const tint = (def ? brandOf(def.brandColor) : null) ?? c.ink;
  const radius = Math.round(size * 0.3);
  const { scheme } = useTheme();
  // No logo: the first letter on a color of its own, picked by the name (the same server, the same color everywhere).
  const lettered = !uri && !(own && own.uri !== failed);
  const [light, deep] = gradientOf(monogramColor(label));
  const tile = lettered ? mixHex(c.raised, light, scheme === "dark" ? 0.28 : 0.4) : c.raised;
  const letter = scheme === "dark" ? light : deep;
  const loose = bare && !lettered;
  // Bare, the logo fills its box (no tile's margin around it).
  const markScale = loose ? 1 : null;
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: loose ? "transparent" : tile,
          borderColor: lettered || loose ? "transparent" : c.line,
        },
      ]}
      accessible={false}
    >
      {uri ? (
        <Image
          source={{ uri }}
          tintColor={tint}
          contentFit="contain"
          style={{ width: Math.round(size * (markScale ?? 0.5)), height: Math.round(size * (markScale ?? 0.5)) }}
        />
      ) : own && own.uri !== failed ? (
        <Image
          source={own}
          onError={() => setFailed(own.uri)}
          contentFit="contain"
          style={{ width: Math.round(size * (markScale ?? 0.58)), height: Math.round(size * (markScale ?? 0.58)) }}
        />
      ) : (
        // Its line as tall as its letters: the body's taller line, in a small tile, set them low.
        <Text variant="body" style={[styles.mono, monogramSize(size), { color: letter }]}>
          {monogram(label)}
        </Text>
      )}
      {check ? (
        <View style={[styles.check, { backgroundColor: c.ok, borderColor: c.bg }]}>
          {/* The ring's color for the mark too: white on dark's light green was hard to read. */}
          <Icon name="check" size={12} color={c.bg} />
        </View>
      ) : null}
    </View>
  );
}

/** One of our own icons on the same tile (a built-in tool, a mailbox), where a service would show its mark. */
export function IconTile({ name, size = 20, bare = false }: { name: IconName; size?: number; bare?: boolean }) {
  const c = useColors();
  // Bare: the icon alone, as a request card's name line draws a mark (no tile inside a card).
  if (bare)
    return (
      <View style={[styles.tile, styles.bare, { width: size, height: size }]} accessible={false}>
        <Icon name={name} size={Math.round(size * 0.85)} color={c.muted} />
      </View>
    );
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
          backgroundColor: c.sunken,
          borderColor: c.line,
        },
      ]}
      accessible={false}
    >
      <Icon name={name} size={Math.round(size * 0.62)} color={c.muted} />
    </View>
  );
}

/** A monogram's letters for a tile `size` wide, on a line just as tall, so they sit in the tile's middle. */
const MONOGRAM_COLORS: AgentPresetColor[] = ["sky", "indigo", "violet", "rose", "amber", "green", "teal"];
/** A lettered server's color, from its name: stable across screens and launches. */
const monogramColor = (label: string): AgentPresetColor => {
  let h = 0;
  for (const ch of label) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return MONOGRAM_COLORS[h % MONOGRAM_COLORS.length] ?? "sky";
};

const monogramSize = (size: number) => {
  const fontSize = Math.round(size * 0.36);
  return { fontSize, lineHeight: Math.round(fontSize * 1.2) };
};

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  bare: { borderWidth: 0 },
  mono: { fontWeight: "700", textAlign: "center", includeFontPadding: false },
  check: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
