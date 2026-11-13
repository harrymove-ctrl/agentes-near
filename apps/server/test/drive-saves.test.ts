import { afterEach, expect, test } from "bun:test";
import { driveSections, PRIVATE_SECTION } from "@agenteschat/client/lib/drive";
import { grantScopes } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** A routine's file as a person gets it: its model's real tool calls, then the Drive API and the page's sections. */

let t: TestServer;
afterEach(() => t.close());

type Artifact = Parameters<typeof driveSections>[0][number];

const DRIVE = ["drive:read", "drive:write"].map((scope) => ({ connectionId: null, scope }));

/** The routine saves a document (`extra`: more of the call's input), then hands off. */
const routineModel =
  (extra: Record<string, unknown> = {}) =>
  (req: { messages: unknown[] }) => {
    const last = JSON.stringify(req.messages.at(-1));
    if (last.includes("Posted.")) return { chunks: ["registrado"] };
    if (last.includes("Saved"))
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: "Relatório pronto." } }] };
    return {
      chunks: [],
      toolUses: [{ name: "create_artifact", input: { title: "Semana", kind: "document", markdown: "# oi", ...extra } }],
    };
  };

async function fired(target: Record<string, unknown>, extra?: Record<string, unknown>) {
  t = await createTestServer({ reply: routineModel(extra) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  await grantScopes(t.db, seeded.orgId, seeded.agentId, DRIVE);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const created = await api("/routines", {
    json: {
      name: "Relatório",
      agentId: seeded.agentId,
      prompt: "Salve o relatório da semana no Drive.",
      target: target.type === "channel" ? { ...target, channelId: seeded.channelId } : target,
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
    },
  });
  const routine = (await created.json()) as { id: string };
  await api(`/routines/${routine.id}/run`, { json: {} });
  await t.drain();
  const list = async () => ((await (await api("/artifacts")).json()) as { artifacts: Artifact[] }).artifacts;
  return { list };
}

test("a routine reporting to a channel: its creator finds the file in the Drive's main sections", async () => {
  const { list } = await fired({ type: "channel" });
  const files = await list();
  expect(files.map((a) => a.title)).toEqual(["Semana"]);
  expect(files[0]?.audience).toMatchObject({ kind: "channel", private: false });
  expect(driveSections(files, "date").map((s) => s.key)).toEqual(["today"]);
});

test("a routine reporting in a DM: its creator finds it in the private section", async () => {
  const { list } = await fired({ type: "dm" });
  const files = await list();
  expect(files[0]?.audience.kind).toBe("dm");
  expect(driveSections(files, "date").map((s) => s.key)).toEqual([PRIVATE_SECTION]);
});

test("with shared_drive: in the main sections, of no conversation", async () => {
  const { list } = await fired({ type: "dm" }, { shared_drive: true });
  const files = await list();
  expect(files[0]).toMatchObject({ channelId: null, audience: { kind: "workspace" } });
  expect(driveSections(files, "date").map((s) => s.key)).toEqual(["today"]);
});
