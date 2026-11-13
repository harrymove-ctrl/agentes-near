import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  type Brain,
  type ChannelEvent,
  createJobHandlers,
  drainOutbox,
  type MachineStatus,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The waiting row's step line: what the agent wrote before a call is its next call's words (`agent.tool` `said`, or
 * `agent.step` for a computer brain's own call), one short line, and never a message.
 */

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

const agentBodies = async () =>
  (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent")
    .map((m) => m.body);

type ToolEvent = Extract<ChannelEvent, { type: "agent.tool" }>;
const toolStarts = (events: { type: string }[]) =>
  (events as ToolEvent[]).filter((e) => e.type === "agent.tool" && e.tool !== null);

test("a model brain: what it wrote before its call is that call's step words, cut to one line, never posted", async () => {
  const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
  f = await setup({
    contextTools: true,
    reply: (req) =>
      lastText(req).includes("tool_result")
        ? { chunks: ["Faltam o ícone e a classificação de conteúdo."] }
        : {
            chunks: ["**Vou ler** o painel de tarefas do app. Depois respondo com o que falta."],
            toolUses: [{ name: "search_context", input: { query: "android review" } }],
          },
  });
  const events = f.listen(f.general.id);
  await post("@dev o que falta para o review do android?");
  await drainOutbox(f.db, f.handlers);

  const [start] = toolStarts(events);
  expect(start).toMatchObject({ tool: "search_context", said: "Vou ler o painel de tarefas do app" });
  expect(await agentBodies()).toEqual(["Faltam o ícone e a classificação de conteúdo."]);
});

const onComputer = async (brain: Brain) => {
  f = await setup({ contextTools: true });
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  return createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id): Promise<MachineStatus> => ({
        id,
        orgId: f.org.id,
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: 8,
        executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
  });
};

test("a computer brain: its own call says its step once it ended, a bridged call as it starts", async () => {
  const brain: Brain = {
    kind: "claude_code",
    async *run(_turn, io) {
      yield { type: "text_delta", text: "Vou ler o README do app.\n\nE depois o changelog." };
      yield {
        type: "tool_call",
        id: "r1",
        name: "Read",
        input: { file_path: "README.md" },
        executed: { content: "ok" },
      };
      yield { type: "text_delta", text: "Agora procuro nas conversas." };
      const input = { query: "android" };
      const result = await io.executeTool({ id: "b1", name: "search_context", input });
      yield { type: "tool_call", id: "b1", name: "search_context", input, executed: result };
      yield { type: "tool_call", id: "g1", name: "Grep", input: { pattern: "aab" }, executed: { content: "" } };
      yield { type: "text_delta", text: "Pronto: falta o ícone." };
      yield { type: "done", text: "Pronto: falta o ícone." };
    },
  };
  const handlers = await onComputer(brain);
  const events = f.listen(f.general.id);
  await post("@dev o que falta?");
  await drainOutbox(f.db, handlers);

  const steps = events.filter((e) => e.type === "agent.step");
  expect(steps).toMatchObject([
    { tool: "Read", said: "Vou ler o README do app" },
    // Nothing written between the bridged call and this one: no words of its own.
    { tool: "Grep" },
  ]);
  expect((steps[1] as { said?: string }).said).toBeUndefined();
  expect(toolStarts(events)).toMatchObject([{ tool: "search_context", said: "Agora procuro nas conversas" }]);
  expect(await agentBodies()).toEqual(["Pronto: falta o ícone."]);
});

test("a computer brain that tells its own call as it starts: the step line says it then, once, with no credential", async () => {
  let atStart: { type: string }[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "text_delta", text: "Vou rodar o build com a chave sk-ant-abcdefghijklmnopqrstuv. Demora." };
      yield { type: "tool_started", id: "b1", name: "Bash" };
      // The command still runs: what the line says now is what people see while it does.
      await new Promise((r) => setTimeout(r, 20));
      atStart = events.filter((e) => e.type === "agent.step");
      yield {
        type: "tool_call",
        id: "b1",
        name: "Bash",
        input: { command: "bun run build" },
        executed: { content: "ok" },
      };
      yield { type: "text_delta", text: "NO_REPLY" };
      yield { type: "tool_started", id: "g1", name: "Grep" };
      yield { type: "tool_call", id: "g1", name: "Grep", input: { pattern: "x" }, executed: { content: "" } };
      yield { type: "text_delta", text: "Build ok." };
      yield { type: "done", text: "Build ok." };
    },
  };
  const handlers = await onComputer(brain);
  const events = f.listen(f.general.id);
  await post("@dev roda o build?");
  await drainOutbox(f.db, handlers);

  expect(atStart).toEqual([expect.objectContaining({ tool: "Bash", said: "Vou rodar o build com a chave ••••" })]);
  const steps = events.filter((e) => e.type === "agent.step");
  // Each call once, as it started; the silence word is never its words.
  expect(steps).toMatchObject([{ tool: "Bash" }, { tool: "Grep" }]);
  expect((steps[1] as { said?: string }).said).toBeUndefined();
});
