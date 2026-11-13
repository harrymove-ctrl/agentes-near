import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { keepWhole } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { objectUrls } from "@/components/artifacts/FileView";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

// A message's pictures in the viewer: ‹ › on the stage's sides, ← →, "2 de 4" in the head, the head following.

const STAGE = { w: 1200, h: 700 };
const saved: { url: string; name: string }[] = [];
const realSave = fileSaver.save;
const realCreate = objectUrls.create;
const realRevoke = objectUrls.revoke;
// The picture's stage has a size (happy-dom lays nothing out): patched for it alone, put back after.
const realRect = Element.prototype.getBoundingClientRect;
const realSize = ["clientWidth", "clientHeight"].map(
  (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
);
const isStage = (el: Element) => el.classList?.contains("izoom__stage");
let urls = 0;
beforeAll(() => {
  fileSaver.save = (url, name) => {
    saved.push({ url, name });
  };
  objectUrls.create = () => `blob:preview-${++urls}`;
  objectUrls.revoke = () => {};
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!isStage(this)) return realRect.call(this);
    const r = { x: 0, y: 0, left: 0, top: 0, width: STAGE.w, height: STAGE.h, right: STAGE.w, bottom: STAGE.h };
    return { ...r, toJSON: () => r } as DOMRect;
  };
  for (const [k, d] of realSize) {
    const size = k === "clientWidth" ? STAGE.w : STAGE.h;
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get(this: HTMLElement) {
        return isStage(this) ? size : (d?.get?.call(this) ?? 0);
      },
    });
  }
});
afterAll(() => {
  fileSaver.save = realSave;
  objectUrls.create = realCreate;
  objectUrls.revoke = realRevoke;
  Element.prototype.getBoundingClientRect = realRect;
  for (const [k, d] of realSize) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
});
afterEach(() => {
  cleanup();
  saved.length = 0;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const press = async (k: string, el: Element = document.activeElement ?? document.body) => {
  await act(async () => fireEvent.keyDown(el, { key: k }));
  await settle(3);
};
const png = (name: string, extra: number) =>
  new File([new Uint8Array([137, 80, 78, 71, ...Array.from({ length: extra }, (_, i) => i)])], name, {
    type: "image/png",
  });

/** #eng with an agent's message carrying `files` (pictures and a zip, in that order), the channel open. */
async function channelWith(files: File[]) {
  const state = seedState();
  const api = createFakeApi(state);
  const ids: Record<string, string> = {};
  for (const f of files) ids[f.name] = (await api.artifacts.upload(ORG_ID, f)).id;
  state.messages.push({
    id: "m-shots",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ATLAS_ID },
    body: "As telas do lançamento, desktop e celular.",
    mentionedAgentIds: [],
    agentRunId: "r-shots",
    meta: { artifacts: files.map((f) => ({ id: ids[f.name] as string, version: 1 })) },
    createdAt: new Date().toISOString(),
  });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(10);
  return { ...r, ids };
}

const FOUR = () => [
  png("tela-1.png", 1),
  png("tela-2.png", 2),
  new File([new Uint8Array([80, 75, 3, 4])], "notas.zip", { type: "application/zip" }),
  png("tela-3.png", 3),
  png("tela-4.png", 4),
];

const openThumb = async (name: string) => {
  await click(screen().getByRole("button", { name: `Abrir ${name}` }));
  await settle(6);
  return screen().getByRole("dialog", { name });
};
const dialog = () => screen().getByRole("dialog");
const place = () => dialog().querySelector(".artifact-sheet__place")?.textContent ?? null;
const nav = (name: "Imagem anterior" | "Próxima imagem") => within(dialog()).queryByRole("button", { name });
const title = () => dialog().querySelector(".ac-details__title")?.textContent;
/** The picture shown has loaded at `w`×`h`: it is fitted to the 1200×700 stage. */
const load = async (w = 3600, h = 600) => {
  const img = dialog().querySelector<HTMLImageElement>(".izoom__img");
  if (!img) throw new Error("no picture on the stage");
  Object.defineProperty(img, "naturalWidth", { value: w });
  Object.defineProperty(img, "naturalHeight", { value: h });
  await act(async () => fireEvent.load(img));
  return img;
};
const scaleOf = (img: HTMLImageElement) => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)?.[1]);

