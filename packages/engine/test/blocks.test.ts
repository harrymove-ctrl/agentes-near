import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import type { BlockSpec } from "@agenteschat/ui/blocks/spec";
import {
  addChannelMember,
  BLOCK_MANUAL,
  buildRunContext,
  closePoll,
  createArtifact,
  createBlockToolSource,
  drainOutbox,
  getArtifact,
  getPoll,
  keepBlock,
  listArtifacts,
  listMessages,
  POLL_CLOSE_JOB,
  postPersonMessage,
  replyToBlock,
  type ToolContext,
  toolKind,
  ValidationError,
  validateContent,
  votePoll,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const last = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const person = (userId: string) => ({ type: "person" as const, userId });

const BLOCK = '<ac-slider name="x" label="X" min="0" max="10"></ac-slider>';
const SPEC: BlockSpec = {
  data: { custo: 40 },
  compute: { margem: "(preco - custo) / preco * 100" },
  parts: [
    { type: "slider", name: "preco", label: "Preço", min: 50, max: 200, step: 10, value: 100, format: "brl" },
    { type: "stat", label: "Margem", value: "margem", format: "pct" },
  ],
  send: { label: "Usar este preço", text: "Usar {preco:brl}." },
};

/** What the agent's last tool call answered, as the model read it. */
let toolResult = "";

function agent(req: ModelRequest) {
  const text = last(req);
  if (text.includes("tool_result")) {
    toolResult = text;
    return { chunks: ["Mexe aí."] };
  }
  if (text.includes("errado")) {
    return {
      chunks: [],
      toolUses: [
        {
          name: "show_block",
          input: { title: "Preço", spec: { parts: [{ type: "stat", label: "X", value: "lucro" }] } },
        },
      ],
    };
  }
  if (text.includes("monta")) {
    return {
      chunks: [],
      toolUses: [{ name: "show_block", input: { title: "Preço", spec: SPEC, html: BLOCK } }],
    };
  }
  if (text.includes("simula")) {
    return {
      chunks: [],
      toolUses: [{ name: "show_block", input: { title: "Simulador", subtitle: "Dados de hoje", html: BLOCK } }],
    };
  }
  if (text.includes("vota")) {
    return {
      chunks: [],
      toolUses: [{ name: "start_poll", input: { question: "Qual data?", options: ["Terça", "Sexta"] } }],
    };
  }
  return { chunks: ["ok"] };
}

const ask = async (body: string) => {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  await drainOutbox(f.db, f.handlers);
  const [row] = await f.db.select().from(schema.artifacts);
  if (!row) throw new Error("nothing shown");
  return row;
};

const factsOf = async (id: string) =>
  withPersonFacts(f.db, f.owner.id, f.org.id, [await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, id)]);

test("a block goes to the trash only once it is in the Drive", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await ask("@dev simula");
  expect((await factsOf(row.id))[0]?.canDelete).toBe(false);
  await keepBlock(f.artifactDeps, f.owner.id, f.org.id, row.id);
  expect((await factsOf(row.id))[0]?.canDelete).toBe(true);
});

