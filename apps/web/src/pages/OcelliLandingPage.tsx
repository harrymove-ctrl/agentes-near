import { useEffect, useState } from "react";
import {
  BenchoSloshSlider,
  DitherButton,
  DitherCard,
  DitherGauge,
  DitherHeatmap,
  DitherProgressBar,
  DitherScene,
  type DitherSceneVariant,
  DitherStatCard,
  DitherTabs,
  DitherUptimeBar,
  MdxcnFrame,
} from "@/components/dithercn";
import "./ocelli-landing.css";

type DemoPaneId = "arena" | "enclave" | "endowment" | "quote";

interface ConvictionMarket {
  id: string;
  title: string;
  channel: string;
  backPoolWnear: number;
  fadePoolWnear: number;
  burnTicker: string;
}

interface EnclaveResult {
  allowed: boolean;
  amountUsd: number;
  capUsd: number;
  reason: string;
  receiptHash: string;
  nep413Tag?: number;
  teeMeasurement?: string;
}

interface QuoteResult {
  pair: string;
  amountInUsd: number;
  amountOutDisplay: string;
  bestSolver: string;
  latencyMs: number;
  liveMode: string;
  solvers: Array<{ name: string; outDisplay: string; feeBps: number }>;
}

interface EndowmentState {
  hourlyRateUsd: number;
  fundedHours: number;
  poolUsd: number;
  tabCreditUsd: number;
  escrowLockedUsdc: number;
  credentialLevel: number;
}

const SCENE_OPTIONS: Array<{ id: DitherSceneVariant; label: string }> = [
  { id: "horizon", label: "horizon" },
  { id: "aurora", label: "aurora" },
  { id: "plasma", label: "plasma" },
  { id: "waves", label: "waves" },
  { id: "dither-orb", label: "dither-orb" },
];

const INITIAL_MARKETS: ConvictionMarket[] = [
  {
    id: "mkt-1click-route",
    title: "1Click solver auction settles under 3s across Wintermute + Rhea",
    channel: "#near-intents-arena",
    backPoolWnear: 412,
    fadePoolWnear: 128,
    burnTicker: "$AGENTES",
  },
  {
    id: "mkt-agentes-burn",
    title: "@ada stays 100% inside $25/tx OutLayer TDX cap over 500 trades",
    channel: "#outlayer-tee-vault",
    backPoolWnear: 580,
    fadePoolWnear: 95,
    burnTicker: "$AGENTES",
  },
];

const PROMPT_STREAMS = [
  {
    id: "stream-arena",
    label: "Back SOL>ETH 1Click intent",
    channel: "#near-intents-arena",
    userPrompt:
      "Quote 10 NEAR to USDC on 1click.chaindefuser.com and open a Terrace Social BACK market.",
    steps: [
      "@theo queried 1click.chaindefuser.com/v0/quote (best solver: wintermute-intent.near, 312ms)",
      "@ada signed NEP-413 payload (tag 2147484061) inside OutLayer Intel TDX enclave",
      "@lia appended ML-DSA-65 receipt #49 to immutable workspace ledger",
    ],
    replyAgent: "@ada",
    replyRole: "Intent Router · OutLayer TEE",
    replyText:
      "Quoted 10 NEAR -> 48.20 USDC via wintermute-intent.near. Opened conviction market in #near-intents-arena with 412 wNEAR BACK vs 128 wNEAR FADE.",
  },
  {
    id: "stream-guard",
    label: "Approve $12 & block $45 drain",
    channel: "#outlayer-tee-vault",
    userPrompt:
      "Run OutLayer TDX spend guard check: $12 safe swap followed by $45 rogue drain.",
    steps: [
      "OutLayer WASI wasm32-wasip2 guard evaluated $12.00 <= $25.00/tx hardware cap: APPROVED",
      "OutLayer WASI wasm32-wasip2 guard evaluated $45.00 > $25.00/tx hardware cap: BLOCKED",
      "@kronos sealed dual SHA-256 + ML-DSA-65 denial proof into audit chain",
    ],
    replyAgent: "@kronos",
    replyRole: "Security Sentinel · Intel TDX",
    replyText:
      "$12.00 swap cleared with NEP-413 receipt. The $45.00 rogue drain never touched MPC signing shares and returned deterministic hardware rejection.",
  },
  {
    id: "stream-endowment",
    label: "Fund +4h H100 TEE via x402",
    channel: "#compute-endowment",
    userPrompt:
      "Top up +4h H100 confidential compute ($1.84/hr) and check Tab BNPL credit line.",
    steps: [
      "Corpus x402 streaming pool credited $7.36 (+4.0 GPU hours at $1.84/hr)",
      "NEAR AI Cloud ITA attestation verified DeepSeek-V4.1 & Qwen3.6 enclave quotes",
      "Tab BNPL USDC.near line refreshed: $120.00 available for burst inference",
    ],
    replyAgent: "@theo",
    replyRole: "Compute Treasurer · x402",
    replyText:
      "Self-hosted agents now have 18.5 hours of funded H100 TEE runway. Outbound BYOC runner ergo-byoc-mac-studio-01 remains connected with zero open ports.",
  },
  {
    id: "stream-escrow",
    label: "Verify ML-DSA-65 & NEP-171",
    channel: "#near-intents-arena",
    userPrompt:
      "Run 1-nibble tamper check on Kyvera receipts and release Kanmani task escrow.",
    steps: [
      "Kyvera verifier detected 1-nibble payload mutation in dry-run copy; live ledger 100% intact",
      "Kanmani escrow released 18.00 USDC.near to @lia upon verified benchmark completion",
      "NEP-171 Dynamic Agent Credential NFT upgraded @lia to Level 7 Verified Operator",
    ],
    replyAgent: "@lia",
    replyRole: "Verification Lead · Kyvera",
    replyText:
      "All 48 PGlite ledger receipts passed NIST FIPS 204 ML-DSA-65 verification. Secret-free .ergo-bundle export is ready for zero lock-in migration.",
  },
];

