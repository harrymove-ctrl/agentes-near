import { parseChart } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { ChartCard } from "./ChartCard";
import { CodeCard } from "./CodeCard";
import { CHAT_TEXT_MAX_SCALE, type Inline, parseBlocks } from "./logic";
import { useRowLook } from "./look";
import { Spans, Table } from "./MessageSpans";

/**
 * A message's text: paragraphs, lists, quotes, headings, bold, italic,
 * @mentions and code (mono only for code).
 */
export const MessageText = memo(function MessageText({
  body,
  muted = false,
  selectable = true,
  accent,
  channelRefs,
  everyone = false,
  ink,
  small = false,
}: {
  body: string;
  muted?: boolean;
  /**
   * false in chat rows: a long press there opens the message sheet (which has "Copiar texto"), and native
   * selection would float iOS's own "Copiar" bubble over it.
   */
  selectable?: boolean;
  /** The writing agent's color: its charts take its tones. */
  accent?: AgentColorName;
  /** The message's `meta.channelRefs`: the channel each `#name` meant when written. */
  channelRefs?: Record<string, string>;
  /** The message's `meta.mentionsEveryone`: its `@todos` shows in the reader's language, like a mention of them. */
  everyone?: boolean;
  /** Over a solid bubble: the words' color in place of the page's. */
  ink?: string;
  /** On a page, under a title: a step smaller than a conversation's words. */
  small?: boolean;
}) {
  const c = useColors();
  const look = useRowLook();
  const blocks = useMemo(() => parseBlocks(body), [body]);
  const inked = ink ? { color: ink } : undefined;
  const variant = small ? "footnote" : "body";
  // In a conversation, the person's Tamanho do texto, which the system's text size grows up to its cap.
  const sized = small ? null : look.text;
  const line = small ? undefined : (sized ?? styles.line);
  const fit = sized ? { maxFontSizeMultiplier: CHAT_TEXT_MAX_SCALE } : {};
  const spans = (inline: Inline[]) => <Spans inline={inline} channelRefs={channelRefs} everyone={everyone} ink={ink} />;
  const tone = muted ? "muted" : "ink";
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
            return <Fenced key={i} lang={b.lang} text={b.text} accent={accent} />;
          case "table":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={ink ? [styles.cut, { backgroundColor: c.bg }] : undefined}>
                <Table header={b.header} rows={b.rows} align={b.align} />
              </View>
            );
          case "heading":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant={variant} tone="ink" style={[line, styles.heading, inked]} {...fit}>
                {spans(b.inline)}
              </Text>
            );
          case "bullet":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={styles.bullet}>
                <Text variant={variant} tone="faint" style={[line, styles.mark, inked]} {...fit}>
                  {b.ordinal ? `${b.ordinal}.` : "•"}
                </Text>
                <Text variant={variant} tone={tone} style={[line, styles.flex, inked]} {...fit}>
                  {spans(b.inline)}
                </Text>
              </View>
            );
          case "details":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={ink ? [styles.cut, { backgroundColor: c.bg }] : undefined}>
                <Details summary={b.summary} body={b.body} muted={muted} accent={accent} channelRefs={channelRefs} />
              </View>
            );
          case "quote":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[styles.quote, { borderLeftColor: ink ?? c.line2 ?? c.line }]}>
                <Text variant={variant} tone="muted" style={[line, inked]} {...fit}>
                  {spans(b.inline)}
                </Text>
              </View>
            );
          default:
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant={variant} tone={tone} style={[line, inked]} selectable={selectable} {...fit}>
                {spans(b.inline)}
              </Text>
            );
        }
      })}
    </View>
  );
});

/** A fenced block: a ```chart that reads as one is drawn; anything else is a code card. */
function Fenced({ lang, text, accent }: { lang: string; text: string; accent?: AgentColorName }) {
  const isChart = lang.toLowerCase() === "chart";
  const chart = useMemo(() => (isChart ? parseChart(text) : null), [isChart, text]);
  if (chart) return <ChartCard spec={chart} {...(accent ? { accent } : {})} />;
  return <CodeCard lang={isChart ? "json" : lang} text={text} />;
}

/** A collapsed block (`<details>`, ADR 0147): its summary opens what only some want to read. */
function Details({
  summary,
  body,
  muted,
  accent,
  channelRefs,
}: {
  summary: Inline[];
  body: string;
  muted: boolean;
  accent?: AgentColorName;
  channelRefs?: Record<string, string>;
}) {
  const c = useColors();
  const sized = useRowLook().text;
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.details, { borderColor: c.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          setOpen((v) => !v);
        }}
        style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
      >
        <Text
          variant="body"
          tone="muted"
          style={[sized ?? styles.line, styles.flex, styles.heading]}
          {...(sized ? { maxFontSizeMultiplier: CHAT_TEXT_MAX_SCALE } : {})}
        >
          {summary.length > 0 ? <Spans inline={summary} channelRefs={channelRefs} /> : "…"}
        </Text>
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={15} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <MessageText
          body={body}
          muted={muted}
          {...(accent ? { accent } : {})}
          {...(channelRefs ? { channelRefs } : {})}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 1 },
  /** Outside a conversation (a task's text, a document): the body's size on a line of ~1.42. */
  line: { lineHeight: 24 },
  flex: { flex: 1 },
  heading: { fontWeight: "700" },
  bullet: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  mark: { minWidth: 14 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  /** On a solid bubble: a table or a collapsed block stays on the page's color, in the page's ink. */
  cut: { borderRadius: 10, overflow: "hidden" },
  details: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  summary: { flexDirection: "row", alignItems: "center", gap: 8 },
  pressed: { opacity: 0.6 },
  flip: { transform: [{ rotate: "180deg" }] },
});
