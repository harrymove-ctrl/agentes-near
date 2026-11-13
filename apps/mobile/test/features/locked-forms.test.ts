import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");

/** Where the first `<Locked` opens, where its `</Locked>` closes, and where `mark` stands. */
const around = (source: string, mark: string) => ({
  open: source.indexOf("<Locked"),
  close: source.indexOf("</Locked>"),
  at: source.indexOf(mark),
});

describe("a form that is sending turns its controls off", () => {
  test.each(["features/settings/parts.tsx", "features/me/parts.tsx"])(
    "%s locks inside the scroll view, so the page still scrolls",
    (file) => {
      expect(read(file)).toMatch(
        /<ScrollView[\s\S]*?<Locked when=\{locked(?: \|\| frozen)?\}(?: readable=\{[^}]*\})?>[\s\S]*?\{children\}[\s\S]*?<\/Locked>\s*<\/ScrollView>/,
      );
    },
  );

  test("a sheet's question locks its field and leaves the button's spinner undimmed", () => {
    const form = read("features/shared/PromptForm.tsx");
    const field = around(form, "<TextArea");
    expect(field.open).toBeLessThan(field.at);
    expect(field.at).toBeLessThan(field.close);
    expect(form.indexOf("<Button", field.close)).toBeGreaterThan(field.close);
    expect(form).toContain("loading={busy}");
  });

  test("a card in the chat locks what it asks for while Send runs", () => {
    const card = read("features/chat/SecretCard.tsx");
    expect(card).toContain("<Locked when={busy !== null}");
    expect(card.indexOf("</Locked>")).toBeLessThan(card.indexOf('label={t("secret.send")}'));
  });

  test("fixing a memory locks its text while it saves", () => {
    const profile = read("features/agents/AgentProfileScreen.tsx");
    expect(profile).toMatch(/<Locked when=\{action\.isPending\}>\s*<TextArea value=\{text\}/);
  });

  test("answering a choice card leaves the keyboard to the composer, which `Locked` would close", () => {
    const card = read("features/blocks/ChoicesCard.tsx");
    expect(card).not.toContain("<Locked");
    expect(card).toContain("disabled={answer.isPending}");
    expect(card).toContain("answer.isPending && styles.sending");
  });

  test("signing in locks the field while the answer is on its way", () => {
    const flow = read("features/auth/AuthFlow.tsx");
    expect(flow).toContain("<Locked when={pending}");
    expect(flow).toContain("loading={pending}");
  });
});
