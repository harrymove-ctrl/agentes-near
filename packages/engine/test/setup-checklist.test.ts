import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Database, eq, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { agentView, confirmSetupStep, createAgent, createOrganization, NotFoundError, newSetup, setupOf } from "../src";
import { addMember, addUser } from "./fixtures";

// A new agent's setup checklist (ADR 0155 §2): every new agent starts with one, whichever way it was made; its owner
// or whoever manages agents confirms its steps; agents made before it keep none.

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const MODEL = { model: "claude-sonnet-5-5" };

async function workspace() {
  const t = await createTestDatabase();
  close = t.close;
  const db: Database = t.db;
  const owner = await addUser(db, "ana");
  const { organization: org } = await createOrganization(db, owner.id, { name: "Acme" });
  const member = await addMember(db, org.id, "member");
  const admin = await addMember(db, org.id, "admin");
  return { db, owner, org, member, admin };
}

async function stored(db: Database, agentId: string) {
  const { agents } = schema;
  const [row] = await db.select({ setup: agents.setup }).from(agents).where(eq(agents.id, agentId));
  return row?.setup ?? null;
}

describe("setup checklist", () => {
  test("a new agent starts with it, with the role it was made from; no role is none", async () => {
    const w = await workspace();
    const nina = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      { name: "Nina", handle: "nina", setup: { role: "support" } },
      MODEL,
    );
    // Who talks to it and how it works have good defaults: they start done.
    expect(agentView(nina).setup).toEqual({ role: "support", done: ["who", "how"] });
    const sol = await createAgent(w.db, w.owner.id, w.org.id, { name: "Sol", handle: "sol" }, MODEL);
    expect(agentView(sol).setup).toEqual({ role: null, done: ["who", "how"] });
    // Something that isn't a role id is no role.
    const odd = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      { name: "Odd", handle: "odd", setup: { role: "Atendimento ao cliente" } },
      MODEL,
    );
    expect(agentView(odd).setup).toEqual({ role: null, done: ["who", "how"] });
  });

  test("a new workspace's right hand starts its first-run checklist (ADR 0155 §6)", async () => {
    const w = await workspace();
    const [lodi] = await w.db
      .select({ setup: schema.agents.setup })
      .from(schema.agents)
      .where(eq(schema.agents.builtin, "right_hand"));
    expect(lodi?.setup).toEqual({ role: null, done: [] });
  });

  test("on the right hand only Agora não is stored, on apps and people, by who may connect or invite", async () => {
    const w = await workspace();
    const [lodi] = await w.db.select().from(schema.agents).where(eq(schema.agents.builtin, "right_hand"));
    const id = lodi?.id ?? "";
    await confirmSetupStep(w.db, w.owner.id, w.org.id, id, "apps");
    await confirmSetupStep(w.db, w.owner.id, w.org.id, id, "people");
    expect(await stored(w.db, id)).toEqual({ role: null, done: ["apps", "people"] });
    // The other rows read done from the data alone, and a new agent's steps aren't its.
    for (const step of ["about", "team", "ai", "where"] as const) {
      await expect(confirmSetupStep(w.db, w.owner.id, w.org.id, id, step)).rejects.toBeInstanceOf(NotFoundError);
    }
    // And a new agent's checklist has no first-run rows.
    const leo = await createAgent(w.db, w.owner.id, w.org.id, { name: "Leo", handle: "leo" }, MODEL);
    await expect(confirmSetupStep(w.db, w.owner.id, w.org.id, leo.id, "people")).rejects.toBeInstanceOf(NotFoundError);
    expect(await stored(w.db, id)).toEqual({ role: null, done: ["apps", "people"] });
  });

  test("its owner confirms a step once; twice changes nothing; the order is kept", async () => {
    const w = await workspace();
    // A member's own agent (made for them by the workspace's owner: members don't create agents by default).
    const leo = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      { name: "Leo", handle: "leo", ownerUserId: w.member.id },
      MODEL,
    );
    await confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "where");
    await confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "apps");
    await confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "where");
    expect(await stored(w.db, leo.id)).toEqual({ role: null, done: ["who", "how", "where", "apps"] });
  });

  test("whoever manages agents confirms any agent's; another member can't", async () => {
    const w = await workspace();
    const leo = await createAgent(w.db, w.owner.id, w.org.id, { name: "Leo", handle: "leo" }, MODEL);
    await confirmSetupStep(w.db, w.admin.id, w.org.id, leo.id, "where");
    expect(await stored(w.db, leo.id)).toEqual({ role: null, done: ["who", "how", "where"] });
    await expect(confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "apps")).rejects.toBeInstanceOf(NotFoundError);
    expect(await stored(w.db, leo.id)).toEqual({ role: null, done: ["who", "how", "where"] });
  });

  test("an agent made before the checklist keeps none", async () => {
    const w = await workspace();
    const old = await createAgent(w.db, w.owner.id, w.org.id, { name: "Old", handle: "old" }, MODEL);
    await w.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.id, old.id));
    await confirmSetupStep(w.db, w.owner.id, w.org.id, old.id, "ai");
    expect(await stored(w.db, old.id)).toBeNull();
  });

  test("the migration gives the checklist to the right hand of workspaces with no agent besides it", async () => {
    const w = await workspace();
    const other = await createOrganization(w.db, w.owner.id, { name: "Beta" });
    await createAgent(w.db, w.owner.id, other.organization.id, { name: "Leo", handle: "leo" }, MODEL);
    await w.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.builtin, "right_hand"));
    const file = readFileSync(join(import.meta.dir, "../../db/migrations/0241_agent_setup.sql"), "utf8");
    const backfill = file.split("--> statement-breakpoint")[1] ?? "";
    await w.db.execute(sql.raw(backfill));
    const rows = await w.db
      .select({ orgId: schema.agents.orgId, setup: schema.agents.setup })
      .from(schema.agents)
      .where(eq(schema.agents.builtin, "right_hand"));
    const of = (orgId: string) => rows.find((r) => r.orgId === orgId)?.setup ?? null;
    expect(of(w.org.id)).toEqual({ role: null, done: [] });
    expect(of(other.organization.id)).toBeNull();
  });

  test("reading it drops what isn't a step or a role", () => {
    expect(setupOf(null)).toBeNull();
    expect(setupOf({ role: "dev", done: ["ai", "nope", "ai", "how"] })).toEqual({ role: "dev", done: ["ai", "how"] });
    expect(setupOf({ role: 7, done: "ai" })).toEqual({ role: null, done: [] });
    expect(newSetup(undefined)).toEqual({ role: null, done: ["who", "how"] });
  });

  test("its card's hello, starter and apps are kept, trimmed and capped (ADR 0164); odd ones dropped", () => {
    expect(
      newSetup(null, {
        hello: "  Vou cuidar da sua agenda.  ",
        starter: "clara",
        apps: { "google-calendar": "write", todoist: "read", "Bad Id": "write", notion: "admin" },
      }),
    ).toEqual({
      role: null,
      done: ["who", "how"],
      hello: "Vou cuidar da sua agenda.",
      starter: "clara",
      apps: { "google-calendar": "write", todoist: "read" },
    });
    // Nothing to keep: no key at all, as an agent made before the card reads.
    expect(Object.keys(newSetup("dev", { hello: "   ", starter: "Clara!", apps: {} }))).toEqual(["role", "done"]);
    expect(newSetup(null, { hello: "x".repeat(900) }).hello).toHaveLength(500);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`app-${i}`, "read"]));
    expect(Object.keys(newSetup(null, { apps: many }).apps ?? {})).toHaveLength(12);
    // Read back from the database the same way.
    expect(setupOf({ role: "dev", done: ["ai"], hello: "Oi", apps: { github: "write", x: 3 } })).toEqual({
      role: "dev",
      done: ["ai"],
      hello: "Oi",
      apps: { github: "write" },
    });
  });

  test("a new agent made from its card keeps what the card said", async () => {
    const w = await workspace();
    const clara = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      {
        name: "Clara",
        handle: "clara",
        setup: {
          role: null,
          hello: "Vou cuidar da sua agenda.",
          starter: "clara",
          apps: { "google-calendar": "write" },
        },
      },
      MODEL,
    );
    expect(agentView(clara).setup).toEqual({
      role: null,
      done: ["who", "how"],
      hello: "Vou cuidar da sua agenda.",
      starter: "clara",
      apps: { "google-calendar": "write" },
    });
    expect(await stored(w.db, clara.id)).toMatchObject({ starter: "clara", apps: { "google-calendar": "write" } });
  });
});
