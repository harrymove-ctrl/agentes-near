import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userTopic } from "@agenteschat/adapters";
import { and, eq, migrationsFolder, schema, sql } from "@agenteschat/db";
import {
  archiveAgent,
  consolidateItem,
  consolidateOrg,
  createAgent,
  decideProposal,
  itemWords,
  listNotifications,
  listProposals,
  orgOverview,
  proposeChange,
  proposeFromItem,
  receiptLine,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const REFUSED = "A person refused this change; don't propose it again: ";

const teammate = (handle: string) =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: handle, handle, role: "Dev", instructions: "Seja breve." },
    { model: "claude-sonnet-5-5" },
  );

const propose = (agentIds: string[], change: string, requesterId = f.owner.id) =>
  proposeChange(
    { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
    {
      orgId: f.org.id,
      agentId: f.agent.id,
      target: "agent_instructions",
      agentIds,
      change,
      rationale: "",
      requesterId,
    },
  );

/** A verified lesson of the fixture's agent, strong enough to become a proposal. */
const lesson = async (content: string) => {
  const input = {
    orgId: f.org.id,
    kind: "lesson" as const,
    scopeType: "agent" as const,
    agentId: f.agent.id,
    subject: content,
    content,
    trust: "high" as const,
    evidence: [{ type: "human" as const, ref: crypto.randomUUID(), at: new Date().toISOString() }],
    confidence: 0.9,
  };
  await consolidateItem(f.db, input);
  return (await consolidateItem(f.db, input)).item;
};

const rows = () => f.db.select().from(schema.contextProposals);
const open = async () => (await rows()).filter((p) => p.status === "pending");

describe("a refusal", () => {
  test("teaches the agent and never comes back as a proposal, however often it is refused", async () => {
    f = await setup();
    const ada = await teammate("ada");
    const lia = await teammate("lia");
    const { proposals } = await propose([ada.id, lia.id], "Remover o sistema antigo.");
    for (const p of proposals) await decideProposal(f.db, f.owner.id, f.org.id, p.id, "reject");
    await consolidateOrg(f.context, f.org.id);

    const [taught] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.kind, "lesson"));
    expect(taught).toMatchObject({ agentId: f.agent.id, status: "active", recurrence: 2 });
    expect(await open()).toEqual([]);
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.instructions).not.toContain("refused");
  });

  test("of an approval is no rule to propose either", async () => {
    f = await setup();
    const item = await lesson('"Fazer deploy" was refused by a person.');
    expect(await proposeFromItem(f, item)).toBeNull();
  });

  test("a change a person refused isn't proposed again from another memory", async () => {
    f = await setup();
    const first = await proposeFromItem(f, await lesson("Sempre responder em português."));
    await decideProposal(f.db, f.owner.id, f.org.id, first?.id ?? "", "reject");
    const again = await lesson("Sempre responder em português.");
    expect(await proposeFromItem(f, { ...again, proposedAt: null })).toBeNull();
    expect(await open()).toEqual([]);
  });
});

describe("what people read of the server's own lessons", () => {
  test("only the words it is about, and how they came", async () => {
    f = await setup();
    const of = (content: string) => itemWords({ content });
    expect(of(`${REFUSED}## Learned - Remover o sistema antigo.`)).toEqual({
      text: "Remover o sistema antigo.",
      how: "refused",
    });
    expect(of(`${REFUSED}- ${REFUSED}- Remover o sistema antigo.`)).toEqual({
      text: "Remover o sistema antigo.",
      how: "refused",
    });
    expect(of(`${REFUSED}role: Designer`)).toEqual({ text: "Designer", how: "refused" });
    expect(of(`${REFUSED}removing "Seja breve."`)).toEqual({ text: "Seja breve.", how: "refused" });
    expect(of('"Fazer deploy" was refused by a person.')).toEqual({ text: "Fazer deploy", how: "refused" });
    expect(of('"Fazer deploy" was refused: hoje não')).toEqual({ text: "Fazer deploy: hoje não", how: "refused" });
    expect(of('A person corrected "O build roda no CI": Roda no Buildkite.')).toEqual({
      text: "Roda no Buildkite.",
      how: "corrected",
    });
    expect(of("Prefere respostas curtas.")).toEqual({ text: "Prefere respostas curtas.", how: null });
  });

  test("a correction's chat receipt says the person's words", async () => {
    f = await setup();
    const correction = {
      title: "",
      content: 'A person corrected "O build roda no CI": Roda no Buildkite.',
      kind: "lesson" as const,
      agentId: "a",
      scopeType: "agent" as const,
      createdByKind: "person" as const,
      evidence: [{ type: "human" as const, ref: "m", at: "2026-11-06" }],
    };
    expect(receiptLine(correction)).toBe("Roda no Buildkite.");
  });

  test("a correction reaches the instructions in the person's own words", async () => {
    f = await setup();
    const item = await lesson('A person corrected "O build roda no CI": Roda no Buildkite.');
    const proposal = await proposeFromItem(f, item);
    expect(proposal?.proposedText).toContain("- Roda no Buildkite.");
    expect(proposal?.proposedText).not.toContain("A person");
  });
});

