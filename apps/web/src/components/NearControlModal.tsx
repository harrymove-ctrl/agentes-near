import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  Icon,
  Input,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  BenchoSloshSlider,
  DitherGauge,
  DitherProgressBar,
  DitherStatCard,
  MdxcnFrame,
} from "@/components/dithercn";
import "./near-modal.css";

export type NearTab = "enclave" | "markets" | "endowment" | "film";

interface SolverBid {
  solver: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  spreadBps: number;
  estimatedSeconds: number;
  winner: boolean;
  source: "live" | "fallback";
}

interface OneClickQuoteResult {
  ok: boolean;
  source: "live" | "fallback";
  live: boolean;
  dry: true;
  assetIn: string;
  assetOut: string;
  amountUsd: number;
  amountInFormatted: string;
  amountOutFormatted: string;
  amountInUsd: string;
  amountOutUsd: string;
  timeEstimateSec: number;
  correlationId: string;
  signature: string;
  bestSolver: string;
  solverBids: SolverBid[];
  timestamp: string;
}

interface OutLayerAgentWallet {
  agentHandle: "ada" | "theo" | "lia" | "kronos";
  displayName: string;
  accountId: string;
  teeVendor: string;
  wasiTarget: string;
  perTxLimitUsd: number;
  dailyLimitUsd: number;
  spentTodayUsd: number;
  enclaveMeasurement: string;
  keyPolicy: string;
  lastActionAt: string;
}

interface EnclaveTestResult {
  ok: boolean;
  allowed: boolean;
  decision: "APPROVED" | "BLOCKED_PER_TX_CAP" | "BLOCKED_DAILY_CAP";
  reason: string;
  agentHandle: string;
  walletAccountId: string;
  action: string;
  toAddress: string;
  amountUsd: number;
  perTxCapUsd: number;
  dailyLimitUsd: number;
  spentTodayBeforeUsd: number;
  spentTodayAfterUsd: number;
  dailyRemainingUsd: number;
  outlayerProbe: {
    endpoint: string;
    source: "live" | "fallback";
    status: string;
    version: string;
    gitSha: string;
  };
  wasiTelemetry: {
    target: string;
    moduleSha256: string;
    abi: string[];
    fuelConsumed: number;
    execLatencyMs: number;
  };
  nep413: {
    tag: number;
    tagHex: string;
    payloadSha256: string;
    nep413Hash: string;
    nonceHex: string;
    recipient: string;
    borshByteLength: number;
  };
  nep297Event: string;
  pqReceiptId: string | null;
  timestamp: string;
}

interface ConvictionMarket {
  marketId: string;
  channel: string;
  title: string;
  mechanic: string;
  stakeAsset: "wNEAR" | "$AGENTES";
  backPoolWnear: number;
  fadePoolWnear: number;
  backOdds: number;
  fadeOdds: number;
  backProbabilityPct: number;
  burnOnMissRatePct: number;
  totalBurnedAgentes: number;
  participantsCount: number;
  status: "open" | "settled";
  lastBet?: {
    handle: string;
    side: "BACK" | "FADE";
    stakeWnear: number;
    potentialBurnAgentes: number;
    at: string;
  };
}

interface ComputeEndowmentState {
  mechanic: string;
  gpuNode: string;
  hourlyRateUsd: number;
  fundedHours: number;
  balanceUsd: number;
  runwayHours: number;
  x402Endpoint: string;
  lastX402Header: string;
  tabCreditLimitUsd: number;
  tabUsedUsd: number;
  tabAvailableUsd: number;
  tabSettlementAsset: string;
  contributorsCount: number;
  lastSponsor: string;
  updatedAt: string;
}

interface DynamicAgentCredentialNft {
  tokenId: string;
  standard: string;
  agentHandle: string;
  title: string;
  tier: "Bronze" | "Silver" | "Gold" | "Apex";
  level: number;
  xp: number;
  verifiedTasks: number;
  slashedCount: number;
  stakeUsdc: number;
  metadataHash: string;
}

