import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ModelRequest } from "@agenteschat/providers";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** "cria um agente" proposes Ada; the tool's answer gets a short reply. */
function reply(req: ModelRequest) {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Propus a Ada no card."] };
  if (last.includes("cria um agente que checa meus emails")) {
    return {
      chunks: [],
      toolUses: [
        {
          name: "propose_agent",
          input: {
            name: "Caio",
            handle: "caio",
            role: "E-mail",
            instructions: "Cuida dos e-mails.",
            routine: { schedule: "0 12 * * *", prompt: "Lê a caixa de entrada e resume o que chegou." },
            why: "Você pediu alguém para checar seus e-mails ao meio-dia.",
          },
        },
      ],
    };
  }
  if (last.includes("cria um agente")) {
    return {
      chunks: [],
      toolUses: [
        {
          name: "propose_agent",
          input: {
            name: "Ada",
            handle: "ada",
            role: "Designer",
            instructions: "Desenha as telas.",
            channels: ["general"],
            why: "Você pediu alguém para o design.",
          },
        },
      ],
    };
  }
  return { chunks: ["Ok."] };
}

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply });
});
afterEach(() => t.close());

type Proposal = {
  state: string;
  canDecide: boolean;
  agentId: string | null;
  params: { draft: { name: string; handle: string; channelIds: string[]; ai: { kind: string } } };
};

test("an agent's proposal of a new agent: created from the card with what the person edited, or denied", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const ask = async () => {
    await api(`/channels/${channelId}/messages`, { json: { body: "@dev cria um agente de design" } });
    await t.drain();
    const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
      messages: { id: string; meta?: { actionCard?: { kind?: string } } }[];
    };
    const card = timeline.messages.filter((m) => m.meta?.actionCard?.kind === "agent_proposal").at(-1);
    if (!card) throw new Error("no card");
    return card.id;
  };
  const first = await ask();
  const proposal = (await (await api(`/agent-proposals/${first}`)).json()) as Proposal;
  expect(proposal).toMatchObject({
    state: "pending",
    canDecide: true,
    params: { draft: { name: "Ada", handle: "ada", channelIds: [channelId], ai: { kind: "model" } } },
  });

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  await asMember(`/channels/${channelId}/join`, { json: {} });
  // Read-only for who can't create agents.
  expect(((await (await asMember(`/agent-proposals/${first}`)).json()) as Proposal).canDecide).toBe(false);
  expect((await asMember(`/agent-proposals/${first}/deny`, { json: {} })).status).toBe(403);
  expect((await asMember("/agents", { json: { name: "Ada", handle: "ada", proposal: first } })).status).toBe(403);

  // Created from the card, with the person's edits.
  const created = await api("/agents", {
    json: { name: "Ada Lovelace", handle: "ada-l", role: "Design", proposal: first },
  });
  expect(created.status).toBe(201);
  const agent = (await created.json()) as { id: string; name: string; handle: string; role: string };
  expect(agent).toMatchObject({ name: "Ada Lovelace", handle: "ada-l", role: "Design" });
  expect(await (await api(`/agent-proposals/${first}`)).json()).toMatchObject({
    state: "created",
    agentId: agent.id,
    canDecide: false,
  });
  expect((await api(`/agent-proposals/${first}/deny`, { json: {} })).status).toBe(409);
  expect((await api("/agents", { json: { name: "Ada 2", handle: "ada-2", proposal: first } })).status).toBe(409);

  // Another one, denied: the card stays, marked.
  const second = await ask();
  const denied = await api(`/agent-proposals/${second}/deny`, { json: {} });
  expect(denied.status).toBe(200);
  expect(await denied.json()).toMatchObject({ state: "denied", agentId: null });
  expect((await api(`/agent-proposals/${crypto.randomUUID()}`)).status).toBe(404);
});

test("Criar on the card: the agent as proposed in one click, with its channel and routine; a 40-character role is taken", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  await api(`/channels/${channelId}/messages`, {
    json: { body: "@dev cria um agente que checa meus emails todo dia" },
  });
  await t.drain();
  const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; meta?: { actionCard?: { kind?: string } } }[];
  };
  const card = timeline.messages.find((m) => m.meta?.actionCard?.kind === "agent_proposal")?.id;
  if (!card) throw new Error("no card");

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  await member(`/api/app/organizations/${orgId}/channels/${channelId}/join`, { json: {} });
  expect((await member(`/api/app/organizations/${orgId}/agent-proposals/${card}/create`, { json: {} })).status).toBe(
    403,
  );

  const made = await api(`/agent-proposals/${card}/create`, { json: {} });
  expect(made.status).toBe(201);
  const { agent, proposal, ai } = (await made.json()) as {
    agent: { id: string; name: string; handle: string; role: string };
    proposal: { state: string; agentId: string; applied: { channelIds: string[] }; routineId: string | null };
    ai: string;
  };
  // What it thinks with now, for the apps to open Connect when it is nothing.
  expect(["account", "model", "none"]).toContain(ai);
  expect(agent).toMatchObject({ name: "Caio", handle: "caio", role: "E-mail" });
  // Its routine reports where it was asked: it joined that channel to do it.
  expect(proposal).toMatchObject({ state: "created", agentId: agent.id, applied: { channelIds: [channelId] } });
  expect(typeof proposal.routineId).toBe("string");
  const routines = (await (await api("/routines")).json()) as { routines: { id: string; agentId: string }[] };
  expect(routines.routines.find((r) => r.id === proposal.routineId)?.agentId).toBe(agent.id);
  // Once: a second click, or the review's routine after it, is refused.
  expect((await api(`/agent-proposals/${card}/create`, { json: {} })).status).toBe(409);
  const again = await api(`/agent-proposals/${card}/routine`, { json: {} });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("agent_proposal.routine_made");

  const role = "Assistente de e-mails, agenda e reuniões";
  const long = await api(`/agents/${agent.id}`, { method: "PATCH", json: { role } });
  expect(long.status).toBe(200);
  expect(((await long.json()) as { role: string }).role).toBe(role);
  // The API's cap stays.
  expect((await api(`/agents/${agent.id}`, { method: "PATCH", json: { role: "r".repeat(201) } })).status).toBe(400);
});
