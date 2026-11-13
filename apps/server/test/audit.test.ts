import { afterEach, beforeEach, expect, test } from "bun:test";
import { recordAudit, recordToolCall } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

test("the audit log: admins read agents' calls and people's changes, filtered; members get 403", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, agentId, channelId } = await seedOrg(owner);
  await recordAudit(t.db, {
    orgId,
    actor: { type: "person", id: ownerId },
    action: "storage.activated",
    target: { type: "storage", id: null },
  });
  await recordToolCall(t.db, {
    orgId,
    agentId,
    runId: null,
    channelId,
    authority: { kind: "person", personId: ownerId },
    tool: "mail_sales_send",
    kind: "external",
    connector: "Gmail",
    input: { to: "joao@acme.com", subject: "Proposta", apiKey: "sk-ant-api-secret-9876" },
    outcome: "done",
  });

  type Page = {
    rows: {
      actor: { type: string; name: string | null };
      action: string;
      outcome: string | null;
      onBehalfOf: { id: string } | null;
      details: Record<string, unknown>;
    }[];
    next: string | null;
  };
  const res = await owner(`/api/app/organizations/${orgId}/audit`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("sk-ant-api-secret-9876");
  const page = JSON.parse(text) as Page;
  // Newest first (setting up the workspace wrote rows of its own before these).
  expect(page.rows.slice(0, 2).map((r) => r.action)).toEqual(["tool.call", "storage.activated"]);
  expect(page.rows[0]).toMatchObject({
    actor: { type: "agent", name: "Dev" },
    outcome: "done",
    onBehalfOf: { id: ownerId },
    details: { kind: "external", connector: "Gmail", behind: "person", input: { to: "joao@acme.com" } },
  });

  const changes = (await (await owner(`/api/app/organizations/${orgId}/audit?kind=change`)).json()) as Page;
  expect(changes.rows[0]?.action).toBe("storage.activated");
  expect(changes.rows.some((r) => r.action === "tool.call")).toBe(false);
  const agentOnly = (await (
    await owner(`/api/app/organizations/${orgId}/audit?actorType=agent&outcome=done`)
  ).json()) as Page;
  expect(agentOnly.rows).toHaveLength(1);
  const wrong = (await (await owner(`/api/app/organizations/${orgId}/audit?outcome=refused,failed`)).json()) as Page;
  expect(wrong.rows).toEqual([]);
  expect((await owner(`/api/app/organizations/${orgId}/audit?outcome=done,nope`)).status).toBe(400);
  expect(page.rows[0]).toMatchObject({ channel: { id: channelId, kind: "channel" }, approval: null });

  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  expect((await member(`/api/app/organizations/${orgId}/audit`)).status).toBe(403);
});
