import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { clampCrop, cropRect, encode, VIEW_PX } from "@/components/ProfilePhoto";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
/** The account menu, from the keyboard (Radix opens it on a key or a pointer press, not on a click). */
const openAccountMenu = async () => {
  const row = screen().getByRole("button", { name: /^Conta: / });
  row.focus();
  await act(async () => {
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyUp(row, { key: "Enter" });
  });
  await settle(2);
  return screen().getAllByRole("menu")[0] as HTMLElement;
};

describe("profile photo", () => {
  test("crop math: the image always covers the square; the rect maps back to image pixels", () => {
    // 1000×500 at zoom 1 → scale 240/500 = 0.48 → 480×240 on screen.
    expect(clampCrop({ zoom: 1, x: 50, y: -10 }, 1000, 500)).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(clampCrop({ zoom: 1, x: -400, y: 0 }, 1000, 500)).toEqual({ zoom: 1, x: -240, y: 0 });
    expect(cropRect({ zoom: 1, x: -120, y: 0 }, 1000, 500)).toEqual({ sx: 250, sy: 0, size: 500 });
    expect(cropRect({ zoom: 2, x: 0, y: 0 }, 1000, 500).size).toBe(250);
    expect(VIEW_PX).toBe(240);
  });

  test("without a canvas, the original file goes as base64", async () => {
    const out = await encode(new File(["png-bytes"], "eu.png", { type: "image/png" }), null, { zoom: 1, x: 0, y: 0 });
    expect(out).toEqual({ imageBase64: btoa("png-bytes"), contentType: "image/png" });
  });

  test("Edit profile → Change photo → Upload a photo: pick an image, save; my avatar uses it", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(state) });
    await settle(6);
    await click(within(await openAccountMenu()).getByRole("menuitem", { name: "Editar perfil" }));
    await settle(2);
    const profile = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    // Photo and @ need no line; the time zone's use is its ⓘ, which also describes the picker.
    expect(profile.querySelectorAll(".ac-field__example, .small.muted")).toHaveLength(0);
    const zone = within(profile).getByRole("button", { name: "Sobre Fuso horário" });
    const zoneHint = document.getElementById(zone.getAttribute("aria-describedby") ?? "");
    expect(zoneHint?.textContent).toBe("Mostra a sua hora local no seu cartão de perfil.");
    await click(within(profile).getByRole("button", { name: "Trocar foto" }));
    await settle(2);
    // The question comes first: build an avatar or upload a photo.
    const ask = screen().getByRole("dialog", { name: "Como você quer aparecer?" });
    expect(within(ask).getByRole("button", { name: /^Enviar uma foto/ })).toBeTruthy();
    await click(within(ask).getByRole("button", { name: /^Criar um avatar/ }));
    await settle(2);
    // The builder: Masculine or Feminine, its tabs, and the photo one link away.
    const builder = screen().getByRole("dialog", { name: "Seu avatar" });
    expect(within(builder).getByRole("radio", { name: "Masculino" })).toBeTruthy();
    expect(
      within(builder)
        .getAllByRole("tab")
        .map((el) => el.textContent),
    ).toEqual(["Rosto", "Cabelo", "Barba", "Marcas", "Acessórios", "Roupa", "Fundo"]);
    await click(within(builder).getByRole("button", { name: "Enviar foto" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Foto do perfil" });
    expect(within(dialog).getByRole("button", { name: /Solte uma imagem aqui/ })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    // Not an image: says so.
    const input = within(dialog).getByLabelText("Escolher imagem") as HTMLInputElement;
    await act(async () =>
      fireEvent.change(input, { target: { files: [new File(["x"], "notas.txt", { type: "text/plain" })] } }),
    );
    expect(within(dialog).getByRole("alert").textContent).toBe("Escolha uma imagem (JPG, PNG ou WebP).");
    await act(async () =>
      fireEvent.change(input, { target: { files: [new File(["png-bytes"], "eu.png", { type: "image/png" })] } }),
    );
    await settle(3);
    expect(within(dialog).getByRole("img", { name: "Prévia da foto" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "orgs.setAvatar");
    expect(call?.args[1]).toMatchObject({ contentType: "image/png" });
    expect(state.members.find((m) => m.userId === "u-walter")?.avatarUrl).toStartWith("data:image/png;base64,");
    expect(document.body.textContent).toContain("Foto atualizada.");
  });
});

describe("workspace logo", () => {
  test("Configurações → Geral → Enviar logo: crop, save; the sidebar shows the logo", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings`, { api: createFakeApi(state) });
    await settle(8);
    // No logo yet: the agent mark in the sidebar.
    expect(document.querySelector(".sidebar__org-mark.org-mark")).toBeNull();
    await click(screen().getByRole("button", { name: "Enviar logo" }));
    const dialog = screen().getByRole("dialog", { name: "Logo do workspace" });
    const input = within(dialog).getByLabelText("Escolher imagem") as HTMLInputElement;
    await act(async () =>
      fireEvent.change(input, { target: { files: [new File(["png-bytes"], "logo.png", { type: "image/png" })] } }),
    );
    await settle(3);
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(8);
    const call = state.calls.find((c) => c.method === "orgs.setLogo");
    expect(call?.args[0]).toBe(ORG_ID);
    expect(document.body.textContent).toContain("Logo atualizado.");
    const mark = document.querySelector<HTMLImageElement>("img.sidebar__org-mark.org-mark");
    expect(mark?.getAttribute("src")).toStartWith("data:image/png;base64,");
    expect(screen().getByRole("button", { name: "Trocar logo" })).toBeTruthy();
  });
});
