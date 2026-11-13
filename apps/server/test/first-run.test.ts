import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/* The right hand's first run over HTTP (ADR 0155 §6): the checklist it starts with, a stored skip, a template's team in one call. */

let t: TestServer;
afterEach(() => t.close());

interface AgentRow {
  id: string;
  handle: string;
  builtin: string | null;
  setup: { role: string | null; done: string[] } | null;
}

test("a new workspace's right hand starts the checklist; only Agora não is stored; Criar o time makes the team at once", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const created = (await (await owner("/api/app/organizations", { json: { name: "Acme" } })).json()) as {
    organization: { id: string };
  };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${created.organization.id}${path}`, init);
  const list = async () => ((await (await api("/agents")).json()) as { agents: AgentRow[] }).agents;

  const [lodi] = await list();
  expect(lodi).toMatchObject({ builtin: "right_hand", setup: { role: null, done: [] } });

  const skipped = await api(`/agents/${lodi?.id}/setup/apps`, { json: {} });
  expect(skipped.status).toBe(200);
  expect(((await skipped.json()) as AgentRow).setup?.done).toEqual(["apps"]);
  // The other rows read done from the data: nothing to store.
  expect((await api(`/agents/${lodi?.id}/setup/about`, { json: {} })).status).toBe(404);

  const used = await api("/team-templates/clinic/use", { json: { locale: "pt-BR" } });
  expect(used.status).toBe(200);
  const card = (await used.json()) as { channelId: string; state: string; error: unknown };
  expect(card).toMatchObject({ state: "created", error: null });
  expect((await list()).filter((a) => !a.builtin).length).toBeGreaterThan(1);

  // One message in the DM, the created card: no question after it.
  const messages = (await (await api(`/channels/${card.channelId}/messages`)).json()) as {
    messages: { meta: Record<string, unknown> | null }[];
  };
  expect(messages.messages.length).toBe(1);
  expect(messages.messages.some((m) => m.meta?.replyChips)).toBe(false);
});

test("a personal workspace (ADR 0159): made with its mode, its templates are for one person's life, made with no channel", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "solo@example.com");
  const made = await owner("/api/app/organizations", { json: { name: "Personal", mode: "personal" } });
  const created = (await made.json()) as { organization: { id: string } };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${created.organization.id}${path}`, init);
  expect(((await (await api("/settings")).json()) as { mode: string }).mode).toBe("personal");

  const gallery = (await (await api("/team-templates?locale=en")).json()) as {
    templates: { id: string; team: { agents: { channel: string }[]; newChannels: string[] } }[];
  };
  expect(gallery.templates.map((x) => x.id)).toEqual(["life", "health", "studies", "home", "travel", "freelance"]);
  expect(gallery.templates.every((x) => x.team.newChannels.length === 0)).toBe(true);
  expect(gallery.templates.flatMap((x) => x.team.agents.map((a) => a.channel))).not.toContain("support");

  const used = await api("/team-templates/life/use", { json: { locale: "en" } });
  expect(used.status).toBe(200);
  expect(await used.json()).toMatchObject({ state: "created", error: null });
  const agents = ((await (await api("/agents")).json()) as { agents: AgentRow[] }).agents;
  expect(agents.filter((a) => !a.builtin).map((a) => a.handle)).toEqual(expect.arrayContaining(["clara", "duda"]));
});