describe("the prompt", () => {
  test("the manual describes blocks as parts and formulas the app draws, and a page only as the way out", () => {
    for (const part of ['"type":"slider"', '"type":"card"', '"type":"result"', '"type":"actions"', "draw", "send"])
      expect(BLOCK_MANUAL).toContain(part);
    expect(BLOCK_MANUAL).toContain("you write no HTML, CSS or colors");
    expect(BLOCK_MANUAL).toContain("runs only when a person presses it");
    expect(BLOCK_MANUAL.length).toBeLessThan(6500);
  });

  test("show_block is short and says to show one unprompted; the manual comes with a call without html", async () => {
    f = await setup();
    const tools = await createBlockToolSource(f.artifactDeps).tools({} as ToolContext);
    const show = tools.find((t) => t.name === "show_block");
    if (!show) throw new Error("no show_block");
    expect(show.description.length).toBeLessThan(800);
    expect(show.description).toContain("Use it on your own whenever using something beats reading about it");
    expect(show.description).not.toContain("<ac-slider");
    const manual = await show.execute({ title: "Planos" }, {} as ToolContext);
    expect(manual.content).toBe(BLOCK_MANUAL);
    expect(manual.isError).toBeUndefined();
  });

  test("says when to show a block only where the tools are, and never in a routine's run", async () => {
    f = await setup();
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const system = async (r: typeof run, options: { blocks?: boolean; routine?: boolean }) => {
      const ctx = await buildRunContext(f.db, r, f.agent, { maxMessages: 30, toolsAvailable: true, ...options });
      return systemText(ctx.system);
    };
    expect(await system(run, { blocks: true })).toContain("show_block");
    expect(await system(run, {})).not.toContain("show_block");
    expect(await system(run, { blocks: true, routine: true })).not.toContain("show_block");
    expect(await system({ ...run, background: true }, { blocks: true })).not.toContain("show_block");
  });

  test("the ask_choices line, there only when a person is behind the run, keeps a computer session going", async () => {
    f = await setup();
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const context = (choices: boolean) =>
      buildRunContext(f.db, run, f.agent, { maxMessages: 30, toolsAvailable: true, choices });
    const [person, agentAsks] = await Promise.all([context(true), context(false)]);
    expect(systemText(person.system)).toContain("ask_choices");
    expect(person.sessionPrompt).toEqual(agentAsks.sessionPrompt);
  });
});

describe("live blocks", () => {
  test("an agent shows one with no scope of its own, in its reply and out of the Drive", async () => {
    f = await setup({ blockTools: true, reply: agent });
    const row = await ask("@dev simula o desconto");
    expect(row).toMatchObject({ kind: "block", inDrive: false, untrusted: true, channelId: f.general.id });
    const reply = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1);
    expect(reply?.meta.artifacts).toEqual([{ id: row.id, version: 1, title: row.title }]);
    const shown = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, row.id);
    expect(shown.content).toEqual({ kind: "block", html: BLOCK, subtitle: "Dados de hoje" });
    expect(await listArtifacts(f.db, person(f.owner.id), f.org.id)).toEqual([]);
  });

  test("a person keeps one, and it joins the Drive", async () => {
    f = await setup({ blockTools: true, reply: agent });
    const row = await ask("@dev simula o desconto");
    const kept = await keepBlock(f.artifactDeps, f.owner.id, f.org.id, row.id);
    expect(kept.inDrive).toBe(true);
    expect((await listArtifacts(f.db, person(f.owner.id), f.org.id)).map((a) => a.id)).toEqual([row.id]);
  });

  test("what comes back is the person's own message, to the agent that made the block", async () => {
    f = await setup({ blockTools: true, reply: agent });
    const row = await ask("@dev simula o desconto");
    const message = await replyToBlock({ ...f.artifactDeps, pubsub: f.pubsub }, f.owner.id, f.org.id, row.id, {
      text: "Usar 15%",
    });
    expect(message.body).toBe("@dev Usar 15%");
    expect(message.author).toMatchObject({ type: "person", id: f.owner.id });
    expect(message.meta.blockReply).toEqual({ id: row.id, title: "Simulador" });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
    expect(run?.agentId).toBe(f.agent.id);
  });

  test("nobody outside can answer one, and a file is not a block", async () => {
    f = await setup({ blockTools: true, reply: agent });
    const row = await ask("@dev simula o desconto");
    const deps = { ...f.artifactDeps, pubsub: f.pubsub };
    await expect(replyToBlock(deps, f.owner.id, f.org.id, row.id, { text: "  " })).rejects.toThrow(ValidationError);
    const doc = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, {
      title: "Doc",
      content: { kind: "document", markdown: "a" },
    });
    await expect(replyToBlock(deps, f.owner.id, f.org.id, doc.id, { text: "oi" })).rejects.toThrow("Block not found");
  });

  test("an agent describes one in parts: kept as its spec, never run as a page", async () => {
    f = await setup({ blockTools: true, reply: agent });
    const row = await ask("@dev monta um simulador de preço");
    const shown = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, row.id);
    // Sent with both, the parts win: a page would wait for a click.
    expect(shown.content).toEqual({ kind: "block", spec: SPEC });
  });

  test("a spec that reads a value it doesn't have comes back to the agent, saying where", async () => {
    f = await setup({ blockTools: true, reply: agent });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev monta um errado",
    });
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.artifacts)).toEqual([]);
    expect(toolResult).toContain('parts[0].value: there is no value \\"lucro\\"');
  });

  test("a spec is checked like any content: its parts, its formulas on its own data, and both kinds at once", () => {
    expect(validateContent({ kind: "block", spec: SPEC, subtitle: " Hoje " })).toEqual({
      kind: "block",
      spec: SPEC,
      subtitle: "Hoje",
    });
    expect(() => validateContent({ kind: "block", spec: { parts: [{ type: "script" }] } })).toThrow(ValidationError);
    expect(() =>
      validateContent({
        kind: "block",
        spec: { data: { n: 1 }, parts: [{ type: "stat", label: "X", value: "sum(n)" }] },
      }),
    ).toThrow("sum() needs a list");
    expect(() => validateContent({ kind: "block", spec: SPEC, html: BLOCK })).toThrow("a spec or html, not both");
  });

  test("it can't be made as a file", () => {
    expect(() => validateContent({ kind: "block", html: " " })).toThrow(ValidationError);
    expect(() => validateContent({ kind: "block", html: "x".repeat(200_001) })).toThrow("too large");
  });

  test("it speaks only in its own conversation, so a routine's room refuses it", () => {
    for (const name of ["show_block", "start_poll"]) expect(toolKind({ name, scope: "" })).toEqual({ kind: "here" });
  });
});

