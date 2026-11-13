import { createTestDatabase } from "../packages/db/test/pglite";
import { createLocalKeyWrapper } from "../packages/engine/src/index";
import { createApp } from "../apps/server/src/app";
import { verifyZenLedger } from "../apps/server/src/zen/ledger";
import { seedZenWorkspace } from "../apps/server/src/zen/seed";
import {
  fundComputeEndowment,
  getOneClickQuote,
  NEP413_TAG,
  placeConvictionBet,
  probeNearAiAttestation,
  probeTestnetRpc,
  runAgentEscrowAction,
  runEnclaveTest,
} from "../apps/server/src/near/service";

interface CheckItem {
  id: number;
  name: string;
  pass: boolean;
  detail: string;
}

async function main() {
  const results: CheckItem[] = [];
  const handle = await createTestDatabase();

  try {
    const keyWrapper = createLocalKeyWrapper("agentes-near-check-secret-0001");
    const seeded = await seedZenWorkspace(handle.db, keyWrapper);

    // 1. NEAR Intents 1Click quote
    const quote = await getOneClickQuote({ assetIn: "USDC", assetOut: "wNEAR", amountUsd: 12 });
    const check1 =
      quote.ok &&
      quote.dry === true &&
      quote.solverBids.length === 3 &&
      quote.bestSolver === "1click.chaindefuser.com" &&
      Number(quote.amountOutFormatted) > 0;
    results.push({
      id: 1,
      name: "NEAR Intents 1Click Multi-Solver Quote",
      pass: check1,
      detail: `${quote.source.toUpperCase()} · 12 USDC -> ${quote.amountOutFormatted} wNEAR (${quote.bestSolver})`,
    });

    // 2. OutLayer Intel TDX $12 pass + $45 rogue drain block + NEP-413
    const safe = await runEnclaveTest(handle.db, {
      orgId: seeded.orgId,
      agentHandle: "ada",
      amountUsd: 12,
      capUsd: 25,
      action: "1click_swap_settlement",
      toAddress: "intents.near",
    });
    const rogue = await runEnclaveTest(handle.db, {
      orgId: seeded.orgId,
      agentHandle: "ada",
      amountUsd: 45,
      capUsd: 25,
      action: "rogue_drain_attempt",
      toAddress: "attacker.near",
    });
    const check2 =
      safe.allowed === true &&
      safe.decision === "APPROVED" &&
      safe.nep413.tag === NEP413_TAG &&
      safe.wasiTelemetry.target === "wasm32-wasip2" &&
      rogue.allowed === false &&
      rogue.decision === "BLOCKED_PER_TX_CAP";
    results.push({
      id: 2,
      name: "OutLayer Intel TDX Guard ($12 Pass + $45 Block + NEP-413)",
      pass: check2,
      detail: `OutLayer=${safe.outlayerProbe.source.toUpperCase()} · $12=${safe.decision} · $45=${rogue.decision} · NEP-413=${safe.nep413.tagHex}`,
    });

    // 3. NEAR AI Cloud ITA Attestation
    const ita = await probeNearAiAttestation();
    const check3 =
      ita.models.length === 3 &&
      ita.models.every((m) => m.attested) &&
      ita.models.map((m) => m.model).join(",") === "DeepSeek-V4.1,Qwen3.6,GLM-5.3";
    results.push({
      id: 3,
      name: "NEAR AI Cloud Confidential TEE ITA Attestation",
      pass: check3,
      detail: `${ita.source.toUpperCase()} · ${ita.tokenSigningAlg} · models=${ita.models.map((m) => m.model).join(", ")}`,
    });

    // 4. NEAR Testnet RPC view call (pips-quay-contract-i5gp.testnet)
    const rpc = await probeTestnetRpc();
    const check4 =
      rpc.contractId === "pips-quay-contract-i5gp.testnet" &&
      rpc.blockHeight > 0 &&
      rpc.outlayerConfidentialEnabled === true;
    results.push({
      id: 4,
      name: "NEAR Testnet RPC View Probe (pips-quay-contract-i5gp.testnet)",
      pass: check4,
      detail: `${rpc.source.toUpperCase()} · block=${rpc.blockHeight} · strikes=${rpc.totalPipsStrikes} · verifier=${rpc.verifierContract}`,
    });

    // 5. Terrace Social + Hunch + meme.cooking conviction bet
    const bet = await placeConvictionBet(handle.db, {
      orgId: seeded.orgId,
      marketId: "mkt-1click-route",
      side: "BACK",
      stakeWnear: 10,
      handle: "harry.phan",
    });
    const check5 = bet.ok && bet.market.backPoolWnear > 142.5 && bet.burnOnMissEstimateAgentes > 0;
    results.push({
      id: 5,
      name: "Terrace Social + Hunch Conviction Market ($AGENTES Burn-on-Miss)",
      pass: check5,
      detail: `BACK 10 wNEAR · pool=${bet.market.backPoolWnear} wNEAR · burnSink=+${bet.burnOnMissEstimateAgentes} $AGENTES`,
    });

    // 6. Corpus x402 H100 TEE Compute Endowment ($1.84/hr) + Tab BNPL
    const endow = await fundComputeEndowment(handle.db, {
      orgId: seeded.orgId,
      hours: 4,
      sponsor: "harry.phan@commandoss.com",
      useTabBnpl: true,
    });
    const check6 = endow.ok && endow.costUsd === 7.36 && endow.endowment.fundedHours === 52;
    results.push({
      id: 6,
      name: "Corpus x402 H100 TEE Endowment ($1.84/hr) + Tab BNPL",
      pass: check6,
      detail: `+4h ($7.36) · runway=${endow.endowment.runwayHours}h · tabAvailable=$${endow.endowment.tabAvailableUsd}`,
    });

    // 7. Kanmani Escrow + Slashing + NEP-171 Dynamic Credential NFT
    const hire = await runAgentEscrowAction(handle.db, {
      orgId: seeded.orgId,
      agentHandle: "ada",
      taskTitle: "Verify 1Click route + NEP-297 log emission",
      amountUsdc: 20,
      action: "hire",
    });
    const release = await runAgentEscrowAction(handle.db, {
      orgId: seeded.orgId,
      agentHandle: "ada",
      action: "release",
    });
    const check7 =
      hire.escrow.status === "locked" &&
      release.escrow.status === "released" &&
      release.credential.standard === "NEP-171" &&
      release.credential.xp >= 290;
    results.push({
      id: 7,
      name: "Kanmani Escrow + NEP-171 Dynamic Agent Credential NFT",
      pass: check7,
      detail: `${release.credential.tokenId} Lv.${release.credential.level} (${release.credential.tier}, ${release.credential.xp} XP)`,
    });

    // 8. ML-DSA-65 Receipt Chain + Public /api/near/status Endpoint
    const ledger = await verifyZenLedger(handle.db, seeded.orgId);
    const app = createApp({
      edition: "selfhost",
      version: "0.4.0-near",
      modules: [],
      pingDatabase: async () => {},
    });
    const httpRes = await app.request("http://localhost/api/near/status");
    const check8 = ledger.ok && ledger.m5ProvenanceRate === "100%" && httpRes.status === 200;
    results.push({
      id: 8,
      name: "ML-DSA-65 Post-Quantum Receipt Chain + Public /api/near/* Router",
      pass: check8,
      detail: `${ledger.algorithm} · receipts=${ledger.verifiedReceipts}/${ledger.totalReceipts} (${ledger.m5ProvenanceRate}) · HTTP ${httpRes.status}`,
    });

    for (const r of results) {
      console.log(`[${r.pass ? "PASS" : "FAIL"}] #${r.id} ${r.name} :: ${r.detail}`);
    }

    const passed = results.filter((r) => r.pass).length;
    console.log(`\nNEAR CHECK: ${passed === 8 ? "PASS" : "FAIL"} (${passed}/8)`);
    if (passed !== 8) {
      process.exitCode = 1;
    }
  } finally {
    await handle.close();
  }
}

await main();