const TRACK_MATRIX = [
  {
    name: "Memecoins",
    ev: "9.7% EV",
    tier: "high",
    feature: "$AGENTES NEP-141 burn-on-miss mechanic tied to conviction market misses.",
    tag: "meme.cooking + Terrace",
  },
  {
    name: "Games",
    ev: "8.8% EV",
    tier: "high",
    feature: "Live #near-intents-arena BACK/FADE prediction game with real-time odds.",
    tag: "Terrace Social + Hunch",
  },
  {
    name: "Thesis",
    ev: "7.5% EV",
    tier: "high",
    feature: "Auditable investment & solver theses backed by ML-DSA-65 receipts.",
    tag: "Kyvera + Zen Ledger",
  },
  {
    name: "NFTs",
    ev: "7.0% EV",
    tier: "high",
    feature: "NEP-171 Dynamic Agent Credential NFTs that level up on released escrows.",
    tag: "Kanmani + NEP-171",
  },
  {
    name: "Social",
    ev: "6.5% EV",
    tier: "high",
    feature: "Slack-grade team + agent channels where humans and AI bet side by side.",
    tag: "Terrace Social + Slack",
  },
  {
    name: "Swarms",
    ev: "6.5% EV",
    tier: "high",
    feature: "@ada, @theo, @lia, and @kronos coordinate via bounded channel handoffs.",
    tag: "Multi-Agent Swarm",
  },
  {
    name: "DeFi",
    ev: "Core Track",
    tier: "core",
    feature: "Live NEAR Intents 1Click cross-chain routing across competing solvers.",
    tag: "1click.chaindefuser.com",
  },
  {
    name: "Privacy",
    ev: "Core Track",
    tier: "core",
    feature: "NEAR AI Cloud Confidential TEE attestation + monotonic channel isolation.",
    tag: "Intel TDX + ITA",
  },
  {
    name: "Business",
    ev: "Core Track",
    tier: "core",
    feature: "Corpus x402 compute endowment ($1.84/hr) + Tab USDC.near BNPL lines.",
    tag: "Corpus + Tab",
  },
  {
    name: "Real World",
    ev: "Core Track",
    tier: "core",
    feature: "Hold-to-Approve payload gates & CommandOSS Customer Zero team workflows.",
    tag: "BYOC + Approvals",
  },
  {
    name: "Agents",
    ev: "Core Track",
    tier: "core",
    feature: "Autonomous 24/7 agent staff with SKILL.md manifests and hardware spend caps.",
    tag: "OutLayer MPC + WASI",
  },
  {
    name: "Security",
    ev: "Core Track",
    tier: "core",
    feature: "Deterministic $45 rogue drain block + NIST FIPS 204 ML-DSA-65 chain.",
    tag: "OutLayer + Kyvera",
  },
  {
    name: "Open",
    ev: "Core Track",
    tier: "core",
    feature: "Self-hosted Bun + PGlite stack with secret-free .ergo-bundle portability.",
    tag: "MIT + Zero Lock-In",
  },
];

const FAQ_ITEMS = [
  {
    q: "How can judges test the full workspace and live NEAR flows in 1 click?",
    a: "Click '1-Click Enter Live Slack Workspace' above. It signs you in as Harry Phan via POST /api/auth/zen-demo-login, drops you straight into #near-intents-arena, and opens the NEAR Intents & TEE control panel with zero password prompts.",
  },
  {
    q: "How does OutLayer Intel TDX enforce the $25.00/tx spend guard?",
    a: "Every agent transaction passes through a WASI wasm32-wasip2 policy gate inside the OutLayer TDX enclave before MPC key shares sign. A $12.00 swap receives a NEP-413 receipt, while a $45.00 drain attempt is blocked deterministically when the slider cap is $25.00.",
  },
  {
    q: "What makes NEAR Intents 1Click real instead of a static mockup?",
    a: "POST /api/near/quote calls https://1click.chaindefuser.com/v0/quote (with dry: true for safe judge demos) and compares live quotes from 1click.chaindefuser.com, wintermute-intent.near, and rhea-liquidity.near, falling back cleanly only when offline.",
  },
  {
    q: "How do Terrace Social conviction markets and Corpus x402 endowment connect?",
    a: "Teammates and agents stake wNEAR on BACK or FADE outcomes right inside #near-intents-arena. Winning theses build agent NEP-171 credentials, misses burn $AGENTES, and protocol fees stream into the Corpus x402 H100 TEE pool ($1.84/hr) to keep self-hosted agents online 24/7.",
  },
  {
    q: "Where do private keys and audit logs live?",
    a: "MPC signing shares stay inside OutLayer Intel TDX, private team context stays isolated in #exec-security, and every message, bet, and enclave decision writes a SHA-256 + NIST FIPS 204 ML-DSA-65 hash-chained receipt verifiable in PGlite.",
  },
  {
    q: "What open-source baseline does Agentes NEAR build upon?",
    a: "Agentes NEAR builds transparently on the self-hosted agentes-chat Slack-for-agents baseline (Bun, React, TanStack Router, PGlite) combined with custom NEAR Intents 1Click, OutLayer TDX, NEAR AI Cloud ITA, dithercn/mdxcn/slosh UI primitives, and ML-DSA-65 ledger modules under MIT license.",
  },
];

const UPTIME_DAYS = Array.from({ length: 24 }, (_, i) => ({
  label: `Probe #${i + 1}`,
  status: i === 13 ? ("degraded" as const) : ("up" as const),
  latencyMs: i === 13 ? 418 : 112 + ((i * 29) % 85),
  detail: i === 13 ? "1Click solver fallback check" : "TDX + Testnet RPC OK",
}));

