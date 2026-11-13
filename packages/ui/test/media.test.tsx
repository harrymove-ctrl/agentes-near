import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  AgentSticker,
  ChatGif,
  drawSticker,
  type EmojiPickerLabels,
  EmojiPickerPopover,
  GifPicker,
  type GifPickerLabels,
  liveStickerCount,
  masonryColumns,
  type PickerGif,
  type PickerTab,
  STICKER_MOODS,
  STICKER_STILL_T,
  StickerPicker,
  type StickerPickerLabels,
  stickerMoodsFor,
  stickerSeed,
  WAVE_SECONDS,
} from "../src";
import type { Ctx2D } from "../src/agent/engine.js";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

const body = () => within(document.body);
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** Runs `fn` with the person's motion setting (another file may have left it at `reduce`), then puts it back. */
async function withMotion(value: "reduce" | "no-preference", fn: () => Promise<void> | void) {
  const device = domWindow().happyDOM.settings.device;
  const was = device.prefersReducedMotion;
  device.prefersReducedMotion = value;
  try {
    await fn();
  } finally {
    device.prefersReducedMotion = was;
  }
}

/** The engine's 2D subset (engine.d.ts `Ctx2D`): what the phone app can replay on Skia. */
const CTX_METHODS = new Set([
  "save",
  "restore",
  "beginPath",
  "roundRect",
  "clip",
  "fillRect",
  "fill",
  "stroke",
  "ellipse",
  "translate",
  "scale",
  "moveTo",
  "lineTo",
  "bezierCurveTo",
  "quadraticCurveTo",
  "closePath",
]);
const CTX_PROPS = new Set(["fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin"]);

/** A 2D context that records every call and refuses anything outside the subset. */
function recorder() {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (CTX_PROPS.has(key)) return state[key];
        if (!CTX_METHODS.has(key)) throw new Error(`outside the Ctx2D subset: ${key}`);
        return (...args: unknown[]) => {
          calls.push(`${key}(${args.map((a) => (typeof a === "number" ? a.toFixed(2) : String(a))).join(",")})`);
        };
      },
      set(_target, key, value) {
        if (typeof key !== "string" || !CTX_PROPS.has(key)) throw new Error(`outside the Ctx2D subset: ${String(key)}`);
        state[key] = value;
        calls.push(`${key}=${String(value)}`);
        return true;
      },
    },
  ) as unknown as Ctx2D;
  return { ctx, calls };
}

