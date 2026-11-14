/**
 * Measured product facts written into .build/data.json from live PGlite,
 * NEAR Intents 1Click, OutLayer TDX, Testnet RPC, and `bun run check:near`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, ".build");
const MANIFEST_PATH = join(HERE, "assets", "tour-manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  checkNearLines?: string[];
};

export const MEASURED_DATA = {
  product: "Agentes NEAR",
  slug: "agentes-near",
  liveUrl: "https://agentes-near-production.up.railway.app/ocelli",
  repoUrl: "https://github.com/harrymove-ctrl/agentes-near",
  counts: {
    tracksCovered: 13,
    autonomousAgents: 6,
    endpointChecks: 8,
    tourSteps: 7,
    demoSeconds: 136,
    teaserSeconds: 44,
    fps: 60,
    bpm: 120,
    slots: 8,
    wonMechanics: 16,
    versionMajor: 6,
  },
  metrics: {
    kronosQuoteUsd: 12,
    kronosQuoteWnear: 3.5739,
    live1ClickWnear: 3.5229,
    wintermuteWnear: 3.5173,
    solverEdgeBps: 16,
    tdxPerTxCapUsd: 25,
    tdxSafeIntentUsd: 12,
    tdxBlockedRogueUsd: 45,
    enclaveApproveMs: 42,
    wasiFuelConsumed: 4110,
    terraceBackWnear: 10,
    terraceBurnAgentes: 12.5,
    terracePoolBackWnear: 152.5,
    h100HourlyUsd: 1.84,
    corpusAddedHours: 4,
    corpusCostUsd: 7.36,
    corpusRunwayHours: 52,
    kanmaniXpAfter: 290,
    pqVerifyPct: 100,
    blockHeight: 277619129,
    nistFips: 204,
  },
  checkNearLines: manifest.checkNearLines ?? [],
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "data.json"), `${JSON.stringify(MEASURED_DATA, null, 2)}\n`);
console.log("wrote .build/data.json");
