import { describe, expect, test } from "bun:test";
import { createMemoryPubSub, orgTopic, userTopic } from "@agenteschat/adapters";
import { publishDashboardChanged, publishWidgetChanged } from "../src/dashboards/events";

const ORG = "00000000-0000-4000-8000-000000000001";
const NINA = "user-nina";

function listen() {
  const pubsub = createMemoryPubSub();
  const org: unknown[] = [];
  const nina: unknown[] = [];
  pubsub.subscribe(orgTopic(ORG), (e) => org.push(e));
  pubsub.subscribe(userTopic(ORG, NINA), (e) => nina.push(e));
  return { pubsub, org, nina };
}

const board = (over: Partial<{ kind: string; audience: string; ownerUserId: string | null }> = {}) => ({
  id: "board-1",
  orgId: ORG,
  kind: "board",
  audience: "workspace",
  ownerUserId: NINA,
  ...over,
});

describe("dashboard events (ADR 0135)", () => {
  test("a shared board's changes go to the whole workspace, as ids only", async () => {
    const { pubsub, org, nina } = listen();
    await publishDashboardChanged(pubsub, board({ audience: "roles" }));
    await publishWidgetChanged(pubsub, board(), { id: "w-1", status: "updating" });
    expect(org).toEqual([
      { type: "org.broadcast", orgId: ORG, event: { type: "dashboard.changed", orgId: ORG, dashboardId: "board-1" } },
      {
        type: "org.broadcast",
        orgId: ORG,
        event: { type: "dashboard.widget", orgId: ORG, dashboardId: "board-1", widgetId: "w-1", status: "updating" },
      },
    ]);
    expect(nina).toEqual([]);
  });

  test("a private board and a home board are their owner's alone", async () => {
    const { pubsub, org, nina } = listen();
    await publishDashboardChanged(pubsub, board({ audience: "private" }));
    await publishWidgetChanged(pubsub, board({ kind: "home", audience: "private" }), { id: "w-2", status: "ok" });
    expect(org).toEqual([]);
    expect(nina).toEqual([
      { type: "dashboard.changed", orgId: ORG, dashboardId: "board-1" },
      { type: "dashboard.widget", orgId: ORG, dashboardId: "board-1", widgetId: "w-2", status: "ok" },
    ]);
  });

  test("a board made private, or deleted, still tells everyone who saw it", async () => {
    const { pubsub, org, nina } = listen();
    await publishDashboardChanged(pubsub, board({ audience: "private" }), { wide: true });
    await publishDashboardChanged(pubsub, board({ audience: "private" }), { deleted: true });
    expect(org).toHaveLength(2);
    expect(org[1]).toEqual({
      type: "org.broadcast",
      orgId: ORG,
      event: { type: "dashboard.changed", orgId: ORG, dashboardId: "board-1", deleted: true },
    });
    expect(nina).toEqual([]);
  });

  test("a private board nobody owns any more tells nobody", async () => {
    const { pubsub, org, nina } = listen();
    await publishDashboardChanged(pubsub, board({ audience: "private", ownerUserId: null }));
    expect(org).toEqual([]);
    expect(nina).toEqual([]);
  });
});
