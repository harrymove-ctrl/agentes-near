/**
 * Measured product facts written into .build/data.json.
 * Every number displayed inside AI Video Maker scenes references this verified snapshot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, ".build");

export const MEASURED_DATA = {
  product: "Agentes NEAR",
  slug: "agentes-near",
  liveUrl: "https://agentes-near-production.up.railway.app/ocelli",
  repoUrl: "https://github.com/harrymove-ctrl/agentes-near",
  counts: {
    tracksCovered: 13,
    autonomousAgents: 6,
    endpointChecks: 8,
    demoSeconds: 90,
    teaserSeconds: 30,
    fps: 60,
    bpm: 120,
    slots: 13,
    wonMechanics: 16,
  },
  metrics: {
    quoteUsd: 500,
    quoteInUsdc: 1250,
    quoteWnear: 358.13,
    liveQuoteWnear: 367.731,
    wintermuteWnear: 354.18,
    solverEdgeBps: 16,
    wintermuteSpreadBps: 4,
    tdxPerTxCapUsd: 25,
    tdxSafeIntentUsd: 12,
    tdxBlockedRogueUsd: 45,
    tdxDailyCapUsd: 100,
    h100HourlyUsd: 1.84,
    pqVerifyPct: 100,
    auditPassPct: 100,
    blockHeight: 277602026,
    legacyBlockHeight: 277497700,
    enclaveLatencyMs: 42,
    wasiFuelConsumed: 4110,
    retainerUsd: 240,
    arenaBackPct: 85,
    nistFips: 204,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "data.json"), `${JSON.stringify(MEASURED_DATA, null, 2)}\n`);
console.log("wrote .build/data.json");
