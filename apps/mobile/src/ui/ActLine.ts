import { StyleSheet } from "react-native";

/** Narrower than this beside an action, words would be a sliver (about 24 characters of the small text). */
export const ACT_TEXT_MIN = 170;

/**
 * Words and their actions (a team check and Abrir, an approval and its buttons, a header and its way on), as the web
 * kit's `.ac-actline`: one row that wraps, the words growing from their own one-line width, so the actions sit beside
 * them only while the words fit on one line there, else on a row of their own under them, from the words' start. A
 * lead icon and a close × stay outside it: in it, wrapped words would drop under the icon. `row` on the line, `text`
 * on the words; the line keeps its own gap.
 */
export const ACT_LINE = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-start" },
  text: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
});
