import { describe, expect, test } from "bun:test";
import type { DirectMessage, Message } from "@agenteschat/client";
import { isMediaAlone, mediaTabsOf, shownMediaSettings } from "@agenteschat/client/lib/media";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { STICKER_MOODS } from "@agenteschat/ui/agent/stickers";
import { createFrameClock } from "../../src/agent/clock";
import { stickerFrame } from "../../src/agent/sticker";
import { createStickerStage } from "../../src/agent/sticker-stage";
import { subtitleOf } from "../../src/features/activity/logic";
import { teamLines } from "../../src/features/agents/logic";
import { buildRows } from "../../src/features/chat/logic";
import {
  continuesReply,
  GIF_AHEAD,
  GIF_GAP,
  gifBox,
  MESSAGE_GIF_MAX,
  MESSAGE_GIF_MAX_HEIGHT,
  MESSAGE_LIVE_STICKERS,
  masonryPlaces,
  mediaAfterOf,
  nearEnd,
  nearView,
  PICKER_LIVE_STICKERS,
  pickerHeight,
  pickerLiveIds,
  sectionsInView,
  stickerAgentsFor,
  stickerCellId,
  stickerRowsOnScreen,
} from "../../src/features/chat/media";
import { type ScrollRow, unseenBelow } from "../../src/features/chat/scroll";
import { buildConversations } from "../../src/features/chats/logic";
import { agent, at, message, notification, translator } from "./fixtures";

// GIFs and stickers in chat (ADR 0091), on the phone.

const gif = { kind: "gif", provider: "giphy", id: "g1", title: "a cat dancing", width: 480, height: 270 };
const sticker = { kind: "sticker", agentId: "dev", mood: "celebrate" };

const reply = (over: Partial<Message> = {}) =>
  message({
    id: "reply",
    author: { type: "agent", id: "dev" },
    agentRunId: "run1",
    threadId: "root",
    body: "Pronto, subiu.",
    createdAt: at(10),
    ...over,
  });
const after = (over: Partial<Message> = {}) =>
  message({
    id: "after",
    author: { type: "agent", id: "dev" },
    agentRunId: "run1",
    threadId: "root",
    body: "",
    meta: { media: sticker, mediaAfter: "reply" },
    createdAt: at(9.9),
    ...over,
  });

describe("a GIF's box", () => {
  test("its own proportions, up to 260 wide", () => {
    expect(gifBox(480, 270)).toEqual({ width: MESSAGE_GIF_MAX, height: Math.round((260 * 270) / 480) });
    // Smaller than the most: as it is.
    expect(gifBox(200, 100)).toEqual({ width: 200, height: 100 });
  });

  test("never wider than the row's room", () => {
    expect(gifBox(480, 240, 200)).toEqual({ width: 200, height: 100 });
  });

  test("a tall one gets narrower instead of filling the screen", () => {
    const box = gifBox(200, 600);
    expect(box.height).toBe(MESSAGE_GIF_MAX_HEIGHT);
    expect(box.width).toBe(Math.round((MESSAGE_GIF_MAX_HEIGHT * 200) / 600));
  });

  test("sizes it doesn't know draw 4:3", () => {
    expect(gifBox(0, 0)).toEqual({ width: 260, height: 195 });
  });
});

describe("the sticker or GIF an agent adds after its reply", () => {
  test("reads as the end of that reply", () => {
    expect(mediaAfterOf(after().meta)).toBe("reply");
    expect(mediaAfterOf(reply().meta)).toBeNull();
    expect(continuesReply(reply(), after())).toBe(true);
    // Another message in between, or another author: not the reply it follows.
    expect(continuesReply(message({ id: "x" }), after())).toBe(false);
    expect(continuesReply(reply({ author: { type: "agent", id: "infra" } }), after())).toBe(false);
  });

  test("groups under its reply, even one that stands alone", () => {
    const consulted = reply({ meta: { consulted: [{ agentId: "infra", status: "answered", answer: "ok" }] } });
    const rows = buildRows([consulted, after()]);
    const shown = rows.filter((r) => r.kind === "message");
    expect(shown.map((r) => r.kind === "message" && r.grouped)).toEqual([false, true]);
  });

  test("a person's GIF groups like any message", () => {
    const a = message({ id: "a", createdAt: at(10) });
    const b = message({ id: "b", body: "", meta: { media: gif }, createdAt: at(9) });
    const shown = buildRows([a, b]).filter((r) => r.kind === "message");
    expect(shown.map((r) => r.kind === "message" && r.grouped)).toEqual([false, true]);
  });

  test("never counts as new below the person", () => {
    const rows: ScrollRow[] = [
      { key: "a", kind: "message" },
      { key: "after", kind: "message", who: "agent:dev", silent: true },
      { key: "b", kind: "message", who: "person:u2" },
    ];
    expect(unseenBelow(rows, "a")).toEqual({
      messages: 1,
      firstKey: "b",
      authors: ["person:u2"],
      working: [],
      mentionsMe: false,
    });
    expect(unseenBelow(rows.slice(0, 2), "a").messages).toBe(0);
  });
});

