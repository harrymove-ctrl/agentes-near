import { describe, expect, test } from "bun:test";
import { en, ptBR } from "@agenteschat/i18n";
import { PERSON_DEFAULT, PERSON_FIELDS, type PersonRecipe } from "@agenteschat/ui";
import { NAMED_FIELDS, optionsOf, switchBuild, tabsOf } from "@/components/AvatarBuilder";

const she: PersonRecipe = { ...PERSON_DEFAULT, build: "f", hair: "wavy", skin: "s4", eyes: "green", bg: "rose" };

describe("avatar builder", () => {
  test("every option shown with a name has one, in English and pt-BR", () => {
    for (const strings of [en, ptBR]) {
      const names = strings.portrait.options as Record<string, Record<string, string>>;
      for (const field of NAMED_FIELDS)
        expect(Object.keys(names[field] ?? {}).sort()).toEqual([...PERSON_FIELDS[field]].sort());
    }
  });

  test("each build has its own tabs: Beard on the masculine one only, unless every option is shown", () => {
    expect(tabsOf("m", false)).toContain("beard");
    expect(tabsOf("f", false)).not.toContain("beard");
    expect(tabsOf("f", true)).toContain("beard");
    expect(tabsOf("f", false)).toEqual(["face", "hair", "makeup", "accessories", "clothes", "background"]);
  });

  test("a build lists its own options first, never drops what the person wears, and lists everything when asked", () => {
    expect(optionsOf("clothes", she, false)).toContain("dress");
    expect(optionsOf("clothes", she, false)).not.toContain("suit");
    expect(optionsOf("clothes", { ...she, clothes: "suit" }, false).at(-1)).toBe("suit");
    expect(optionsOf("clothes", she, true)).toEqual(PERSON_FIELDS.clothes);
    // A field with no list of its own offers everything.
    expect(optionsOf("glasses", she, false)).toEqual(PERSON_FIELDS.glasses);
    expect(optionsOf("ear", { ...she, build: "m" }, false)).toEqual(["none", "studs", "hoops"]);
  });

  test("changing build starts plain, keeps skin, eyes, hair color, mood and background, and comes back as left", () => {
    const he = switchBuild(she, "m");
    expect(he).toMatchObject({ build: "m", hair: "short", clothes: "tee", skin: "s4", eyes: "green", bg: "rose" });
    expect(he).toMatchObject({ ear: "none", extra: "none", neck: "none", beard: "none" });
    const bearded = { ...he, beard: "full", skin: "s2" };
    const back = switchBuild(bearded, "f", she);
    expect(back).toMatchObject({ build: "f", hair: "wavy", skin: "s2" });
    expect(switchBuild(back, "m", bearded)).toMatchObject({ beard: "full" });
  });
});