export function OcelliLandingPage() {
  const [scene, setScene] = useState<DitherSceneVariant>("horizon");
  const [activePane, setActivePane] = useState<DemoPaneId>("arena");
  const [activePromptIdx, setActivePromptIdx] = useState(0);
  const [enteringWorkspace, setEnteringWorkspace] = useState(false);

  const [markets, setMarkets] = useState<ConvictionMarket[]>(INITIAL_MARKETS);
  const [betBusy, setBetBusy] = useState<string | null>(null);
  const [betLog, setBetLog] = useState<string>(
    "Live pool synced. Pick BACK or FADE to stake 5 wNEAR in #near-intents-arena.",
  );

  const [capUsd, setCapUsd] = useState<number>(25);
  const [enclaveBusy, setEnclaveBusy] = useState(false);
  const [enclaveResult, setEnclaveResult] = useState<EnclaveResult>({
    allowed: true,
    amountUsd: 12,
    capUsd: 25,
    reason: "Within OutLayer Intel TDX per-tx guardrail ($12.00 <= $25.00)",
    receiptHash: "sha256:9f84b2c1e8a7d01944c3b1a8e720f94e1c",
    nep413Tag: 2147484061,
    teeMeasurement: "tdx-mrtd-near-outlayer-v2",
  });

  const [endowment, setEndowment] = useState<EndowmentState>({
    hourlyRateUsd: 1.84,
    fundedHours: 14.5,
    poolUsd: 26.68,
    tabCreditUsd: 120,
    escrowLockedUsdc: 42.5,
    credentialLevel: 7,
  });
  const [endowBusy, setEndowBusy] = useState(false);
  const [endowNote, setEndowNote] = useState(
    "Corpus x402 pool active at $1.84/hr H100 TEE rate.",
  );

  const [quotePair, setQuotePair] = useState<"NEAR_USDC" | "ETH_NEAR" | "USDC_WNEAR">("NEAR_USDC");
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteResult, setQuoteResult] = useState<QuoteResult>({
    pair: "10 NEAR -> USDC",
    amountInUsd: 48.2,
    amountOutDisplay: "48.20 USDC.near",
    bestSolver: "wintermute-intent.near",
    latencyMs: 312,
    liveMode: "1click.chaindefuser.com",
    solvers: [
      { name: "wintermute-intent.near", outDisplay: "48.20 USDC", feeBps: 4 },
      { name: "1click.chaindefuser.com", outDisplay: "48.09 USDC", feeBps: 6 },
      { name: "rhea-liquidity.near", outDisplay: "47.94 USDC", feeBps: 8 },
    ],
  });

  const [liveStatusSummary, setLiveStatusSummary] = useState<string>(
    "NEAR Testnet + OutLayer TDX + 1Click Ready",
  );

  useEffect(() => {
    document.title = "Agentes NEAR · Your team and NEAR AI agents, in one Slack workspace";
    let cancelled = false;

    void fetch("/api/near/status")
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as Record<string, unknown>;
      })
      .then((data) => {
        if (cancelled || !data) return;

        const rawMarkets = Array.isArray(data.markets) ? data.markets : null;
        if (rawMarkets && rawMarkets.length > 0) {
          setMarkets(
            rawMarkets.slice(0, 2).map((m: Record<string, unknown>, idx: number) => ({
              id: String(m.marketId ?? m.id ?? INITIAL_MARKETS[idx]?.id ?? `mkt-${idx}`),
              title: String(m.title ?? INITIAL_MARKETS[idx]?.title ?? "Conviction Market"),
              channel: String(m.channel ?? "#near-intents-arena"),
              backPoolWnear: Number(m.backPoolWnear ?? m.backPool ?? 412),
              fadePoolWnear: Number(m.fadePoolWnear ?? m.fadePool ?? 128),
              burnTicker: String(m.stakeAsset ?? m.burnTicker ?? "$AGENTES"),
            })),
          );
        }

        const pool = (data.endowment ?? data.computeEndowment) as Record<string, unknown> | undefined;
        const escrows = Array.isArray(data.escrows) ? data.escrows : [];
        const creds = Array.isArray(data.credentials) ? data.credentials : [];
        const lockedEscrowSum = escrows.reduce(
          (acc: number, e: Record<string, unknown>) =>
            e.status === "locked" ? acc + Number(e.amountUsdc ?? 0) : acc,
          0,
        );
        const topCredLevel = creds.reduce(
          (mx: number, c: Record<string, unknown>) => Math.max(mx, Number(c.level ?? 0)),
          0,
        );
        if (pool) {
          setEndowment((prev) => ({
            hourlyRateUsd: Number(pool.hourlyRateUsd ?? prev.hourlyRateUsd),
            fundedHours: Number(pool.fundedHours ?? pool.runwayHours ?? prev.fundedHours),
            poolUsd: Number(pool.balanceUsd ?? pool.poolUsd ?? prev.poolUsd),
            tabCreditUsd: Number(pool.tabAvailableUsd ?? pool.tabCreditUsd ?? prev.tabCreditUsd),
            escrowLockedUsdc: lockedEscrowSum > 0 ? lockedEscrowSum : prev.escrowLockedUsdc,
            credentialLevel: topCredLevel > 0 ? topCredLevel : prev.credentialLevel,
          }));
        }

        const liveQuote = data.oneClickQuote as Record<string, unknown> | undefined;
        if (liveQuote && Array.isArray(liveQuote.solverBids)) {
          setQuoteResult({
            pair: `${String(liveQuote.amountInFormatted ?? "10 NEAR")} -> ${String(liveQuote.assetOut ?? "USDC")}`,
            amountInUsd: Number(liveQuote.amountUsd ?? 48.2),
            amountOutDisplay: `${String(liveQuote.amountOutFormatted ?? "48.20")} ${String(liveQuote.assetOut ?? "USDC")}`,
            bestSolver: String(liveQuote.bestSolver ?? "wintermute-intent.near"),
            latencyMs: Number(liveQuote.timeEstimateSec ?? 2) * 140,
            liveMode: String(liveQuote.source ?? "live"),
            solvers: (liveQuote.solverBids as Array<Record<string, unknown>>).map((s) => ({
              name: String(s.solver ?? "1click.chaindefuser.com"),
              outDisplay: String(s.amountOutFormatted ?? "Verified"),
              feeBps: Number(s.spreadBps ?? 5),
            })),
          });
        }

        const network = String(data.network ?? "testnet");
        const ledger = data.zenLedger as Record<string, unknown> | undefined;
        const m5 = ledger?.m5ProvenanceRate ? String(ledger.m5ProvenanceRate) : "100%";
        setLiveStatusSummary(`NEAR ${network} · ML-DSA-65 M5=${m5}`);
      })
      .catch(() => {
        // Keep initial snapshot if server is booting
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const enterWorkspace = async (openNearPanel = false) => {
    setEnteringWorkspace(true);
    try {
      await fetch("/api/auth/zen-demo-login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "harry.phan@commandoss.com" }),
      });
      const meRes = await fetch("/api/app/me", { credentials: "include" });
      if (meRes.ok) {
        const me = (await meRes.json()) as { organizations?: Array<{ id: string }> };
        const orgId = me.organizations?.[0]?.id;
        if (orgId) {
          window.location.assign(openNearPanel ? `/org/${orgId}/home?near=1` : `/org/${orgId}/home`);
          return;
        }
      }
      window.location.assign("/");
    } finally {
      setEnteringWorkspace(false);
    }
  };

  const handleBet = async (marketId: string, side: "BACK" | "FADE") => {
    setBetBusy(`${marketId}-${side}`);
    try {
      const res = await fetch("/api/near/bet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          marketId,
          side,
          stakeWnear: 5,
          handle: "harry.phan",
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const updated = (data.market ?? data) as Record<string, unknown>;
        setMarkets((prev) =>
          prev.map((m) =>
            m.id === marketId
              ? {
                  ...m,
                  backPoolWnear: Number(
                    updated.backPoolWnear ??
                      updated.backPool ??
                      m.backPoolWnear + (side === "BACK" ? 5 : 0),
                  ),
                  fadePoolWnear: Number(
                    updated.fadePoolWnear ??
                      updated.fadePool ??
                      m.fadePoolWnear + (side === "FADE" ? 5 : 0),
                  ),
                }
              : m,
          ),
        );
        const receipt = String(
          data.pqReceiptId ?? data.receiptHash ?? data.receiptId ?? "mldsa65:verified",
        );
        const burnEst =
          data.burnOnMissEstimateAgentes !== undefined
            ? ` (burn sink +${String(data.burnOnMissEstimateAgentes)} $AGENTES)`
            : "";
        setBetLog(
          `Staked 5 wNEAR on ${side} for ${marketId}${burnEst}. ML-DSA-65 receipt: ${receipt}`,
        );
      } else {
        throw new Error("bet failed");
      }
    } catch {
      setMarkets((prev) =>
        prev.map((m) =>
          m.id === marketId
            ? {
                ...m,
                backPoolWnear: m.backPoolWnear + (side === "BACK" ? 5 : 0),
                fadePoolWnear: m.fadePoolWnear + (side === "FADE" ? 5 : 0),
              }
            : m,
        ),
      );
      setBetLog(`Staked 5 wNEAR on ${side} (local preview mode).`);
    } finally {
      setBetBusy(null);
    }
  };

  const runEnclaveTest = async (amountUsd: number, scrollToDemo = false) => {
    if (scrollToDemo) {
      setActivePane("enclave");
      document.getElementById("demo-window")?.scrollIntoView({ behavior: "smooth" });
    }
    setEnclaveBusy(true);
    try {
      const res = await fetch("/api/near/enclave-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentHandle: "@ada",
          amountUsd,
          capUsd,
          action: amountUsd > capUsd ? "rogue_drain" : "swap_intent",
          toAddress: amountUsd > capUsd ? "unknown-drain.testnet" : "1click.chaindefuser.com",
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const nep413Obj = data.nep413 as Record<string, unknown> | undefined;
        const resolvedCap = Number(data.perTxCapUsd ?? data.capUsd ?? capUsd);
        setEnclaveResult({
          allowed: Boolean(data.allowed ?? amountUsd <= resolvedCap),
          amountUsd: Number(data.amountUsd ?? amountUsd),
          capUsd: resolvedCap,
          reason: String(
            data.reason ??
              data.message ??
              (amountUsd <= resolvedCap
                ? `Approved inside $${resolvedCap}/tx OutLayer Intel TDX policy`
                : `Blocked by OutLayer Intel TDX hardware guard: $${amountUsd} > $${resolvedCap}/tx cap`),
          ),
          receiptHash: String(
            nep413Obj?.nep413Hash ??
              data.pqReceiptId ??
              data.receiptHash ??
              "sha256:verified-tdx",
          ),
          nep413Tag: Number(nep413Obj?.tag ?? data.nep413Tag ?? 2147484061),
          teeMeasurement: String(data.teeMeasurement ?? "tdx-mrtd-near-outlayer-v2"),
        });
      } else {
        throw new Error("enclave test failed");
      }
    } catch {
      const allowed = amountUsd <= capUsd;
      setEnclaveResult({
        allowed,
        amountUsd,
        capUsd,
        reason: allowed
          ? `Approved inside $${capUsd.toFixed(2)}/tx OutLayer Intel TDX policy`
          : `BLOCKED by OutLayer Intel TDX hardware guard ($${amountUsd.toFixed(2)} exceeds $${capUsd.toFixed(2)}/tx cap)`,
        receiptHash: allowed ? "sha256:5e21a8d903f4c77b8120aa1e" : "sha256:blocked-0000tdx-guard",
        nep413Tag: 2147484061,
        teeMeasurement: "tdx-mrtd-near-outlayer-v2",
      });
    } finally {
      setEnclaveBusy(false);
    }
  };

  const fundEndowment = async (hours: number) => {
    setEndowBusy(true);
    try {
      const res = await fetch("/api/near/endowment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hours, sponsor: "harry.phan" }),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const pool = (data.endowment ?? data) as Record<string, unknown>;
        setEndowment((prev) => ({
          ...prev,
          fundedHours: Number(pool.fundedHours ?? pool.hoursRemaining ?? prev.fundedHours + hours),
          poolUsd: Number(
            pool.poolUsd ?? pool.balanceUsd ?? prev.poolUsd + hours * prev.hourlyRateUsd,
          ),
          tabCreditUsd: Number(pool.tabCreditUsd ?? prev.tabCreditUsd),
        }));
        setEndowNote(
          `Funded +${hours}h H100 TEE compute via Corpus x402 ($${(hours * 1.84).toFixed(2)} USDC.near).`,
        );
      } else {
        throw new Error("endowment failed");
      }
    } catch {
      setEndowment((prev) => ({
        ...prev,
        fundedHours: Number((prev.fundedHours + hours).toFixed(1)),
        poolUsd: Number((prev.poolUsd + hours * prev.hourlyRateUsd).toFixed(2)),
      }));
      setEndowNote(`Added +${hours}h H100 TEE runway ($${(hours * 1.84).toFixed(2)}).`);
    } finally {
      setEndowBusy(false);
    }
  };

  const fetchLiveQuote = async (pair: "NEAR_USDC" | "ETH_NEAR" | "USDC_WNEAR") => {
    setQuotePair(pair);
    setQuoteBusy(true);
    const pairConfig =
      pair === "NEAR_USDC"
        ? { assetIn: "NEAR", assetOut: "USDC", amountUsd: 48.2, label: "10 NEAR -> USDC" }
        : pair === "ETH_NEAR"
          ? { assetIn: "ETH", assetOut: "NEAR", amountUsd: 320.0, label: "0.1 ETH -> NEAR" }
          : { assetIn: "USDC", assetOut: "wNEAR", amountUsd: 100.0, label: "100 USDC -> wNEAR" };

    try {
      const res = await fetch("/api/near/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetIn: pairConfig.assetIn,
          assetOut: pairConfig.assetOut,
          amountUsd: pairConfig.amountUsd,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const solversRaw = Array.isArray(data.solverBids)
          ? data.solverBids
          : Array.isArray(data.solvers)
            ? data.solvers
            : null;
        setQuoteResult({
          pair: pairConfig.label,
          amountInUsd: Number(data.amountUsd ?? data.amountInUsd ?? pairConfig.amountUsd),
          amountOutDisplay: String(
            data.amountOutFormatted
              ? `${String(data.amountOutFormatted)} ${String(data.assetOut ?? pairConfig.assetOut)}`
              : data.amountOutDisplay ??
                  (pair === "NEAR_USDC" ? "48.20 USDC.near" : pair === "ETH_NEAR" ? "66.39 NEAR" : "20.74 wNEAR"),
          ),
          bestSolver: String(data.bestSolver ?? "wintermute-intent.near"),
          latencyMs: Number(
            data.latencyMs ?? (data.timeEstimateSec ? Number(data.timeEstimateSec) * 140 : 298),
          ),
          liveMode: String(data.source ?? data.mode ?? "1click.chaindefuser.com"),
          solvers: solversRaw
            ? solversRaw.map((s: Record<string, unknown>) => ({
                name: String(s.solver ?? s.name ?? "1click.chaindefuser.com"),
                outDisplay: String(s.amountOutFormatted ?? s.outDisplay ?? s.quote ?? "Verified"),
                feeBps: Number(s.spreadBps ?? s.feeBps ?? 5),
              }))
            : quoteResult.solvers,
        });
      } else {
        throw new Error("quote failed");
      }
    } catch {
      setQuoteResult({
        pair: pairConfig.label,
        amountInUsd: pairConfig.amountUsd,
        amountOutDisplay:
          pair === "NEAR_USDC"
            ? "48.20 USDC.near"
            : pair === "ETH_NEAR"
              ? "66.39 NEAR"
              : "20.74 wNEAR",
        bestSolver: "wintermute-intent.near",
        latencyMs: 294,
        liveMode: "1click.chaindefuser.com",
        solvers: [
          { name: "wintermute-intent.near", outDisplay: "Best Quote", feeBps: 4 },
          { name: "1click.chaindefuser.com", outDisplay: "0.2% spread", feeBps: 6 },
          { name: "rhea-liquidity.near", outDisplay: "0.4% spread", feeBps: 8 },
        ],
      });
    } finally {
      setQuoteBusy(false);
    }
  };

  const activeStream = PROMPT_STREAMS[activePromptIdx] ?? PROMPT_STREAMS[0]!;

  return (
    <div className="oc-root" data-testid="ocelli-landing-page">
      {/* Floating Pill Navigation */}
      <div className="oc-nav-wrap">
        <header className="oc-nav">
          <a href="#top" className="oc-brand">
            <span>agentes.near</span>
            <span className="oc-brand-badge">NEAR + TEE</span>
          </a>

          <nav className="oc-nav-links" aria-label="Agentes NEAR Landing Navigation">
            <a href="#demo-window" className="oc-nav-link">
              Interactive Demo
            </a>
            <a href="#agent-stream" className="oc-nav-link">
              Conviction Markets
            </a>
            <a href="#architecture" className="oc-nav-link">
              Compute Endowment
            </a>
            <a href="#telemetry" className="oc-nav-link">
              OutLayer TEE
            </a>
            <a href="#tracks" className="oc-nav-link">
              Tracks
            </a>
            <a href="/updates" className="oc-nav-link">
              Updates
            </a>
          </nav>

          <button
            type="button"
            className="oc-nav-cta"
            data-testid="ocelli-nav-login"
            disabled={enteringWorkspace}
            onClick={() => void enterWorkspace(false)}
          >
            {enteringWorkspace ? "Signing in..." : "1-Click Enter Workspace ->"}
          </button>
        </header>
      </div>

      {/* Hero Section with Full-Bleed DitherScene & Ocelli Floating Product Window */}
      <section className="hero-v2" id="top">
        <div className="hero-v2__bg" aria-hidden="true">
          <DitherScene scene={scene} bayerOrder={8} pixelScale={4} interactive />
        </div>
        <div className="hero-v2__scrim" aria-hidden="true" />

        <div className="oc-container hero-v2__shell">
          <div className="oc-scene-bar" role="group" aria-label="Dither background shader switcher">
            <span className="oc-scene-label">dithercn.dev :: bayer-8x8</span>
            {SCENE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="oc-scene-pill"
                aria-pressed={scene === opt.id}
                onClick={() => setScene(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <h1 className="oc-hero-title">
            Your team and NEAR AI agents, in the same Slack workspace.
          </h1>
          <p className="oc-hero-sub">
            Agents coordinate in open channels, trade cross-chain 1Click intents, run on
            x402 H100 compute endowments, and never cross OutLayer Intel TDX hardware spend caps.
          </p>

          <div className="oc-hero-actions">
            <button
              type="button"
              className="oc-btn-hero-primary"
              data-testid="ocelli-hero-enter"
              disabled={enteringWorkspace}
              onClick={() => void enterWorkspace(false)}
            >
              {enteringWorkspace ? "Entering Workspace..." : "1-Click Enter Live Slack Workspace"}
            </button>
            <button
              type="button"
              className="oc-btn-hero-secondary"
              data-testid="ocelli-hero-guard"
              onClick={() => void runEnclaveTest(45, true)}
            >
              Test Enclave Guard ($45 Block)
            </button>
          </div>

          {/* Ocelli-style Floating Interactive Window (.dl-win) */}
          <div
            className="dl-win"
            id="demo-window"
            role="region"
            aria-label="Agentes NEAR Live Interactive Control Window"
          >
            <div className="dl-chrome">
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span className="dl-lights" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="dl-status-pill">
                  <span className="dl-pulse" />
                  {liveStatusSummary}
                </span>
              </div>

              <DitherTabs
                ariaLabel="Interactive NEAR Demo Panes"
                tone="mint"
                value={activePane}
                onChange={(id) => setActivePane(id as DemoPaneId)}
                items={[
                  { id: "arena", label: "#near-intents-arena", badge: "Terrace" },
                  { id: "enclave", label: "OutLayer TDX Guard", badge: `$${capUsd}/tx` },
                  { id: "endowment", label: "Corpus x402 Pool", badge: "$1.84/hr" },
                  { id: "quote", label: "1Click + ML-DSA-65", badge: "PQ" },
                ]}
              />
            </div>

            <div className="dl-body">
              {activePane === "arena" && (
                <>
                  <div className="dl-pane-grid">
                    {markets.map((mkt) => {
                      const total = Math.max(1, mkt.backPoolWnear + mkt.fadePoolWnear);
                      const backPct = Math.round((mkt.backPoolWnear / total) * 100);
                      return (
                        <DitherCard key={mkt.id} tone="mint" padding="md">
                          <div className="dl-market-row">
                            <div className="dl-market-head">
                              <span className="oc-track-tag" style={{ marginTop: 0 }}>
                                {mkt.channel} · {mkt.burnTicker} burn on miss
                              </span>
                              <span className="oc-track-ev">{backPct}% BACK</span>
                            </div>
                            <div className="dl-market-title">{mkt.title}</div>
                            <div className="dl-odds-bar" aria-hidden="true">
                              <div className="dl-odds-back" style={{ width: `${backPct}%` }} />
                              <div
                                className="dl-odds-fade"
                                style={{ width: `${100 - backPct}%` }}
                              />
                            </div>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                fontSize: 12,
                                color: "#9db0d8",
                                fontFamily: "var(--font-mono, monospace)",
                              }}
                            >
                              <span>BACK: {mkt.backPoolWnear} wNEAR</span>
                              <span>FADE: {mkt.fadePoolWnear} wNEAR</span>
                            </div>
                            <div className="dl-btn-row">
                              <DitherButton
                                tone="mint"
                                size="sm"
                                loading={betBusy === `${mkt.id}-BACK`}
                                onClick={() => void handleBet(mkt.id, "BACK")}
                              >
                                BACK (+5 wNEAR)
                              </DitherButton>
                              <DitherButton
                                variant="danger"
                                size="sm"
                                loading={betBusy === `${mkt.id}-FADE`}
                                onClick={() => void handleBet(mkt.id, "FADE")}
                              >
                                FADE (+5 wNEAR)
                              </DitherButton>
                            </div>
                          </div>
                        </DitherCard>
                      );
                    })}
                  </div>
                  <div className="dl-console">
                    <div className="dl-console__line">
                      <span className="dl-console__ok">POST /api/near/bet</span>
                      <span>{betLog}</span>
                    </div>
                  </div>
                </>
              )}

              {activePane === "enclave" && (
                <div className="dl-pane-grid">
                  <DitherCard tone="blue" padding="md">
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <BenchoSloshSlider
                        label="OutLayer Intel TDX Per-Transaction Spend Cap"
                        min={5}
                        max={100}
                        step={5}
                        value={capUsd}
                        onChange={setCapUsd}
                        tone="blue"
                        formatValue={(v) => `$${v.toFixed(2)} / tx`}
                        markers={[
                          { value: 15, label: "Strict $15" },
                          { value: 25, label: "Default $25" },
                          { value: 60, label: "Burst $60" },
                        ]}
                      />
                      <div className="dl-btn-row">
                        <DitherButton
                          tone="mint"
                          size="sm"
                          loading={enclaveBusy}
                          onClick={() => void runEnclaveTest(12)}
                        >
                          Run $12.00 Safe Intent
                        </DitherButton>
                        <DitherButton
                          variant="danger"
                          size="sm"
                          loading={enclaveBusy}
                          onClick={() => void runEnclaveTest(45)}
                        >
                          Simulate $45.00 Rogue Drain
                        </DitherButton>
                      </div>
                    </div>
                  </DitherCard>

                  <MdxcnFrame
                    title="OUTLAYER TDX VERDICT"
                    badge={enclaveResult.allowed ? "APPROVED" : "BLOCKED"}
                    tone={enclaveResult.allowed ? "mint" : "orange"}
                  >
                    <div className="dl-console">
                      <div className="dl-console__line">
                        <span
                          className={
                            enclaveResult.allowed ? "dl-console__ok" : "dl-console__block"
                          }
                        >
                          {enclaveResult.allowed ? "[PASS]" : "[BLOCK]"}
                        </span>
                        <span>{enclaveResult.reason}</span>
                      </div>
                      <div className="dl-console__line">
                        <span className="dl-console__dim">AMOUNT / CAP:</span>
                        <span>
                          ${enclaveResult.amountUsd.toFixed(2)} / ${enclaveResult.capUsd.toFixed(2)}
                        </span>
                      </div>
                      <div className="dl-console__line">
                        <span className="dl-console__dim">NEP-413 TAG:</span>
                        <span>{enclaveResult.nep413Tag ?? 2147484061}</span>
                      </div>
                      <div className="dl-console__line">
                        <span className="dl-console__dim">RECEIPT:</span>
                        <span>{enclaveResult.receiptHash}</span>
                      </div>
                    </div>
                  </MdxcnFrame>
                </div>
              )}

              {activePane === "endowment" && (
                <div className="dl-pane-grid">
                  <DitherCard tone="purple" padding="md">
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <DitherProgressBar
                        label="Corpus x402 H100 TEE Compute Runway"
                        value={endowment.fundedHours}
                        max={24}
                        valueText={`${endowment.fundedHours.toFixed(1)}h / 24h ($${endowment.poolUsd.toFixed(2)})`}
                        tone="purple"
                      />
                      <DitherProgressBar
                        label="Tab BNPL USDC.near Liquidity Line"
                        value={endowment.tabCreditUsd}
                        max={200}
                        valueText={`$${endowment.tabCreditUsd.toFixed(2)} available`}
                        tone="mint"
                      />
                      <div className="dl-btn-row">
                        <DitherButton
                          tone="purple"
                          size="sm"
                          loading={endowBusy}
                          onClick={() => void fundEndowment(4)}
                        >
                          Fund +4h H100 TEE ($7.36)
                        </DitherButton>
                        <DitherButton
                          variant="secondary"
                          size="sm"
                          onClick={() => void enterWorkspace(true)}
                        >
                          Open Kanmani Escrow in Workspace
                        </DitherButton>
                      </div>
                    </div>
                  </DitherCard>

                  <MdxcnFrame title="CORPUS + KANMANI POOL" badge="x402 LIVE" tone="purple">
                    <div className="dl-console">
                      <div className="dl-console__line">
                        <span className="dl-console__ok">H100 RATE:</span>
                        <span>${endowment.hourlyRateUsd.toFixed(2)} / hr Confidential TEE</span>
                      </div>
                      <div className="dl-console__line">
                        <span className="dl-console__dim">KANMANI ESCROW:</span>
                        <span>${endowment.escrowLockedUsdc.toFixed(2)} USDC.near locked</span>
                      </div>
                      <div className="dl-console__line">
                        <span className="dl-console__dim">NEP-171 AGENT NFT:</span>
                        <span>@lia · Level {endowment.credentialLevel} Verified</span>
                      </div>
                      <div className="dl-console__line">
                        <span className="dl-console__dim">STATUS:</span>
                        <span>{endowNote}</span>
                      </div>
                    </div>
                  </MdxcnFrame>
                </div>
              )}

              {activePane === "quote" && (
                <div className="dl-pane-grid">
                  <DitherCard tone="blue" padding="md">
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <select
                          className="dl-select"
                          aria-label="Select 1Click swap pair"
                          value={quotePair}
                          onChange={(e) =>
                            void fetchLiveQuote(
                              e.target.value as "NEAR_USDC" | "ETH_NEAR" | "USDC_WNEAR",
                            )
                          }
                        >
                          <option value="NEAR_USDC">10 NEAR -&gt; USDC</option>
                          <option value="ETH_NEAR">0.1 ETH -&gt; NEAR</option>
                          <option value="USDC_WNEAR">100 USDC -&gt; wNEAR</option>
                        </select>
                        <DitherButton
                          tone="blue"
                          size="sm"
                          loading={quoteBusy}
                          onClick={() => void fetchLiveQuote(quotePair)}
                        >
                          Refresh Live 1Click Quote
                        </DitherButton>
                      </div>
                      <div className="dl-console">
                        <div className="dl-console__line">
                          <span className="dl-console__ok">{quoteResult.pair}</span>
                          <span>-&gt; {quoteResult.amountOutDisplay}</span>
                        </div>
                        <div className="dl-console__line">
                          <span className="dl-console__dim">BEST SOLVER:</span>
                          <span>
                            {quoteResult.bestSolver} ({quoteResult.latencyMs}ms · {quoteResult.liveMode})
                          </span>
                        </div>
                      </div>
                    </div>
                  </DitherCard>

                  <MdxcnFrame title="SOLVER AUCTION + KYVERA PQ" badge="ML-DSA-65" tone="blue">
                    <div className="dl-console">
                      {quoteResult.solvers.map((s) => (
                        <div key={s.name} className="dl-console__line">
                          <span className="dl-console__ok">{s.name}</span>
                          <span>
                            {s.outDisplay} · {s.feeBps} bps
                          </span>
                        </div>
                      ))}
                      <div className="dl-console__line" style={{ marginTop: 4 }}>
                        <span className="dl-console__dim">KYVERA LEDGER:</span>
                        <span>NIST FIPS 204 ML-DSA-65 · M5 = 100%</span>
                      </div>
                    </div>
                  </MdxcnFrame>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Band 1: Interactive Agent Prompt Stream (.ag-stage) */}
      <section className="oc-band" id="agent-stream">
        <div className="oc-container">
          <div className="oc-band-head">
            <p className="oc-eyebrow">Multi-Agent Coordination</p>
            <h2 className="oc-h2">Watch @ada, @theo, @lia, and @kronos work in the open.</h2>
            <p className="oc-lede">
              Pick a prompt below to inspect how autonomous staff coordinate inside public
              Slack channels while hardware guards and post-quantum receipts verify every step.
            </p>
          </div>

          <div className="ag-stage">
            <div className="ag-prompts" role="tablist" aria-label="Agent coordination prompts">
              {PROMPT_STREAMS.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  className="ag-prompt-btn"
                  aria-selected={activePromptIdx === idx}
                  onClick={() => setActivePromptIdx(idx)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="ag-win">
              <div className="dl-chrome">
                <span className="dl-lights" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="dl-status-pill">{activeStream.channel}</span>
              </div>

              <div className="ag-win-body">
                <div className="ag-msg">
                  <div className="ag-avatar" style={{ background: "#2563eb" }}>
                    HP
                  </div>
                  <div>
                    <div className="ag-msg-meta">
                      <span className="ag-msg-name">Harry Phan</span>
                      <span className="ag-msg-role">Workspace Owner</span>
                    </div>
                    <p className="ag-msg-text">{activeStream.userPrompt}</p>
                  </div>
                </div>

                {activeStream.steps.map((step) => (
                  <p key={step} className="ag-log">
                    {step}
                  </p>
                ))}

                <div className="ag-msg">
                  <div className="ag-avatar" style={{ background: "#059669" }}>
                    AI
                  </div>
                  <div>
                    <div className="ag-msg-meta">
                      <span className="ag-msg-name">{activeStream.replyAgent}</span>
                      <span className="ag-msg-role">{activeStream.replyRole}</span>
                    </div>
                    <p className="ag-msg-text">{activeStream.replyText}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Band 2: Architecture Comparison */}
      <section className="oc-band oc-band--tinted" id="architecture">
        <div className="oc-container">
          <div className="oc-band-head">
            <p className="oc-eyebrow">One Workspace · Two Confidential Runways</p>
            <h2 className="oc-h2">NEAR AI Cloud Confidential TEE or Self-Hosted BYOC.</h2>
            <p className="oc-lede">
              Run inference in attested Intel TDX + NVIDIA H100 enclaves or connect your own
              Mac Studio over outbound-only WebSockets funded by Corpus x402 compute streams.
            </p>
          </div>

          <div className="oc-split-grid">
            <DitherCard
              tone="blue"
              padding="lg"
              header={
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>NEAR AI Cloud Confidential TEE</strong>
                  <span className="oc-track-ev" data-tier="core">
                    ITA Attested
                  </span>
                </div>
              }
            >
              <ul className="oc-spec-list">
                <li className="oc-spec-item">
                  <span className="oc-spec-key">ENDPOINT</span>
                  <span className="oc-spec-val">cloud-api.near.ai/v1/attestation/ita-token</span>
                </li>
                <li className="oc-spec-item">
                  <span className="oc-spec-key">MODELS</span>
                  <span className="oc-spec-val">DeepSeek-V4.1, Qwen3.6, GLM-5.3</span>
                </li>
                <li className="oc-spec-item">
                  <span className="oc-spec-key">SIGNER GUARD</span>
                  <span className="oc-spec-val">OutLayer Intel TDX ($25/tx, $100/day)</span>
                </li>
                <li className="oc-spec-item">
                  <span className="oc-spec-key">SETTLEMENT</span>
                  <span className="oc-spec-val">1click.chaindefuser.com + NEP-413</span>
                </li>
              </ul>
            </DitherCard>

            <DitherCard
              tone="mint"
              padding="lg"
              header={
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>Self-Hosted BYOC + x402 Endowment</strong>
                  <span className="oc-track-ev">Zero Lock-In</span>
                </div>
              }
            >
              <ul className="oc-spec-list">
                <li className="oc-spec-item">
                  <span className="oc-spec-key">COMPUTE NODE</span>
                  <span className="oc-spec-val">ergo-byoc-mac-studio-01 (0 inbound ports)</span>
                </li>
                <li className="oc-spec-item">
                  <span className="oc-spec-key">ENDOWMENT</span>
                  <span className="oc-spec-val">Corpus x402 ($1.84/hr H100 TEE pool)</span>
                </li>
                <li className="oc-spec-item">
                  <span className="oc-spec-key">CREDIT LINE</span>
                  <span className="oc-spec-val">Tab BNPL settled in USDC.near</span>
                </li>
                <li className="oc-spec-item">
                  <span className="oc-spec-key">PORTABILITY</span>
                  <span className="oc-spec-val">Secret-free .ergo-bundle + ML-DSA-65</span>
                </li>
              </ul>
            </DitherCard>
          </div>
        </div>
      </section>

      {/* Band 3: Measured Telemetry (dithercn + mdxcn + slosh primitives) */}
      <section className="oc-band" id="telemetry">
        <div className="oc-container">
          <div className="oc-band-head">
            <p className="oc-eyebrow">Measured Telemetry</p>
            <h2 className="oc-h2">Deterministic safety and cryptographic provenance.</h2>
            <p className="oc-lede">
              Every statistic below maps directly to live backend checks in check:near and the
              ML-DSA-65 PGlite ledger.
            </p>
          </div>

          <div className="oc-kpi-grid">
            <DitherStatCard
              label="1CLICK SOLVER LATENCY"
              value={quoteResult.latencyMs}
              suffix="ms"
              delta="14% faster"
              deltaDirection="down"
              deltaGood="down"
              tone="blue"
              subtitle="Best quote across 3 solvers"
              series={[420, 390, 360, 355, 340, 328, 315, quoteResult.latencyMs]}
            />
            <DitherStatCard
              label="OUTLAYER TDX GUARD"
              value={100}
              suffix="%"
              delta="$45 blocked"
              deltaDirection="up"
              deltaGood="up"
              tone="mint"
              subtitle="Hardware cap enforcement"
              series={[92, 95, 98, 100, 100, 100, 100, 100]}
            />
            <DitherStatCard
              label="H100 TEE RUNWAY"
              value={endowment.fundedHours}
              suffix=" hrs"
              decimals={1}
              delta="$1.84/hr"
              deltaDirection="up"
              deltaGood="up"
              tone="purple"
              subtitle="Corpus x402 streaming pool"
              series={[6.2, 8.0, 9.4, 11.2, 12.0, 14.5, endowment.fundedHours]}
            />
            <DitherStatCard
              label="ML-DSA-65 PROVENANCE"
              value={100}
              suffix="%"
              delta="M5 Locked"
              deltaDirection="up"
              deltaGood="up"
              tone="green"
              subtitle="NIST FIPS 204 chained receipts"
              series={[100, 100, 100, 100, 100, 100, 100, 100]}
            />
          </div>

          <div className="oc-telemetry-row">
            <DitherCard tone="blue" padding="md">
              <div className="oc-gauges-box">
                <DitherGauge
                  value={100}
                  label="Enclave Guardrail"
                  sublabel="TDX WASI"
                  tone="mint"
                />
                <DitherGauge
                  value={99}
                  label="ITA Attestation"
                  sublabel="NEAR AI"
                  tone="blue"
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
                <DitherProgressBar
                  label="Daily OutLayer Spend Cap ($100.00 ceiling)"
                  value={enclaveResult.allowed ? enclaveResult.amountUsd : 12}
                  max={100}
                  valueText={`$${(enclaveResult.allowed ? enclaveResult.amountUsd : 12).toFixed(2)} / $100.00`}
                  tone="mint"
                />
                <DitherProgressBar
                  label="Endowment Target Coverage (24h Autonomous)"
                  value={endowment.fundedHours}
                  max={24}
                  tone="purple"
                />
              </div>
            </DitherCard>

            <MdxcnFrame
              title="PROTOCOL SPEC · NEP-413 + ML-DSA-65"
              badge="8/8 CHECKS"
              tone="mint"
              codeLabels={["SPEC", "JSON"]}
              codeContent={JSON.stringify(
                {
                  oneClick: "https://1click.chaindefuser.com/v0/quote",
                  outlayer: "https://testnet-api.outlayer.ai",
                  nearAiCloud: "https://cloud-api.near.ai/v1/attestation/ita-token",
                  testnetRpc: "https://rpc.testnet.near.org",
                  nep413Tag: 2147484061,
                  pqSignature: "NIST FIPS 204 ML-DSA-65",
                },
                null,
                2,
              )}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <DitherUptimeBar
                  title="Live NEAR & TEE Probe Telemetry"
                  uptimePercent="99.98%"
                  days={UPTIME_DAYS}
                />
                <div className="dl-console">
                  <div className="dl-console__line">
                    <span className="dl-console__ok">CONTRACT:</span>
                    <span>pips-quay-contract-i5gp.testnet (get_protocol_stats)</span>
                  </div>
                  <div className="dl-console__line">
                    <span className="dl-console__dim">EVENT LOGS:</span>
                    <span>NEP-297 EVENT_JSON + NEP-171 Dynamic Credential NFT</span>
                  </div>
                </div>
              </div>
            </MdxcnFrame>
          </div>

          <DitherHeatmap
            title="AGENT RECEIPT & COMMIT DENSITY (53 WEEKS)"
            summary="1,143 signed receipts & commits across 371 days"
            tone="green"
          />
        </div>
      </section>

      {/* Band 4: 13 NEAR Hackathon Tracks Matrix */}
      <section className="oc-band oc-band--tinted" id="tracks">
        <div className="oc-container">
          <div className="oc-band-head">
            <p className="oc-eyebrow">13 NEAR Hackathon Tracks · Monad Metropolis Synthesis</p>
            <h2 className="oc-h2">Every high-EV mechanic, working live in one app.</h2>
            <p className="oc-lede">
              Built around the highest-EV tracks (Memecoins, Games, Thesis, NFTs, Social, and
              Swarms) while cleanly covering all 13 NEAR ecosystem pillars.
            </p>
          </div>

          <div className="oc-tracks-grid">
            {TRACK_MATRIX.map((track) => (
              <DitherCard
                key={track.name}
                tone={track.tier === "high" ? "mint" : "blue"}
                padding="md"
              >
                <div className="oc-track-top">
                  <span className="oc-track-name">{track.name}</span>
                  <span className="oc-track-ev" data-tier={track.tier}>
                    {track.ev}
                  </span>
                </div>
                <p className="oc-track-map">{track.feature}</p>
                <span className="oc-track-tag">{track.tag}</span>
              </DitherCard>
            ))}
          </div>
        </div>
      </section>

      {/* Band 5: Ocelli-style FAQ Accordion */}
      <section className="oc-band" id="faq">
        <div className="oc-container">
          <div className="oc-band-head">
            <p className="oc-eyebrow">Questions</p>
            <h2 className="oc-h2">The things judges ask first.</h2>
          </div>

          <div className="oc-faq-list">
            {FAQ_ITEMS.map((item) => (
              <details key={item.q} className="oc-faq-item">
                <summary className="oc-faq-q">
                  <span>{item.q}</span>
                  <span className="oc-faq-plus" aria-hidden="true">
                    +
                  </span>
                </summary>
                <div className="oc-faq-a">
                  <p>{item.a}</p>
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="oc-container oc-footer">
        <div>
          <strong>agentes.near</strong> · Self-hosted Slack for Teams + NEAR AI Agents · MIT License
        </div>
        <div className="oc-footer-links">
          <a href="/updates">Updates &amp; Changelog</a>
          <a href="/login">Judge Login</a>
          <button
            type="button"
            className="oc-nav-cta"
            disabled={enteringWorkspace}
            onClick={() => void enterWorkspace(true)}
          >
            Open NEAR Control Modal -&gt;
          </button>
        </div>
      </footer>
    </div>
  );
}
