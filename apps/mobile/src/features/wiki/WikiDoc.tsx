import type { WikiPageSummary } from "@agenteschat/client";
import { resolveWikiLink } from "@agenteschat/client/lib/wiki";
import { memo, useMemo } from "react";
import { Pressable, Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { parseInline } from "../chat/logic";
import { Spans, Table } from "../chat/MessageSpans";
import { useColors } from "../shared/hooks";
import { MONO, tapHaptic } from "../shared/parts";
import { type DocBlock, type DocRun, docBlocks } from "./logic";

/**
 * A page as it reads: headings, paragraphs, lists, quotes, code, tables and rules, with the chat's marks; a
 * `[[link]]` to a page that exists in the accent (it opens), to one that doesn't yet dashed (it creates); tasks
 * check with a tap when the person may edit (`onToggleTask`, the task's line in the text).
 */
export const WikiDoc = memo(function WikiDoc({
  body,
  pages,
  onOpenLink,
  onToggleTask,
}: {
  body: string;
  /** Every page, to tell links that exist from those that don't. */
  pages: WikiPageSummary[];
  onOpenLink: (title: string, page: WikiPageSummary | undefined) => void;
  onToggleTask?: ((line: number) => void) | undefined;
}) {
  const blocks = useMemo(() => docBlocks(body), [body]);
  return (
    <View style={styles.doc}>
      {blocks.map((b, i) => (
        // Blocks have no ids; their order is the text's.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <Block key={i} block={b} pages={pages} onOpenLink={onOpenLink} onToggleTask={onToggleTask} />
      ))}
    </View>
  );
});

function Block({
  block: b,
  pages,
  onOpenLink,
  onToggleTask,
}: {
  block: DocBlock;
  pages: WikiPageSummary[];
  onOpenLink: (title: string, page: WikiPageSummary | undefined) => void;
  onToggleTask?: ((line: number) => void) | undefined;
}) {
  const c = useColors();
  const runs = (r: DocRun[]) => <Runs runs={r} pages={pages} onOpenLink={onOpenLink} />;
  switch (b.kind) {
    case "heading":
      return (
        <Text variant={b.level <= 2 ? "title2" : "title"} accessibilityRole="header" style={styles.heading}>
          {runs(b.runs)}
        </Text>
      );
    case "paragraph":
      return (
        <Text variant="body" tone="ink2" selectable>
          {runs(b.runs)}
        </Text>
      );
    case "bullet":
      return (
        <View style={styles.item}>
          <Text variant="body" tone="faint" style={styles.mark}>
            {b.ordinal ? `${b.ordinal}.` : "•"}
          </Text>
          <Text variant="body" tone="ink2" style={styles.grow} selectable>
            {runs(b.runs)}
          </Text>
        </View>
      );
    case "task":
      return (
        <View style={styles.item}>
          <Pressable
            onPress={
              onToggleTask
                ? () => {
                    tapHaptic();
                    onToggleTask(b.line);
                  }
                : undefined
            }
            disabled={!onToggleTask}
            hitSlop={10}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: b.done, disabled: !onToggleTask }}
            // Ink, as a task's criteria check: blue is the agents' color, and a fixed white broke on dark.
            style={({ pressed }) => [
              styles.box,
              b.done ? { backgroundColor: c.ink } : { borderWidth: 1.5, borderColor: c.line2 },
              pressed && styles.pressed,
            ]}
          >
            {b.done ? <Icon name="check" size={13} color={c.bg} /> : null}
          </Pressable>
          <Text variant="body" tone={b.done ? "muted" : "ink2"} style={styles.grow} selectable>
            {runs(b.runs)}
          </Text>
        </View>
      );
    case "quote":
      return (
        <View style={[styles.quote, { borderLeftColor: c.line2 }]}>
          <Text variant="body" tone="muted" selectable>
            {runs(b.runs)}
          </Text>
        </View>
      );
    case "code":
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.code, { backgroundColor: c.sunken }]}
        >
          <Text selectable style={[styles.mono, { color: c.ink2 }]}>
            {b.text}
          </Text>
        </ScrollView>
      );
    case "table":
      return (
        <Table
          header={b.header.map((cell) => parseInline(cell))}
          rows={b.rows.map((row) => row.map((cell) => parseInline(cell)))}
          align={b.align}
        />
      );
    case "rule":
      return <View style={[styles.rule, { backgroundColor: c.line2 }]} />;
  }
}

/** A line's runs: words with the chat's marks, links pressable inline. */
function Runs({
  runs,
  pages,
  onOpenLink,
}: {
  runs: DocRun[];
  pages: WikiPageSummary[];
  onOpenLink: (title: string, page: WikiPageSummary | undefined) => void;
}) {
  const c = useColors();
  return (
    <>
      {runs.map((r, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
        if (r.kind === "text") return <Spans key={i} inline={parseInline(r.text)} />;
        const page = resolveWikiLink(pages, r.title);
        return (
          <RNText
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
            key={i}
            accessibilityRole="link"
            onPress={() => onOpenLink(r.title, page)}
            style={
              page
                ? [styles.link, { color: c.agent }]
                : [styles.missing, { color: c.faint, textDecorationColor: c.faint }]
            }
          >
            {r.label}
          </RNText>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  // 12 between blocks, 24 over a heading (its 12 on the gap), so a section starts as one group with its text.
  doc: { gap: 12 },
  heading: { marginTop: 12 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  mark: { minWidth: 14 },
  grow: { flex: 1, minWidth: 0 },
  box: { width: 20, height: 20, borderRadius: 6, marginTop: 2, alignItems: "center", justifyContent: "center" },
  quote: { borderLeftWidth: 3, paddingLeft: 12 },
  // As a diff's block (`DiffView`).
  code: { borderRadius: 14, padding: 12 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  mono: { fontFamily: MONO, fontSize: 14, lineHeight: 20 },
  link: { fontWeight: "500" },
  missing: { textDecorationLine: "underline", textDecorationStyle: "dashed" },
  pressed: { opacity: 0.6 },
});