describe("stickers on Skia", () => {
  test("every mood draws the agent at its still frame", () => {
    for (const mood of STICKER_MOODS) {
      const ops = stickerFrame({ color: "sky", eyes: "round" }, mood, 110);
      expect(ops.length).toBeGreaterThan(0);
      // Only what the Skia replay knows, and colors it can read.
      for (const op of ops) {
        expect(["save", "restore", "translate", "scale", "rects", "fill", "stroke", "clip"]).toContain(op.op);
        if ("color" in op) expect(typeof op.color).toBe("string");
      }
    }
  });

  test("the same look and mood draw the same frame", () => {
    const look = { color: "sky", eyes: "round", accessory: "cap" };
    expect(stickerFrame(look, "love", 110)).toEqual(stickerFrame(look, "love", 110));
  });

  test("the loop moves: another moment draws another frame", () => {
    const look = { color: "sky", eyes: "round" };
    for (const mood of STICKER_MOODS) {
      const still = JSON.stringify(stickerFrame(look, mood, 110));
      const moments = [0.85, 1.7, 2.9].map((t) => JSON.stringify(stickerFrame(look, mood, 110, t)));
      expect(moments.some((frame) => frame !== still)).toBe(true);
    }
  });
});

describe("one clock for every sticker", () => {
  const timers = () => {
    const running = new Set<number>();
    return {
      running,
      now: () => 0,
      setInterval: () => {
        running.add(1);
        return 1;
      },
      clearInterval: () => {
        running.clear();
      },
    };
  };

  test("it runs only while someone listens and the app is in front", () => {
    const fake = timers();
    const clock = createFrameClock(25, fake);
    expect(clock.running).toBe(false);
    const stop = clock.subscribe(() => undefined);
    const other = clock.subscribe(() => undefined);
    expect(clock.running).toBe(true);
    expect(fake.running.size).toBe(1);
    clock.setPaused(true);
    expect(clock.running).toBe(false);
    clock.setPaused(false);
    stop();
    expect(clock.running).toBe(true);
    other();
    expect(clock.running).toBe(false);
  });
});

describe("the stage: which stickers play", () => {
  test("a sticker hears only that something changed, and only when it did", () => {
    const stage = createStickerStage();
    let told = 0;
    const leave = stage.subscribe(() => {
      told++;
    });
    stage.setOnScreen(["a", "b"]);
    expect(told).toBe(1);
    expect(stage.isLive("a")).toBe(true);
    expect(stage.isLive("c")).toBe(false);
    stage.setOnScreen(["b", "a"]);
    expect(told).toBe(1);
    stage.setOnScreen(["b"]);
    expect(told).toBe(2);
    expect(stage.isLive("a")).toBe(false);
    leave();
    stage.setOnScreen([]);
    expect(told).toBe(2);
  });

  test("nobody plays under a sheet, and they go on after it", () => {
    const stage = createStickerStage();
    stage.setOnScreen(["a"]);
    stage.setCovered(true);
    expect(stage.isLive("a")).toBe(false);
    stage.setCovered(false);
    expect(stage.isLive("a")).toBe(true);
  });

  const stickerRow = (id: string, index: number) => ({
    index,
    item: { kind: "message", message: { id, meta: { media: sticker } } },
  });

  test("a long conversation plays only its newest stickers in view", () => {
    const rows = [
      stickerRow("s3", 7),
      stickerRow("s1", 2),
      { index: 3, item: { kind: "message", message: { id: "g", meta: { media: gif } } } },
      { index: 4, item: { kind: "run" } },
      { index: 5, item: { kind: "message", message: { id: "t", meta: {} } } },
      stickerRow("s2", 6),
      stickerRow("s4", 8),
      stickerRow("s5", 9),
    ];
    expect(MESSAGE_LIVE_STICKERS).toBe(3);
    expect(stickerRowsOnScreen(rows)).toEqual(["s3", "s4", "s5"]);
    expect(stickerRowsOnScreen([])).toEqual([]);
  });

  test("the picker plays the first ones in view, never all of them", () => {
    const all = [...STICKER_MOODS];
    const live = pickerLiveIds(["a", "b", "c"], () => all);
    expect(live).toHaveLength(PICKER_LIVE_STICKERS);
    expect(live[0]).toBe(stickerCellId("a", "celebrate"));
    expect(live.at(-1)).toBe(stickerCellId("b", "celebrate"));
    // What a search left of a section is what counts.
    expect(pickerLiveIds(["a"], () => ["love"])).toEqual([stickerCellId("a", "love")]);
  });

  test("sections count as in view by where they measured", () => {
    const sections = [
      { id: "c", y: 400, height: 200 },
      { id: "a", y: 0, height: 200 },
      { id: "b", y: 200, height: 200 },
    ];
    expect(sectionsInView(sections, 0, 300)).toEqual(["a", "b"]);
    expect(sectionsInView(sections, 200, 100)).toEqual(["b"]);
    expect(sectionsInView(sections, 0, 0)).toEqual([]);
  });
});

