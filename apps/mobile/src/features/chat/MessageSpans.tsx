import { everyoneWord, isEveryoneWord } from "@agenteschat/client/lib/everyone";
import { linkPill } from "@agenteschat/client/lib/link-pills";
import { parseFileLink, parseMessageLink } from "@agenteschat/client/lib/message-links";
import { LinearGradient } from "expo-linear-gradient";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { ScrollView as GestureScrollView } from "react-native-gesture-handler";
import { serverUrl } from "@/lib/server";
import { Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { withAlpha } from "@/ui/palette";
import { variantStyle } from "@/ui/Text";
import { openPage } from "../ai/parts";
import { ownLinkHref } from "../links/app-links";
import { useColors, useDirectory, useMyHandle } from "../shared/hooks";
import { MONO } from "../shared/parts";
import { ChannelRefText } from "./ChannelRefText";
import { FileRefText } from "./FileRefText";
import { IdRefText } from "./IdRefText";
import { LinkPillText } from "./LinkPillText";
import {
  type Block,
  CHAT_TEXT_MAX_SCALE,
  chatCellOf,
  chatCodeOf,
  type Inline,
  mentionTint,
  tableColumnWidths,
  tableHidden,
} from "./logic";
import { useRowLook } from "./look";
import { MessageRefText } from "./MessageRefText";

/**
 * Inline marks of a message (bold, italic, `code`, links, a message's or a file's link as its pill, an internal id as
 * what it names, @mentions, #channels), inside a Text. `channelRefs`: the
 * message's `meta.channelRefs` (a renamed channel still links).
 */
export function Spans({
  inline,
  channelRefs,
  everyone = false,
  ink,
}: {
  inline: Inline[];
  channelRefs?: Record<string, string>;
  /** The message mentions everyone (`meta.mentionsEveryone`): its word shows in the reader's language. */
  everyone?: boolean;
  /** Over a solid bubble: a mention's color and plate in place of its own. */
  ink?: string | undefined;
}) {
  const c = useColors();
  const myHandle = useMyHandle();
  const { i18n } = useTranslation();
  const { agents, memberByHandle } = useDirectory();
  const { scheme } = useTheme();
  // In a conversation, the size of code in its card (`chatCodeOf`), so inline and fenced code agree at every step.
  const sized = useRowLook().text;
  const codeSize = sized ? { fontSize: chatCodeOf(sized).fontSize } : undefined;
  return (
    <>
      {inline.map((s, i) => {
        const key = `${i}-${s.kind}`;
        switch (s.kind) {
          case "bold":
            return (
              <RNText key={key} style={styles.bold}>
                {s.text}
              </RNText>
            );
          case "italic":
            return (
              <RNText key={key} style={styles.italic}>
                {s.text}
              </RNText>
            );
          case "code":
            return (
              <RNText key={key} style={[styles.inlineCode, codeSize, { backgroundColor: c.sunken, color: c.ink2 }]}>
                {s.text}
              </RNText>
            );
          case "link": {
            // A message or a file here: its pill, opening it in the app.
            const message = parseMessageLink(s.href, [serverUrl()]);
            if (message) return <MessageRefText key={key} link={message} />;
            const file = parseFileLink(s.href, [serverUrl()]);
            if (file) return <FileRefText key={key} link={file} />;
            // An address as written, whatever way: the words of a link written with its own stay.
            const pill = s.text === s.href ? linkPill(s.href) : null;
            if (pill) return <LinkPillText key={key} href={s.href} pill={pill} />;
            // A page of this server opens its screen here; any other site the in-app browser. A press on a link wins
            // over the row's long press.
            const own = ownLinkHref(s.href, serverUrl());
            return (
              <RNText
                key={key}
                accessibilityRole="link"
                onPress={() => (own ? router.push(own as never) : openPage(s.href))}
                style={styles.link}
              >
                {s.text}
              </RNText>
            );
          }
          case "channel":
            return <ChannelRefText key={key} name={s.name} text={s.text} refs={channelRefs} />;
          case "id": {
            const shown = (
              <RNText
                key={key}
                style={s.code ? [styles.inlineCode, { backgroundColor: c.sunken, color: c.ink2 }] : undefined}
              >
                {s.text}
              </RNText>
            );
            return <IdRefText key={key} id={s.id} shown={shown} />;
          }
          case "mention": {
            const handle = s.text.slice(1);
            const all = everyone && isEveryoneWord(handle);
            const tint = mentionTint(handle, agents, scheme);
            if (!all && !tint && !memberByHandle.has(handle.toLowerCase())) return <RNText key={key}>{s.text}</RNText>;
            return (
              <RNText
                key={key}
                style={[
                  styles.bold,
                  ink
                    ? { color: ink, backgroundColor: "rgba(0,0,0,0.16)" }
                    : all || handle.toLowerCase() === myHandle
                      ? { color: c.amber, backgroundColor: `${c.amber}2e` }
                      : (tint ?? { color: c.ink }),
                ]}
              >
                {all ? `@${everyoneWord(i18n.language)}` : s.text}
              </RNText>
            );
          }
          default:
            return <RNText key={key}>{s.text}</RNText>;
        }
      })}
    </>
  );
}

type TableBlock = Extract<Block, { kind: "table" }>;

/**
 * A table (the web's `md__table`): a quiet box with a hairline, the header on a soft band, rows split by
 * hairlines, numbers on the right in tabular figures. Each column is as wide as its widest cell as drawn (measured
 * on an unseen copy that never wraps, since a guess by letters came out narrow and broke words), up to a max that
 * grows with the text size (`tableColumnWidths`); a table wider than the message scrolls sideways inside its box,
 * its hidden side fading out at the edge, and the scroll bar flashes once when it first shows there is more.
 * `surface`: the color under the table (the fade's), the chat's background unless said.
 */
export function Table({
  header,
  rows,
  align,
  surface,
}: Pick<TableBlock, "header" | "rows" | "align"> & { surface?: string }) {
  const c = useColors();
  const { fontScale } = useWindowDimensions();
  const [drawn, setDrawn] = useState<Record<number, number>>({});
  const [frame, setFrame] = useState(0);
  const [x, setX] = useState(0);
  const scroller = useRef<ComponentRef<typeof GestureScrollView>>(null);
  const flashed = useRef(false);
  const widths = tableColumnWidths(header, rows, drawn, fontScale);
  // The content's width said outright (not left to layout), so the box always knows it has more to scroll.
  const total = widths.reduce((sum, w) => sum + w, 0);
  const hidden = tableHidden(x, frame, total);
  // A table wider than the message says so once: the system's scroll bar flashes, then the fade keeps saying it.
  useEffect(() => {
    if (flashed.current || !hidden.right) return;
    flashed.current = true;
    scroller.current?.flashScrollIndicators();
  }, [hidden.right]);
  const fadeTo = surface ?? c.bg;
  // In a conversation the cells follow the person's Tamanho do texto, as the words around the table do.
  const sized = useRowLook().text;
  const words = (inline: Inline[], col: number, head: boolean) => (
    <Text
      variant={head ? "label" : "subhead"}
      tone={head ? "muted" : "ink"}
      style={[
        styles.cellText,
        sized ? chatCellOf(variantStyle(head ? "label" : "subhead"), sized) : null,
        { textAlign: align[col] ?? "left" },
      ]}
      maxFontSizeMultiplier={sized ? CHAT_TEXT_MAX_SCALE : undefined}
    >
      <Spans inline={inline} />
    </Text>
  );
  const cell = (inline: Inline[], col: number, head: boolean) => (
    <View key={col} style={[styles.cell, { width: widths[col] }]}>
      {words(inline, col, head)}
    </View>
  );
  return (
    <View>
      {/* Each column's cells unseen, on a sideways strip with no width to wrap them: their widths. */}
      <View
        pointerEvents="none"
        style={styles.measure}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
          {header.map((h, col) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the columns of one table, in order
              key={col}
              onLayout={(e) => {
                const w = e.nativeEvent.layout.width;
                setDrawn((d) => (d[col] === w ? d : { ...d, [col]: w }));
              }}
            >
              {[h, ...rows.map((r) => r[col] ?? [])].map((inline, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one column, in order
                <View key={j} style={styles.cell}>
                  {words(inline, col, j === 0)}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
      {/* The message's long-press (select) is a Pressable around the whole row: the table takes its own touches so a
          sideways drag scrolls it instead of starting the press, and its scroller is the gesture handler's (native
          gesture first, ahead of the row's JS responder). Long-press elsewhere on the message still selects it. */}
      <View
        style={[styles.table, { borderColor: c.line2 ?? c.line }]}
        onStartShouldSetResponder={() => true}
        onResponderTerminationRequest={() => true}
      >
        <GestureScrollView
          ref={scroller}
          horizontal
          directionalLockEnabled
          nestedScrollEnabled
          alwaysBounceHorizontal={false}
          showsHorizontalScrollIndicator
          scrollEventThrottle={16}
          onLayout={(e) => setFrame(e.nativeEvent.layout.width)}
          onScroll={(e) => setX(e.nativeEvent.contentOffset.x)}
          contentContainerStyle={{ width: total }}
        >
          <View style={{ width: total }}>
            <View style={[styles.tr, { backgroundColor: c.plate }]}>{header.map((h, col) => cell(h, col, true))}</View>
            {rows.map((r, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one table, in order
              <View key={j} style={[styles.tr, { borderTopColor: c.line }, styles.trLine]}>
                {header.map((_, col) => cell(r[col] ?? [], col, false))}
              </View>
            ))}
          </View>
        </GestureScrollView>
        {hidden.left ? (
          <LinearGradient
            pointerEvents="none"
            colors={[fadeTo, withAlpha(fadeTo, 0)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.fade, styles.fadeLeft]}
          />
        ) : null}
        {hidden.right ? (
          <LinearGradient
            pointerEvents="none"
            colors={[withAlpha(fadeTo, 0), fadeTo]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.fade, styles.fadeRight]}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  table: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  fade: { position: "absolute", top: 0, bottom: 0, width: 28 },
  fadeLeft: { left: 0 },
  fadeRight: { right: 0 },
  measure: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
  tr: { flexDirection: "row" },
  trLine: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 12, paddingVertical: 8 },
  cellText: { fontVariant: ["tabular-nums"] },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  link: { textDecorationLine: "underline" },
  inlineCode: { fontFamily: MONO, fontSize: 15 },
});
