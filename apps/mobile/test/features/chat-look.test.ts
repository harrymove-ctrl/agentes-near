import { describe, expect, test } from "bun:test";
import {
  CHAT_TEXT_SIZES,
  chatLookOf,
  facesShown,
  mineOnRight,
  openAtOf,
  textSizeOf,
} from "@agenteschat/client/lib/chat-look";
import { AGENT_GRADIENTS, type AgentColorName, contrastOf, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import {
  BUBBLES_INSET,
  bubbleFill,
  CHAT_TEXT,
  CHAT_TEXT_MAX_SCALE,
  chatCellOf,
  chatCodeOf,
  chatNameOf,
  chatTimeOf,
  MSG_INSET,
  MSG_TEXT,
  nameInk,
  quietInset,
  ROW_BODY_INSET,
  rowBodyInset,
} from "../../src/features/chat/logic";
import { appColors } from "../../src/ui/palette";
import { typeScale } from "../../src/ui/type-scale";

const read = (rel: string) => Bun.file(new URL(`../../src/features/${rel}`, import.meta.url).pathname).text();

describe("the bubbles' colors", () => {
  test("light is a tint of the agent's deep color on the page, stronger on a dark page; strong is the color darkened", () => {
    const deep = gradientOf("green")[1];
    expect(bubbleFill("green", "light", "#ffffff", false)).toBe(mixHex("#ffffff", deep, 0.2));
    expect(bubbleFill("green", "light", "#111110", true)).toBe(mixHex("#111110", deep, 0.3));
    expect(bubbleFill("green", "strong", "#ffffff", false)).toBe(mixHex(deep, "#000000", 0.18));
  });

  const colors = [...Object.keys(AGENT_GRADIENTS), "#ffff00", "#00ffff", "#ffffff"] as AgentColorName[];

  test("every color: white on the strong bubble is AA", () => {
    for (const color of colors) {
      expect(contrastOf("#ffffff", bubbleFill(color, "strong", "#ffffff", false))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("every color: a name is AA on the bubble of both themes", () => {
    for (const color of colors) {
      expect(contrastOf(nameInk(color, false), appColors("light").bubble)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(nameInk(color, true), appColors("dark").bubble)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the rows follow the same choice as the web", () => {
  test("defaults: channels on the left, DMs in bubbles", () => {
    expect(chatLookOf(undefined, false).style).toBe("left");
    expect(chatLookOf(undefined, true).style).toBe("bubbles");
    expect(mineOnRight("left")).toBe(false);
  });

  test("a personal workspace opens every conversation in bubbles; the person's choice wins (ADR 0159)", async () => {
    expect(chatLookOf(undefined, false, true).style).toBe("bubbles");
    expect(chatLookOf(undefined, true, true).style).toBe("bubbles");
    expect(chatLookOf({ channelStyle: "compact" }, false, true).style).toBe("compact");
    // Every conversation and the preview read the workspace's mode.
    expect(await read("chat/look.ts")).toContain("chatLookOf(org?.chatPrefs, dm, isPersonal(org))");
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("chatLookOf(prefs, dm, isPersonal(org))");
    // Its channels are its group conversations: the tab and the tone's header say so.
    expect(page).toContain('label: t(modeKey(org, "settings.account.chat.channels"))');
    expect(page).toContain('modeKey(org, "settings.account.chat.toneChannels")');
  });

  test("my row reads the conversation's look", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("const onRight = mine && mineOnRight(look.style);");
    expect(row).toContain("if (onRight) {");
    const chat = await read("chat/ChatScreen.tsx");
    expect(chat).toContain("<RowLookContext.Provider value={rowLook}>");
    expect(chat).toContain('Boolean(dm) || thread.data?.channelKind === "dm"');
  });

  test("a DM drops the name only where a bubble stands: a card alone keeps it ahead of its time", async () => {
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("{!inBubble || look.names ? (");
    expect(row).not.toContain("{!bubbled || look.names ? (");
  });

  test("opening at the last read message goes to the line, once, with no glide", async () => {
    const chat = await read("chat/ChatScreen.tsx");
    expect(chat).toContain("firstUnreadId(list, from.at, meId)");
    expect(chat).toContain("holdAt(id ?? undefined, 0, false);");
  });

  test("a DM whose sides say who spoke has no face: its bodies and quiet rows start at the rows' own padding", () => {
    const dm = (style: "comfortable" | "bubbles") => ({ style, faces: facesShown(style, true) });
    expect(rowBodyInset(dm("bubbles"))).toEqual({ left: BUBBLES_INSET, right: ROW_BODY_INSET.bubbles.right });
    expect(rowBodyInset(dm("comfortable"))).toEqual({ left: MSG_INSET, right: ROW_BODY_INSET.comfortable.right });
    expect(quietInset(dm("bubbles"))).toBe(BUBBLES_INSET);
    expect(quietInset(dm("comfortable"))).toBe(MSG_INSET);
    // A channel, and a DM in a look with everyone on the left, keep the face and the words' column.
    for (const style of ["comfortable", "bubbles", "left", "compact"] as const) {
      expect(rowBodyInset({ style, faces: facesShown(style, false) })).toEqual(ROW_BODY_INSET[style]);
      expect(quietInset({ style, faces: facesShown(style, false) })).toBe(MSG_TEXT);
    }
    expect(quietInset({ style: "left", faces: facesShown("left", true) })).toBe(MSG_TEXT);
  });

  test("the look says it, and every row with a face column and every quiet row reads it", async () => {
    expect(await read("chat/look.ts")).toContain("faces: facesShown(style, dm)");
    expect(await read("chat/look.ts")).toContain("paddingLeft: BUBBLES_INSET");
    expect(await read("chat/MessageRow.tsx")).toContain("{look.faces ? (");
    const queue = await read("queue/parts.tsx");
    expect(queue).toContain("{faces ? (");
    expect(await read("chat/QuoteLine.tsx")).toContain(
      "look.faces ? WORDS_START[look.style] : rowBodyInset(look).left",
    );
    expect(await read("chat/ConsultGroup.tsx")).toContain("const inset = rowBodyInset(useRowLook());");
    expect(await read("chat/ChatScreen.tsx")).toContain("const quiet = quietInset(rowLook);");
    for (const file of [
      "chat/EventLine.tsx",
      "chat/issue-work.tsx",
      "chat/StoppedLine.tsx",
      "chat/AgentReceipts.tsx",
      "queue/parts.tsx",
    ]) {
      const src = await read(file);
      expect(src).toContain("useQuietInset()");
      expect(src).not.toContain("MSG_TEXT");
    }
  });

  test("Conversa's preview draws it as the conversation does", async () => {
    const page = await read("me/ChatLookPage.tsx");
    // One preview, in the look the conversation hands its rows, with the conversation's own words and frames.
    expect(page).toContain("const faced = !right && facesShown(style, dm);");
    expect(page).toContain("<RowLookContext.Provider value={look}>");
    expect(page).toContain("text: CHAT_TEXT[size]");
    expect(page).toContain("<MessageText body={line.text}");
    expect(page).toContain("lookRows.bubblesRow");
  });

  test("Você opens Conversa, which saves on the server", async () => {
    expect(await read("me/MeScreen.tsx")).toContain('onPress={() => open("/me/chat-look")}');
    const page = await read("me/ChatLookPage.tsx");
    expect(page).toContain("useSetChatPrefs(orgId)");
    expect(page).toContain("save(dm ? { dmStyle: s } : { channelStyle: s })");
  });

  test("a conversation opens at the last read message until the person picks the newest, as on the web", async () => {
    expect(openAtOf(undefined)).toBe("read");
    expect(openAtOf({ openAt: "latest" })).toBe("latest");
    expect(await read("me/ChatLookPage.tsx")).toContain("const openAt = openAtOf(prefs);");
    expect(await read("chat/ChatScreen.tsx")).toContain("opensAtLastRead(org?.chatPrefs");
  });
});

describe("Tamanho do texto on the phone", () => {
  /** Points, before the system's own text size: the words and their line. */
  const STEPS = { xs: [13, 18], sm: [15, 21], md: [17, 24], lg: [19, 27], xl: [21, 29] } as const;

  for (const step of CHAT_TEXT_SIZES)
    test(`${step}: the words and their line follow the step, the name a step under them`, () => {
      const [fontSize, lineHeight] = STEPS[step];
      expect(CHAT_TEXT[step]).toEqual({ fontSize, lineHeight });
      expect(chatNameOf(CHAT_TEXT[step])).toEqual({ fontSize: fontSize - 1, lineHeight: lineHeight - 2 });
      expect(lineHeight / fontSize).toBeGreaterThanOrEqual(1.35);
      expect(lineHeight / fontSize).toBeLessThanOrEqual(1.45);
      // The time on the name's line, never bigger than the name; code two points under the words, inline or fenced.
      const time = chatTimeOf(CHAT_TEXT[step]);
      expect(time).toEqual({ fontSize: Math.max(11, fontSize - 2), lineHeight: lineHeight - 2 });
      expect(time.fontSize).toBeLessThan(chatNameOf(CHAT_TEXT[step]).fontSize);
      expect(chatCodeOf(CHAT_TEXT[step])).toEqual({ fontSize: fontSize - 2, lineHeight: lineHeight - 1 });
    });

  test("the default is md: iOS's body on its line, the name a step under it", () => {
    expect(textSizeOf(undefined)).toBe("md");
    const md = CHAT_TEXT.md;
    expect(md).toEqual({ fontSize: typeScale("ios").body.fontSize, lineHeight: 24 });
    expect(chatNameOf(md)).toEqual({ fontSize: 16, lineHeight: 22 });
    const sizes = CHAT_TEXT_SIZES.map((s) => CHAT_TEXT[s].fontSize);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  test("the system's text size still grows the words and the name, up to twice", async () => {
    expect(CHAT_TEXT_MAX_SCALE).toBe(2);
    const words = await read("chat/MessageText.tsx");
    expect(words).toContain("const sized = small ? null : look.text;");
    expect(words).toContain("const fit = sized ? { maxFontSizeMultiplier: CHAT_TEXT_MAX_SCALE } : {};");
    // Outside a conversation (a task's text, a document) the page's own body, as before.
    expect(words).toContain("(sized ?? styles.line)");
    for (const file of ["chat/MessageText.tsx", "chat/MessageRow.tsx", "chat/LiveRows.tsx", "chat/MessageSpans.tsx"])
      expect(await read(file)).not.toContain("allowFontScaling={false}");
    expect(await read("chat/MessageRow.tsx")).toContain(
      "maxFontSizeMultiplier={nameSize ? CHAT_TEXT_MAX_SCALE : undefined}",
    );
  });

  test("every conversation reads the step from its look, and Conversa saves it on the server with a preview", async () => {
    expect(await read("chat/look.ts")).toContain("const text = CHAT_TEXT[textSizeOf(org?.chatPrefs)];");
    expect(await read("chat/look.ts")).toMatch(/ROW_LOOK_DEFAULT: RowLook = \{[^}]*\btext: null,?\s*\}/);
    const page = await read("me/ChatLookPage.tsx");
    // A stepped slider (small A, five steps, big A) the preview follows while it moves; saved when it lands.
    expect(page).toContain("save({ textSize: v })");
    expect(page).toContain("<ChatPreview style={style} tone={tone} size={shownSize} dm={dm} />");
    expect(page).toContain('accessibilityRole="adjustable"');
    expect(page).toContain("accessibilityValue={{ text: labels[value] }}");
    expect(page).toContain("{labels[DEFAULT_TEXT_SIZE]}");
    expect(page).toContain('t("settings.account.chat.textSizePhone")');
  });

  test("the time beside the name and code follow the step, capped as the words", async () => {
    // At the default (iOS's body, 17 on 24): the time and code two points under the words.
    expect(chatTimeOf(CHAT_TEXT.md).fontSize).toBe(15);
    expect(chatCodeOf(CHAT_TEXT.md)).toEqual({ fontSize: 15, lineHeight: 23 });
    // Capped as the name is: an uncapped time grows past the name and the words at the system's largest sizes.
    const row = await read("chat/MessageRow.tsx");
    expect(row).toContain("const timeSize = look.text ? chatTimeOf(look.text) : undefined;");
    expect(row).toContain("maxFontSizeMultiplier={timeSize ? CHAT_TEXT_MAX_SCALE : undefined}");
    // A receipt at the end of someone else's name line centres on that line, as tall as the name's at every step.
    expect(row).toContain("[styles.whoMark, nameSize ? { height: nameSize.lineHeight } : null]");
    const card = await read("chat/CodeCard.tsx");
    expect(card).toContain("sized ? chatCodeOf(sized) : null");
    expect(card).toContain("maxFontSizeMultiplier={sized ? CHAT_TEXT_MAX_SCALE : undefined}");
    expect(await read("chat/MessageSpans.tsx")).toContain("{ fontSize: chatCodeOf(sized).fontSize }");
  });

  test("a table's cells grow and shrink with the words, by the same points, the default table as it is", async () => {
    for (const os of ["ios", "android"] as const) {
      const { subhead, footnote } = typeScale(os);
      for (const step of CHAT_TEXT_SIZES) {
        const by = CHAT_TEXT[step].fontSize - CHAT_TEXT.md.fontSize;
        for (const cell of [subhead, footnote]) {
          const grown = chatCellOf(cell, CHAT_TEXT[step]);
          expect(grown.fontSize).toBe(cell.fontSize + by);
          expect(grown.lineHeight - cell.lineHeight).toBe(Math.round(by * 1.4));
          expect(grown.lineHeight).toBeGreaterThan(grown.fontSize);
        }
      }
      expect(chatCellOf(subhead, CHAT_TEXT.md)).toEqual({ fontSize: subhead.fontSize, lineHeight: subhead.lineHeight });
    }
    const spans = await read("chat/MessageSpans.tsx");
    expect(spans).toContain('sized ? chatCellOf(variantStyle(head ? "label" : "subhead"), sized) : null');
    expect(spans).toContain("maxFontSizeMultiplier={sized ? CHAT_TEXT_MAX_SCALE : undefined}");
  });
});
