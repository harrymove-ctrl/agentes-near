import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS } from "@agenteschat/providers";
import type { TFunction } from "i18next";
import {
  apiModelName,
  autoMakerOf,
  keyLine,
  keyLooksValid,
  keyStepHint,
  PROVIDERS,
  providerGuess,
  providerOf,
  providersForKey,
} from "../src/lib/providers";

const ids = (key: string) => providersForKey(key).map((p) => p.id);
const AQ = "AQ.Ab8RN6LxSampleOnlyKey_0123456789-abc";
const AIZA = "AIzaSyD-sample0only1key2for3tests4567";
// Joined at run time: the secret scan reads a literal OpenRouter key shape as a real key.
const OPENROUTER = ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-");

describe("whose key is it", () => {
  test("the same providers as the server's catalog, the most used first: Claude, OpenAI, Gemini, OpenRouter", () => {
    // A workspace's own endpoint (`custom`) has a form of its own, never a key's.
    const ids = PROVIDERS.map((p) => p.id);
    expect([...ids].sort()).toEqual(PROVIDER_IDS.filter((id) => id !== "custom").sort());
    expect(ids.slice(0, 4)).toEqual(["anthropic", "openai", "gemini", "openrouter"]);
  });

  test("a Gemini key, either kind AI Studio hands out, fits Gemini alone, whichever provider was chosen", () => {
    expect(ids(AQ)).toEqual(["gemini"]);
    expect(ids(AIZA)).toEqual(["gemini"]);
    expect(providerGuess(AQ, "anthropic")).toBe("gemini");
    expect(providerGuess(AIZA, "zai")).toBe("gemini");
    expect(keyLooksValid("gemini", ` ${AQ} `)).toBe(true);
    expect(keyLooksValid("gemini", "AQ.short")).toBe(false);
    expect(keyLooksValid("gemini", "sk-0123456789abcdef0123456789abcdef")).toBe(false);
  });

  test("other keys keep their providers: any sk- key could be several, Claude's and the plans' are their own", () => {
    expect(ids("sk-0123456789abcdef0123456789abcdef")).toEqual(["openai", "deepseek", "moonshot", "minimax"]);
    expect(ids("sk-ant-api03-abcdefghijklmnop")).toEqual(["anthropic"]);
    expect(ids("0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp")).toEqual(["zai", "minimax"]);
    // A MiniMax plan key (sk-cp-) never fits MiniMax.
    expect(ids("sk-cp-abcdefghijklmnopqrst")).toEqual(["openai"]);
  });

  test("an OpenRouter key fits OpenRouter alone, whichever provider was chosen", () => {
    expect(ids(OPENROUTER)).toEqual(["openrouter"]);
    expect(providerGuess(OPENROUTER, "openai")).toBe("openrouter");
    expect(keyLooksValid("openrouter", ` ${OPENROUTER} `)).toBe(true);
    expect(keyLooksValid("openrouter", "sk-or-v1-short")).toBe(false);
    expect(keyLooksValid("openrouter", "sk-0123456789abcdef0123456789abcdef")).toBe(false);
    expect(providerOf("openrouter")).toMatchObject({ label: "OpenRouter", site: "openrouter.ai/keys" });
  });

  test("the key panel's first step: where a plan's key goes, billing, OpenRouter's privacy; nothing for the others", () => {
    const hint = (id: string) => {
      const p = providerOf(id);
      return p && keyStepHint(p);
    };
    expect(hint("moonshot")).toBe("connectAi.key.notPlan");
    expect(hint("gemini")).toBe("connectAi.key.billing");
    expect(hint("anthropic")).toBeUndefined();
    expect(hint("openai")).toBeUndefined();
    // OpenRouter passes what is sent on to other providers: its own privacy settings say who may keep it.
    expect(hint("openrouter")).toBe("connectAi.key.privacy");
  });
});

describe("a saved key's line", () => {
  const t = ((key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o)}`) as unknown as TFunction;
  test("a key named after its provider says only how it ends, any other name says the provider too", () => {
    expect(keyLine(t, { label: "Claude", provider: "anthropic", keyHint: "0000" })).toBe(
      'vault.item.endsIn {"hint":"0000"}',
    );
    expect(keyLine(t, { label: " claude ", provider: "anthropic", keyHint: "0000" })).toBe(
      'vault.item.endsIn {"hint":"0000"}',
    );
    expect(keyLine(t, { label: "Marketing", provider: "anthropic", keyHint: "0000" })).toBe(
      'newAgent.otherKeyDesc {"provider":"Claude","hint":"0000"}',
    );
  });
});

describe("what an agent on a key thinks with, by name", () => {
  const t = ((key: string) => (key === "brain.auto.label" ? "Automático" : key)) as unknown as TFunction;
  test("on Automático, the maker of the key it runs on, as the right hand's panel names its key; else its model", () => {
    const status = { agents: [{ agentId: "iara", provider: "anthropic" }, { agentId: "otto" }] };
    expect(autoMakerOf(status, "iara")).toBe("anthropic");
    expect(apiModelName(t, "auto", undefined, autoMakerOf(status, "iara"))).toBe("Claude");
    // No key known yet (or no AI): the mode's own name.
    expect(apiModelName(t, "auto", undefined, autoMakerOf(status, "otto"))).toBe("Automático");
    expect(apiModelName(t, "auto", undefined, autoMakerOf(undefined, "iara"))).toBe("Automático");
    // A model picked by name keeps it.
    expect(apiModelName(t, "claude-sonnet-5-5", "Sonnet 5.5", "anthropic")).toBe("Sonnet 5.5");
    expect(apiModelName(t, "my-model", undefined, undefined)).toBe("my-model");
  });
});