describe("polls", () => {
  const twoPeople = async () => {
    f = await setup({ blockTools: true, reply: agent });
    const ana = await addMember(f.db, f.org.id, "member", "Ana");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: ana.id });
    return ana;
  };

  test("everyone sees the marks, a person changes theirs, and the last one in closes it", async () => {
    const ana = await twoPeople();
    const row = await ask("@dev vota a data");
    expect(row).toMatchObject({ kind: "poll", inDrive: false });
    const events = f.listen(f.general.id);

    await votePoll(f.artifactDeps, f.owner.id, f.org.id, row.id, [0]);
    const changed = await votePoll(f.artifactDeps, f.owner.id, f.org.id, row.id, [1]);
    expect(changed.votes).toEqual([{ userId: f.owner.id, option: 1 }]);
    expect(changed.closedAt).toBeNull();
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "poll.updated")).toBe(true);

    const closed = await votePoll(f.artifactDeps, ana.id, f.org.id, row.id, [1]);
    expect(closed.closedAt).not.toBeNull();
    await expect(votePoll(f.artifactDeps, ana.id, f.org.id, row.id, [0])).rejects.toThrow("This poll has closed");

    const notes = await f.db.select().from(schema.messages);
    const notice = notes.map((m) => m.meta as { notice?: { kind: string; text: string } }).find((m) => m.notice);
    expect(notice?.notice?.kind).toBe("poll_result");
    expect(notice?.notice?.text).toContain("- Sexta: 2");
    expect(notice?.notice?.text).toContain("2 of 2 people answered");
  });

  test("one choice unless the agent asked for many; only options that exist; empty takes it back", async () => {
    await twoPeople();
    const row = await ask("@dev vota a data");
    await expect(votePoll(f.artifactDeps, f.owner.id, f.org.id, row.id, [0, 1])).rejects.toThrow("one option");
    await expect(votePoll(f.artifactDeps, f.owner.id, f.org.id, row.id, [2])).rejects.toThrow("no such option");
    await votePoll(f.artifactDeps, f.owner.id, f.org.id, row.id, [0]);
    expect((await votePoll(f.artifactDeps, f.owner.id, f.org.id, row.id, [])).votes).toEqual([]);
  });

  test("its time closes it, once, through the outbox", async () => {
    await twoPeople();
    const row = await ask("@dev vota a data");
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, POLL_CLOSE_JOB));
    expect(job?.payload).toEqual({ artifactId: row.id });
    expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(await closePoll(f.artifactDeps, f.org.id, row.id)).not.toBeNull();
    expect(await closePoll(f.artifactDeps, f.org.id, row.id)).toBeNull();
    expect((await getPoll(f.artifactDeps, f.owner.id, f.org.id, row.id)).closedAt).not.toBeNull();
  });
});