describe("the same change", () => {
  test("asked for again while it waits is left off, with why", async () => {
    f = await setup();
    const ada = await teammate("ada");
    await propose([ada.id], "Responder em português.");
    const again = await propose([ada.id], "Responder em português.");
    expect(again.proposals).toEqual([]);
    expect(again.skipped.join(" ")).toContain("already waiting");
    expect(await open()).toHaveLength(1);
  });

  test("from two memories is listed once, and the second isn't tried again", async () => {
    f = await setup();
    const line = "Sempre pedir revisão.";
    await proposeFromItem(f, await lesson(line));
    const copy = await lesson(`${line} `);
    await f.db.update(schema.contextItems).set({ proposedAt: null }).where(eq(schema.contextItems.id, copy.id));
    const [fresh] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, copy.id));
    expect(await proposeFromItem(f, fresh as NonNullable<typeof fresh>)).toBeNull();
    expect(await open()).toHaveLength(1);
    const [after] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, copy.id));
    expect(after?.proposedAt).not.toBeNull();
  });

  test("is asked again once the row waiting for it can't be accepted any more", async () => {
    f = await setup();
    const ada = await teammate("ada");
    await propose([ada.id], "Responder em português.");
    await updateAgent(f.db, f.owner.id, f.org.id, ada.id, { instructions: "Outro texto." });
    const [fresh] = (await propose([ada.id], "Responder em português.")).proposals;
    expect(fresh).toBeDefined();
    const mine = (await listProposals(f.db, f.owner.id, f.org.id)).filter((p) => p.canDecide);
    expect(mine.map((p) => p.id)).toEqual([fresh?.id ?? ""]);
  });

  test("for another agent is another change", async () => {
    f = await setup();
    const ada = await teammate("ada");
    const lia = await teammate("lia");
    await propose([ada.id], "Responder em português.");
    expect((await propose([lia.id], "Responder em português.")).proposals).toHaveLength(1);
  });
});