interface AgentEscrowRecord {
  escrowId: string;
  agentHandle: string;
  taskTitle: string;
  amountUsdc: number;
  slashStakeUsdc: number;
  status: "locked" | "released" | "slashed";
  pqReceiptId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface NearAiModelAttestation {
  model: string;
  modelId: string;
  teeProvider: string;
  attested: boolean;
  source: "live" | "fallback";
  tokenSigningAlg: string;
}

interface NearStatusResponse {
  ok: boolean;
  orgId: string;
  network: string;
  oneClickQuote: OneClickQuoteResult;
  outlayerHealth: {
    source: "live" | "fallback";
    status: string;
    version: string;
    gitSha: string;
  };
  nearAiAttestation: {
    source: "live" | "fallback";
    nonce: string;
    tokenSigningAlg: string;
    models: NearAiModelAttestation[];
  };
  testnetRpc: {
    source: "live" | "fallback";
    contractId: string;
    blockHeight: number;
    outlayerConfidentialEnabled: boolean;
    activeSessionKeys: number;
  };
  wallets: OutLayerAgentWallet[];
  markets: ConvictionMarket[];
  endowment: ComputeEndowmentState;
  credentials: DynamicAgentCredentialNft[];
  escrows: AgentEscrowRecord[];
  nep297Logs: string[];
  zenLedger: {
    ok: boolean;
    algorithm: string;
    totalReceipts: number;
    verifiedReceipts: number;
    m5ProvenanceRate: string;
    headHash: string;
  } | null;
  timestamp: string;
}

const QUOTE_PAIRS: Array<{ label: string; assetIn: string; assetOut: string }> = [
  { label: "USDC -> wNEAR", assetIn: "USDC", assetOut: "wNEAR" },
  { label: "USDC -> ETH", assetIn: "USDC", assetOut: "ETH" },
  { label: "wNEAR -> USDC", assetIn: "wNEAR", assetOut: "USDC" },
];

export function NearControlModal({
  open,
  onOpenChange,
  orgId,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  initialTab?: NearTab;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<NearTab>(initialTab ?? "enclave");
  useEffect(() => {
    if (open && initialTab) {
      setTab(initialTab);
    }
  }, [open, initialTab]);
  const [capUsd, setCapUsd] = useState<number>(25);
  const [selectedAgent, setSelectedAgent] = useState<"ada" | "theo" | "lia" | "kronos">("ada");
  const [quotePairIdx, setQuotePairIdx] = useState(0);
  const [quoteAmountUsd, setQuoteAmountUsd] = useState(12);
  const [stakeWnear, setStakeWnear] = useState(2.5);
  const [escrowTaskTitle, setEscrowTaskTitle] = useState("Verify 1Click solver route + NEP-413 attestation");
  const [enclaveResult, setEnclaveResult] = useState<EnclaveTestResult | null>(null);
  const [quoteResult, setQuoteResult] = useState<OneClickQuoteResult | null>(null);
  const [lastBetReceipt, setLastBetReceipt] = useState<{
    marketId: string;
    side: string;
    burnOnMissEstimateAgentes: number;
    nep297Event: string;
    pqReceiptId: string | null;
  } | null>(null);
  const [lastEscrowNotice, setLastEscrowNotice] = useState<string | null>(null);

  const statusQuery = useQuery<NearStatusResponse>({
    queryKey: ["near-status", orgId],
    enabled: open,
    queryFn: async () => {
      const res = await fetch("/api/near/status", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load NEAR status (${res.status})`);
      return res.json() as Promise<NearStatusResponse>;
    },
  });

  const enclaveMutation = useMutation({
    mutationFn: async (input: { amountUsd: number; action: string; toAddress: string }) => {
      const res = await fetch("/api/near/enclave-test", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentHandle: selectedAgent,
          amountUsd: input.amountUsd,
          capUsd,
          action: input.action,
          toAddress: input.toAddress,
        }),
      });
      if (!res.ok) throw new Error(`Enclave test failed (${res.status})`);
      return res.json() as Promise<EnclaveTestResult>;
    },
    onSuccess: (data) => {
      setEnclaveResult(data);
      void qc.invalidateQueries({ queryKey: ["near-status", orgId] });
    },
  });

  const quoteMutation = useMutation({
    mutationFn: async (input: { assetIn: string; assetOut: string; amountUsd: number }) => {
      const res = await fetch("/api/near/quote", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`1Click quote failed (${res.status})`);
      return res.json() as Promise<OneClickQuoteResult>;
    },
    onSuccess: (data) => {
      setQuoteResult(data);
      void qc.invalidateQueries({ queryKey: ["near-status", orgId] });
    },
  });

  const betMutation = useMutation({
    mutationFn: async (input: { marketId: string; side: "BACK" | "FADE"; stakeWnear: number }) => {
      const res = await fetch("/api/near/bet", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, handle: "harry.near" }),
      });
      if (!res.ok) throw new Error(`Conviction bet failed (${res.status})`);
      return res.json() as Promise<{
        ok: boolean;
        market: ConvictionMarket;
        burnOnMissEstimateAgentes: number;
        nep297Event: string;
        pqReceiptId: string | null;
      }>;
    },
    onSuccess: (data) => {
      setLastBetReceipt({
        marketId: data.market.marketId,
        side: data.market.lastBet?.side ?? "BACK",
        burnOnMissEstimateAgentes: data.burnOnMissEstimateAgentes,
        nep297Event: data.nep297Event,
        pqReceiptId: data.pqReceiptId,
      });
      void qc.invalidateQueries({ queryKey: ["near-status", orgId] });
    },
  });

  const endowmentMutation = useMutation({
    mutationFn: async (input: { hours: number; useTabBnpl: boolean }) => {
      const res = await fetch("/api/near/endowment", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hours: input.hours,
          sponsor: "harry.near",
          useTabBnpl: input.useTabBnpl,
        }),
      });
      if (!res.ok) throw new Error(`Endowment funding failed (${res.status})`);
      return res.json() as Promise<{
        ok: boolean;
        addedHours: number;
        costUsd: number;
        endowment: ComputeEndowmentState;
        nep297Event: string;
        pqReceiptId: string | null;
      }>;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["near-status", orgId] });
    },
  });

  const escrowMutation = useMutation({
    mutationFn: async (input: { action: "hire" | "release" | "slash"; amountUsdc: number }) => {
      const res = await fetch("/api/near/escrow", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentHandle: selectedAgent,
          taskTitle: escrowTaskTitle,
          amountUsdc: input.amountUsdc,
          action: input.action,
        }),
      });
      if (!res.ok) throw new Error(`Escrow action failed (${res.status})`);
      return res.json() as Promise<{
        ok: boolean;
        action: string;
        escrow: AgentEscrowRecord;
        credential: DynamicAgentCredentialNft;
        nep297Event: string;
        pqReceiptId: string | null;
      }>;
    },
    onSuccess: (data) => {
      setLastEscrowNotice(
        `${data.action.toUpperCase()} @${data.credential.agentHandle} -> Level ${data.credential.level} ${data.credential.tier} (${data.credential.xp} XP) · PQ ${data.pqReceiptId ?? "logged"}`,
      );
      void qc.invalidateQueries({ queryKey: ["near-status", orgId] });
    },
  });

  const data = statusQuery.data;
  const activeQuote = quoteResult ?? data?.oneClickQuote ?? null;
  const activePair = QUOTE_PAIRS[quotePairIdx] ?? QUOTE_PAIRS[0]!;
  const wallets = data?.wallets ?? [];
  const markets = data?.markets ?? [];
  const endowment = data?.endowment;
  const credentials = data?.credentials ?? [];
  const escrows = data?.escrows ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={840}
      title="NEAR Intents & OutLayer TEE Control"
      subtitle="1Click Multi-Solver Swaps · Intel TDX Hardware Spend Guard · Terrace Markets · Corpus x402"
      closeLabel="Close"
    >
      <DialogBody>
        <div className="near-modal" data-testid="near-control-modal">
          <div className="near-modal__bar">
            <div className="near-modal__metrics">
              <span>
                OutLayer TEE:{" "}
                <strong>
                  {data ? `${data.outlayerHealth.status} (${data.outlayerHealth.source})` : "Probing..."}
                </strong>
              </span>
              <span>
                Testnet RPC:{" "}
                <strong>
                  {data ? `#${data.testnetRpc.blockHeight.toLocaleString()}` : "Loading..."}
                </strong>
              </span>
              <span>
                NEAR AI ITA:{" "}
                <strong>
                  {data
                    ? `${data.nearAiAttestation.tokenSigningAlg} (${data.nearAiAttestation.source})`
                    : "..."}
                </strong>
              </span>
              {data?.zenLedger && (
                <span>
                  ML-DSA-65:{" "}
                  <strong>
                    {data.zenLedger.m5ProvenanceRate} ({data.zenLedger.verifiedReceipts}/{data.zenLedger.totalReceipts})
                  </strong>
                </span>
              )}
            </div>
            <Link
              to="/ocelli"
              className="near-modal__ocelli-link"
              onClick={() => onOpenChange(false)}
            >
              <Icon name="globe" size={14} />
              <span>Ocelli Landing</span>
            </Link>
          </div>

          <Tabs<NearTab>
            variant="segmented"
            label="NEAR Intents and OutLayer TEE sections"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "enclave", label: "Enclave & Intents" },
              { value: "markets", label: "Terrace Markets", count: markets.length || 3 },
              {
                value: "endowment",
                label: "Corpus Endowment",
                count: endowment ? Math.round(endowment.runwayHours) : undefined,
              },
              { value: "film", label: "4:00 Narrated Master Film (240s · V-Drill)" },
            ]}
          >
            <TabPanel value="enclave">
              <div className="near-modal__panel">
                <div className="near-modal__stats">
                  <DitherStatCard
                    label="Hardware Per-Tx Cap"
                    value={capUsd}
                    prefix="$"
                    decimals={2}
                    subtitle="OutLayer Intel TDX policy"
                    tone="blue"
                  />
                  <DitherStatCard
                    label="1Click Best Quote"
                    value={activeQuote ? activeQuote.amountOutFormatted : "..."}
                    suffix={activeQuote ? ` ${activeQuote.assetOut}` : ""}
                    subtitle={activeQuote ? `Solver: ${activeQuote.bestSolver}` : "1click.chaindefuser.com"}
                    tone="mint"
                  />
                  <DitherStatCard
                    label="Testnet Block"
                    value={data?.testnetRpc.blockHeight ?? 0}
                    subtitle={data?.testnetRpc.contractId ?? "pips-quay-contract-i5gp.testnet"}
                    tone="purple"
                  />
                </div>

                <MdxcnFrame
                  title="OUTLAYER INTEL TDX HARDWARE SPEND GUARD"
                  badge="wasm32-wasip2 · NEP-413"
                  tone="blue"
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div className="near-modal__agents">
                      {wallets.map((w) => {
                        const active = selectedAgent === w.agentHandle;
                        return (
                          <button
                            key={w.agentHandle}
                            type="button"
                            className="near-agent-pill"
                            data-active={active}
                            data-testid={`near-agent-${w.agentHandle}`}
                            onClick={() => setSelectedAgent(w.agentHandle)}
                          >
                            <div className="near-agent-pill__head">
                              <span>@{w.agentHandle}</span>
                              <span>
                                ${w.spentTodayUsd.toFixed(0)}/${w.dailyLimitUsd.toFixed(0)}
                              </span>
                            </div>
                            <span className="near-agent-pill__acct">{w.accountId}</span>
                            <DitherProgressBar
                              value={w.spentTodayUsd}
                              max={w.dailyLimitUsd}
                              height={5}
                              tone={active ? "blue" : "mint"}
                            />
                          </button>
                        );
                      })}
                    </div>

                    <BenchoSloshSlider
                      value={capUsd}
                      min={5}
                      max={100}
                      step={1}
                      onChange={setCapUsd}
                      label="OutLayer Intel TDX Per-Tx Cap"
                      formatValue={(v) => `$${v.toFixed(2)} / tx`}
                      markers={[
                        { value: 12, label: "$12 Safe", tone: "mint" },
                        { value: 25, label: "$25 Guard", tone: "blue" },
                        { value: 45, label: "$45 Drain", tone: "orange" },
                      ]}
                      tone="blue"
                    />

                    <div className="near-modal__actions">
                      <Button
                        size="sm"
                        variant="primary"
                        icon="check"
                        data-testid="near-approve-safe-btn"
                        loading={
                          enclaveMutation.isPending && enclaveMutation.variables?.amountUsd === 12
                        }
                        onClick={() =>
                          enclaveMutation.mutate({
                            amountUsd: 12,
                            action: "1click_swap_intent",
                            toAddress: "intents.near",
                          })
                        }
                      >
                        Approve $12.00 Safe Intent
                      </Button>
                      <Button
                        size="sm"
                        variant="default"
                        icon="shield"
                        data-testid="near-test-rogue-btn"
                        loading={
                          enclaveMutation.isPending && enclaveMutation.variables?.amountUsd === 45
                        }
                        onClick={() =>
                          enclaveMutation.mutate({
                            amountUsd: 45,
                            action: "rogue_drain_attempt",
                            toAddress: "attacker-drain.testnet",
                          })
                        }
                      >
                        Test $45.00 Rogue Drain
                      </Button>
                    </div>

                    {enclaveResult && (
                      <div
                        className="near-result-box"
                        data-allowed={enclaveResult.allowed ? "true" : "false"}
                        data-testid="near-enclave-result"
                      >
                        <div className="near-result-box__head">
                          <strong>
                            {enclaveResult.allowed ? "APPROVED BY INTEL TDX" : "BLOCKED BY OUTLAYER GUARD"} (
                            {enclaveResult.decision})
                          </strong>
                          <Chip tone={enclaveResult.allowed ? "done" : "waiting"}>
                            ${enclaveResult.amountUsd.toFixed(2)} vs ${enclaveResult.perTxCapUsd.toFixed(2)} cap
                          </Chip>
                        </div>
                        <div>{enclaveResult.reason}</div>
                        <div className="near-result-box__meta">
                          <span>NEP-413: {enclaveResult.nep413.tagHex}</span>
                          <span>Hash: {enclaveResult.nep413.nep413Hash.slice(0, 16)}...</span>
                          <span>WASI fuel: {enclaveResult.wasiTelemetry.fuelConsumed.toLocaleString()}</span>
                          <span>Latency: {enclaveResult.wasiTelemetry.execLatencyMs}ms</span>
                          {enclaveResult.pqReceiptId && <span>PQ: {enclaveResult.pqReceiptId}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                </MdxcnFrame>

                <MdxcnFrame
                  title="1CLICK CROSS-CHAIN QUOTE"
                  badge={activeQuote ? `${activeQuote.source.toUpperCase()} · ${activeQuote.bestSolver}` : "DRY QUOTE"}
                  tone="mint"
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div className="near-quote-controls">
                      <div className="near-chip-row">
                        {QUOTE_PAIRS.map((pair, idx) => (
                          <button
                            key={pair.label}
                            type="button"
                            className="near-pill-btn"
                            data-active={quotePairIdx === idx}
                            onClick={() => setQuotePairIdx(idx)}
                          >
                            {pair.label}
                          </button>
                        ))}
                        {[12, 25, 100].map((amt) => (
                          <button
                            key={amt}
                            type="button"
                            className="near-pill-btn"
                            data-active={quoteAmountUsd === amt}
                            onClick={() => setQuoteAmountUsd(amt)}
                          >
                            ${amt}
                          </button>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        variant="default"
                        icon="bolt"
                        data-testid="near-fetch-quote-btn"
                        loading={quoteMutation.isPending}
                        onClick={() =>
                          quoteMutation.mutate({
                            assetIn: activePair.assetIn,
                            assetOut: activePair.assetOut,
                            amountUsd: quoteAmountUsd,
                          })
                        }
                      >
                        Quote 1Click Intent
                      </Button>
                    </div>

                    {activeQuote && (
                      <>
                        <table className="near-solver-table" data-testid="near-quote-table">
                          <thead>
                            <tr>
                              <th>Solver</th>
                              <th>Out</th>
                              <th>USD</th>
                              <th>Spread</th>
                              <th>ETA</th>
                            </tr>
                          </thead>
                          <tbody>
                            {activeQuote.solverBids.map((bid) => (
                              <tr key={bid.solver}>
                                <td>
                                  <strong>{bid.solver}</strong> {bid.winner ? "(Best)" : ""}
                                </td>
                                <td>
                                  {bid.amountOutFormatted} {activeQuote.assetOut}
                                </td>
                                <td>${bid.amountOutUsd}</td>
                                <td>{bid.spreadBps} bps</td>
                                <td>{bid.estimatedSeconds}s</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="near-result-box__meta">
                          <span>Correlation: {activeQuote.correlationId}</span>
                          <span>Sig: {activeQuote.signature.slice(0, 18)}...</span>
                        </div>
                      </>
                    )}
                  </div>
                </MdxcnFrame>

                {data?.nearAiAttestation.models && (
                  <div className="near-chip-row">
                    {data.nearAiAttestation.models.map((m) => (
                      <Chip key={m.model} tone="done" icon="shield">
                        {m.model} · {m.teeProvider} ({m.tokenSigningAlg})
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            </TabPanel>

            <TabPanel value="markets">
              <div className="near-modal__panel">
                <div className="near-modal__bar">
                  <span className="near-modal__lead">
                    In-chat <strong>#near-intents-arena</strong> conviction markets (Terrace Social + Hunch +
                    meme.cooking). Misses burn <strong>$AGENTES</strong> NEP-141.
                  </span>
                  <div className="near-chip-row">
                    {[1, 2.5, 5, 10].map((amt) => (
                      <button
                        key={amt}
                        type="button"
                        className="near-pill-btn"
                        data-active={stakeWnear === amt}
                        onClick={() => setStakeWnear(amt)}
                      >
                        {amt} wNEAR
                      </button>
                    ))}
                  </div>
                </div>

                {lastBetReceipt && (
                  <div className="near-result-box" data-allowed="true" data-testid="near-bet-receipt">
                    <div className="near-result-box__head">
                      <strong>
                        Conviction Recorded: {lastBetReceipt.side} on {lastBetReceipt.marketId}
                      </strong>
                      <Chip tone="done">
                        Burn-on-Miss: {lastBetReceipt.burnOnMissEstimateAgentes} $AGENTES
                      </Chip>
                    </div>
                    <div className="near-result-box__meta">
                      <span>{lastBetReceipt.nep297Event.slice(0, 88)}...</span>
                      {lastBetReceipt.pqReceiptId && <span>PQ: {lastBetReceipt.pqReceiptId}</span>}
                    </div>
                  </div>
                )}

                {markets.map((m) => (
                  <MdxcnFrame
                    key={m.marketId}
                    title={m.title}
                    badge={`${m.channel} · ${m.participantsCount} traders`}
                    tone="purple"
                  >
                    <div className="near-market-card" data-testid={`near-market-${m.marketId}`}>
                      <DitherProgressBar
                        value={m.backProbabilityPct}
                        max={100}
                        label={`BACK ${m.backProbabilityPct}% vs FADE ${100 - m.backProbabilityPct}%`}
                        valueText={`${m.backPoolWnear.toFixed(1)} / ${m.fadePoolWnear.toFixed(1)} wNEAR`}
                        tone="mint"
                        showSteps
                      />
                      <div className="near-market-card__meta">
                        <span>
                          Burned: <strong>{m.totalBurnedAgentes.toLocaleString()} $AGENTES</strong> (
                          {m.burnOnMissRatePct}% miss penalty)
                        </span>
                        <div className="near-modal__actions">
                          <Button
                            size="sm"
                            variant="primary"
                            data-testid={`near-bet-back-${m.marketId}`}
                            loading={
                              betMutation.isPending &&
                              betMutation.variables?.marketId === m.marketId &&
                              betMutation.variables?.side === "BACK"
                            }
                            onClick={() =>
                              betMutation.mutate({
                                marketId: m.marketId,
                                side: "BACK",
                                stakeWnear,
                              })
                            }
                          >
                            BACK ({m.backOdds.toFixed(2)}x)
                          </Button>
                          <Button
                            size="sm"
                            variant="default"
                            data-testid={`near-bet-fade-${m.marketId}`}
                            loading={
                              betMutation.isPending &&
                              betMutation.variables?.marketId === m.marketId &&
                              betMutation.variables?.side === "FADE"
                            }
                            onClick={() =>
                              betMutation.mutate({
                                marketId: m.marketId,
                                side: "FADE",
                                stakeWnear,
                              })
                            }
                          >
                            FADE ({m.fadeOdds.toFixed(2)}x)
                          </Button>
                        </div>
                      </div>
                    </div>
                  </MdxcnFrame>
                ))}
              </div>
            </TabPanel>

            <TabPanel value="endowment">
              <div className="near-modal__panel">
                {endowment && (
                  <MdxcnFrame
                    title="CORPUS x402 H100 TEE COMPUTE ENDOWMENT"
                    badge={`$${endowment.hourlyRateUsd.toFixed(2)}/hr`}
                    tone="mint"
                  >
                    <div className="near-endowment-hero">
                      <DitherGauge
                        value={Math.min(100, endowment.runwayHours)}
                        max={100}
                        label="TEE Runway"
                        sublabel={`${endowment.runwayHours.toFixed(1)}h live`}
                        valueText={`${Math.round(endowment.runwayHours)}h`}
                        size={112}
                        tone="mint"
                      />
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div className="near-modal__stats">
                          <DitherStatCard
                            label="x402 Pool Balance"
                            value={endowment.balanceUsd}
                            prefix="$"
                            decimals={2}
                            subtitle={`${endowment.fundedHours.toFixed(1)}h · ${endowment.gpuNode}`}
                            tone="mint"
                          />
                          <DitherStatCard
                            label="Tab BNPL Available"
                            value={endowment.tabAvailableUsd}
                            prefix="$"
                            decimals={2}
                            subtitle={`Used $${endowment.tabUsedUsd.toFixed(2)} / $${endowment.tabCreditLimitUsd} ${endowment.tabSettlementAsset}`}
                            tone="blue"
                          />
                        </div>
                        <div className="near-modal__actions">
                          <Button
                            size="sm"
                            variant="primary"
                            icon="bolt"
                            data-testid="near-fund-4h-btn"
                            loading={
                              endowmentMutation.isPending && !endowmentMutation.variables?.useTabBnpl
                            }
                            onClick={() => endowmentMutation.mutate({ hours: 4, useTabBnpl: false })}
                          >
                            Fund +4h H100 TEE ($7.36)
                          </Button>
                          <Button
                            size="sm"
                            variant="default"
                            data-testid="near-fund-tab-btn"
                            loading={
                              endowmentMutation.isPending && endowmentMutation.variables?.useTabBnpl === true
                            }
                            onClick={() => endowmentMutation.mutate({ hours: 8, useTabBnpl: true })}
                          >
                            Fund +8h via Tab BNPL
                          </Button>
                        </div>
                        <div className="near-result-box__meta">
                          <span>Last Sponsor: {endowment.lastSponsor}</span>
                          <span>Contributors: {endowment.contributorsCount}</span>
                          <span>Header: {endowment.lastX402Header.slice(0, 34)}...</span>
                        </div>
                      </div>
                    </div>
                  </MdxcnFrame>
                )}

                <MdxcnFrame
                  title="KANMANI AGENT ESCROW & NEP-171 CREDENTIALS"
                  badge={`@${selectedAgent} · ML-DSA-65`}
                  tone="orange"
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div className="near-modal__actions">
                      {(["ada", "theo", "lia", "kronos"] as const).map((handle) => (
                        <button
                          key={handle}
                          type="button"
                          className="near-pill-btn"
                          data-active={selectedAgent === handle}
                          onClick={() => setSelectedAgent(handle)}
                        >
                          @{handle}
                        </button>
                      ))}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ flex: "1 1 240px" }}>
                        <Input
                          aria-label="Escrow task title"
                          value={escrowTaskTitle}
                          onChange={(e) => setEscrowTaskTitle(e.target.value)}
                          placeholder="Task for Kanmani escrow..."
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        data-testid="near-escrow-hire-btn"
                        loading={
                          escrowMutation.isPending && escrowMutation.variables?.action === "hire"
                        }
                        onClick={() => escrowMutation.mutate({ action: "hire", amountUsdc: 15 })}
                      >
                        Hire ($15 USDC)
                      </Button>
                      <Button
                        size="sm"
                        variant="default"
                        data-testid="near-escrow-release-btn"
                        loading={
                          escrowMutation.isPending && escrowMutation.variables?.action === "release"
                        }
                        onClick={() => escrowMutation.mutate({ action: "release", amountUsdc: 15 })}
                      >
                        Release + Level Up NFT
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="near-escrow-slash-btn"
                        loading={
                          escrowMutation.isPending && escrowMutation.variables?.action === "slash"
                        }
                        onClick={() => escrowMutation.mutate({ action: "slash", amountUsdc: 15 })}
                      >
                        Slash Stake
                      </Button>
                    </div>

                    {lastEscrowNotice && (
                      <div className="near-result-box" data-allowed="true" data-testid="near-escrow-result">
                        <strong>{lastEscrowNotice}</strong>
                      </div>
                    )}

                    <div className="near-cred-grid">
                      {credentials.map((c) => (
                        <div key={c.tokenId} className="near-cred-card">
                          <div className="near-agent-pill__head">
                            <span>
                              @{c.agentHandle} · Lvl {c.level} {c.tier}
                            </span>
                            <Chip tone="done">{c.standard}</Chip>
                          </div>
                          <div style={{ color: "var(--ac-ink-soft)" }}>{c.title}</div>
                          <div className="near-result-box__meta">
                            <span>{c.xp} XP</span>
                            <span>{c.verifiedTasks} verified</span>
                            <span>{c.slashedCount} slashed</span>
                            <span>${c.stakeUsdc} stake</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {escrows.slice(0, 3).map((e) => (
                      <div key={e.escrowId} className="near-escrow-row">
                        <span>
                          <strong>@{e.agentHandle}</strong> · {e.taskTitle}
                        </span>
                        <Chip
                          tone={
                            e.status === "released"
                              ? "done"
                              : e.status === "slashed"
                                ? "waiting"
                                : "neutral"
                          }
                        >
                          {e.status.toUpperCase()} (${e.amountUsdc} USDC)
                        </Chip>
                      </div>
                    ))}
                  </div>
                </MdxcnFrame>
              </div>
            </TabPanel>

            <TabPanel value="film">
              <div className="near-modal__panel" data-testid="near-film-panel">
                <MdxcnFrame
                  title="AGENTES NEAR · 4:00 NARRATED MASTER FILM (240s · V-DRILL)"
                  badge="7 CHAPTERS · DAN TRANH + 808 SCORE"
                  tone="purple"
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <p className="near-modal__lead" style={{ margin: 0 }}>
                        Watch the 4:00 Narrated Master Film (240s · V-Drill) directed by <strong>@mira</strong> with
                        4 neural voices (Alex, @ada, @kronos, @mira) covering NEAR Intents 1Click, OutLayer Intel TDX,
                        Terrace conviction markets, and Corpus x402 compute.
                      </p>
                      <a
                        href="/ocelli#motion-studio"
                        className="near-modal__ocelli-link"
                        data-testid="near-film-studio-link"
                        onClick={() => onOpenChange(false)}
                      >
                        <Icon name="globe" size={14} />
                        <span>Open Interactive Motion Studio (/ocelli#motion-studio)</span>
                      </a>
                    </div>

                    <div
                      style={{
                        borderRadius: 10,
                        overflow: "hidden",
                        border: "1px solid var(--ac-line)",
                        background: "#05070e",
                      }}
                    >
                      {/* biome-ignore lint/a11y/useMediaCaption: Hackathon product demo video */}
                      <video
                        src="/video/agentes-near-demo.mp4"
                        poster="/screenshots/motion-studio.png"
                        controls
                        playsInline
                        preload="metadata"
                        data-testid="near-film-video"
                        style={{ width: "100%", display: "block", maxHeight: 420 }}
                      />
                    </div>

                    <div className="near-result-box__meta">
                      <span>Duration: 4:00 (240.0s · 1920x1080)</span>
                      <span>Audio: 4 Neural Voices + Dan Tranh V-Drill (-14 LUFS)</span>
                      <a
                        href="/video/agentes-near-x-teaser.mp4"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--ac-ink)", textDecoration: "underline" }}
                      >
                        60s X Teaser Cut (MP4)
                      </a>
                    </div>
                  </div>
                </MdxcnFrame>
              </div>
            </TabPanel>
          </Tabs>
        </div>
      </DialogBody>
    </Dialog>
  );
}