describe("the agents' stickers (ADR 0091)", () => {
  test("seven moods, each drawn with the engine's subset only, the same frame for the same moment", () => {
    expect([...STICKER_MOODS]).toEqual(["celebrate", "love", "deal", "thinking", "wow", "dizzy", "wave"]);
    const look = { color: "amber", eyes: "round", accessory: "beanie" };
    for (const mood of STICKER_MOODS) {
      const a = recorder();
      drawSticker(a.ctx, look, mood, 1.3, 128);
      expect(a.calls.filter((c) => c.startsWith("fillRect")).length).toBeGreaterThan(50);
      const b = recorder();
      drawSticker(b.ctx, look, mood, 1.3, 128);
      expect(b.calls).toEqual(a.calls);
    }
    // It moves: another moment is another frame.
    const now = recorder();
    const later = recorder();
    drawSticker(now.ctx, look, "celebrate", 0.2, 128);
    drawSticker(later.ctx, look, "celebrate", 0.5, 128);
    expect(later.calls).not.toEqual(now.calls);
  });

  test("the hearts fade with their color's alpha, in the agent's own tones (rose: #f58aa6, #c9406a)", () => {
    const { ctx, calls } = recorder();
    drawSticker(ctx, { color: "rose" }, "love", STICKER_STILL_T, 128);
    const hearts = calls.filter((c) => /^fillStyle=rgba\((245, 138, 166|201, 64, 106), 0\.\d+\)$/.test(c));
    expect(hearts.length).toBeGreaterThan(0);
  });

  test("the wave, a mood people and agents send, waves, rests on its still frame as long, then waves again", () => {
    const frame = (t: number) => {
      const r = recorder();
      drawSticker(r.ctx, { color: "teal" }, "wave", t, 128);
      return r.calls;
    };
    const still = frame(STICKER_STILL_T);
    expect(frame(0.1)).not.toEqual(still);
    expect(frame(WAVE_SECONDS + 0.5)).toEqual(still);
    expect(frame(WAVE_SECONDS * 2 + 0.1)).toEqual(frame(0.1));
  });

  test("a seed keeps stickers side by side out of step, the same one for the same agent", () => {
    expect(stickerSeed("ag-1")).toBe(stickerSeed("ag-1"));
    expect(stickerSeed("ag-1")).not.toBe(stickerSeed("ag-2"));
    expect(stickerSeed("ag-1")).toBeGreaterThanOrEqual(0);
    expect(stickerSeed("ag-1")).toBeLessThan(10);
  });

  test("AgentSticker: a canvas of its size, named when labelled, in the shared loop while mounted", () => {
    const before = liveStickerCount();
    const { container, unmount } = render(
      <>
        <AgentSticker appearance={{ color: "amber" }} mood="love" size={120} label="Figurinha do Dev: amei" />
        <AgentSticker mood="wow" size={72} />
      </>,
    );
    const named = body().getByRole("img", { name: "Figurinha do Dev: amei" });
    expect(named.tagName).toBe("CANVAS");
    expect((named as HTMLElement).style.width).toBe("120px");
    expect(named.getAttribute("data-mood")).toBe("love");
    const quiet = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    expect(quiet.getAttribute("aria-hidden")).toBe("true");
    expect(quiet.style.height).toBe("72px");
    // One loop draws them all, and lets them go.
    expect(liveStickerCount()).toBe(before + 2);
    unmount();
    expect(liveStickerCount()).toBe(before);
  });
});

describe("a GIF in a message", () => {
  const props = {
    src: "/gifs/g1/media?size=full",
    still: "/gifs/g1/media?size=still",
    width: 480,
    height: 270,
    label: "GIF: party cat",
    mark: "GIF",
    source: "GIPHY",
  };

  test("the picture at its proportions, up to 300px, its mark, and where it comes from", () =>
    withMotion("no-preference", () => {
      const { container } = render(<ChatGif {...props} />);
      const img = body().getByRole("img", { name: "GIF: party cat" });
      expect(img.getAttribute("src")).toBe(props.src);
      expect(img.getAttribute("width")).toBe("480");
      expect(img.getAttribute("height")).toBe("270");
      const frame = container.querySelector(".ac-gif") as HTMLElement;
      expect(frame.style.getPropertyValue("--gif-w")).toBe("300px");
      expect(frame.style.getPropertyValue("--gif-ar")).toBe("480 / 270");
      expect(container.querySelector(".ac-gif__mark")?.textContent).toBe("GIF");
      expect(container.querySelector(".ac-gif__source")?.textContent).toBe("GIPHY");
      // It plays on its own: nothing to focus.
      expect(frame.getAttribute("tabindex")).toBeNull();
    }));

  test("with reduced motion: still until hovered or focused", () =>
    withMotion("reduce", async () => {
      const { container } = render(<ChatGif {...props} width={200} />);
      const frame = container.querySelector(".ac-gif") as HTMLElement;
      const img = body().getByRole("img", { name: "GIF: party cat" });
      expect(frame.style.getPropertyValue("--gif-w")).toBe("200px");
      expect(img.getAttribute("src")).toBe(props.still);
      expect(frame.getAttribute("tabindex")).toBe("0");
      await act(async () => fireEvent.mouseEnter(frame));
      expect(img.getAttribute("src")).toBe(props.src);
      await act(async () => fireEvent.mouseLeave(frame));
      expect(img.getAttribute("src")).toBe(props.still);
      await act(async () => fireEvent.focus(frame));
      expect(img.getAttribute("src")).toBe(props.src);
    }));

  test("a file that no longer loads leaves a quiet card: its title and the mark, no broken picture", async () => {
    render(<ChatGif {...props} title="party cat" />);
    await act(async () => fireEvent.error(body().getByRole("img", { name: "GIF: party cat" })));
    const card = body().getByRole("img", { name: "GIF: party cat" });
    expect(card.tagName).toBe("SPAN");
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".ac-gif__title")?.textContent).toBe("party cat");
    expect(card.querySelector(".ac-gif__mark")?.textContent).toBe("GIF");
  });
});

