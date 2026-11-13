import { describe, expect, test } from "bun:test";
import { CHAT_RHYTHM, CHAT_STYLES } from "@agenteschat/client/lib/chat-look";
import { rowFrame } from "../../src/features/chat/logic";

const read = (rel: string) => Bun.file(new URL(`../../src/features/${rel}`, import.meta.url).pathname).text();

/** The style's body in a sheet: from its key to the next key at its depth. */
const styleOf = (sheet: string, key: string) => {
  const at = sheet.search(new RegExp(`^  ${key}: \\{`, "m"));
  expect(at).toBeGreaterThanOrEqual(0);
  const end = sheet.indexOf("\n  }", at);
  const line = sheet.indexOf("\n", at);
  return sheet.slice(at, sheet.slice(at, line).trimEnd().endsWith("{") ? end : line);
};

describe("one rhythm, the web's numbers (chat-rhythm-css.test.ts holds them to the sheet)", () => {
  test("from what shows to what shows: a row gives its plate's room back, whatever stands next to it", () => {
    for (const style of CHAT_STYLES) {
      const { part, turn, block } = CHAT_RHYTHM[style];
      for (const gap of [part, turn]) {
        const above = rowFrame(block, turn);
        const row = rowFrame(block, gap);
        // Row under a row: the plate under the first, its given-back room, the second's top and its plate.
        expect(above.paddingVertical + above.marginBottom + row.marginTop + row.paddingVertical).toBe(gap);
        // Row under a line, which has no plate.
        expect(row.marginTop + row.paddingVertical).toBe(gap);
        // A line under a row, at `gap`: the row ends on what shows.
        expect(above.paddingVertical + above.marginBottom).toBe(0);
      }
    }
  });

  test("the rows take their room from it, the parts from the body's gap, none from a margin of its own", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("rowFrame(rhythm.block, rowGap)");
    expect(row).toContain("quoteAbove && styles.replied");
    expect(row).toContain("[styles.body, { gap: rhythm.part }]");
    expect(row).toContain("[styles.meParts, { gap: rhythm.part }]");
    const parts: [string, string[]][] = [
      ["chat/MessageRow.tsx", ["msg", "me", "status", "stopped", "talkMore", "reacts"]],
      ["chat/look.ts", ["bubblesRow", "compactRow"]],
      ["chat/ToolCalls.tsx", ["block", "steps"]],
      ["chat/Receipts.tsx", ["one", "group"]],
      ["chat/TeamChecks.tsx", ["list"]],
      ["chat/ReachLines.tsx", ["list"]],
      ["chat/WorkLine.tsx", ["line"]],
      ["chat/ChatMedia.tsx", ["wrap", "sticker"]],
      ["chat/issue-work.tsx", ["card"]],
      ["browser/TrailCard.tsx", ["card"]],
      ["voice/VoiceMessage.tsx", ["box"]],
      ["ai/UsagePauseCard.tsx", ["acts"]],
      ["chat/asks.tsx", ["done"]],
      ["chat/EventLine.tsx", ["line"]],
      ["chat/StoppedLine.tsx", ["line"]],
      ["chat/issue-work.tsx", ["line"]],
      ["agents/ProposalCard.tsx", ["card"]],
      ["agents/InstructionProposalCard.tsx", ["card"]],
      ["missions/cards.tsx", ["mcard", "askcard", "inv"]],
    ];
    expect(styleOf(row, "msg")).not.toContain("paddingVertical");
    expect(styleOf(row, "me")).not.toContain("paddingVertical");
    for (const [file, keys] of parts) {
      const sheet = await read(file);
      for (const key of keys) expect(styleOf(sheet, key)).not.toMatch(/margin(Top|Bottom|Vertical)/);
    }
  });

  test("a card under a message stands the card gap off it, in its row or in one of its own", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("cardRow ? rhythm.card : rhythm.part");
    expect(row).toContain("const cardTop = body || media ? rhythm.card - rhythm.part : 0;");
    expect(row.match(/<RowPartContext.Provider value=\{cardTop\}>/g)).toHaveLength(2);
    for (const file of [
      "chat/asks.tsx",
      "chat/issue-work.tsx",
      "chat/WorkLine.tsx",
      "chat/Receipts.tsx",
      "chat/TeamChecks.tsx",
      "chat/ReachLines.tsx",
      "missions/cards.tsx",
      "browser/TrailCard.tsx",
      "agents/ProposalCard.tsx",
      "agents/InstructionProposalCard.tsx",
      "right-hand/TeamWeekCard.tsx",
    ]) {
      expect(await read(file)).toContain("useCardTop(");
    }
  });

  test("an event pill is a part: the body sets its top, the list its row's, and none sets one of its own", async () => {
    const asks = await read("chat/asks.tsx");
    // Decided and waiting alike; a pill alone (a mission's screen) keeps the part's 8.
    expect(asks.match(/const ownTop = useOwnTop\(8\);/g)).toHaveLength(2);
    expect(asks.match(/style=\{\[styles\.done, ownTop\]\}/g)).toHaveLength(2);
    for (const file of ["ai/NoAiCard.tsx", "ai/OfferCard.tsx", "ai/StretchCard.tsx", "ai/CostlyProposalCard.tsx"]) {
      const sheet = await read(file);
      expect(sheet).toMatch(/<Ask(Waiting|Done)/);
      expect(sheet).not.toMatch(/margin(Top|Bottom|Vertical)/);
    }
    expect(await read("chat/StoppedLine.tsx")).not.toContain("inRow");
    for (const file of ["chat/EventLine.tsx", "chat/StoppedLine.tsx", "chat/issue-work.tsx"])
      expect(await read(file)).toContain("[styles.line, { paddingLeft: inset, marginTop: gap }]");
  });

  test("what stacks inside a row's words takes the part gap too", async () => {
    const row = await read("chat/MessageRow.tsx");
    // The line it opened with and an unfolded report, outside a bubble, stand a part from the words under them.
    expect(row).toContain("opener && words ? <View style={{ marginBottom: rhythm.part }}>{opener}</View> : opener");
    expect(row).toContain("(inBubble || opener || words) && { marginBottom: rhythm.part }");
    expect(styleOf(row, "report")).not.toContain("marginBottom");
    // A pin's caption stays on its words on either side: the body's gap is paid back on my rows.
    expect(styleOf(row, "pinLine")).not.toContain("marginBottom");
    expect(row).toContain("marginBottom: PIN_GAP - rhythm.part");
    // A row under its quote keeps its plate off the quote.
    expect(styleOf(row, "replied")).toContain("marginTop: 0");
  });

  test("the agents' line runs across the conversation, the pair on its middle, under the list's gap", async () => {
    const group = await read("chat/ConsultGroup.tsx");
    expect(group).toContain("marginTop: gap ?? rhythm.turn");
    expect(group.match(/<View style=\{\[styles\.rule/g)).toHaveLength(2);
    expect(styleOf(group, "rule")).toContain("flex: 1");
    expect(group).not.toContain("marginBottom: -6");
    // Inside a message, between turns too: the body's part gap and the line's own room make the turn's.
    expect(group).toContain("marginTop: gap ?? rhythm.turn - rhythm.part,");
    expect(group).toContain("marginBottom: rhythm.turn - rhythm.part,");
    // Two in a row stack at the part gap, as the list's quiet lines: the room under the first, the list's gap and the
    // second's margin add up to it.
    const reach = await read("chat/ReachLines.tsx");
    expect(reach).toContain("list: { gap: LIST_GAP }");
    expect(reach).toContain("gap={talkAbove ? rhythm.part - (rhythm.turn - rhythm.part) - LIST_GAP : undefined}");
  });
});

describe("the long work's card", () => {
  test("one row of at most three actions; sharing with everyone is in the task's menu", async () => {
    const line = await read("chat/WorkLine.tsx");
    expect(line).toContain("const MAX_ACTIONS = 3;");
    expect(line).toContain(".slice(0, MAX_ACTIONS)");
    expect(line).not.toContain("ShareAction");
    expect(line).toContain("export function useShareWork(");
    const screen = await read("issues/IssueScreen.tsx");
    expect(screen).toContain("const shareWork = useShareWork(i);");
    expect(screen).toContain('label: t("work.shareEveryone")');
    // On the task's screen it stands on the screen's margin and card gap, under the work card.
    expect(screen).toContain("<IssueWorkLine issue={i} style={styles.section} />");
    expect(screen).toContain("section: { marginHorizontal: 16, marginTop: 12 },");
  });
});
