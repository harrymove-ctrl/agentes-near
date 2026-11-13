import { expect, test } from "bun:test";
import { AGENT_ACTION_KINDS, WORKSPACE_ACTIONS } from "@agenteschat/engine";
import { AGENT_ACTION_KINDS as APP_KINDS, WORKSPACE_ACTION_IDS } from "../../../packages/client/src/api/types";
import { AgentAction } from "../src/routes/app/schemas";

// The apps' tables (sentences, icons) are checked against the apps' list in their own tests.
test("receipt kinds: the engine, the API's enum and the apps know the same ones", () => {
  const engine = [...AGENT_ACTION_KINDS].sort();
  expect([...AgentAction.shape.kind.options].sort()).toEqual(engine);
  expect([...APP_KINDS].sort()).toEqual(engine);
});

test("the right hand's catalog actions: the apps word the same ones the engine does", () => {
  expect([...WORKSPACE_ACTION_IDS].sort() as string[]).toEqual(WORKSPACE_ACTIONS.map((a) => a.id).sort());
});
