import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import { keyRemovalText } from "../src/lib/ai-accounts";
import { keyRefusal } from "../src/lib/errors";
import { rightHandFallback, rightHandOnKey, thinksWithLine } from "../src/lib/right-hand";

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", resources, initAsync: false });
const t: TFunction = i18n.t.bind(i18n);

const refused = (code: string, params: Record<string, unknown>) => new ApiError(422, code, "refused", params);

test("a key with no credit says why, in the provider's words, and where to add it", () => {
  const out = keyRefusal(
    t,
    refused("provider_key_no_credit", { provider: "OpenAI", said: "You exceeded your quota." }),
  );
  expect(out?.text).toContain("OpenAI says this key has no credit");
  expect(out?.text).toContain("OpenAI said: You exceeded your quota.");
  expect(out?.href).toBe("https://platform.openai.com/settings/organization/billing/overview");
  expect(out?.site).toBe("platform.openai.com");
});

test("a refused key points at the provider's keys page, and any other failure isn't a refusal", () => {
  expect(keyRefusal(t, refused("provider_key_invalid", { provider: "Claude", said: "" }))?.href).toBe(
    "https://platform.claude.com/settings/keys",
  );
  expect(keyRefusal(t, refused("org.paused", {}))).toBeNull();
  expect(keyRefusal(t, new Error("x"))).toBeNull();
});

test("removing a key says what happens to the agents on it, before it happens", () => {
  const key = { id: "k1", usedBy: [{ id: "a", name: "Lodi" }] };
  expect(keyRemovalText(t, { id: "k1", usedBy: [] }, [{ id: "k1" }], false)).toContain("No agent thinks with it");
  expect(keyRemovalText(t, key, [{ id: "k1" }], false)).toContain("Lodi thinks with this key and has nothing else");
  expect(keyRemovalText(t, key, [{ id: "k1" }, { id: "k2" }], false)).toContain("moves to another key");
  expect(keyRemovalText(t, key, [{ id: "k1" }], true)).toContain("moves to another key");
  const two = { id: "k1", usedBy: [...key.usedBy, { id: "b", name: "Rio" }] };
  expect(keyRemovalText(t, two, [{ id: "k1" }], false)).toContain("think with this key and have nothing else");
});

test("the right hand's words say which of its AIs moved", () => {
  expect(thinksWithLine(t, "workspace", "Lodi", "OpenAI")).toBe(
    "Lodi now thinks with OpenAI for everyone without a plan of their own.",
  );
  expect(thinksWithLine(t, "mine", "Lodi", "ChatGPT")).toBe(
    "Your conversation with Lodi now thinks with ChatGPT. Only yours does.",
  );
  expect(thinksWithLine(t, undefined, "Rio", "OpenAI")).toBe("Rio now thinks with OpenAI.");
});

test("what a person without a plan reads names the key, or that there is none", () => {
  const ai = { brain: "model", ownerId: null, servesYou: true } as const;
  const say = (over: object, platform = false) =>
    rightHandFallback(t, { ...ai, ...over }, "me", { name: "Lodi" }, () => undefined, platform);
  expect(say({ key: { provider: "openai", label: "OpenAI" } })).toContain("the workspace's key: OpenAI");
  expect(say({ key: null })).toContain("no API key yet");
  expect(say({ key: null }, true)).toContain("the workspace's API key");
});

test("a key for the right hand: the workspace's moves first, so a refusal leaves the person's own; a model it can't run becomes Automatic", async () => {
  const calls: unknown[] = [];
  const api = {
    agents: {
      setBrain: async (_o: string, _a: string, input: unknown) => void calls.push(input),
      update: async (_o: string, _a: string, patch: unknown) => void calls.push(patch),
    },
  } as never;
  await rightHandOnKey(api, "o", { id: "lodi", model: "claude-opus" }, { id: "k1", provider: "openai" }, []);
  expect(calls).toEqual([
    { scope: "workspace", brain: "model" },
    { credentialId: "k1", model: "auto" },
    { brain: "model" },
  ]);
});
