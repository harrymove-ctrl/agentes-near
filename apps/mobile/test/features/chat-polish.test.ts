import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyReceiptEvent, receiptTicks } from "@agenteschat/client";
import { dayInView } from "../../src/features/chat/logic";
import { appColors, toastGlow, toastToneOf, toneColor, withAlpha } from "../../src/ui/palette";
import { message } from "./fixtures";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("the floating date while the conversation scrolls", () => {
  test("the day of the topmost row in view that has one: a day line, else a message", () => {
    const m = message({ id: "a", createdAt: "2026-10-30T12:00:00.000Z" });
    expect(
      dayInView([
        { index: 4, item: { kind: "message", message: m } },
        { index: 3, item: { kind: "unseen" } },
        { index: 5, item: { kind: "day", iso: "2026-10-31T00:00:00.000Z" } },
      ]),
    ).toBe("2026-10-30T12:00:00.000Z");
    expect(dayInView([{ index: 2, item: { kind: "day", iso: "2026-10-29T00:00:00.000Z" } }])).toBe(
      "2026-10-29T00:00:00.000Z",
    );
    expect(dayInView([{ index: 1, item: { kind: "run" } }])).toBeNull();
    expect(dayInView([])).toBeNull();
  });

  test("none while the list's first row is in view: above it are the greeting and the setup card, which have no day", () => {
    const m = message({ id: "a", createdAt: "2026-10-30T12:00:00.000Z" });
    expect(
      dayInView([
        { index: 0, item: { kind: "day", iso: "2026-10-30T00:00:00.000Z" } },
        { index: 1, item: { kind: "message", message: m } },
      ]),
    ).toBeNull();
    expect(dayInView([{ index: 1, item: { kind: "message", message: m } }])).toBe("2026-10-30T12:00:00.000Z");
  });

  test("the day it keeps stays the same string while rows of that day pass the top, so scrolling skips re-renders", () => {
    const at = (createdAt: string) => [
      { index: 3, item: { kind: "message", message: message({ id: createdAt, createdAt }) } },
    ];
    const prev = "2026-10-30T12:00:00.000Z";
    expect(dayInView(at(new Date(new Date(prev).getTime() + 60_000).toISOString()), prev)).toBe(prev);
    expect(dayInView(at("2026-10-27T12:00:00.000Z"), prev)).toBe("2026-10-27T12:00:00.000Z");
    expect(dayInView([], prev)).toBeNull();
  });

  test("it shows while the person drags or flings the list and fades a moment after it stops", () => {
    const screen = src("features/chat/ChatScreen.tsx");
    expect(screen).toMatch(/onScrollBeginDrag=\{\(\) => \{\s*dragging\.current = true;\s*showDay\(\);/);
    expect(screen).toContain("onMomentumScrollBegin={showDay}");
    expect(screen).toMatch(/onMomentumScrollEnd=\{\(\) => \{\s*releaseAtEnd\(\);\s*hideDay\(\);/);
    expect(screen).toContain("setTopDay((prev) => dayInView(viewableItems, prev))");
    // The person's locale: the shared day words ("Hoje", "Ontem", a weekday this week, else a date).
    expect(src("features/chat/DatePill.tsx")).toContain('dayLabel(t, i18n.language || "en", day)');
  });
});

describe("toasts glow in their tone, as the web's", () => {
  test("a failure is danger, a done check success, any other icon neutral; a tone given wins", () => {
    expect(toastToneOf("x")).toBe("danger");
    expect(toastToneOf("alert")).toBe("danger");
    expect(toastToneOf(undefined)).toBe("success");
    expect(toastToneOf("check")).toBe("success");
    expect(toastToneOf("copy")).toBe("neutral");
    expect(src("ui/Toast.tsx")).toContain("item.tone ?? toastToneOf(item.icon)");
  });

  test("the glow is the tone's color from the right, 24% in light and 30% in dark, clear over the left 55%", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = appColors(scheme);
      const end = scheme === "dark" ? "4d" : "3d";
      expect(toastGlow(colors, "success", scheme).colors).toEqual([
        withAlpha(colors.ok, 0),
        withAlpha(colors.ok, 0),
        `${colors.ok.slice(0, 7)}${end}`,
      ]);
      expect(toastGlow(colors, "info", scheme).colors[2]).toBe(withAlpha(colors.agent, scheme === "dark" ? 0.3 : 0.24));
      expect(toastGlow(colors, "warning", scheme).colors[2]).toBe(
        withAlpha(colors.warn, scheme === "dark" ? 0.3 : 0.24),
      );
      expect(toastGlow(colors, "danger", scheme).colors[2]).toBe(
        withAlpha(colors.danger, scheme === "dark" ? 0.3 : 0.24),
      );
      expect(toastGlow(colors, "neutral", scheme).colors[2]).toBe(
        withAlpha(colors.faint, scheme === "dark" ? 0.3 : 0.24),
      );
      expect(toastGlow(colors, "info", scheme).locations).toEqual([0, 0.55, 1]);
      expect(toneColor(colors, "danger")).toBe(colors.danger);
    }
  });
});

describe("nobody will answer: the receipt's sheet, never a line", () => {
  test("the sheet says it and offers each agent it reached to call, with its @handle put in the box", () => {
    const receipts = src("features/chat/AgentReceipts.tsx");
    expect(receipts).toContain('t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")');
    expect(receipts).toContain('<SectionHeader title={t("channel.callAgent")} />');
    expect(receipts).toMatch(/requestComposerText\(m\.channelId, `@\$\{c\.handle\} `\)/);
    // The marks are the clock, one tick and two.
    expect(receipts).toMatch(/if \(mark === "none"\) return null;\s*return <Icon name=\{mark\}/);
  });
});

describe("a reply heard live", () => {
  test("too big for its event, it still refreshes its thread's link and header", () => {
    expect(src("features/chat/live.ts")).toContain("const threadId = repliedThread(event);");
    expect(src("features/chat/live.ts")).toContain("refreshRepliedThread(qc, orgId, threadId)");
  });
});

describe("a reply in a task's conversation", () => {
  test("the task lists read again, as the web's", () => {
    expect(src("features/shared/userEvents.ts")).toContain("applyIssueEvent(qc, orgId, event);");
  });
});

describe("my message's clock from the moment it is sent", () => {
  test("sent into a channel with agents, it wears the clock before the server says anything, as the web's", () => {
    const screen = src("features/chat/ChatScreen.tsx");
    expect(screen).toContain(
      "if (channel && channelAgents.length > 0 && !isMediaAlone(message)) live.picking(message.id);",
    );
    expect(src("features/chat/live.ts").replace(/\s+/g, " ")).toContain(
      'dispatch({ type: "event", event: { type: "message.routing", channelId, messageId, step: "plan" }, at: Date.now(), })',
    );
    const picking = applyReceiptEvent({}, { type: "message.routing", channelId: "c", messageId: "m", step: "plan" });
    expect(receiptTicks(picking.m)).toBe("clock");
    const routed = applyReceiptEvent(picking, {
      type: "message.routed",
      channelId: "c",
      messageId: "m",
      seenBy: ["a"],
      pickedBy: [],
      strategy: "router",
    });
    expect(receiptTicks(routed.m)).toBe("checks");
  });
});

describe("a conversation with a pinned message", () => {
  test("no header fade over the first messages: the list starts below the pinned bar, whose hairline is the edge", () => {
    const screen = src("features/chat/ChatScreen.tsx");
    const fade = screen.indexOf("styles.topFade, { height: headerHeight + 28 }");
    expect(fade).toBeGreaterThan(0);
    expect(screen.lastIndexOf("{!hasPin ? (", fade)).toBeGreaterThan(screen.lastIndexOf("<KeyboardGestureArea", fade));
    expect(src("features/chat/PinsSheet.tsx")).not.toMatch(/boxShadow|shadowOpacity|elevation/);
  });
});

describe("going to a message", () => {
  test("out of pages, it waits for a cached page refreshing before saying the message can't be reached", () => {
    const screen = src("features/chat/ChatScreen.tsx");
    const missing = screen.indexOf('toast({ title: t("channel.jumpMissing")');
    expect(missing).toBeGreaterThan(0);
    expect(screen.lastIndexOf("if (seekRefreshing) return;", missing)).toBeGreaterThan(
      screen.lastIndexOf("seekPages.current >= SEEK_MAX_PAGES", missing),
    );
    expect(screen).toContain("const seekRefreshing = isThread ? threadMessages.isFetching : top.isFetching;");
  });
});

describe("back to the latest messages", () => {
  test("the round button sits at the bottom right, above the composer, riding the keyboard with it", () => {
    const screen = src("features/chat/ChatScreen.tsx");
    const dock = screen.indexOf("style={[styles.jumpAt, { bottom: composerHeight + 10 }]}");
    expect(dock).toBeGreaterThan(0);
    expect(screen.lastIndexOf("<KeyboardStickyView", dock)).toBeGreaterThan(
      screen.lastIndexOf("</Animated.View>", dock),
    );
    expect(screen.indexOf("<ToLatest unseen={unseen} onPress={toEnd} />", dock)).toBeGreaterThan(dock);
    expect(screen.indexOf("styles.composerDock", dock)).toBeGreaterThan(dock);
  });
});
