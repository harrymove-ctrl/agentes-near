import { type DiffKind, type DiffLine, diffBlocks } from "@agenteschat/ui/diff";
import type { ReactNode } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import { withAlpha } from "./palette";
import { useSystemText } from "./Text";
import { fonts, useTheme } from "./theme";

/**
 * A line diff drawn as the web's, as GitHub shows a change: added lines on green with a green bar, removed ones on red,
 * struck through. `prose`: words, not code, so no mono (a proposed change to a text). With `render` and `folded`,
 * words in Markdown: each run of lines drawn as one block by `render` (told which kind, so a removed one reads muted),
 * long unchanged runs folded to the line beside each change, `folded` saying how many.
 */
export function DiffView({
  lines,
  prose = false,
  render,
  folded,
}: {
  lines: DiffLine[];
  prose?: boolean;
  render?: (text: string, kind: DiffKind) => ReactNode;
  folded?: (count: number) => string;
}) {
  const { colors } = useTheme();
  // Words (a proposed change to a text) are the footnote on the scale, grown with the person's text size; code keeps mono.
  const words = useSystemText("footnote");
  const band = (kind: DiffKind) =>
    kind === "add"
      ? { backgroundColor: withAlpha(colors.ok, 0.12), borderLeftColor: colors.ok }
      : kind === "del"
        ? { backgroundColor: withAlpha(colors.danger, 0.1), borderLeftColor: colors.danger }
        : null;
  if (render && folded) {
    return (
      <View style={[styles.diff, { borderColor: colors.line }]}>
        {diffBlocks(lines).map((b, i) =>
          b.kind === "fold" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
            <RNText key={i} style={[words, styles.fold, { color: colors.muted, backgroundColor: colors.sunken }]}>
              {folded(b.count)}
            </RNText>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
            <View key={i} style={[styles.edge, styles.block, band(b.kind)]}>
              {render(b.text, b.kind)}
            </View>
          ),
        )}
      </View>
    );
  }
  return (
    <View style={[styles.diff, styles.lines, { borderColor: colors.line }]}>
      {lines.map((l, i) => (
        <RNText
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          key={i}
          style={[
            prose ? words : styles.line,
            styles.edge,
            band(l.kind),
            { color: l.kind === "del" ? colors.muted : colors.ink2 },
            l.kind === "del" && styles.removed,
          ]}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
          {l.text || " "}
        </RNText>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  diff: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  lines: { paddingVertical: 8 },
  line: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  // Every line and block 12 from the edge, its bar (when it has one) on the edge.
  edge: { paddingLeft: 9, paddingRight: 12, borderLeftWidth: 3, borderLeftColor: "transparent" },
  block: { paddingVertical: 8 },
  fold: { paddingVertical: 4, paddingHorizontal: 12 },
  removed: { textDecorationLine: "line-through" },
});