const EMOJI: EmojiPickerLabels = {
  dialog: "Emojis",
  search: "Buscar emoji",
  noResults: "Nenhum emoji encontrado.",
  recent: "Usados recentemente",
  results: "Resultados",
  categories: {
    smileys: "Carinhas",
    people: "Pessoas e gestos",
    nature: "Natureza",
    food: "Comida e bebida",
    activities: "Atividades",
    travel: "Viagens e lugares",
    objects: "Objetos",
    symbols: "Símbolos",
  },
};

describe("one picker with tabs", () => {
  const sent: string[] = [];
  const TABS: PickerTab[] = [
    {
      id: "gifs",
      label: "GIFs",
      render: ({ close }) => (
        <button
          type="button"
          onClick={() => {
            sent.push("gif");
            close();
          }}
        >
          gif-1
        </button>
      ),
    },
    { id: "stickers", label: "Figurinhas", render: () => <p>stickers here</p> },
  ];
  const trigger = (
    <button type="button" aria-label="Emojis, GIFs e figurinhas">
      +
    </button>
  );

  test("Emojis first, the tabs given after; a tab's pick closes it; it opens again on the tab last used", async () => {
    sent.length = 0;
    render(
      <EmojiPickerPopover
        labels={EMOJI}
        onPick={() => {}}
        trigger={trigger}
        tabs={TABS}
        tabLabels={{ dialog: "Emojis, GIFs e figurinhas", tabs: "O que mandar" }}
      />,
    );
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Emojis, GIFs e figurinhas" })));
    await tick();
    const dialog = body().getByRole("dialog", { name: "Emojis, GIFs e figurinhas" });
    const tabs = within(dialog).getByRole("tablist", { name: "O que mandar" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Emojis", "GIFs", "Figurinhas"]);
    // It opens on Emojis, searching.
    expect(document.activeElement === within(dialog).getByRole("searchbox", { name: "Buscar emoji" })).toBe(true);
    await act(async () => fireEvent.mouseDown(within(tabs).getByRole("tab", { name: "GIFs" }), { button: 0 }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "gif-1" })));
    await tick();
    expect(sent).toEqual(["gif"]);
    expect(body().queryByRole("dialog")).toBeNull();
    // Opened again: on GIFs.
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Emojis, GIFs e figurinhas" })));
    await tick();
    const again = body().getByRole("dialog", { name: "Emojis, GIFs e figurinhas" });
    expect(within(again).getByRole("tab", { name: "GIFs" }).getAttribute("aria-selected")).toBe("true");
    expect(within(again).getByRole("button", { name: "gif-1" })).toBeTruthy();
  });

  test("without tabs it is the emoji picker it always was (reactions)", async () => {
    render(<EmojiPickerPopover labels={EMOJI} onPick={() => {}} trigger={trigger} />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Emojis, GIFs e figurinhas" })));
    await tick();
    const dialog = body().getByRole("dialog", { name: "Emojis" });
    expect(within(dialog).queryByRole("tablist")).toBeNull();
    expect(within(dialog).getByRole("searchbox", { name: "Buscar emoji" })).toBeTruthy();
  });
});

const GIF_LABELS: GifPickerLabels = {
  search: "Buscar GIFs",
  clearSearch: "Limpar busca",
  categories: "Categorias",
  previous: "Categorias anteriores",
  next: "Mais categorias",
  trending: "Em alta",
  results: "GIFs",
  loading: "Carregando GIFs",
  empty: "Nenhum GIF encontrado.",
  error: "Não deu para buscar GIFs agora.",
  retry: "Tentar de novo",
  attribution: "GIFs do GIPHY",
  hint: "Um clique envia",
};

const gif = (id: string, width: number, height: number): PickerGif => ({
  id,
  src: `/gifs/${id}/media?size=preview`,
  width,
  height,
  label: `GIF: ${id}`,
});

describe("the GIFs tab", () => {
  test("masonry: each GIF in the shorter column, and a new page never moves the ones placed", () => {
    const first = [gif("a", 100, 200), gif("b", 100, 50), gif("c", 100, 50), gif("d", 100, 100)];
    const cols = masonryColumns(first, 2);
    expect(cols.map((c) => c.map((g) => g.id))).toEqual([["a"], ["b", "c", "d"]]);
    const more = masonryColumns([...first, gif("e", 100, 100)], 2);
    expect(more.map((c) => c.map((g) => g.id))).toEqual([
      ["a", "e"],
      ["b", "c", "d"],
    ]);
  });

  function Harness(props: Partial<Parameters<typeof GifPicker>[0]> & { log: string[] }) {
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<string | null>(null);
    const { log, ...rest } = props;
    return (
      <GifPicker
        labels={GIF_LABELS}
        query={query}
        onQueryChange={(q) => {
          log.push(`query:${q}`);
          setQuery(q);
        }}
        categories={[
          { id: "celebrate", label: "Comemorar" },
          { id: "thanks", label: "Obrigado" },
        ]}
        category={category}
        onCategoryChange={(c) => {
          log.push(`category:${c}`);
          setCategory(c);
        }}
        gifs={[gif("a", 480, 270), gif("b", 480, 480), gif("c", 360, 480)]}
        status="ready"
        hasMore
        loadingMore={false}
        onLoadMore={() => log.push("more")}
        onRetry={() => log.push("retry")}
        onPick={(g) => log.push(`pick:${g.id}`)}
        {...rest}
      />
    );
  }

  test("search, chips, two columns of buttons, the credit; one click picks", async () => {
    const log: string[] = [];
    const { container } = render(<Harness log={log} autoFocus />);
    const search = body().getByRole("searchbox", { name: "Buscar GIFs" });
    expect(document.activeElement === search).toBe(true);
    const chips = body().getByRole("group", { name: "Categorias" });
    expect(within(chips).getByRole("button", { name: "Em alta" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(within(chips).getByRole("button", { name: "Obrigado" })));
    expect(log).toContain("category:thanks");
    expect(within(chips).getByRole("button", { name: "Obrigado" }).getAttribute("aria-pressed")).toBe("true");
    const results = body().getByRole("group", { name: "GIFs" });
    expect(results.querySelectorAll(".ac-gifs__col")).toHaveLength(2);
    const cell = within(results).getByRole("button", { name: "GIF: b" });
    // Its size holds its place before it loads; lazy, from our server.
    const img = cell.querySelector("img");
    expect([img?.getAttribute("width"), img?.getAttribute("height")]).toEqual(["480", "480"]);
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("src")).toBe("/gifs/b/media?size=preview");
    await act(async () => fireEvent.click(cell));
    expect(log).toContain("pick:b");
    await act(async () => fireEvent.change(search, { target: { value: "gato" } }));
    expect(log).toContain("query:gato");
    // Typing leaves the chips: none is pressed.
    expect(within(chips).queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(container.querySelector(".ac-media__foot")?.textContent).toContain("GIFs do GIPHY");
  });

  test("keyboard: ArrowDown from the box enters, arrows move between the columns, up goes back", async () => {
    render(<Harness log={[]} />);
    const search = body().getByRole("searchbox", { name: "Buscar GIFs" });
    search.focus();
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("GIF: a");
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("GIF: b");
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" }));
    expect(document.activeElement === search).toBe(true);
  });

  test("near the end of the list the next page loads", async () => {
    const log: string[] = [];
    const { container } = render(<Harness log={log} />);
    await act(async () => fireEvent.scroll(container.querySelector(".ac-media__scroll") as Element));
    expect(log).toContain("more");
  });

  test("loading, nothing found and a failed search each say so; Tentar de novo asks again", async () => {
    const log: string[] = [];
    const { unmount } = render(<Harness log={log} status="loading" gifs={[]} />);
    expect(body().getByRole("status", { name: "Carregando GIFs" })).toBeTruthy();
    unmount();
    const empty = render(<Harness log={log} gifs={[]} hasMore={false} />);
    expect(body().getByRole("status").textContent).toBe("Nenhum GIF encontrado.");
    empty.unmount();
    render(<Harness log={log} status="error" gifs={[]} />);
    expect(body().getByRole("status").textContent).toContain("Não deu para buscar GIFs agora.");
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Tentar de novo" })));
    expect(log).toContain("retry");
  });
});

const STICKER_LABELS: StickerPickerLabels = {
  search: "Buscar figurinhas",
  clearSearch: "Limpar busca",
  empty: "Nenhuma figurinha encontrada.",
  foot: "Feitas do visual de cada agente",
  moods: {
    celebrate: "comemorando",
    love: "amei",
    deal: "fechado",
    thinking: "pensando",
    wow: "uau",
    dizzy: "zonzo",
    wave: "oi",
  },
  moodWords: { love: "obrigado valeu", celebrate: "festa parabéns" },
  sticker: (name, mood) => `Figurinha de ${name}: ${STICKER_LABELS.moods[mood]}`,
};

describe("the stickers tab", () => {
  const agents = [
    { id: "ag-dev", name: "Dev", appearance: { color: "amber" as const } },
    { id: "ag-infra", name: "Infra", appearance: { color: "rose" as const } },
  ];

  test("a search finds an agent by name (all seven) or the moods by their words", () => {
    expect(stickerMoodsFor("", "Dev", STICKER_LABELS)).toHaveLength(7);
    expect(stickerMoodsFor("de", "Dev", STICKER_LABELS)).toHaveLength(7);
    expect(stickerMoodsFor("valeu", "Dev", STICKER_LABELS)).toEqual(["love"]);
    expect(stickerMoodsFor("Pensando", "Dev", STICKER_LABELS)).toEqual(["thinking"]);
    expect(stickerMoodsFor("xyz", "Dev", STICKER_LABELS)).toEqual([]);
  });

  test("a section per agent with its seven moods; a click picks; nothing found says so", async () => {
    const picked: string[] = [];
    render(
      <StickerPicker labels={STICKER_LABELS} agents={agents} onPick={(a, mood) => picked.push(`${a.id}:${mood}`)} />,
    );
    const dev = body().getByRole("region", { name: "Dev" });
    expect(within(dev).getAllByRole("button")).toHaveLength(7);
    expect(body().getByRole("region", { name: "Infra" })).toBeTruthy();
    await act(async () => fireEvent.click(within(dev).getByRole("button", { name: "Figurinha de Dev: amei" })));
    expect(picked).toEqual(["ag-dev:love"]);
    const search = body().getByRole("searchbox", { name: "Buscar figurinhas" });
    await act(async () => fireEvent.change(search, { target: { value: "infra" } }));
    expect(body().queryByRole("region", { name: "Dev" })).toBeNull();
    await act(async () => fireEvent.change(search, { target: { value: "nada assim" } }));
    expect(body().getByRole("status").textContent).toBe("Nenhuma figurinha encontrada.");
  });
});
