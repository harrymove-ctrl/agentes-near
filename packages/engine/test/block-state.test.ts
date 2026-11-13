import { afterEach, describe, expect, test } from "bun:test";
import { desc, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import type { BlockSpec } from "@agenteschat/ui/blocks/spec";
import {
  addChannelMember,
  blockShows,
  blockSpecAt,
  blockStateText,
  buildRunContext,
  drainOutbox,
  drawBlock,
  fairIndex,
  getBlockState,
  postPersonMessage,
  setBlockState,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHEEL = `<ac-result label="Sorteado" bind="nome"></ac-result>
<ac-actions><button onclick="agentes.draw('nome', ['Bento', 'Luna'])">Girar</button></ac-actions>`;

const PRICE: BlockSpec = {
  data: { custo: 40 },
  compute: { margem: "(preco - custo) / preco * 100", serie: "map(range(3), m => {label: 'M' + m, value: m})" },
  parts: [
    { type: "slider", name: "preco", label: "Preço", min: 50, max: 200, step: 10, value: 100 },
    { type: "stat", label: "Margem", value: "margem", format: "pct" },
  ],
};

function agent(req: ModelRequest) {
  const text = JSON.stringify(req.messages.at(-1)?.content);
  if (text.includes("tool_result")) return { chunks: ["Gira aí."] };
  if (text.includes("preço")) {
    return { chunks: [], toolUses: [{ name: "show_block", input: { title: "Preço", spec: PRICE } }] };
  }
  if (text.includes("roleta")) {
    return { chunks: [], toolUses: [{ name: "show_block", input: { title: "Roleta", html: WHEEL } }] };
  }
  return { chunks: ["ok"] };
}

/** The owner and Bia in #general, and the agent's wheel in its reply. */
async function wheel() {
  f = await setup({ blockTools: true, reply: agent });
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz uma roleta",
  });
  await drainOutbox(f.db, f.handlers);
  const [row] = await f.db.select().from(schema.artifacts);
  if (!row) throw new Error("no block");
  return { bia, block: row };
}

describe("a live block's state is everyone's (ADR 0113)", () => {
  test("a draw is made once on the server: everyone reads the same pick, and hears it", async () => {
    const { bia, block } = await wheel();
    const events = f.listen(f.general.id);
    const drawn = await drawBlock(f.artifactDeps, f.owner.id, f.org.id, block.id, {
      version: 1,
      name: "nome",
      options: ["Bento", "Luna"],
    });
    expect(["Bento", "Luna"]).toContain(drawn.state.nome as string);
    expect(drawn.changes.nome).toMatchObject({ by: f.owner.id, drawn: 2 });
    expect(drawn.rev).toBe(1);

    // Bia opens it later and sees the same name, with who drew it.
    const seen = await getBlockState(f.artifactDeps, bia.id, f.org.id, block.id, 1);
    expect(seen.state).toEqual(drawn.state);
    expect(seen.changes.nome?.name).toBe(f.owner.name);
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "block.state")).toBe(true);
  });

  test("values merge, each with who set it; the newest change has the highest rev", async () => {
    const { bia, block } = await wheel();
    await setBlockState(f.artifactDeps, f.owner.id, f.org.id, block.id, { version: 1, values: { a: 1, b: "x" } });
    const next = await setBlockState(f.artifactDeps, bia.id, f.org.id, block.id, { version: 1, values: { b: "y" } });
    expect(next.state).toEqual({ a: 1, b: "y" });
    expect(next.changes.a?.by).toBe(f.owner.id);
    expect(next.changes.b?.by).toBe(bia.id);
    expect(next.rev).toBe(2);
  });

  test("refuses bad names, too much, draws without choices, and blocks that aren't there", async () => {
    const { block } = await wheel();
    const set = (values: Record<string, unknown>) =>
      setBlockState(f.artifactDeps, f.owner.id, f.org.id, block.id, { version: 1, values });
    await expect(set({ "bad name": 1 })).rejects.toThrow("invalid name");
    await expect(set({})).rejects.toThrow("Nothing to set");
    await expect(set({ big: "x".repeat(20_000) })).rejects.toThrow("too much");
    // Everyone would see it, and so would the agent.
    await expect(set({ form: { key: "sk-ant-abcdefghijklmnop" } })).rejects.toThrow("password or a key");
    await expect(set({ note: "password: hunter2" })).rejects.toThrow("password or a key");
    await expect(set({ senha: "hunter2" })).rejects.toThrow("password or a key");
    // An empty field named so is fine: nothing was typed.
    expect((await set({ senha: "", nome: "Bento" })).state).toMatchObject({ nome: "Bento" });
    await expect(
      drawBlock(f.artifactDeps, f.owner.id, f.org.id, block.id, { version: 1, name: "n", options: ["só"] }),
    ).rejects.toThrow("2 to");
    await expect(getBlockState(f.artifactDeps, f.owner.id, f.org.id, block.id, 9)).rejects.toThrow();
  });

  test("the agent reads the block as it is now, right after the message that showed it", async () => {
    const { block } = await wheel();
    await drawBlock(f.artifactDeps, f.owner.id, f.org.id, block.id, {
      version: 1,
      name: "nome",
      options: ["Bento", "Luna"],
    });
    const { state } = await getBlockState(f.artifactDeps, f.owner.id, f.org.id, block.id, 1);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev bom, então foi decidido na sorte",
    });
    const [run] = await f.db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.createdAt)).limit(1);
    if (!run) throw new Error("no run");
    const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
    const text = JSON.stringify(ctx.messages);
    expect(text).toContain('[Block \\"Roleta\\"');
    expect(text).toContain('\\"drawnAmong\\":2');
    expect(text).toContain(String(state.nome));
    // Before the person's message, which talks about it.
    expect(text.indexOf("drawnAmong")).toBeLessThan(text.indexOf("decidido na sorte"));
  });
});

