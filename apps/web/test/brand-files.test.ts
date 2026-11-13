import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { existsSync, readdirSync } from "node:fs";
import { POSTGRES_MARK } from "@agenteschat/client/lib/databases";
import { PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { DatabaseIcon } from "@/components/DatabaseConnect";
import { MailIcon, mailChoices } from "@/components/MailConnect";
import { createI18n } from "@/i18n";
import { MAIL_PROVIDERS } from "./fakes/mail";

afterEach(() => cleanup());

const PUBLIC = new URL("../public/", import.meta.url).pathname;

describe("the brand files the app serves", () => {
  test("every SVG is a drawing on the 24×24 grid that runs nothing and loads nothing", async () => {
    const svgs = ["brands/", "connectors/"].flatMap((dir) =>
      readdirSync(PUBLIC + dir)
        .filter((name) => name.endsWith(".svg"))
        .map((name) => dir + name),
    );
    expect(svgs).toContain("brands/postgresql.svg");
    expect(svgs).toContain("connectors/square.svg");
    for (const name of svgs) {
      const svg = await Bun.file(PUBLIC + name).text();
      expect([name, /<svg\b[^>]*\sviewBox="0 0 24 24"/.test(svg)]).toEqual([name, true]);
      expect([name, svg.match(/<script|<style|<foreignObject|\sstyle\s*=|\son[a-z]+\s*=/gi)]).toEqual([name, null]);
      // Links only to the file's own ids (`href="#a"`, `url(#a)`), never out.
      expect([name, svg.match(/href\s*=\s*["'](?!#)|url\(\s*["']?(?![#"'])/gi)]).toEqual([name, null]);
    }
  });

  test("each AI maker's image mark is a file here, 128 px square", async () => {
    const images = Object.values(PROVIDER_MARKS).flatMap((mark) => ("image" in mark ? [mark.image] : []));
    expect(images).toEqual(["/brands/soniox.png", "/brands/gemini.png", "/brands/vscode.png"]);
    for (const image of images) {
      const png = new DataView(await Bun.file(new URL(`../public${image}`, import.meta.url).pathname).arrayBuffer());
      // The PNG signature, then the header's width and height.
      expect([image, png.getUint32(0), png.getUint32(16), png.getUint32(20)]).toEqual([image, 0x89504e47, 128, 128]);
    }
  });

  test("the database connector draws PostgreSQL's own mark, in its own colors", () => {
    const tile = render(createElement(DatabaseIcon, { size: "lg" })).container.firstElementChild as HTMLElement;
    expect(tile.className).toBe("connector-icon connector-icon--lg connector-icon--brand");
    const img = tile.querySelector("img");
    expect([img?.className, img?.getAttribute("src"), img?.getAttribute("alt")]).toEqual([
      "connector-icon__img",
      "/brands/postgresql.svg",
      "",
    ]);
    expect(POSTGRES_MARK).toBe("/brands/postgresql.svg");
  });

  test("a connector's one-color mark is a mask in its brand color; one in its maker's colors is drawn as it is", () => {
    const icon = (iconUrl: string) =>
      render(createElement(ConnectorIcon, { def: { iconUrl, brandColor: null }, label: "PayPal" })).container
        .firstElementChild as HTMLElement;
    const square = icon("/connectors/square.svg").querySelector<HTMLElement>(".connector-icon__mark");
    expect(square?.style.getPropertyValue("--connector-icon")).toBe('url("/connectors/square.svg")');
    const paypal = icon("/brands/paypal.svg").querySelector("img");
    expect([paypal?.className, paypal?.getAttribute("src")]).toEqual(["connector-icon__img", "/brands/paypal.svg"]);
    // Only a file of ours, by its name.
    expect(icon("/brands/../paypal.svg").textContent).toBe("P");
  });

  test("every mailbox card but 'Outro email' draws its maker's mark, a file here, never a letter", () => {
    const i18n = createI18n("pt-BR");
    const choices = mailChoices(MAIL_PROVIDERS);
    expect(choices).toEqual(["gmail", "outlook", "icloud", "other"]);
    for (const choice of choices.filter((c) => c !== "other")) {
      const tile = render(createElement(I18nextProvider, { i18n }, createElement(MailIcon, { choice }))).container
        .firstElementChild as HTMLElement;
      const mask = tile.querySelector<HTMLElement>(".connector-icon__mark")?.style.getPropertyValue("--connector-icon");
      const file = tile.querySelector("img")?.getAttribute("src") ?? mask?.match(/^url\("(.+)"\)$/)?.[1];
      expect([
        choice,
        tile.classList.contains("connector-icon--mono"),
        file && existsSync(PUBLIC + file.slice(1)),
      ]).toEqual([choice, false, true]);
      cleanup();
    }
  });
});
