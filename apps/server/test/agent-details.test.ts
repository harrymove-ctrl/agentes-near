import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

type ListedAgent = {
  id: string;
  handle: string;
  instructions: string;
  seesDetails: boolean;
  canTalk: boolean;
  budgetUsedPercent?: number;
};

const DETAIL_READS = [
  "access",
  "approval-rules",
  "browser",
  "databases",
  "learned-skills",
  "mail",
  "memories",
  "repositories",
  "scopes",
  "skills",
  "usage",
];

test("someone an agent doesn't answer sees only its public card, on every route that says how it works", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, credentialId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;

  const made = await owner(`${org}/agents`, {
    json: {
      name: "Rex",
      handle: "rex",
      model: "claude-sonnet-5-5",
      credentialId,
      instructions: "The pricing table lives in sheet 4.",
      audience: { mode: "owner", userIds: [] },
    },
  });
  expect(made.status).toBe(201);
  const rex = (await made.json()) as { id: string };
  const open = await owner(`${org}/agents`, {
    json: { name: "Ana", handle: "ana", instructions: "Answer support questions." },
  });
  const ana = (await open.json()) as { id: string };

  // The list: Rex's card without its instructions; Ana, who answers everyone, as before.
  const listed = ((await (await bia(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents;
  const rexListed = listed.find((a) => a.id === rex.id);
  expect(rexListed?.seesDetails).toBe(false);
  expect(rexListed?.instructions).toBe("");
  expect(rexListed && "budgetUsedPercent" in rexListed).toBe(false);
  expect(listed.find((a) => a.id === ana.id)?.budgetUsedPercent).toBe(0);
  expect(listed.find((a) => a.id === ana.id)?.instructions).toBe("Answer support questions.");
  expect(listed.find((a) => a.id === ana.id)?.seesDetails).toBe(true);

  // Its page: the public card, no instructions or month.
  const detail = (await (await bia(`${org}/agents/${rex.id}`)).json()) as {
    instructions: string;
    seesDetails: boolean;
    channels: unknown[];
    credentialId: string | null;
  };
  expect(detail.seesDetails).toBe(false);
  expect(detail.credentialId).toBeNull();
  expect(detail.instructions).toBe("");
  expect(Array.isArray(detail.channels)).toBe(true);

  // The Team page's card: no capabilities.
  const team = (await (await bia(`${org}/team`)).json()) as {
    agents: { id: string; capabilities: string[]; seesDetails: boolean }[];
  };
  expect(team.agents.find((a) => a.id === rex.id)?.seesDetails).toBe(false);
  expect(team.agents.find((a) => a.id === rex.id)?.capabilities).toEqual([]);

  for (const part of DETAIL_READS) {
    const res = await bia(`${org}/agents/${rex.id}/${part}`);
    expect({ part, status: res.status }).toEqual({ part, status: 403 });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent.details_hidden");
  }
  // The workspace's memory list, filtered to Rex, says nothing either.
  const items = (await (await bia(`${org}/context-items?agentId=${rex.id}`)).json()) as { items: unknown[] };
  expect(items.items).toEqual([]);
  // What it learned from her is still hers to see.
  expect((await bia(`${org}/agents/${rex.id}/memories?about=me`)).status).toBe(200);
  // Ana answers her: her tools and memory are open to her.
  expect((await bia(`${org}/agents/${ana.id}/access`)).status).toBe(200);
  expect((await bia(`${org}/agents/${ana.id}/memories`)).status).toBe(200);
  // Its owner sees everything.
  expect((await owner(`${org}/agents/${rex.id}/access`)).status).toBe(200);
  const own = (await (await owner(`${org}/agents/${rex.id}`)).json()) as { instructions: string; seesDetails: boolean };
  expect(own).toMatchObject({ instructions: "The pricing table lives in sheet 4.", seesDetails: true });

  // Let into its audience, she reads how it works.
  const me = (await (await bia("/api/app/me")).json()) as { user: { id: string } };
  const widened = await owner(`${org}/agents/${rex.id}`, {
    method: "PATCH",
    json: { audience: { mode: "people", userIds: [me.user.id] } },
  });
  expect(widened.status).toBe(200);
  expect((await bia(`${org}/agents/${rex.id}/access`)).status).toBe(200);
  const now = (await (await bia(`${org}/agents/${rex.id}`)).json()) as { instructions: string };
  expect(now.instructions).toBe("The pricing table lives in sheet 4.");
});

test("an admin who isn't in the audience still sees every detail", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const admin = await joinByInvitation(t, owner, orgId, "admin@example.com", { role: "admin" });
  const org = `/api/app/organizations/${orgId}`;
  const rex = (await (
    await owner(`${org}/agents`, {
      json: { name: "Rex", handle: "rex", instructions: "Private notes.", audience: { mode: "owner", userIds: [] } },
    })
  ).json()) as { id: string };
  const listed = ((await (await admin(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents;
  expect(listed.find((a) => a.id === rex.id)).toMatchObject({ seesDetails: true, instructions: "Private notes." });
  expect((await admin(`${org}/agents/${rex.id}/access`)).status).toBe(200);
});

test("the owner and admins see another admin's agent kept to a role they don't hold, in every list and on its page, and manage it", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  const walt = await joinByInvitation(t, owner, orgId, "walt@example.com", { role: "admin" });
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com", { role: "admin" });
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const support = (await (await owner(`${org}/roles`, { json: { name: "Suporte", permissions: [] } })).json()) as {
    id: string;
  };
  const rex = (await (
    await walt(`${org}/agents`, {
      json: {
        name: "Rex",
        handle: "rex",
        instructions: "Walt's notes.",
        audience: { mode: "people", userIds: [], roleIds: [support.id] },
      },
    })
  ).json()) as { id: string };

  for (const admin of [owner, caio]) {
    const listed = ((await (await admin(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents;
    expect(listed.find((a) => a.id === rex.id)).toMatchObject({
      seesDetails: true,
      canTalk: false,
      instructions: "Walt's notes.",
    });
    const page = (await (await admin(`${org}/agents/${rex.id}`)).json()) as {
      seesDetails: boolean;
      instructions: string;
    };
    expect(page).toMatchObject({ seesDetails: true, instructions: "Walt's notes." });
    const team = (await (await admin(`${org}/team`)).json()) as { agents: { id: string; seesDetails: boolean }[] };
    expect(team.agents.find((a) => a.id === rex.id)?.seesDetails).toBe(true);
    for (const part of DETAIL_READS) {
      const res = await admin(`${org}/agents/${rex.id}/${part}`);
      expect({ part, status: res.status }).toEqual({ part, status: 200 });
    }
    // Its conversation opens (locked in the apps), not a refusal.
    expect((await admin(`${org}/dms`, { json: { agentId: rex.id } })).status).toBe(200);
  }
  const edited = await caio(`${org}/agents/${rex.id}`, { method: "PATCH", json: { role: "Suporte" } });
  expect(edited.status).toBe(200);

  // A member outside it: the public card, and no new conversation.
  const forBia = ((await (await bia(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents;
  expect(forBia.find((a) => a.id === rex.id)).toMatchObject({ seesDetails: false, instructions: "" });
  expect((await bia(`${org}/agents/${rex.id}/access`)).status).toBe(403);
  expect((await bia(`${org}/dms`, { json: { agentId: rex.id } })).status).toBe(403);
});

test("what the agents know of the workspace is only for who configures it", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;

  const mine = (await (await owner(`${org}/settings`)).json()) as { context: string };
  expect(mine.context).toBe("Acme builds rockets.");
  const hers = (await (await bia(`${org}/settings`)).json()) as { context: string; timezone: string };
  expect(hers.context).toBe("");
  expect(typeof hers.timezone).toBe("string");
  const summary = (await (await bia(org)).json()) as { context: string };
  expect(summary.context).toBe("");
  expect(((await (await owner(org)).json()) as { context: string }).context).toBe("Acme builds rockets.");
  // Changing it stays admins'.
  expect((await bia(`${org}/settings`, { method: "PATCH", json: { context: "x" } })).status).toBe(403);
});

test("an agent's playbook comes with its plain summary, only for its owner and admins", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const made = await owner(`${org}/agents`, {
    json: { name: "Ana", handle: "ana", instructions: "Answer support questions." },
  });
  const ana = (await made.json()) as { id: string };
  const item = (kind: "note" | "fact", title: string, content: string) => ({
    orgId,
    kind,
    scopeType: "agent",
    scopeId: ana.id,
    agentId: ana.id,
    subjectKey: title.toLowerCase(),
    title,
    content,
    channelIds: [],
    createdByKind: "agent",
  });
  await t.db
    .insert(schema.contextItems)
    .values([
      item("note", "Como gravar senhas sem expô-las", "supabase secrets set KEY=…; read it with Deno.env.get"),
      item("fact", "", "The office closes at 18:00."),
    ]);
  type Mem = { text: string; summary: string | null; playbook: boolean };
  const list = async (b: typeof owner) =>
    ((await (await b(`${org}/agents/${ana.id}/memories`)).json()) as { memories: Mem[] }).memories
      .map((m) => ({ text: m.text, summary: m.summary, playbook: m.playbook }))
      .sort((a, b) => a.text.localeCompare(b.text));
  expect(await list(owner)).toEqual([
    {
      text: "supabase secrets set KEY=…; read it with Deno.env.get",
      summary: "Como gravar senhas sem expô-las",
      playbook: true,
    },
    { text: "The office closes at 18:00.", summary: null, playbook: false },
  ]);
  expect(await list(bia)).toEqual([{ text: "The office closes at 18:00.", summary: null, playbook: false }]);
});
