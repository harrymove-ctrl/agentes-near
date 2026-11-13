import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { MEDIA_ROW, type MediaRowSize, mediaRowAxis } from "./media-row";
import { Text, type TextTone, textLineOf } from "./Text";
import { useFontScale } from "./text-scale";
import { weights } from "./type-scale";

export interface MediaRowProps {
  /** The face, `MEDIA_ROW[size].face` square: an agent, a person, a maker's tile. */
  face: ReactNode;
  name: string;
  /** What it is, muted, after the name on its line (a role, "#129 · há 6 min"). */
  meta?: string;
  /** At the end of the name's line: a time, a count, an icon's control. A labelled action goes under, never beside. */
  end?: ReactNode;
  /** Under the name's line, at the row's full width, 8 apart. */
  children?: ReactNode;
  /** `card` (face 32) in a card's head, `row` (face 24) in a list. */
  size?: MediaRowSize;
  /** A quieter name (a step done, or waiting on another): in this tone, at the text's own weight. */
  quiet?: TextTone;
}

/** A face, the name and what it is on one line, and the rest under them at full width (the web's MediaRow). */
export function MediaRow({ face, name, meta, end, children, size = "card", quiet }: MediaRowProps) {
  const { face: side, gap } = MEDIA_ROW[size];
  const axis = mediaRowAxis(side, textLineOf("subhead", useFontScale()));
  return (
    <View style={styles.row}>
      <View style={[styles.head, { gap }]}>
        <View style={{ width: side, height: side, marginTop: axis.face }}>{face}</View>
        <Text variant="subhead" style={[styles.words, { paddingTop: axis.words }]}>
          <Text variant="subhead" tone={quiet} style={quiet ? undefined : styles.name}>
            {name}
          </Text>
          {meta ? (
            <Text variant="footnote" tone="muted">
              {` ${meta}`}
            </Text>
          ) : null}
        </Text>
        {end ? <View style={[styles.end, { height: side, marginTop: axis.face }]}>{end}</View> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: MEDIA_ROW.under },
  head: { flexDirection: "row", alignItems: "flex-start" },
  // As tall as the face, what ends the line centred on it: a taller control reaches as far above as below.
  end: { justifyContent: "center" },
  words: { flex: 1, minWidth: 0 },
  name: { fontWeight: weights.semibold },
});
