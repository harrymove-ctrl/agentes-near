import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { grantScopes, type ToolSource } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

const WHY = "The reporter confirmed it works now: closing the ticket ends the follow-up.";
const closed: Record<string, unknown>[] = [];
/** The custom server's connection (set once the workspace exists), and whether its tool may be approved for good. */
const server = { connectionId: "", rememberable: true };
const tickets: ToolSource = {
  name: "test-custom-server",
  tools: async () =>
    server.connectionId
      ? [
          {
            name: "suporte_close_ticket",
            description: "Close a ticket",
            scope: `custom:${server.connectionId}:write`,
            connectionId: server.connectionId,
            connectorLabel: "Suporte",
            sensitive: true,
            ...(server.rememberable ? { rememberAs: "close_ticket" } : {}),
            inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            describe: (i) => ({ title: `Suporte: Fechar chamado #${i.id}` }),
            execute: async (input) => {
              closed.push(input);
              return { content: "closed" };
            },
          },
        ]
      : [],
};

let t: TestServer;
beforeEach(async () => {
  closed.length = 0;
  server.connectionId = "";
  server.rememberable = true;
  t = await createTestServer({
    // The person from another workspace signs up too.
    env: { ALLOW_SIGNUP: "true" },
    toolSources: [tickets],
    reply: (req) => {
      const said = JSON.stringify(req.messages);
      if (JSON.stringify(req.messages.at(-1)?.content).includes("closed")) return { chunks: ["Fechado."] };
      const id = Number([...said.matchAll(/fecha o (\d+)/g)].at(-1)?.[1] ?? 0);
      return { chunks: [], toolUses: [{ name: "suporte_close_ticket", input: { id, why: WHY } }] };
    },
  });
});
afterEach(() => t.close());

type Approval = { id: string; status: string; approveAlways: { tool: string; actions: string[] } | null };
type Rules = { rules: { id: string; server: string; tool: string; toolLabel: string; action: string }[] };

async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const [connection] = await t.db
    .insert(schema.connectorConnections)
    .values({
      orgId,
      connector: "custom:suporte",
      label: "Suporte",
      toolPrefix: "suporte",
      serverUrl: "https://tickets.example.com/mcp",
      authType: "none",
    })
    .returning();
  server.connectionId = connection?.id ?? "";
  await grantScopes(t.db, orgId, agentId, [
    { connectionId: server.connectionId, scope: `custom:${server.connectionId}:write` },
  ]);
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const ask = async (body: string) => {
    await api(owner, `/channels/${channelId}/messages`, { json: { body } });
    await t.drain();
    const list = (await (await api(owner, "/approvals?status=pending")).json()) as { approvals: Approval[] };
    return list.approvals;
  };
  return { owner, orgId, agentId, api, ask };
}

test("Aprovar sempre over HTTP: who decides approves for good, the next one runs, the rule is listed and removed", async () => {
  const { owner, orgId, agentId, api, ask } = await workspace();
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  const theirs = await seedOrg(stranger);

  const [first] = await ask("@dev fecha o 1");
  expect(first).toMatchObject({ status: "pending", approveAlways: { tool: "close_ticket", actions: [] } });
  const id = first?.id ?? "";
  // Who can't decide it can't approve it for good; from another workspace it isn't there.
  expect((await api(member, `/approvals/${id}/approve`, { json: { always: true } })).status).toBe(403);
  const across = await stranger(`/api/app/organizations/${theirs.orgId}/approvals/${id}/approve`, {
    json: { always: true },
  });
  expect(across.status).toBe(404);
  const approved = await api(owner, `/approvals/${id}/approve`, { json: { always: true } });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ status: "approved" });
  await t.drain();
  expect(closed).toEqual([{ id: 1 }]);

  // Every member sees the rule; another workspace doesn't find the agent.
  const listed = (await (await api(member, `/agents/${agentId}/approval-rules`)).json()) as Rules;
  expect(listed.rules).toMatchObject([
    { server: "Suporte", tool: "close_ticket", toolLabel: "close_ticket", action: "" },
  ]);
  const ruleId = listed.rules[0]?.id ?? "";
  expect((await stranger(`/api/app/organizations/${theirs.orgId}/agents/${agentId}/approval-rules`)).status).toBe(404);

  // The next one of that kind runs without a card.
  expect(await ask("@dev fecha o 2")).toEqual([]);
  expect(closed).toEqual([{ id: 1 }, { id: 2 }]);

  // Only who decides removes it; then it asks again.
  const rule = `/agents/${agentId}/approval-rules/${ruleId}`;
  expect((await api(member, rule, { method: "DELETE" })).status).toBe(403);
  expect(
    (
      await stranger(`/api/app/organizations/${theirs.orgId}/agents/${theirs.agentId}/approval-rules/${ruleId}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(404);
  expect((await api(owner, rule, { method: "DELETE" })).status).toBe(204);
  expect(((await (await api(owner, `/agents/${agentId}/approval-rules`)).json()) as Rules).rules).toEqual([]);
  const [again] = await ask("@dev fecha o 3");
  expect(again?.status).toBe("pending");
  expect(closed).toHaveLength(2);
});

test("approving for good where it isn't offered is a 409, and the request stays waiting", async () => {
  server.rememberable = false;
  const { api, ask, owner } = await workspace();
  const [first] = await ask("@dev fecha o 1");
  expect(first?.approveAlways).toBeNull();
  const res = await api(owner, `/approvals/${first?.id}/approve`, { json: { always: true } });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "approval.always_unavailable" } });
  const [still] = (
    (await (await api(owner, "/approvals?status=pending")).json()) as {
      approvals: Approval[];
    }
  ).approvals;
  expect(still?.id).toBe(first?.id);
});
