import { expect, test } from "bun:test";
import { openTarget } from "@agenteschat/client/lib/notifications";
import { notificationHref } from "../../src/features/links/logic";
import { notification } from "./fixtures";

test("an agent's model that left its plan's list opens where another is chosen: its model on the phone, Quem pensa's model screen on the web", () => {
  const n = notification({
    id: "n-dropped",
    kind: "plan_model_dropped",
    source: { agentId: "ag-1", label: "Ada" },
    latest: { title: "DeepSeek V4.1 Flash", plan: "OpenCode Go", nowModel: "MiniMax M3" },
  });
  expect(notificationHref(n)).toBe("/agent-model/ag-1");
  expect(openTarget(n)).toEqual({
    to: "/org/$orgId/agents/$agentId",
    params: { agentId: "ag-1" },
    // The web's dialog opens straight on the model's screen (`brain=model`), as the phone opens its model.
    search: { sec: "brain", brain: "model" },
  });
  expect(notificationHref({ ...n, source: { agentId: "../x" } })).toBeNull();
});