describe("what waits on a person", () => {
  test("the count and the inbox: who can decide it hears, who asked for it has its card, and it ends with the last one", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const ada = await teammate("ada");
    const [first] = (await propose([ada.id], "Primeira regra.", bia.id)).proposals;
    const [second] = (await propose([ada.id], "Segunda regra.", bia.id)).proposals;

    expect((await orgOverview(f.db, f.owner.id, f.org.id)).proposalsWaitingForMe).toBe(2);
    expect((await orgOverview(f.db, bia.id, f.org.id)).proposalsWaitingForMe).toBe(0);
    const inbox = async (userId: string) =>
      (await listNotifications(f, userId, f.org.id, { filter: "waiting" })).items.filter(
        (n) => n.kind === "proposal_waiting",
      );
    const [row, ...more] = await inbox(f.owner.id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ waiting: true, count: 2 });
    expect(row?.actors).toEqual([expect.objectContaining({ type: "agent", id: f.agent.id })]);
    expect(await inbox(bia.id)).toEqual([]);

    // Accepting one moves the text the other was made against: it still waits, on the new text.
    await decideProposal(f.db, f.owner.id, f.org.id, first?.id ?? "", "accept");
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).proposalsWaitingForMe).toBe(1);
    expect(await inbox(f.owner.id)).toHaveLength(1);
    await decideProposal(f.db, f.owner.id, f.org.id, second?.id ?? "", "accept");
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).proposalsWaitingForMe).toBe(0);
    expect(await inbox(f.owner.id)).toEqual([]);
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, ada.id));
    expect(agent?.instructions).toContain("- Primeira regra.\n- Segunda regra.");
  });

  test("accepted with other words, the others still add their rule to what was accepted", async () => {
    f = await setup();
    const ada = await teammate("ada");
    const [first] = (await propose([ada.id], "Primeira regra.")).proposals;
    const [second] = (await propose([ada.id], "Segunda regra.")).proposals;
    await decideProposal(f.db, f.owner.id, f.org.id, first?.id ?? "", "accept", { finalText: "Texto novo." });
    await decideProposal(f.db, f.owner.id, f.org.id, second?.id ?? "", "accept");
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, ada.id));
    expect(agent?.instructions).toBe("Texto novo.\n\n## Learned\n- Segunda regra.");
  });

  test("a swap of existing words can't be carried: it reads as stale once the text moved", async () => {
    f = await setup();
    const ada = await teammate("ada");
    const [first] = (await propose([ada.id], "Primeira regra.")).proposals;
    const swap = await proposeChange(
      { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
      {
        orgId: f.org.id,
        agentId: f.agent.id,
        target: "agent_instructions",
        agentIds: [ada.id],
        change: "Seja detalhado.",
        replaces: "Seja breve.",
        rationale: "",
        requesterId: f.owner.id,
      },
    );
    await decideProposal(f.db, f.owner.id, f.org.id, first?.id ?? "", "accept");
    const shown = (await listProposals(f.db, f.owner.id, f.org.id)).find((p) => p.id === swap.proposals[0]?.id);
    expect(shown).toMatchObject({ status: "stale", canDecide: false });
  });

  test("an archived agent's rows wait on nobody", async () => {
    f = await setup();
    const ada = await teammate("ada");
    await propose([ada.id], "Uma regra.");
    await archiveAgent(f.db, f.owner.id, f.org.id, ada.id);
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).proposalsWaitingForMe).toBe(0);
  });

  test("whoever else could decide hears it is done, so their count moves", async () => {
    f = await setup();
    const sam = await addMember(f.db, f.org.id, "admin", "sam");
    const ada = await teammate("ada");
    const [row] = (await propose([ada.id], "Uma regra.")).proposals;
    const heard: { type: string }[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, sam.id), (e) => heard.push(e as { type: string }));
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "reject", { pubsub: f.pubsub });
    expect(heard.map((e) => e.type)).toContain("proposal.decided");
  });

  test("a row whose text changed by hand stops waiting too", async () => {
    f = await setup();
    const ada = await teammate("ada");
    await propose([ada.id], "Uma regra.");
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).proposalsWaitingForMe).toBe(1);
    await updateAgent(f.db, f.owner.id, f.org.id, ada.id, { instructions: "Outro texto." });
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).proposalsWaitingForMe).toBe(0);
  });
});

