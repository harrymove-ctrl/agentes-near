import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { agentGrammar } from "../src/lib/grammar";

test("an agent's gender is an i18next context: female for names ending in a, none for the rest", () => {
  expect(agentGrammar("Ada")).toEqual({ name: "Ada", context: "female" });
  expect(agentGrammar("Iris")).toEqual({ name: "Iris", context: "female" });
  expect(agentGrammar("Theo")).toEqual({ name: "Theo", context: undefined });
});

test("a pt-BR `key_female` reads through `t`; English and a language without it keep the base key", () => {
  const t = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
    return instance.t.bind(instance) as (key: string, o: object) => string;
  };
  expect(t("pt-BR")("chat.joined.tip", agentGrammar("Ada"))).toContain("a Ada");
  expect(t("pt-BR")("chat.joined.tip", agentGrammar("Theo"))).toContain("o Theo");
  expect(t("en")("noAi.agent", agentGrammar("Ada"))).toBe("Ada won't reply because she has no AI connected.");
  // ko has no `_female` form: Ada reads its base key.
  const ko = (resources.ko.translation as { noAi: { agent: string } }).noAi.agent;
  expect(t("ko")("noAi.agent", agentGrammar("Ada"))).toBe(ko.replace("{{name}}", "Ada"));
});