describe("moving through a message's pictures in the viewer", () => {
  test("the second of four opens with ‹ ›, 2 de 4 in the head; the zip between them is not one of them", async () => {
    await channelWith(FOUR());
    await openThumb("tela-2.png");
    expect(place()).toBe("2 de 4");
    expect(nav("Imagem anterior")).toBeTruthy();
    expect(nav("Próxima imagem")).toBeTruthy();
    // Square icon buttons of the kit, with their words for screen readers and a tooltip.
    const next = nav("Próxima imagem") as HTMLElement;
    expect(next.className).toContain("ac-btn--icon");
    expect(next.getAttribute("title")).toBe("Próxima imagem");
  });

  test("‹ › and ← → move, the head follows (name, size, Baixar), and the end's button leaves", async () => {
    const r = await channelWith(FOUR());
    await openThumb("tela-2.png");
    await click(nav("Próxima imagem") as HTMLElement);
    await settle(4);
    expect(title()).toBe("tela-3.png");
    expect(place()).toBe("3 de 4");
    expect(dialog().querySelector(".ac-details__subtitle")?.textContent).toContain(keepWhole(formatBytes("pt-BR", 7)));
    await press("ArrowRight");
    expect(title()).toBe("tela-4.png");
    expect(place()).toBe("4 de 4");
    expect(nav("Próxima imagem")).toBeNull();
    expect(nav("Imagem anterior")).toBeTruthy();
    // Past the last one nothing moves (no wrapping round).
    await press("ArrowRight");
    expect(title()).toBe("tela-4.png");
    await click(within(dialog()).getByRole("button", { name: "Baixar" }));
    expect(saved.at(-1)).toEqual({
      url: `/api/app/organizations/${ORG_ID}/artifacts/${r.ids["tela-4.png"]}/file?version=1`,
      name: "tela-4.png",
    });
    for (let i = 0; i < 3; i++) await press("ArrowLeft");
    expect(title()).toBe("tela-1.png");
    expect(place()).toBe("1 de 4");
    expect(nav("Imagem anterior")).toBeNull();
    expect(dialog().querySelector(".artifact-viewer")?.getAttribute("data-moved")).toBe("prev");
  });

  test("the focus stays in the viewer: the button that runs out hands it to the other one", async () => {
    await channelWith(FOUR());
    await openThumb("tela-3.png");
    const next = nav("Próxima imagem") as HTMLElement;
    next.focus();
    await click(next);
    await settle(4);
    expect(title()).toBe("tela-4.png");
    expect(document.activeElement).toBe(nav("Imagem anterior"));
    // ← on the focused picture: its stage leaves with it, and the focus goes to the button that keeps going.
    const stage = dialog().querySelector(".izoom__stage") as HTMLElement;
    stage.focus();
    await press("ArrowLeft", stage);
    expect(title()).toBe("tela-3.png");
    expect(document.activeElement).toBe(nav("Imagem anterior"));
  });

  test("every picture's details load ahead, not only the ones beside it", async () => {
    const r = await channelWith(FOUR());
    await openThumb("tela-2.png");
    await settle(4);
    for (const name of ["tela-1.png", "tela-3.png", "tela-4.png"]) {
      const id = r.ids[name] as string;
      expect(r.services.queryClient.getQueryData(keys.artifact(ORG_ID, id, undefined))).toBeTruthy();
    }
  });

  test("two quick steps land on a picture never beside the one shown: its head at once, never Carregando…", async () => {
    await channelWith(FOUR());
    await openThumb("tela-2.png");
    await settle(4);
    let head: (string | null | undefined)[] = [];
    await act(async () => {
      fireEvent.keyDown(dialog(), { key: "ArrowRight" });
      fireEvent.keyDown(dialog(), { key: "ArrowRight" });
      head = [title(), place()];
    });
    expect(head).toEqual(["tela-4.png", "4 de 4"]);
  });

  test("← → typed in a field outside the viewer leave the picture alone", async () => {
    await channelWith(FOUR());
    await openThumb("tela-2.png");
    const field = [...document.querySelectorAll("textarea")].find((el) => !dialog().contains(el));
    if (!field) throw new Error("no composer behind the viewer");
    await press("ArrowRight", field);
    await press("ArrowLeft", field);
    expect(title()).toBe("tela-2.png");
    expect(place()).toBe("2 de 4");
  });

  test("a zoomed picture takes ← → to move around in it; moving to another one shows it fitted", async () => {
    await channelWith(FOUR());
    await openThumb("tela-1.png");
    let img = await load();
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    const stage = dialog().querySelector(".izoom__stage") as HTMLElement;
    stage.focus();
    await press("1", stage);
    expect(scaleOf(img)).toBe(1);
    expect(dialog().querySelector(".izoom[data-zoomed]")).toBeTruthy();
    const before = img.style.transform;
    await press("ArrowRight", stage);
    expect(title()).toBe("tela-1.png");
    expect(img.style.transform).not.toBe(before);
    await click(nav("Próxima imagem") as HTMLElement);
    await settle(4);
    expect(title()).toBe("tela-2.png");
    img = await load();
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    expect(dialog().querySelector(".izoom[data-zoomed]")).toBeNull();
    await press("ArrowLeft");
    expect(title()).toBe("tela-1.png");
    img = await load();
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
  });

  test("on a phone's sheet, 2 de 4 leads the line under the title: no room beside it", async () => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({ matches: q === "(max-width: 640px)", media: q, addEventListener() {}, removeEventListener() {} }) as never,
    );
    try {
      await channelWith(FOUR());
      await openThumb("tela-2.png");
      expect(place()).toBeNull();
      expect(dialog().querySelector(".ac-details__subtitle")?.textContent).toStartWith("2 de 4 · Arquivo · ");
      expect(nav("Próxima imagem")).toBeTruthy();
    } finally {
      media.mockRestore();
    }
  });

  test("Esc still closes the viewer", async () => {
    await channelWith(FOUR());
    await openThumb("tela-2.png");
    await press("ArrowRight");
    await act(async () => fireEvent.keyDown(document.activeElement ?? dialog(), { key: "Escape" }));
    await settle(4);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("one picture on its message: no count, no ‹ ›, ← → do nothing", async () => {
    await channelWith([
      png("tela-1.png", 1),
      new File([new Uint8Array([80, 75, 3, 4])], "notas.zip", { type: "application/zip" }),
    ]);
    await openThumb("tela-1.png");
    expect(place()).toBeNull();
    expect(nav("Imagem anterior")).toBeNull();
    expect(nav("Próxima imagem")).toBeNull();
    await press("ArrowRight");
    expect(title()).toBe("tela-1.png");
    expect(dialog().querySelector(".artifact-viewer")?.hasAttribute("data-moved")).toBe(false);
  });
});