describe("migration 0233", () => {
  const statements = readFileSync(join(migrationsFolder, "0233_refusal_proposals.sql"), "utf8").split(
    "--> statement-breakpoint",
  );

  test("closes what refusals made, closes repeats, and leaves everything else as it was", async () => {
    f = await setup();
    const ada = await teammate("ada");
    const row = (diff: string, status: "pending" | "rejected" | "accepted", agentId = f.agent.id, ago = 0) => ({
      orgId: f.org.id,
      target: "agent_instructions" as const,
      agentId,
      baseHash: "x",
      proposedText: "x",
      diff,
      rationale: "Seen 2×.",
      status,
      createdAt: new Date(Date.now() - ago * 86_400_000),
    });
    const junk = ` Seja breve.\n+\n+## Learned\n+- ${REFUSED}## Learned - Remover o sistema antigo.`;
    const twin = " Seja breve.\n+\n+## Learned\n+- Sempre pedir revisão.";
    const corrected = await lesson('A person corrected "O CI": Roda no Buildkite.');
    const ids = await f.db
      .insert(schema.contextProposals)
      .values([
        row(junk, "pending"),
        row(junk, "rejected"),
        row(junk, "accepted"),
        row(twin, "pending", f.agent.id, 3),
        row(twin, "pending", f.agent.id, 2),
        row(twin, "pending", f.agent.id, 1),
        row(twin, "pending", ada.id),
        row(" Seja breve.\n+\n+## Learned\n+- Outra coisa.", "pending"),
        row(' Seja breve.\n+\n+## Learned\n+- "Fazer deploy" was refused by a person.', "pending"),
        row(' Seja breve.\n+\n+## Learned\n+- "Fazer deploy" was refused: hoje não', "rejected"),
        {
          ...row(' Seja breve.\n+\n+## Learned\n+- A person corrected "O CI": Roda no Buildkite.', "pending"),
          itemIds: [corrected.id],
        },
        row(' Seja breve.\n+- Quem "foi" was refused não é modelo.', "pending"),
      ])
      .returning({ id: schema.contextProposals.id });
    const id = (i: number) => ids[i]?.id;
    const item = (content: string) => ({
      orgId: f.org.id,
      kind: "lesson" as const,
      scopeType: "agent" as const,
      scopeId: f.agent.id,
      agentId: f.agent.id,
      subjectKey: content.slice(0, 40),
      title: "",
      content,
    });
    const nested = `${REFUSED}- ${REFUSED}- Remover o sistema antigo.`;
    await f.db.insert(schema.contextItems).values([item(nested), item(`${REFUSED}- Remover o sistema antigo.`)]);

    for (const statement of statements) await f.db.execute(sql.raw(statement));

    const after = new Map((await rows()).map((p) => [p.id, p.status]));
    expect([0, 1].map((i) => after.get(id(i) ?? ""))).toEqual(["stale", "stale"]);
    expect(after.get(id(2) ?? "")).toBe("accepted");
    expect([3, 4, 5].map((i) => after.get(id(i) ?? ""))).toEqual(["stale", "stale", "pending"]);
    expect(after.get(id(6) ?? "")).toBe("pending");
    expect(after.get(id(7) ?? "")).toBe("pending");
    expect([8, 9, 10].map((i) => after.get(id(i) ?? ""))).toEqual(["stale", "stale", "stale"]);
    expect(after.get(id(11) ?? "")).toBe("pending");
    const [again] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, corrected.id));
    expect(again?.proposedAt).toBeNull();
    expect((await proposeFromItem(f, again as NonNullable<typeof again>))?.proposedText).toContain(
      "- Roda no Buildkite.",
    );
    const items = await f.db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, f.org.id), eq(schema.contextItems.kind, "lesson")));
    const status = new Map(items.map((i) => [i.content, i.status]));
    expect(status.get(nested)).toBe("archived");
    expect(status.get(`${REFUSED}- Remover o sistema antigo.`)).toBe("active");
  });

  test("who reviews memory gets one inbox row for what already waits, and it ends as any other", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const ada = await teammate("ada");
    const [row] = (await propose([ada.id], "Uma regra.", f.owner.id)).proposals;
    await propose([ada.id], "Outra regra.", f.owner.id);
    await f.db.delete(schema.notifications).where(eq(schema.notifications.kind, "proposal_waiting"));

    for (const statement of statements) await f.db.execute(sql.raw(statement));

    const inbox = async (userId: string) =>
      (await listNotifications(f, userId, f.org.id, { filter: "waiting" })).items.filter(
        (n) => n.kind === "proposal_waiting",
      );
    const [waiting, ...more] = await inbox(f.owner.id);
    expect(more).toEqual([]);
    expect(waiting).toMatchObject({ waiting: true, count: 2 });
    expect(waiting?.actors).toEqual([expect.objectContaining({ type: "agent", id: f.agent.id })]);
    expect(await inbox(bia.id)).toEqual([]);

    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "reject");
    expect(await inbox(f.owner.id)).toHaveLength(1);
  });
});
