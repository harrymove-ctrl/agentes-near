import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createLocalKeyWrapper, listChannels } from "@agenteschat/engine";
import type { ModelProvider } from "@agenteschat/providers";
import { createApp } from "../app";
import { wrapWithZenDemoProviders, ZEN_DEMO_KEY_PREFIX } from "../zen/demo-provider";
import { verifyZenLedger } from "../zen/ledger";
import { ALL_SEEDED_EMAILS, seedZenWorkspace } from "../zen/seed";
import { nearPublicRoutes } from "./routes";
import {
  constructNep413Receipt,
  fundComputeEndowment,
  getNearStatus,
  getOneClickQuote,
  HOURLY_H100_TEE_RATE_USD,
  NEP413_TAG,
  placeConvictionBet,
  probeNearAiAttestation,
  probeTestnetRpc,
  runAgentEscrowAction,
  runEnclaveTest,
} from "./service";

describe("NEAR Hackathon backend integration (PGlite + Live/Fallback Probes + Hono Routes)", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let seededOrgId = "";
  let tempWebDir = "";
  const keyWrapper = createLocalKeyWrapper("agentes-near-test-secret-0001");

  beforeAll(async () => {
    handle = await createTestDatabase();
    const res = await seedZenWorkspace(handle.db, keyWrapper);
    expect(res.seeded).toBe(true);
    seededOrgId = res.orgId;

    tempWebDir = mkdtempSync(join(tmpdir(), "agentes-near-web-"));
    writeFileSync(join(tempWebDir, "index.html"), "<html><body>SPA_FALLBACK</body></html>");
  });

  afterAll(async () => {
    await handle?.close();
    if (tempWebDir) rmSync(tempWebDir, { recursive: true, force: true });
  });

  test("1. Seeded workspace includes #near-intents-arena, #compute-endowment, #outlayer-tee-vault, @kronos, and ALL_SEEDED_EMAILS", async () => {
    const agents = await handle.db
      .select({ handle: schema.agents.handle })
      .from(schema.agents)
      .where(eq(schema.agents.orgId, seededOrgId));
    const handles = agents.map((a) => a.handle);
    expect(handles).toContain("ada");
    expect(handles).toContain("theo");
    expect(handles).toContain("lia");
    expect(handles).toContain("kronos");

    const users = await handle.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users);
    const harry = users.find((u) => u.email === "harry.phan@commandoss.com");
    expect(harry).toBeDefined();
    expect(ALL_SEEDED_EMAILS).toContain("harry.phan@commandoss.com");
    expect(ALL_SEEDED_EMAILS).toContain("henry.nguyen@commandoss.com");

    const channels = await listChannels(handle.db, harry!.id, seededOrgId);
    const channelNames = channels.map((c) => c.name);
    expect(channelNames).toContain("near-intents-arena");
    expect(channelNames).toContain("compute-endowment");
    expect(channelNames).toContain("outlayer-tee-vault");
  });

  test("2. NEAR Intents 1Click dry quote returns multi-solver bids and supports deterministic offline fallback", async () => {
    const liveOrFallback = await getOneClickQuote({
      assetIn: "USDC",
      assetOut: "wNEAR",
      amountUsd: 12,
    });
    expect(liveOrFallback.ok).toBe(true);
    expect(liveOrFallback.dry).toBe(true);
    expect(liveOrFallback.bestSolver).toBe("1click.chaindefuser.com");
    expect(liveOrFallback.solverBids.map((b) => b.solver)).toEqual([
      "1click.chaindefuser.com",
      "wintermute-intent.near",
      "rhea-liquidity.near",
    ]);
    expect(Number(liveOrFallback.amountOutFormatted)).toBeGreaterThan(0);

    const forcedFallback = await getOneClickQuote({
      assetIn: "USDC",
      assetOut: "wNEAR",
      amountUsd: 25,
      forceFallback: true,
    });
    expect(forcedFallback.source).toBe("fallback");
    expect(forcedFallback.live).toBe(false);
    expect(forcedFallback.solverBids.length).toBe(3);
  });

  test("3. OutLayer Intel TDX Spend Guard approves $12 with NEP-413 (tag 2147484061) and blocks $45 rogue drain", async () => {
    const nep413 = constructNep413Receipt({
      messageObj: { test: true, amount: 12 },
      recipient: "intents.near",
      nonceSeed: "unit-test-nonce",
    });
    expect(nep413.tag).toBe(NEP413_TAG);
    expect(nep413.tagHex).toBe("0x8000019d");
    expect(nep413.nep413Hash.length).toBe(64);
    expect(nep413.payloadSha256.length).toBe(64);

    const safe = await runEnclaveTest(handle.db, {
      orgId: seededOrgId,
      agentHandle: "ada",
      amountUsd: 12,
      capUsd: 25,
      action: "1click_swap",
      toAddress: "intents.near",
    });
    expect(safe.allowed).toBe(true);
    expect(safe.decision).toBe("APPROVED");
    expect(safe.wasiTelemetry.target).toBe("wasm32-wasip2");
    expect(safe.nep413.tag).toBe(2_147_484_061);
    expect(safe.pqReceiptId).toStartWith("rcpt_");

    const rogue = await runEnclaveTest(handle.db, {
      orgId: seededOrgId,
      agentHandle: "ada",
      amountUsd: 45,
      capUsd: 25,
      action: "rogue_drain",
      toAddress: "attacker.near",
    });
    expect(rogue.allowed).toBe(false);
    expect(rogue.decision).toBe("BLOCKED_PER_TX_CAP");
    expect(rogue.pqReceiptId).toStartWith("rcpt_");

    // Raising slider cap to $50 allows $45 cleanly
    const raisedCap = await runEnclaveTest(handle.db, {
      orgId: seededOrgId,
      agentHandle: "theo",
      amountUsd: 45,
      capUsd: 50,
      action: "approved_high_cap",
      toAddress: "intents.near",
    });
    expect(raisedCap.allowed).toBe(true);
    expect(raisedCap.perTxCapUsd).toBe(50);
  });

  test("4. NEAR AI Cloud ITA attestation verifies DeepSeek-V4.1, Qwen3.6, and GLM-5.3", async () => {
    const ita = await probeNearAiAttestation();
    expect(ita.models.map((m) => m.model)).toEqual(["DeepSeek-V4.1", "Qwen3.6", "GLM-5.3"]);
    expect(ita.models.every((m) => m.attested)).toBe(true);
    expect(ita.tokenSigningAlg).toBe("PS384");
  });

  test("5. NEAR Testnet RPC probes pips-quay-contract-i5gp.testnet get_protocol_stats", async () => {
    const rpc = await probeTestnetRpc();
    expect(rpc.contractId).toBe("pips-quay-contract-i5gp.testnet");
    expect(rpc.blockHeight).toBeGreaterThan(0);
    expect(rpc.outlayerConfidentialEnabled).toBe(true);
  });

  test("6. Terrace Social + Hunch conviction markets & Corpus x402 H100 TEE endowment ($1.84/hr) persist cleanly", async () => {
    const betRes = await placeConvictionBet(handle.db, {
      orgId: seededOrgId,
      marketId: "mkt-1click-route",
      side: "BACK",
      stakeWnear: 10,
      handle: "harry.phan",
    });
    expect(betRes.ok).toBe(true);
    expect(betRes.market.backPoolWnear).toBe(152.5);
    expect(betRes.burnOnMissEstimateAgentes).toBeGreaterThan(0);
    expect(betRes.pqReceiptId).toStartWith("rcpt_");

    const endowRes = await fundComputeEndowment(handle.db, {
      orgId: seededOrgId,
      hours: 4,
      sponsor: "harry.phan@commandoss.com",
      useTabBnpl: true,
    });
    expect(endowRes.ok).toBe(true);
    expect(endowRes.costUsd).toBe(Number((4 * HOURLY_H100_TEE_RATE_USD).toFixed(2)));
    expect(endowRes.endowment.fundedHours).toBe(52);
    expect(endowRes.endowment.lastX402Header).toContain("X-402-Payment");
    expect(endowRes.pqReceiptId).toStartWith("rcpt_");
  });

  test("7. Kanmani escrow hire/release/slash updates NEP-171 Dynamic Credential NFTs and keeps ML-DSA-65 ledger M5 = 100%", async () => {
    const hired = await runAgentEscrowAction(handle.db, {
      orgId: seededOrgId,
      agentHandle: "ada",
      taskTitle: "Audit 1Click solver slippage bounds",
      amountUsdc: 20,
      action: "hire",
    });
    expect(hired.escrow.status).toBe("locked");
    expect(hired.escrow.slashStakeUsdc).toBe(4);

    const levelBefore = hired.credential.level;
    const xpBefore = hired.credential.xp;
    const released = await runAgentEscrowAction(handle.db, {
      orgId: seededOrgId,
      agentHandle: "ada",
      action: "release",
    });
    expect(released.escrow.status).toBe("released");
    expect(released.credential.xp).toBe(xpBefore + 50);
    expect(released.credential.level).toBeGreaterThanOrEqual(levelBefore);

    const slashed = await runAgentEscrowAction(handle.db, {
      orgId: seededOrgId,
      agentHandle: "lia",
      taskTitle: "Missed SLA latency window",
      amountUsdc: 15,
      action: "slash",
    });
    expect(slashed.escrow.status).toBe("slashed");
    expect(slashed.credential.slashedCount).toBeGreaterThanOrEqual(1);

    const ledger = await verifyZenLedger(handle.db, seededOrgId);
    expect(ledger.ok).toBe(true);
    expect(ledger.m5ProvenanceRate).toBe("100%");
    expect(ledger.totalReceipts).toBeGreaterThanOrEqual(12);
  });

  test("8. Public /api/near/* routes mount BEFORE SPA fallback and serve unauthenticated requests", async () => {
    const app = createApp({
      edition: "selfhost",
      version: "test",
      modules: [],
      pingDatabase: async () => {},
      webDir: tempWebDir,
    });

    // Public SPA still serves index.html on /ocelli
    const spaRes = await app.request("http://localhost/ocelli");
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain("SPA_FALLBACK");

    // Public /api/near/status is NOT swallowed by SPA fallback
    const statusRes = await app.request("http://localhost/api/near/status");
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as { ok: boolean; markets: unknown[]; wallets: unknown[] };
    expect(statusJson.ok).toBe(true);
    expect(statusJson.markets.length).toBe(3);
    expect(statusJson.wallets.length).toBe(4);

    // Public DB-backed nearPublicRoutes handles quote, enclave-test, bet, endowment, escrow
    const pub = nearPublicRoutes({ db: handle.db });
    const qRes = await pub.request("http://localhost/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetIn: "USDC", assetOut: "wNEAR", amountUsd: 15 }),
    });
    expect(qRes.status).toBe(200);

    const eRes = await pub.request("http://localhost/enclave-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentHandle: "kronos", amountUsd: 45, capUsd: 25 }),
    });
    expect(eRes.status).toBe(200);
    const eJson = (await eRes.json()) as { allowed: boolean; decision: string };
    expect(eJson.allowed).toBe(false);
    expect(eJson.decision).toBe("BLOCKED_PER_TX_CAP");

    const finalStatus = await getNearStatus(handle.db, { orgId: seededOrgId });
    expect(finalStatus.zenLedger?.ok).toBe(true);
    expect(finalStatus.nep297Logs.some((l) => l.startsWith("EVENT_JSON:"))).toBe(true);
  });

  test("9. wrapWithZenDemoProviders streams @kronos NEAR 1Click + OutLayer TDX reply with ML-DSA-65 receipt", async () => {
    const dummyBase: ModelProvider = {
      id: "anthropic",
      async stream() {
        throw new Error("Should not call base provider in ZEN_DEMO mode");
      },
    };
    const providers = wrapWithZenDemoProviders(handle.db, { anthropic: dummyBase });
    const deltas: string[] = [];

    const result = await providers.anthropic!.stream(
      {
        model: "claude-sonnet-4-6",
        maxTokens: 512,
        system: "You are @kronos (Name: Kronos, 1Click Intents & OutLayer TEE Desk) inside #near-intents-arena.",
        messages: [
          {
            role: "user",
            content: "Quote $12 USDC -> wNEAR and verify the OutLayer TDX policy receipt",
          },
        ],
      },
      {
        apiKey: `${ZEN_DEMO_KEY_PREFIX}test-key`,
        onDelta: (d) => deltas.push(d),
      },
    );

    const joined = deltas.join("");
    expect(joined).toBe(result.text);
    expect(joined).toContain("3.5739 wNEAR");
    expect(joined).toContain("1click.chaindefuser.com");
    expect(joined).toContain("wintermute-intent.near");
    expect(joined).toContain("NEP-413");
    expect(joined).toContain("ML-DSA-65");
    expect(joined).not.toContain("Ergo `ZEN` workspace coordinator online");

    const ledger = await verifyZenLedger(handle.db, seededOrgId);
    expect(ledger.ok).toBe(true);
  });
});
