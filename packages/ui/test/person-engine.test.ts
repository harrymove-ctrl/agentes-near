import { describe, expect, test } from "bun:test";
import {
  CATALOG,
  cleanRecipe,
  cropFor,
  DEFAULT,
  decodeRecipe,
  drawPerson,
  encodeRecipe,
  FIELDS,
  N,
  PORTRAIT_MARK,
  randomPerson,
  recipeOfUrl,
  swatchOf,
} from "../src/person/engine.js";

const filled = (recipe: Parameters<typeof drawPerson>[0]) => drawPerson(recipe).filter(Boolean).length;

describe("person portrait engine", () => {
  test("a recipe draws a 32×32 grid with the person on it and the background left empty", () => {
    const cells = drawPerson(DEFAULT);
    expect(cells).toHaveLength(N * N);
    expect(cells[0]).toBeNull();
    expect(filled(DEFAULT)).toBeGreaterThan(300);
    for (const c of cells) if (c) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("every value of every field draws, and each piece changes the picture", () => {
    for (const [field, values] of Object.entries(FIELDS)) {
      const seen = new Set<string>();
      for (const value of values) {
        const cells = drawPerson({ ...DEFAULT, build: "m", hair: "bob", [field]: value });
        expect(cells).toHaveLength(N * N);
        seen.add(cells.join(","));
      }
      // The background is not part of the grid: it is painted behind it.
      if (field !== "bg") expect(seen.size).toBe(values.length);
    }
  });

  test("the plain start wears nothing extra: no earrings, nothing on the head or around the neck, no makeup", () => {
    expect(DEFAULT).toMatchObject({ ear: "none", extra: "none", neck: "none", lips: "none", shadow: "none" });
    expect(DEFAULT.beard).toBe("none");
  });

  test("a recipe's code goes there and back; unknown values fall back, other codes are refused", () => {
    const recipe = randomPerson("ana", "f");
    const code = encodeRecipe(recipe);
    expect(code).toMatch(/^1(\.[A-Za-z0-9]+)+$/);
    expect(decodeRecipe(code)).toEqual(recipe);
    expect(decodeRecipe(code.replace(/^1\.f\./, "1.x."))?.build).toBe(DEFAULT.build);
    expect(decodeRecipe("2.f.s1")).toBeNull();
    expect(decodeRecipe("1.f.s1")).toBeNull();
    expect(decodeRecipe(null)).toBeNull();
    // A newer code with more fields still reads.
    expect(decodeRecipe(`${code}.more`)).toEqual(recipe);
    expect(cleanRecipe({ hair: "nope", bogus: "x" } as never)).toEqual(DEFAULT);
  });

  test("a photo address carries the recipe after the mark, and only then", () => {
    const recipe = randomPerson(7, "m");
    const url = `/api/app/avatars/u1/0123456789abcdef.png${PORTRAIT_MARK}${encodeRecipe(recipe)}`;
    expect(recipeOfUrl(url)).toEqual(recipe);
    expect(recipeOfUrl("/api/app/avatars/u1/0123456789abcdef.png")).toBeNull();
    expect(recipeOfUrl(null)).toBeNull();
  });

  test("the same seed gives the same portrait, of the build asked for", () => {
    expect(randomPerson("bia")).toEqual(randomPerson("bia"));
    for (let i = 0; i < 40; i++) {
      expect(randomPerson(i, "f")).toMatchObject({ build: "f", beard: "none" });
      expect(randomPerson(i, "m")).toMatchObject({ build: "m", lips: "none", shadow: "none" });
    }
  });

  test("each build's catalog names only real values and offers no beard on one, no makeup on the other", () => {
    for (const lists of Object.values(CATALOG))
      for (const [field, values] of Object.entries(lists))
        for (const value of values) expect(FIELDS[field as keyof typeof FIELDS]).toContain(value);
    expect(CATALOG.f.beard).toEqual(["none"]);
    expect(CATALOG.m.lips).toEqual(["none"]);
    expect(CATALOG.m.hair).toContain("long");
    expect(CATALOG.f.hair).toContain("short");
  });

  test("small faces show the face alone; swatches exist for the color fields only", () => {
    expect([18, 24, 36, 48].map(cropFor)).toEqual(["face", "face", "face", "face"]);
    expect([56, 112, 192].map(cropFor)).toEqual(["full", "full", "full"]);
    expect(swatchOf("skin", "s1")).toMatch(/^#/);
    expect(swatchOf("eyes", "dark")).toMatch(/^#/);
    expect(swatchOf("bg", "sky")).toStartWith("linear-gradient(");
    expect(swatchOf("hair", "bob")).toBeNull();
  });
});
