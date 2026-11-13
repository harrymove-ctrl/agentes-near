import { expect, test } from "bun:test";
import type { AgentBrain } from "../src/api/types";
import { mineStatus } from "../src/lib/right-hand";

/** "Sua IA" (ADR 0137 §11): the one status the web's side panel and the phone's profile draw. */

const view = (over: Partial<AgentBrain>) =>
  ({ brain: "model", account: null, accounts: [], ...over }) as unknown as AgentBrain;
const ws = (ai: NonNullable<AgentBrain["workspaceAi"]>) => view({ workspaceAi: ai });

test("a plan of mine, or one lent to me, answers me: its account, and whose it is when it isn't mine", () => {
  const accounts = [{ id: "a1", label: "Claude Max", ownerId: "u-ana" }] as AgentBrain["accounts"];
  expect(mineStatus(view({ brain: "claude_code", account: "a1", accounts }), "u-me", false)).toEqual({
    kind: "own",
    brain: "claude_code",
    label: "Claude Max",
    ownerId: "u-ana",
  });
  expect(mineStatus(view({ brain: "claude_code", account: "a1", accounts }), "u-ana", false)).toEqual({
    kind: "own",
    brain: "claude_code",
    label: "Claude Max",
    ownerId: undefined,
  });
});

test("without a plan of mine: the workspace's key, this server's own where it has none, or its plan if it serves me", () => {
  const key = { provider: "anthropic", label: "Claude" };
  expect(mineStatus(ws({ brain: "model", ownerId: null, servesYou: true, key }), "u-me", false)).toEqual({
    kind: "key",
    label: "Claude",
    provider: "anthropic",
  });
  expect(mineStatus(ws({ brain: "model", ownerId: null, servesYou: true, key: null }), "u-me", true)).toEqual({
    kind: "key",
  });
  // This server's own key, by the maker the right hand's models come from: its logo and name, never a key glyph.
  expect(
    mineStatus(ws({ brain: "model", ownerId: null, servesYou: true, key: null }), "u-me", true, "anthropic"),
  ).toEqual({ kind: "key", label: "Claude", provider: "anthropic" });
  expect(mineStatus(ws({ brain: "codex", ownerId: "u-ana", servesYou: true }), "u-me", false)).toEqual({
    kind: "plan",
    brain: "codex",
  });
});

test("nobody answers me: no key and no server key, or a plan that serves only its owner", () => {
  expect(mineStatus(ws({ brain: "model", ownerId: null, servesYou: true, key: null }), "u-me", false)).toEqual({
    kind: "nobody",
  });
  expect(mineStatus(ws({ brain: "codex", ownerId: "u-ana", servesYou: false }), "u-me", false)).toEqual({
    kind: "nobody",
  });
  expect(mineStatus(undefined, "u-me", false)).toBeNull();
});
