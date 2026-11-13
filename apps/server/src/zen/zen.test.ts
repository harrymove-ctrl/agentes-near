import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createLocalKeyWrapper, listChannels } from "@agenteschat/engine";
import { createModelProviders } from "@agenteschat/providers";
import { wrapWithZenDemoProviders, ZEN_DEMO_KEY_PREFIX } from "./demo-provider";
import {
  listZenDecisions,
  simulateZenTamperCheck,
  updateZenDecision,
  verifyZenLedger,
} from "./ledger";
import { seedZenWorkspace } from "./seed";

describe("Ergo ZEN PoC backend integration (PGlite)", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let seededOrgId = "";
  const keyWrapper = createLocalKeyWrapper("ergo-zen-poc-test-secret-0001");

  beforeAll(async () => {
    handle = await createTestDatabase();
    const res = await seedZenWorkspace(handle.db, keyWrapper);
    expect(res.seeded).toBe(true);
    seededOrgId = res.orgId;
  });

  afterAll(async () => {
    await handle?.close();
  });

  test("seedZenWorkspace is idempotent and populates agents, channels, BYOC, tasks, routines, wiki, and approvals", async () => {
    const second = await seedZenWorkspace(handle.db, keyWrapper);
    expect(second.seeded).toBe(false);
    expect(second.orgId).toBe(seededOrgId);

    const agents = await handle.db
      .select({ handle: schema.agents.handle, machineId: schema.agents.machineId })
      .from(schema.agents)
      .where(eq(schema.agents.orgId, seededOrgId));
    const handles = agents.map((a) => a.handle).sort();
    expect(handles).toContain("ada");
    expect(handles).toContain("theo");
    expect(handles).toContain("lia");
    expect(handles).toContain("astra");

    const machines = await handle.db
      .select({ name: schema.machines.name })
      .from(schema.machines)
      .where(eq(schema.machines.orgId, seededOrgId));
    expect(machines.some((m) => m.name === "ergo-byoc-mac-studio-01")).toBe(true);

    const approvals = await handle.db
      .select({ status: schema.approvals.status, actionHash: schema.approvals.actionHash })
      .from(schema.approvals)
      .where(eq(schema.approvals.orgId, seededOrgId));
    expect(approvals.some((a) => a.status === "pending" && a.actionHash.length === 64)).toBe(true);
  });

  test("E9 & F2.8 channel isolation hides private #exec-security from Tyr and External Guest while seeding CommandOSS titles & portraits", async () => {
    const users = await handle.db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, image: schema.users.image })
      .from(schema.users);
    expect(users.length).toBe(12);
    for (const u of users) {
      expect(u.image).toStartWith("#px=1.");
    }
    const byEmail = new Map(users.map((u) => [u.email, u.id]));

    const roles = await handle.db
      .select({ id: schema.orgRoles.id, name: schema.orgRoles.name })
      .from(schema.orgRoles)
      .where(eq(schema.orgRoles.orgId, seededOrgId));
    const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
    const memberRoles = await handle.db
      .select({ userId: schema.organizationMemberRoles.userId, roleId: schema.organizationMemberRoles.roleId })
      .from(schema.organizationMemberRoles)
      .where(eq(schema.organizationMemberRoles.orgId, seededOrgId));
    const heldRoleNames = (email: string) =>
      memberRoles
        .filter((mr) => mr.userId === byEmail.get(email))
        .map((mr) => roleNameById.get(mr.roleId));

    expect(heldRoleNames("daniel.lam@commandoss.com")).toContain("Head of CommandOSS");
    expect(heldRoleNames("tyr@commandoss.com")).toContain("Marketing & BD Lead");
    expect(heldRoleNames("harry.phan@commandoss.com")).toContain("Software Engineer");
    expect(heldRoleNames("henry.nguyen@commandoss.com")).toContain("Software Engineer");

    const henryChannels = await listChannels(handle.db, byEmail.get("henry.nguyen@commandoss.com")!, seededOrgId);
    const tyrChannels = await listChannels(handle.db, byEmail.get("tyr@commandoss.com")!, seededOrgId);
    const guestChannels = await listChannels(handle.db, byEmail.get("guest@partner.example")!, seededOrgId);

    expect(henryChannels.some((c) => c.name === "exec-security")).toBe(true);
    expect(tyrChannels.some((c) => c.name === "exec-security")).toBe(false);
    expect(guestChannels.some((c) => c.name === "exec-security")).toBe(false);
    expect(guestChannels.some((c) => c.name === "client-shared")).toBe(true);
  });

  test("ML-DSA-65 provenance ledger achieves M5 = 100% and detects simulated payload tampering (AC14.6)", async () => {
    const verified = await verifyZenLedger(handle.db, seededOrgId);
    expect(verified.ok).toBe(true);
    expect(verified.m5ProvenanceRate).toBe("100%");
    expect(verified.totalReceipts).toBeGreaterThanOrEqual(6);
    expect(verified.verifiedReceipts).toBe(verified.totalReceipts);

    const tamper = await simulateZenTamperCheck(handle.db, seededOrgId);
    expect(tamper.tamperDetected).toBe(true);
    expect(tamper.verificationAfterTamper.ok).toBe(false);
    expect(tamper.verificationAfterTamper.brokenAtSeq).toBe(tamper.mutatedSeq);
    expect(tamper.liveLedgerIntact).toBe(true);
  });

  test("Tech Lead D1..D9 decision sign-off updates status and appends a verified ML-DSA-65 receipt", async () => {
    const before = await listZenDecisions(handle.db, seededOrgId);
    expect(before.length).toBe(9);

    const updated = await updateZenDecision(handle.db, {
      orgId: seededOrgId,
      decisionId: "D1",
      status: "agree",
      note: "Approved signed channel handle linking for Slack and Telegram.",
      actorUserId: "usr_techlead_test",
      actorName: "Tech Lead",
    });
    expect(updated.decision.status).toBe("agree");
    expect(updated.receiptId).toStartWith("rcpt_");

    const afterVerify = await verifyZenLedger(handle.db, seededOrgId);
    expect(afterVerify.ok).toBe(true);
  });

  test("wrapWithZenDemoProviders synthesizes router outputSchema JSON and streams @ada reply with new receipt", async () => {
    const providers = wrapWithZenDemoProviders(handle.db, createModelProviders({ version: "0.0.0-test" }));
    const anthropic = providers.anthropic!;

    let schemaDelta = "";
    const routerRes = await anthropic.stream(
      {
        model: "claude-haiku-5-5",
        system: "Route the channel message",
        messages: [{ role: "user", content: "@ada check BYOC status?" }],
        outputSchema: {
          type: "object",
          properties: {
            addressee: { type: "string", enum: ["ada", "theo", "none"] },
            reason: { type: "string" },
          },
        },
      },
      {
        apiKey: `${ZEN_DEMO_KEY_PREFIX}ant-commandoss-0001`,
        onDelta: (chunk) => {
          schemaDelta += chunk;
        },
      },
    );
    const parsed = JSON.parse(routerRes.text) as { addressee: string };
    expect(parsed.addressee).toBe("ada");
    expect(schemaDelta).toBe(routerRes.text);

    const countBefore = (await verifyZenLedger(handle.db, seededOrgId)).totalReceipts;
    let replyStream = "";
    const chatRes = await anthropic.stream(
      {
        model: "claude-sonnet-5-5",
        system: "You are @ada, Staff Full-Stack Engineer.",
        messages: [{ role: "user", content: "Summarize BYOC tunnel posture" }],
      },
      {
        apiKey: `${ZEN_DEMO_KEY_PREFIX}ant-commandoss-0001`,
        onDelta: (chunk) => {
          replyStream += chunk;
        },
      },
    );
    expect(chatRes.text).toContain("ergo-byoc-mac-studio-01");
    expect(chatRes.text).toContain("ML-DSA-65");
    expect(replyStream).toBe(chatRes.text);

    const afterVerify = await verifyZenLedger(handle.db, seededOrgId);
    expect(afterVerify.ok).toBe(true);
    expect(afterVerify.totalReceipts).toBe(countBefore + 1);
  });
});