describe("the picker", () => {
  const found = (id: string, width: number, height: number) => ({ id, title: id, width, height });

  test("a short sheet that fits above the keyboard", () => {
    expect(pickerHeight(800, 0)).toBe(496);
    expect(pickerHeight(800, 340)).toBe(320);
    // Never so small that the box and the chips are all there is.
    expect(pickerHeight(600, 340)).toBe(240);
  });

  test("two columns at their own proportions, each into the shortest", () => {
    const room = 200 + GIF_GAP;
    const { places, height } = masonryPlaces([found("a", 100, 200), found("b", 100, 100), found("c", 100, 50)], room);
    expect(places.map(({ item, x, y, width: w, height: h }) => [item.id, x, y, w, h])).toEqual([
      ["a", 0, 0, 100, 200],
      ["b", 100 + GIF_GAP, 0, 100, 100],
      ["c", 100 + GIF_GAP, 100 + GIF_GAP, 100, 50],
    ]);
    expect(height).toBe(200);
  });

  test("a new page moves nothing already placed", () => {
    const first = [found("a", 100, 200), found("b", 100, 100)];
    const before = masonryPlaces(first, 300).places;
    const after = masonryPlaces([...first, found("c", 300, 100), found("d", 100, 100)], 300).places;
    for (const place of before) expect(after).toContainEqual(place);
  });

  test("a GIF of unknown size stands square, and no room places nothing wrong", () => {
    expect(masonryPlaces([found("a", 0, 0)], 206).places[0]).toMatchObject({ width: 100, height: 100 });
    expect(masonryPlaces([], 300)).toEqual({ places: [], height: 0 });
    expect(masonryPlaces([found("a", 100, 100)], 0).places[0]).toMatchObject({ width: 0, height: 0 });
  });

  test("only what is near the view stays mounted", () => {
    expect(nearView({ y: 0, height: 100 }, 0, 400)).toBe(true);
    expect(nearView({ y: 400 + GIF_AHEAD, height: 100 }, 0, 400)).toBe(true);
    expect(nearView({ y: 401 + GIF_AHEAD, height: 100 }, 0, 400)).toBe(false);
    expect(nearView({ y: 0, height: 100 }, 100 + GIF_AHEAD, 400)).toBe(true);
    expect(nearView({ y: 0, height: 100 }, 101 + GIF_AHEAD, 400)).toBe(false);
  });

  test("the next page comes before the end", () => {
    expect(nearEnd(0, 400, 2000)).toBe(false);
    expect(nearEnd(1200, 400, 2000)).toBe(true);
  });

  test("stickers: the conversation's agents, or the whole team where it has none", () => {
    const team = [
      agent({ id: "dev", name: "Dev" }),
      agent({ id: "infra", name: "Infra" }),
      agent({ id: "qa", name: "QA" }),
    ];
    expect(stickerAgentsFor(team, ["qa", "dev"]).map((a) => a.id)).toEqual(["dev", "qa"]);
    expect(stickerAgentsFor(team, []).map((a) => a.id)).toEqual(["dev", "infra", "qa"]);
    // Someone who left the team isn't offered.
    expect(stickerAgentsFor(team, ["gone"]).map((a) => a.id)).toEqual(["dev", "infra", "qa"]);
  });

  const on = { gifs: true, gifsAvailable: true, agentStickers: true };

  test("each tab only where it can work", () => {
    expect(mediaTabsOf(on, 2, true)).toEqual(["gifs", "stickers"]);
    expect(mediaTabsOf({ ...on, gifs: false }, 2, true)).toEqual(["stickers"]);
    expect(mediaTabsOf({ ...on, gifsAvailable: false }, 2, true)).toEqual(["stickers"]);
    expect(mediaTabsOf(on, 2, false)).toEqual(["stickers"]);
    expect(mediaTabsOf({ ...on, agentStickers: false }, 2, true)).toEqual(["gifs"]);
    expect(mediaTabsOf(on, 0, true)).toEqual(["gifs"]);
  });

  test("no button when neither can go, nor before the settings load", () => {
    expect(mediaTabsOf({ gifs: false, gifsAvailable: true, agentStickers: false }, 2, true)).toEqual([]);
    expect(mediaTabsOf(undefined, 2, true)).toEqual([]);
  });

  test("a picked GIF or sticker never makes an agent look like it is answering", () => {
    expect(isMediaAlone(message({ id: "a", body: "", meta: { media: sticker } }))).toBe(true);
    expect(isMediaAlone(message({ id: "b", body: "  ", meta: { media: gif } }))).toBe(true);
    expect(isMediaAlone(message({ id: "c", body: "olha", meta: { media: gif } }))).toBe(false);
    // Files with no words do reach an agent.
    expect(isMediaAlone(message({ id: "d", body: "", meta: { artifacts: [{ id: "f" }] } }))).toBe(false);
  });
});

