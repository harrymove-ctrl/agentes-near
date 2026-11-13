import { afterEach, expect, test } from "bun:test";
import { ISSUE_CARD_FIELDS, ISSUES_GROUPS, ISSUES_SORTS, ISSUES_VIEW_DEFAULT } from "@agenteschat/engine";
import {
  ISSUES_VIEW_DEFAULT as APP_DEFAULT,
  ISSUE_CARD_FIELDS as APP_FIELDS,
  ISSUES_GROUPS as APP_GROUPS,
  ISSUES_SORTS as APP_SORTS,
} from "../../../packages/client/src/lib/issues-view";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("Tarefas' view: the engine and the apps know the same parts and start from the same default", () => {
  expect([...APP_FIELDS]).toEqual([...ISSUE_CARD_FIELDS]);
  expect([...APP_GROUPS]).toEqual([...ISSUES_GROUPS]);
  expect([...APP_SORTS]).toEqual([...ISSUES_SORTS]);
  expect(APP_DEFAULT).toEqual(ISSUES_VIEW_DEFAULT);
});

/** A new workspace, set up (one still in its onboarding would come back instead of another). */
async function workspace(b: ReturnType<typeof browser>, name: string) {
  const created = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  const orgId = created.organization.id;
  await b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  return orgId;
}

const mine = {
  layout: "list",
  group: "assignee",
  sort: "priority",
  fields: { assignee: true, priority: true, due: false, criteria: true, pullRequest: false, label: true },
  assignees: ["none"],
  priorities: ["high"],
  showCanceled: true,
};

test("Tarefas' view: each person's own, per workspace, on every device; known parts only", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const path = `/api/app/organizations/${orgId}/me/issues-view`;
  const viewOf = async (b = owner, at = path) => ((await (await b(at)).json()) as { view: unknown }).view;

  // Never changed: the default.
  expect(await viewOf()).toEqual(ISSUES_VIEW_DEFAULT);

  const saved = await owner(path, { method: "PUT", json: { view: mine } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ view: mine });
  expect(await viewOf()).toEqual(mine);

  // A filter twice is kept once; a part the app doesn't know is dropped.
  const twice = { ...mine, assignees: ["none", "none"], extra: 1 };
  expect(await (await owner(path, { method: "PUT", json: { view: twice } })).json()).toEqual({ view: mine });

  // A layout, a grouping, an order, a priority or an assignee the app doesn't know, or a part missing: refused, kept.
  const { showCanceled: _, ...partial } = mine;
  for (const bad of [
    { ...mine, layout: "grid" },
    { ...mine, group: "label" },
    { ...mine, sort: "random" },
    { ...mine, priorities: ["urgent"] },
    { ...mine, assignees: ["robot:1"] },
    { ...mine, fields: { ...mine.fields, label: "yes" } },
    partial,
  ])
    expect((await owner(path, { method: "PUT", json: { view: bad } })).status).toBe(400);
  expect(await viewOf()).toEqual(mine);

  // Someone else in the workspace keeps their own; so does the owner in another workspace.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await viewOf(member)).toEqual(ISSUES_VIEW_DEFAULT);
  await member(path, { method: "PUT", json: { view: { ...ISSUES_VIEW_DEFAULT, layout: "list" } } });
  expect(await viewOf()).toEqual(mine);
  const other = await workspace(owner, "Beta");
  expect(await viewOf(owner, `/api/app/organizations/${other}/me/issues-view`)).toEqual(ISSUES_VIEW_DEFAULT);

  // "Voltar ao padrão".
  expect(await (await owner(path, { method: "PUT", json: { view: ISSUES_VIEW_DEFAULT } })).json()).toEqual({
    view: ISSUES_VIEW_DEFAULT,
  });
  expect(await viewOf(member)).toEqual({ ...ISSUES_VIEW_DEFAULT, layout: "list" });

  // Not a member (invited, not in yet): refused.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "stranger@example.com" } });
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(path)).status).toBe(403);
  expect((await stranger(path, { method: "PUT", json: { view: mine } })).status).toBe(403);
});
