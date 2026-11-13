import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { toolName } from "../src/lib/tool-review";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};

test("a tool's name in the language's word order: the verb last in ja and ko", () => {
  const parts = { verb: "get", words: ["campaign", "budget"] };
  expect(toolName(tFor("en"), parts, "campaign_budget_get")).toBe("Get campaign budget");
  expect(toolName(tFor("pt-BR"), parts, "campaign_budget_get")).toBe("Ver orçamento da campanha");
  expect(toolName(tFor("ja"), parts, "campaign_budget_get")).toBe("キャンペーンの 予算 取得");
  expect(toolName(tFor("ko"), parts, "campaign_budget_get")).toBe("캠페인 예산 조회");
});