describe("the settings' screen", () => {
  const stored = { gifs: true, gifsAvailable: true, agentMedia: "often" as const, agentMediaAvailable: true };

  test("what is stored, where the server can do it", () => {
    expect(shownMediaSettings(stored)).toEqual({ gifsOn: true, level: "often" });
  });

  test("what the server can't do reads off, whatever is stored", () => {
    expect(shownMediaSettings({ ...stored, gifsAvailable: false }).gifsOn).toBe(false);
    expect(shownMediaSettings({ ...stored, agentMediaAvailable: false }).level).toBe("never");
  });
});

describe("a GIF or a sticker where a message's text shows", () => {
  test("the conversation list says which", async () => {
    const t = await translator("pt-BR");
    const dm: DirectMessage = {
      channelId: "d1",
      with: { type: "agent", id: "dev", name: "Dev", handle: "dev" },
      lastMessage: { id: "m", body: "", meta: null, mediaKind: "sticker", createdAt: at(1), authorType: "person" },
      unread: 0,
    };
    const rows = buildConversations({ channels: [], dms: [dm], threads: [] });
    const last = rows[0]?.kind === "dm" ? rows[0].last : null;
    expect(last?.mediaKind).toBe("sticker");
    expect(previewBody(t, last?.text ?? "", last?.meta ?? null, last?.mediaKind)).toBe("Figurinha");
    const en = await translator("en");
    expect(previewBody(en, "", null, "gif")).toBe("GIF");
  });

  test("the agents' list keeps the kind of their DM's last message", () => {
    const dev = agent({ id: "dev", name: "Dev" });
    const dm = {
      with: { type: "agent" as const, id: "dev", name: "Dev", handle: "dev" },
      lastMessage: { id: "m", body: "", meta: null, mediaKind: "gif" as const, createdAt: at(1), authorType: "agent" },
    };
    const { free } = teamLines([dev], [], [dm]);
    expect(free[0]?.preview).toBeNull();
    expect(free[0]?.previewMedia).toBe("gif");
  });

  test("the inbox names a GIF with no words", () => {
    const say = (_w: unknown, otherwise = "") => otherwise;
    const word = (kind: string) => (kind === "gif" ? "GIF" : "Figurinha");
    expect(subtitleOf(notification({ id: "n", latest: { text: "", media: "gif" } }), say, word)).toBe("GIF");
    expect(subtitleOf(notification({ id: "n", latest: { media: "sticker" } }), say, word)).toBe("Figurinha");
    // Words win; without the word function, nothing changes.
    expect(subtitleOf(notification({ id: "n", latest: { text: "olha", media: "gif" } }), say, word)).toBe("olha");
    expect(subtitleOf(notification({ id: "n", latest: { text: "", media: "gif" } }), say)).toBe("");
  });
});
