import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { serverBody } from "../src/lib/message-body";
import { showsActivity } from "../src/lib/work";

test("a reply's tools show only for a person who turned them on: off by default and with an older server", () => {
  expect(showsActivity({ showActivity: true })).toBe(true);
  expect(showsActivity({ showActivity: false })).toBe(false);
  expect(showsActivity({})).toBe(false);
  expect(showsActivity(null)).toBe(false);
});

test("a secret request's text names who asked; one posted before that reads without a name", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const meta = (bodyParams: Record<string, string>) => ({ bodyCode: "secret_request", bodyParams });
  expect(serverBody(t, "…", meta({ agent: "Ada", name: "BILLING_API_KEY" }))).toBe("chat.body.secret_request");
  expect(serverBody(t, "…", meta({ name: "BILLING_API_KEY" }))).toBe("chat.body.secret_requestAnon");
});

test("a computer brain cut mid-turn says what it already did in the person's words, never the tools' names", async () => {
  const { resources } = await import("@agenteschat/i18n");
  const i18next = (await import("i18next")).default;
  const lang = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
    return instance.t;
  };
  const meta = {
    brainInterrupted: {
      brain: "claude_code",
      text: "",
      tools: ["run_code", "mcp__agentes__update_plan", "github_list_issues", "run_code"],
    },
  };
  expect(serverBody(lang("pt-BR"), "…", meta, "pt-BR")).toBe(
    "_O Claude Code parou antes de terminar. Já feito, sem repetir: rodou código no PC, atualizou o plano e consultou o GitHub._",
  );
  expect(serverBody(lang("en"), "…", meta, "en")).toBe(
    "_Claude Code stopped before finishing. Already done, not repeated: ran code on the PC, updated the plan, and checked GitHub._",
  );
});