test("the agent reads what a block of parts shows, as everyone sees it", async () => {
  f = await setup({ blockTools: true, reply: agent });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev simula o preço",
  });
  await drainOutbox(f.db, f.handlers);
  const [block] = await f.db.select().from(schema.artifacts);
  if (!block) throw new Error("no block");
  await setBlockState(f.artifactDeps, f.owner.id, f.org.id, block.id, { version: 1, values: { preco: 80 } });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev fechou nesse",
  });
  const [run] = await f.db.select().from(schema.agentRuns).orderBy(desc(schema.agentRuns.createdAt)).limit(1);
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, {
    maxMessages: 30,
    blockSpec: (orgId, id, version) => blockSpecAt(f.artifactDeps, orgId, id, version),
  });
  const text = JSON.stringify(ctx.messages);
  expect(text).toContain('\\"values\\":{\\"preco\\":80}');
  expect(text).toContain('\\"shows\\":{\\"margem\\":50}');
  // A list (a chart's points) follows from the values and the block; only plain results are read.
  expect(blockShows(PRICE, { preco: 80 })).toEqual({ margem: 50 });
});

describe("fairIndex", () => {
  test("draws again past the last whole multiple, so no option comes up more often", () => {
    const values = [2 ** 32 - 1, 7];
    const random = (buf: Uint32Array) => {
      buf[0] = values.shift() ?? 0;
      return buf;
    };
    expect(fairIndex(3, random)).toBe(1);
    expect(values).toEqual([]);
  });

  test("stays in range", () => {
    for (let i = 0; i < 200; i++) {
      const n = fairIndex(6);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
  });
});

test("who set what and the values are all outside data", () => {
  const text = blockStateText("Plano", {
    id: "b1",
    version: 1,
    state: { preco: 120 },
    changes: { preco: { by: "u1", name: "Ana", at: "2026-11-03T21:05:00Z" } },
    rev: 3,
  });
  const envelope = text.slice(text.indexOf("<external_data"));
  expect(envelope).toContain('"values":{"preco":120}');
  expect(envelope).toContain('"preco":{"by":"Ana"');
  // Nothing a person wrote is outside the envelope.
  expect(text.slice(0, text.indexOf("<external_data"))).not.toContain("preco");
});
