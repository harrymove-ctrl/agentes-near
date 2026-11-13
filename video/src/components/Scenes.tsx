import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { BayerDitherBackdrop } from "./BayerDitherBackdrop";
import {
  BRAND,
  BenchoSloshSlider,
  DOTO,
  DitherProgressBar,
  DitherStatCard,
  MONO,
  MdxcnFrame,
  SANS,
  TOKENS,
} from "./DitherPrimitives";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

interface SceneProps {
  durationInFrames: number;
}

/**
 * Scene 1: dithercn.dev Bayer horizon shader + ocelli.app floating hero card reveal
 */
export const SceneHeroOcelli: React.FC<SceneProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const navIn = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const titleIn = spring({ frame: Math.max(0, frame - 8), fps, config: { damping: 16, stiffness: 100 } });
  const winIn = spring({ frame: Math.max(0, frame - 22), fps, config: { damping: 17, stiffness: 95 } });

  const tabCount = 4;
  const tabIndex = Math.min(
    tabCount - 1,
    Math.floor(interpolate(frame, [40, Math.max(41, durationInFrames - 25)], [0, tabCount], clamp))
  );

  const tabs = [
    {
      label: "#near-intents-arena",
      tag: "TERRACE + 1CLICK",
      title: "In-Chat Conviction Markets + Multi-Solver Routing",
      rows: [
        ["Active Pool", "142.5 wNEAR BACK · 58.0 wNEAR FADE (71% / 29%)"],
        ["Burn Mechanic", "240 $AGENTES NEP-141 burned automatically on miss"],
        ["1Click Best Bid", "1click.chaindefuser.com -> 91.42 USDC.near (dry: true)"],
      ],
    },
    {
      label: "OutLayer TDX Guard",
      tag: "INTEL TDX + NEP-413",
      title: "Hardware Enclave Policy Wallet ($25.00/tx Cap)",
      rows: [
        ["WASI Module", "wasm32-wasip2 enclave verified · $100.00/day ceiling"],
        ["Safe Intent ($12)", "APPROVED · Signed via NEP-413 (tag = 2147484061)"],
        ["Rogue Drain ($45)", "BLOCKED · Exceeds $25.00/tx hardware cap (fail-closed)"],
      ],
    },
    {
      label: "Corpus x402 Pool",
      tag: "H100 TEE + TAB BNPL",
      title: "Self-Sustaining GPU Compute Endowment ($1.84/hr)",
      rows: [
        ["Endowment Balance", "24.0h H100 TEE Runway funded via x402 micro-streams"],
        ["Tab Credit Line", "$120.00 USDC.near working credit · 0% grace active"],
        ["Kanmani Escrow", "$40.00 task escrow armed · NEP-171 Level 4 agent badge"],
      ],
    },
    {
      label: "Kyvera ML-DSA-65",
      tag: "FIPS 204 + .ERGO-BUNDLE",
      title: "Post-Quantum Hash-Chained Ledger & Zero-Key Export",
      rows: [
        ["Provenance Rate", "100% ML-DSA-65 verified across humans & AI agents"],
        ["Tamper Probe", "1-nibble mutation caught deterministically at Seq #2"],
        ["Portability", "Export .ergo-bundle · 0 raw secrets · MIT License"],
      ],
    },
  ];
  const activeTab = tabs[tabIndex];

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <BayerDitherBackdrop mode="horizon" primaryColor="#5aa8ff" secondaryColor="#00ec97" opacity={0.95} />

      <div
        style={{
          position: "absolute",
          inset: "86px 72px 104px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Ocelli Floating Pill Nav */}
        <div
          style={{
            transform: `translateY(${(1 - navIn) * -18}px)`,
            opacity: navIn,
            display: "flex",
            alignItems: "center",
            gap: 24,
            padding: "10px 22px",
            borderRadius: 999,
            backgroundColor: "rgba(12, 16, 26, 0.88)",
            border: "1px solid rgba(255, 255, 255, 0.16)",
            boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: BRAND, fontSize: 20, fontWeight: 700, color: "#f4f6fb" }}>
              agentes
            </span>
            <span style={{ fontFamily: DOTO, fontSize: 18, fontWeight: 700, color: TOKENS.nearGreen }}>
              .near
            </span>
          </div>
          <div style={{ display: "flex", gap: 18, fontFamily: SANS, fontSize: 14, color: TOKENS.ink2 }}>
            <span>Interactive Demo</span>
            <span>Conviction Markets</span>
            <span>OutLayer TEE</span>
            <span>Corpus x402</span>
            <span>13 Tracks</span>
          </div>
          <div
            style={{
              padding: "7px 14px",
              borderRadius: 999,
              backgroundColor: TOKENS.nearGreen,
              color: "#05060a",
              fontFamily: MONO,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            1-Click Enter Workspace -&gt;
          </div>
        </div>

        {/* Editorial Hero Headline */}
        <div
          style={{
            transform: `translateY(${(1 - titleIn) * 24}px)`,
            opacity: titleIn,
            textAlign: "center",
            maxWidth: 1180,
          }}
        >
          <div
            style={{
              fontFamily: BRAND,
              fontSize: 70,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.06,
              color: "#f4f6fb",
              textShadow: "0 10px 40px rgba(0, 0, 0, 0.65)",
            }}
          >
            Slack for Teams{" "}
            <span style={{ color: TOKENS.agent }}>+ NEAR AI Agents</span>
          </div>
          <div
            style={{
              marginTop: 14,
              fontFamily: SANS,
              fontSize: 24,
              color: "#cbd5e1",
              letterSpacing: "-0.01em",
            }}
          >
            Self-hosted channels. OutLayer Intel TDX spend guards. Live NEAR Intents 1Click settlement.
          </div>
        </div>

        {/* Ocelli Floating Interactive Window (.dl-win) */}
        <div
          style={{
            width: "100%",
            maxWidth: 1320,
            transform: `translateY(${(1 - winIn) * 44}px) scale(${0.96 + 0.04 * winIn})`,
            opacity: winIn,
            borderRadius: 18,
            backgroundColor: "rgba(13, 16, 23, 0.94)",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            boxShadow: "0 32px 84px rgba(0, 0, 0, 0.72)",
            overflow: "hidden",
          }}
        >
          {/* Window Chrome + 4 Interactive Tabs */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 22px",
              borderBottom: "1px solid rgba(255, 255, 255, 0.10)",
              backgroundColor: "rgba(8, 10, 16, 0.95)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: "#f08a80" }} />
              <span style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: "#e0a84a" }} />
              <span style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: "#5fc48a" }} />
              <span style={{ marginLeft: 12, fontFamily: MONO, fontSize: 13, color: TOKENS.muted }}>
                ocelli.agentes.near · LIVE DEMO PANE {tabIndex + 1}/4
              </span>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              {tabs.map((t, idx) => {
                const active = idx === tabIndex;
                return (
                  <div
                    key={t.label}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 8,
                      fontFamily: MONO,
                      fontSize: 12,
                      fontWeight: 700,
                      backgroundColor: active ? "rgba(90, 168, 255, 0.22)" : "rgba(255,255,255,0.04)",
                      border: active
                        ? "1px solid rgba(90, 168, 255, 0.75)"
                        : "1px solid rgba(255,255,255,0.10)",
                      color: active ? "#ffffff" : TOKENS.muted,
                    }}
                  >
                    {t.label}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Active Pane Body */}
          <div
            style={{
              padding: "24px 28px",
              display: "grid",
              gridTemplateColumns: "1.15fr 0.85fr",
              gap: 24,
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  display: "inline-block",
                  padding: "4px 10px",
                  borderRadius: 6,
                  backgroundColor: "rgba(0, 236, 151, 0.14)",
                  border: "1px solid rgba(0, 236, 151, 0.42)",
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  color: TOKENS.nearGreen,
                }}
              >
                {activeTab.tag}
              </div>
              <div
                style={{
                  marginTop: 12,
                  fontFamily: BRAND,
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#ffffff",
                }}
              >
                {activeTab.title}
              </div>
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                {activeTab.rows.map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 16,
                      padding: "10px 14px",
                      borderRadius: 8,
                      backgroundColor: "rgba(255, 255, 255, 0.04)",
                      border: "1px solid rgba(255, 255, 255, 0.09)",
                      fontFamily: MONO,
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: TOKENS.agent2, fontWeight: 700 }}>{k}</span>
                    <span style={{ color: TOKENS.ink }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <DitherStatCard
                label="NEAR AI TEE"
                value="DeepSeek-V4.1"
                delta="ITA ATTESTED"
                color={TOKENS.nearGreen}
              />
              <DitherStatCard
                label="Enclave Cap"
                value="$25.00/tx"
                delta="TDX ARMED"
                color={TOKENS.agent}
              />
              <DitherStatCard
                label="H100 Compute"
                value="$1.84/hr"
                delta="x402 ACTIVE"
                color={TOKENS.warn}
              />
              <DitherStatCard
                label="PQ Ledger"
                value="ML-DSA-65"
                delta="100% VERIFIED"
                color={TOKENS.nearGreen}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Scene 2: Self-hosted workspace channels, 1-click judge sign-in, and multi-agent stream
 */
export const SceneChannelsSwarm: React.FC<SceneProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const shellIn = spring({ frame, fps, config: { damping: 18, stiffness: 110 } });
  const clickProgress = interpolate(frame, [20, 65], [0, 1], clamp);
  const signedIn = frame >= 60;

  const messages = [
    {
      delay: 75,
      author: "Harry Phan",
      role: "JUDGE · HUMAN",
      accent: "#f4f6fb",
      isAgent: false,
      text: "@ada quote 25 wNEAR -> USDC.near via 1Click and verify our $25/tx OutLayer TDX cap.",
      meta: "POST /api/auth/zen-demo-login · Session verified",
    },
    {
      delay: 135,
      author: "@ada",
      role: "INTENTS SOLVER · DeepSeek-V4.1 TEE",
      accent: TOKENS.agent,
      isAgent: true,
      text: "Queried 1click.chaindefuser.com (dry: true). Best solver bid: 91.42 USDC.near vs 91.18 Wintermute.",
      meta: "Used 3 tools · NEAR Intents 1Click + Testnet RPC",
    },
    {
      delay: 205,
      author: "@theo",
      role: "TDX GUARDIAN · wasm32-wasip2",
      accent: TOKENS.nearGreen,
      isAgent: true,
      text: "Intel TDX enclave cap locked at $25.00/tx ($100/day). NEP-413 tag 2147484061 armed.",
      meta: "OutLayer hardware policy · zero raw keys exposed",
    },
    {
      delay: 275,
      author: "@lia",
      role: "COMPUTE STEWARD · Corpus x402",
      accent: TOKENS.warn,
      isAgent: true,
      text: "H100 TEE compute pool holds 24.0h runway ($1.84/hr). Tab $120.00 USDC.near credit ready.",
      meta: "Self-sustaining 24/7 agent uptime",
    },
    {
      delay: 345,
      author: "@kronos",
      role: "PQ AUDITOR · Kyvera ML-DSA-65",
      accent: "#a78bfa",
      isAgent: true,
      text: "Receipt #1042 chained and signed with NIST FIPS 204 ML-DSA-65. Audit chain 100% valid.",
      meta: "Ready for .ergo-bundle export",
    },
  ];

  // Scale delays proportionally if durationInFrames is shorter (e.g. teaser)
  const timeScale = durationInFrames / 1080;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <BayerDitherBackdrop mode="aurora" primaryColor="#5aa8ff" secondaryColor="#00ec97" opacity={0.45} />

      <div
        style={{
          position: "absolute",
          inset: "88px 72px 104px",
          display: "grid",
          gridTemplateColumns: "310px 1fr 330px",
          borderRadius: 16,
          backgroundColor: TOKENS.bg,
          border: "1px solid rgba(255, 255, 255, 0.14)",
          boxShadow: "0 28px 80px rgba(0, 0, 0, 0.72)",
          overflow: "hidden",
          transform: `scale(${0.96 + 0.04 * shellIn})`,
          opacity: shellIn,
        }}
      >
        {/* Left Sidebar */}
        <div
          style={{
            backgroundColor: TOKENS.side,
            borderRight: "1px solid rgba(255,255,255,0.09)",
            padding: "20px 16px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: BRAND, fontSize: 22, fontWeight: 700, color: TOKENS.ink }}>
                CommandOSS
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 6,
                  backgroundColor: "rgba(0, 236, 151, 0.14)",
                  color: TOKENS.nearGreen,
                  border: "1px solid rgba(0,236,151,0.35)",
                }}
              >
                SELF-HOSTED
              </span>
            </div>

            {/* 1-Click Judge Auto-Login Card */}
            <div
              style={{
                marginTop: 16,
                padding: "12px 12px",
                borderRadius: 10,
                backgroundColor: signedIn
                  ? "rgba(0, 236, 151, 0.10)"
                  : "rgba(90, 168, 255, 0.14)",
                border: signedIn
                  ? "1px solid rgba(0, 236, 151, 0.45)"
                  : "1px solid rgba(90, 168, 255, 0.55)",
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 11, color: TOKENS.muted }}>
                {signedIn ? "JUDGE SESSION ACTIVE" : "1-CLICK JUDGE ONBOARDING"}
              </div>
              <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: "#fff", marginTop: 4 }}>
                {signedIn ? "Harry Phan (Verified)" : "Enter as Harry Phan ->"}
              </div>
              <div style={{ marginTop: 8 }}>
                <DitherProgressBar
                  ratio={signedIn ? 1 : clickProgress}
                  color={signedIn ? TOKENS.nearGreen : TOKENS.agent}
                  height={8}
                  segments={14}
                />
              </div>
            </div>

            {/* Channels */}
            <div
              style={{
                marginTop: 20,
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: "0.08em",
                color: TOKENS.muted,
              }}
            >
              NEAR HACKATHON CHANNELS
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { name: "# near-intents-arena", active: true, badge: "4 agents" },
                { name: "# compute-endowment", active: false, badge: "$1.84/h" },
                { name: "# outlayer-tee-vault", active: false, badge: "TDX" },
              ].map((ch) => (
                <div
                  key={ch.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 10px",
                    borderRadius: 8,
                    backgroundColor: ch.active ? "rgba(255,255,255,0.09)" : "transparent",
                    color: ch.active ? "#ffffff" : TOKENS.muted,
                    fontFamily: SANS,
                    fontSize: 15,
                    fontWeight: ch.active ? 600 : 500,
                  }}
                >
                  <span>{ch.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: TOKENS.agent2 }}>{ch.badge}</span>
                </div>
              ))}
            </div>

            {/* Agent Roster */}
            <div
              style={{
                marginTop: 22,
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: "0.08em",
                color: TOKENS.muted,
              }}
            >
              AI STAFF ROSTER (ONLINE)
            </div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                ["@ada", "1Click Solver", TOKENS.agent],
                ["@theo", "Intel TDX Guard", TOKENS.nearGreen],
                ["@lia", "Corpus x402", TOKENS.warn],
                ["@kronos", "Kyvera PQ Audit", "#a78bfa"],
              ].map(([handle, role, clr]) => (
                <div
                  key={handle}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    borderRadius: 6,
                    backgroundColor: "rgba(255,255,255,0.03)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: clr }} />
                    <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#fff" }}>
                      {handle}
                    </span>
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: TOKENS.muted }}>{role}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Sidebar NEAR CTA */}
          <div
            style={{
              padding: "11px 12px",
              borderRadius: 10,
              backgroundColor: "rgba(90, 168, 255, 0.14)",
              border: "1px solid rgba(90, 168, 255, 0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: MONO,
              fontSize: 12,
              fontWeight: 700,
              color: "#ffffff",
            }}
          >
            <span>NEAR Intents &amp; TEE</span>
            <span style={{ color: TOKENS.nearGreen }}>NEAR</span>
          </div>
        </div>

        {/* Center Channel Stream */}
        <div
          style={{
            backgroundColor: TOKENS.pane,
            padding: "18px 26px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 14,
                borderBottom: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div>
                <span style={{ fontFamily: BRAND, fontSize: 22, fontWeight: 700, color: "#fff" }}>
                  # near-intents-arena
                </span>
                <span style={{ marginLeft: 12, fontFamily: SANS, fontSize: 14, color: TOKENS.muted }}>
                  Team + 4 TEE Agents · Multi-solver settlement &amp; conviction markets
                </span>
              </div>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 6,
                  backgroundColor: "rgba(0,236,151,0.12)",
                  color: TOKENS.nearGreen,
                }}
              >
                LIVE STREAM
              </span>
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {messages.map((m) => {
                const startF = Math.round(m.delay * timeScale);
                const msgSpring = spring({
                  frame: Math.max(0, frame - startF),
                  fps,
                  config: { damping: 18, stiffness: 130 },
                });
                if (frame < startF) return null;
                return (
                  <div
                    key={m.author}
                    style={{
                      transform: `translateY(${(1 - msgSpring) * 16}px)`,
                      opacity: msgSpring,
                      padding: "12px 16px",
                      borderRadius: 10,
                      backgroundColor: m.isAgent ? "rgba(255,255,255,0.04)" : "rgba(90,168,255,0.09)",
                      border: m.isAgent
                        ? "1px solid rgba(255,255,255,0.09)"
                        : "1px solid rgba(90,168,255,0.32)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: m.accent }}>
                        {m.author}
                      </span>
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          padding: "2px 7px",
                          borderRadius: 4,
                          backgroundColor: "rgba(255,255,255,0.06)",
                          color: TOKENS.muted,
                        }}
                      >
                        {m.role}
                      </span>
                    </div>
                    <div style={{ marginTop: 5, fontFamily: SANS, fontSize: 16, color: TOKENS.ink, lineHeight: 1.4 }}>
                      {m.text}
                    </div>
                    <div style={{ marginTop: 5, fontFamily: MONO, fontSize: 11, color: TOKENS.agent2 }}>
                      {m.meta}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Composer Pill */}
          <div
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              backgroundColor: TOKENS.raised,
              border: "1px solid rgba(255,255,255,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: MONO,
              fontSize: 13,
              color: TOKENS.muted,
            }}
          >
            <span>Message #near-intents-arena or mention @ada @theo @lia @kronos...</span>
            <span style={{ color: TOKENS.nearGreen }}>NEP-413 READY</span>
          </div>
        </div>

        {/* Right Telemetry Panel */}
        <div
          style={{
            backgroundColor: TOKENS.side,
            borderLeft: "1px solid rgba(255,255,255,0.09)",
            padding: "20px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: TOKENS.agent2 }}>
            WORKSPACE TEE TELEMETRY
          </div>
          <DitherStatCard label="Confidential Models" value="3 / 3" delta="ITA LIVE" color={TOKENS.nearGreen} />
          <DitherStatCard label="OutLayer Guard" value="$25/tx" delta="ARMED" color={TOKENS.agent} />
          <DitherStatCard label="Testnet Contract" value="pips-quay" delta="NEP-297" color={TOKENS.warn} />
        </div>
      </div>
    </div>
  );
};

/**
 * Scene 3: Terrace Social + Hunch conviction market + NEAR Intents 1Click multi-solver
 */
export const SceneTerraceIntents: React.FC<SceneProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardIn = spring({ frame, fps, config: { damping: 17, stiffness: 105 } });
  const betPhase = interpolate(
    frame,
    [Math.round(durationInFrames * 0.25), Math.round(durationInFrames * 0.55)],
    [0, 1],
    { ...clamp, easing: Easing.out(Easing.cubic) }
  );
  const backWnear = 142.5 + 10.0 * betPhase;
  const fadeWnear = 58.0;
  const backRatio = backWnear / (backWnear + fadeWnear);
  const burnedAgentes = Math.round(240 + 45 * betPhase);

  const solvers = [
    {
      name: "1click.chaindefuser.com",
      out: "91.42 USDC.near",
      bps: "+24 bps vs CEX",
      status: "WINNER · EXECUTED",
      color: TOKENS.nearGreen,
    },
    {
      name: "wintermute-intent.near",
      out: "91.18 USDC.near",
      bps: "+16 bps vs CEX",
      status: "QUOTED",
      color: TOKENS.agent,
    },
    {
      name: "rhea-liquidity.near",
      out: "91.05 USDC.near",
      bps: "+11 bps vs CEX",
      status: "QUOTED",
      color: TOKENS.muted,
    },
  ];

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <BayerDitherBackdrop mode="waves" primaryColor="#5aa8ff" secondaryColor="#00ec97" opacity={0.78} />

      <div
        style={{
          position: "absolute",
          inset: "96px 72px 110px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 28,
          transform: `translateY(${(1 - cardIn) * 26}px)`,
          opacity: cardIn,
        }}
      >
        {/* Left: Terrace Social + Hunch Conviction Market */}
        <MdxcnFrame
          title="TERRACE SOCIAL + HUNCH IN-CHAT MARKET"
          accent={TOKENS.warn}
          badge="wNEAR + $AGENTES BURN"
          style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
        >
          <div>
            <div style={{ fontFamily: MONO, fontSize: 13, color: TOKENS.muted }}>
              CHANNEL: #near-intents-arena · POST /api/near/bet
            </div>
            <div style={{ marginTop: 12, fontFamily: BRAND, fontSize: 30, fontWeight: 700, color: "#fff", lineHeight: 1.2 }}>
              Will 1Click Solver Beat CEX Mid by &gt; 18 bps on 25 wNEAR?
            </div>

            <div style={{ marginTop: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 15 }}>
                <span style={{ color: TOKENS.nearGreen, fontWeight: 700 }}>
                  BACK · {Math.round(backRatio * 100)}% ({backWnear.toFixed(1)} wNEAR)
                </span>
                <span style={{ color: TOKENS.danger, fontWeight: 700 }}>
                  FADE · {Math.round((1 - backRatio) * 100)}% ({fadeWnear.toFixed(1)} wNEAR)
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <DitherProgressBar ratio={backRatio} color={TOKENS.nearGreen} height={22} segments={28} />
              </div>
            </div>

            {/* BACK / FADE Action Cards */}
            <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div
                style={{
                  padding: "16px 18px",
                  borderRadius: 10,
                  backgroundColor: "rgba(0, 236, 151, 0.14)",
                  border: "1.5px solid rgba(0, 236, 151, 0.72)",
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 12, color: TOKENS.nearGreen }}>ACTION: BACK</div>
                <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: "#fff", marginTop: 4 }}>
                  +10.0 wNEAR
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: TOKENS.ink2, marginTop: 4 }}>
                  Staked by Harry Phan · Settled on-chain
                </div>
              </div>

              <div
                style={{
                  padding: "16px 18px",
                  borderRadius: 10,
                  backgroundColor: "rgba(240, 138, 128, 0.10)",
                  border: "1px solid rgba(240, 138, 128, 0.40)",
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 12, color: TOKENS.danger }}>
                  $AGENTES BURN-ON-MISS
                </div>
                <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: "#fff", marginTop: 4 }}>
                  {burnedAgentes} $AGENTES
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: TOKENS.ink2, marginTop: 4 }}>
                  Deflationary NEP-141 sink on wrong call
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              padding: "12px 16px",
              borderRadius: 8,
              backgroundColor: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
              fontFamily: MONO,
              fontSize: 13,
              color: TOKENS.ink2,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>RESOLUTION ORACLE: 1click.chaindefuser.com</span>
            <span style={{ color: TOKENS.nearGreen }}>SETTLED: BACK WINS</span>
          </div>
        </MdxcnFrame>

        {/* Right: Live NEAR Intents 1Click Multi-Solver */}
        <MdxcnFrame
          title="NEAR INTENTS 1CLICK MULTI-SOLVER"
          accent={TOKENS.agent}
          badge="LIVE QUOTE (DRY: TRUE)"
          style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
        >
          <div>
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 8,
                backgroundColor: "#090b10",
                border: "1px solid rgba(90, 168, 255, 0.3)",
                fontFamily: MONO,
                fontSize: 13,
                color: TOKENS.agent2,
              }}
            >
              POST https://1click.chaindefuser.com/v0/quote · 25.0 wNEAR -&gt; USDC.near
            </div>

            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
              {solvers.map((s, idx) => {
                const sDelay = Math.round(durationInFrames * (0.14 + idx * 0.12));
                const sIn = spring({
                  frame: Math.max(0, frame - sDelay),
                  fps,
                  config: { damping: 18, stiffness: 120 },
                });
                return (
                  <div
                    key={s.name}
                    style={{
                      transform: `translateX(${(1 - sIn) * 24}px)`,
                      opacity: sIn,
                      padding: "16px 18px",
                      borderRadius: 10,
                      backgroundColor: idx === 0 ? "rgba(0, 236, 151, 0.10)" : "rgba(255,255,255,0.04)",
                      border:
                        idx === 0
                          ? "1.5px solid rgba(0, 236, 151, 0.65)"
                          : "1px solid rgba(255,255,255,0.10)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <div style={{ fontFamily: MONO, fontSize: 16, fontWeight: 700, color: "#fff" }}>
                        {s.name}
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 12, color: s.color, marginTop: 4 }}>
                        {s.bps} · {s.status}
                      </div>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: s.color }}>
                      {s.out}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              padding: "14px 16px",
              borderRadius: 10,
              backgroundColor: "rgba(90, 168, 255, 0.10)",
              border: "1px solid rgba(90, 168, 255, 0.35)",
              fontFamily: MONO,
              fontSize: 13,
              color: TOKENS.ink,
            }}
          >
            <div>RPC TESTNET: pips-quay-contract-i5gp.testnet</div>
            <div style={{ color: TOKENS.nearGreen, marginTop: 4 }}>
              EVENT_JSON: &#123;"standard":"nep297","event":"intent_settled","solver":"1click.chaindefuser.com"&#125;
            </div>
          </div>
        </MdxcnFrame>
      </div>
    </div>
  );
};

/**
 * Scene 4: OutLayer Intel TDX hardware spend guard (BenchoSloshSlider @ $25/tx)
 */
export const SceneOutLayerGuard: React.FC<SceneProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideProg = interpolate(
    frame,
    [Math.round(durationInFrames * 0.08), Math.round(durationInFrames * 0.35)],
    [0, 1],
    { ...clamp, easing: Easing.inOut(Easing.cubic) }
  );
  const capUsd = 52 - 27 * slideProg; // Tunes smoothly from $52 -> $25.00
  const velocity = frame >= durationInFrames * 0.08 && frame <= durationInFrames * 0.35 ? -8.5 : 0;

  const safeIn = spring({
    frame: Math.max(0, frame - Math.round(durationInFrames * 0.34)),
    fps,
    config: { damping: 18, stiffness: 125 },
  });
  const rogueIn = spring({
    frame: Math.max(0, frame - Math.round(durationInFrames * 0.56)),
    fps,
    config: { damping: 16, stiffness: 125 },
  });
  const laserSweep = interpolate(
    frame,
    [Math.round(durationInFrames * 0.60), Math.round(durationInFrames * 0.78)],
    [0, 1],
    clamp
  );

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <BayerDitherBackdrop mode="shield" primaryColor="#00ec97" secondaryColor="#f08a80" opacity={0.72} />

      <div
        style={{
          position: "absolute",
          inset: "94px 72px 108px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 22,
        }}
      >
        <MdxcnFrame
          title="OUTLAYER INTEL TDX HARDWARE SPEND GUARD"
          accent={TOKENS.nearGreen}
          badge="wasm32-wasip2 · testnet-api.outlayer.ai"
        >
          <BenchoSloshSlider
            valueUsd={capUsd}
            minUsd={5}
            maxUsd={100}
            velocity={velocity}
            phase={frame / fps}
          />
        </MdxcnFrame>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, flex: 1 }}>
          {/* $12 Safe Intent APPROVED */}
          <div
            style={{
              transform: `translateY(${(1 - safeIn) * 24}px)`,
              opacity: safeIn,
              padding: "26px 28px",
              borderRadius: 14,
              backgroundColor: "rgba(11, 24, 20, 0.94)",
              border: "2px solid rgba(0, 236, 151, 0.65)",
              boxShadow: "0 20px 56px rgba(0, 236, 151, 0.14)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 13,
                    fontWeight: 700,
                    padding: "4px 10px",
                    borderRadius: 6,
                    backgroundColor: "rgba(0, 236, 151, 0.16)",
                    color: TOKENS.nearGreen,
                  }}
                >
                  SAFE INTENT · WITHIN $25/TX CAP
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: TOKENS.nearGreen }}>HTTP 200 OK</span>
              </div>

              <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 48, fontWeight: 700, color: "#fff" }}>
                $12.00 <span style={{ fontSize: 20, color: TOKENS.nearGreen }}>APPROVED</span>
              </div>

              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8, fontFamily: MONO, fontSize: 14, color: TOKENS.ink2 }}>
                <div>Agent: @ada (MPC Enclave Wallet)</div>
                <div>Payload Hash: sha256:9f4a8c12...e7b1</div>
                <div>Signature: NEP-413 (tag = 2147484061)</div>
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                backgroundColor: "rgba(0, 236, 151, 0.10)",
                fontFamily: MONO,
                fontSize: 13,
                color: TOKENS.nearGreen,
              }}
            >
              ENCLAVE RESULT: Signed &amp; settled to 1click.chaindefuser.com
            </div>
          </div>

          {/* $45 Rogue Drain BLOCKED */}
          <div
            style={{
              position: "relative",
              transform: `translateY(${(1 - rogueIn) * 24}px)`,
              opacity: rogueIn,
              padding: "26px 28px",
              borderRadius: 14,
              backgroundColor: "rgba(28, 12, 14, 0.95)",
              border: "2px solid rgba(240, 138, 128, 0.78)",
              boxShadow: "0 20px 56px rgba(240, 138, 128, 0.18)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              overflow: "hidden",
            }}
          >
            {/* Laser Guard Sweep */}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `${Math.round(14 + 72 * laserSweep)}%`,
                height: 3,
                background: "linear-gradient(90deg, transparent, #f08a80, #ffffff, #f08a80, transparent)",
                opacity: laserSweep > 0 && laserSweep < 1 ? 0.9 : 0.25,
              }}
            />

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 13,
                    fontWeight: 700,
                    padding: "4px 10px",
                    borderRadius: 6,
                    backgroundColor: "rgba(240, 138, 128, 0.18)",
                    color: TOKENS.danger,
                  }}
                >
                  ROGUE DRAIN · EXCEEDS $25/TX CAP
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: TOKENS.danger }}>FAIL-CLOSED 403</span>
              </div>

              <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 48, fontWeight: 700, color: "#fff" }}>
                $45.00 <span style={{ fontSize: 20, color: TOKENS.danger }}>BLOCKED</span>
              </div>

              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8, fontFamily: MONO, fontSize: 14, color: TOKENS.ink2 }}>
                <div>Attempt: Unapproved external drain to evil.near</div>
                <div>Policy Check: $45.00 &gt; $25.00 Intel TDX ceiling</div>
                <div>NEP-413 Signature: REFUSED INSIDE ENCLAVE</div>
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                backgroundColor: "rgba(240, 138, 128, 0.14)",
                fontFamily: MONO,
                fontSize: 13,
                color: TOKENS.danger,
              }}
            >
              ZERO FUNDS LOST · Alert logged to #outlayer-tee-vault
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Scene 5: Corpus x402 Compute Endowment ($1.84/hr), Tab BNPL, Kanmani Escrow, Kyvera ML-DSA-65 + .ergo-bundle
 */
export const SceneCorpusKyvera: React.FC<SceneProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const p1 = spring({ frame, fps, config: { damping: 18, stiffness: 110 } });
  const p2 = spring({ frame: Math.max(0, frame - 12), fps, config: { damping: 18, stiffness: 110 } });
  const p3 = spring({ frame: Math.max(0, frame - 24), fps, config: { damping: 18, stiffness: 110 } });

  const endowmentProg = interpolate(
    frame,
    [Math.round(durationInFrames * 0.12), Math.round(durationInFrames * 0.55)],
    [0.52, 0.88],
    clamp
  );
  const tamperActive = frame >= Math.round(durationInFrames * 0.52);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <BayerDitherBackdrop mode="aurora" primaryColor="#e0a84a" secondaryColor="#5aa8ff" opacity={0.62} />

      <div
        style={{
          position: "absolute",
          inset: "94px 72px 108px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 24,
        }}
      >
        {/* Column 1: Corpus x402 + Tab BNPL */}
        <MdxcnFrame
          title="CORPUS x402 + TAB BNPL"
          accent={TOKENS.warn}
          badge="$1.84 / HR H100 TEE"
          style={{
            transform: `translateY(${(1 - p1) * 24}px)`,
            opacity: p1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontFamily: BRAND, fontSize: 28, fontWeight: 700, color: "#fff" }}>
              24/7 Compute Endowment
            </div>
            <div style={{ marginTop: 8, fontFamily: SANS, fontSize: 15, color: TOKENS.muted, lineHeight: 1.45 }}>
              x402 micro-payments fund confidential H100 TEE GPU hours so team agents never go dark.
            </div>

            <div style={{ marginTop: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 13 }}>
                <span style={{ color: TOKENS.warn }}>H100 TEE POOL RUNWAY</span>
                <span style={{ color: "#fff", fontWeight: 700 }}>{(endowmentProg * 28).toFixed(1)} hrs</span>
              </div>
              <div style={{ marginTop: 8 }}>
                <DitherProgressBar ratio={endowmentProg} color={TOKENS.warn} height={18} segments={18} />
              </div>
            </div>

            <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
              <DitherStatCard label="GPU Rate (H100 TEE)" value="$1.84/hr" delta="x402 LIVE" color={TOKENS.warn} />
              <DitherStatCard label="Tab BNPL Line" value="$120.00" delta="USDC.near" color={TOKENS.agent} />
            </div>
          </div>

          <div style={{ fontFamily: MONO, fontSize: 12, color: TOKENS.ok }}>
            POST /api/near/endowment · +4h H100 TEE funded
          </div>
        </MdxcnFrame>

        {/* Column 2: Kanmani Slashing Escrow + NEP-171 */}
        <MdxcnFrame
          title="KANMANI ESCROW + NEP-171"
          accent={TOKENS.agent}
          badge="DYNAMIC CREDENTIAL NFT"
          style={{
            transform: `translateY(${(1 - p2) * 24}px)`,
            opacity: p2,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontFamily: BRAND, fontSize: 28, fontWeight: 700, color: "#fff" }}>
              Slashing Task Escrow
            </div>
            <div style={{ marginTop: 8, fontFamily: SANS, fontSize: 15, color: TOKENS.muted, lineHeight: 1.45 }}>
              Agents stake wNEAR collateral on deliverables. Verified tasks release escrow and level up NFTs.
            </div>

            <div
              style={{
                marginTop: 22,
                padding: "16px",
                borderRadius: 10,
                backgroundColor: "rgba(90, 168, 255, 0.10)",
                border: "1px solid rgba(90, 168, 255, 0.40)",
                fontFamily: MONO,
                fontSize: 13,
              }}
            >
              <div style={{ color: TOKENS.agent2 }}>TASK ESCROW #884 · @ada</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#fff", marginTop: 6 }}>$40.00 USDC.near</div>
              <div style={{ color: TOKENS.nearGreen, marginTop: 6 }}>STATUS: VERIFIED -&gt; RELEASED</div>
            </div>

            <div
              style={{
                marginTop: 14,
                padding: "16px",
                borderRadius: 10,
                backgroundColor: "rgba(0, 236, 151, 0.08)",
                border: "1px solid rgba(0, 236, 151, 0.36)",
                fontFamily: MONO,
                fontSize: 13,
              }}
            >
              <div style={{ color: TOKENS.nearGreen }}>NEP-171 AGENT CREDENTIAL</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginTop: 6 }}>
                @ada · Level 4 Verified
              </div>
              <div style={{ color: TOKENS.ink2, marginTop: 4 }}>148 verified runs · 0 slashes · 99.4% SLA</div>
            </div>
          </div>

          <div style={{ fontFamily: MONO, fontSize: 12, color: TOKENS.agent2 }}>
            POST /api/near/escrow · hire / release / slash
          </div>
        </MdxcnFrame>

        {/* Column 3: Kyvera ML-DSA-65 + .ergo-bundle */}
        <MdxcnFrame
          title="KYVERA ML-DSA-65 + EXPORT"
          accent={tamperActive ? TOKENS.danger : TOKENS.nearGreen}
          badge={tamperActive ? "1-NIBBLE TAMPER CAUGHT" : "FIPS 204 VERIFIED"}
          style={{
            transform: `translateY(${(1 - p3) * 24}px)`,
            opacity: p3,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontFamily: BRAND, fontSize: 28, fontWeight: 700, color: "#fff" }}>
              Post-Quantum Provenance
            </div>
            <div style={{ marginTop: 8, fontFamily: SANS, fontSize: 15, color: TOKENS.muted, lineHeight: 1.45 }}>
              Every approval and settlement hashes into an ML-DSA-65 chain with portable .ergo-bundle export.
            </div>

            <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { seq: "Seq #1", desc: "1Click Quote · 91.42 USDC.near", bad: false },
                {
                  seq: "Seq #2",
                  desc: tamperActive ? "TAMPERED 1 NIBBLE -> REJECTED" : "OutLayer $12.00 NEP-413 Signed",
                  bad: tamperActive,
                },
                { seq: "Seq #3", desc: "Corpus x402 +4h H100 TEE", bad: false },
                { seq: "Seq #4", desc: "Export .ergo-bundle (0 raw keys)", bad: false },
              ].map((r) => (
                <div
                  key={r.seq}
                  style={{
                    padding: "11px 14px",
                    borderRadius: 8,
                    backgroundColor: r.bad ? "rgba(240, 138, 128, 0.16)" : "rgba(255,255,255,0.04)",
                    border: r.bad
                      ? "1.5px solid rgba(240, 138, 128, 0.85)"
                      : "1px solid rgba(255,255,255,0.10)",
                    display: "flex",
                    justifyContent: "space-between",
                    fontFamily: MONO,
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: r.bad ? TOKENS.danger : TOKENS.agent2, fontWeight: 700 }}>{r.seq}</span>
                  <span style={{ color: r.bad ? TOKENS.danger : TOKENS.ink }}>{r.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              backgroundColor: "rgba(0, 236, 151, 0.10)",
              border: "1px solid rgba(0, 236, 151, 0.35)",
              fontFamily: MONO,
              fontSize: 12,
              color: TOKENS.nearGreen,
            }}
          >
            .ergo-bundle: skills + memory + ML-DSA-65 receipts (0 secrets)
          </div>
        </MdxcnFrame>
      </div>
    </div>
  );
};

/**
 * Scene 6: 13 NEAR Tracks sweep + clean centered Lockup End Card
 */
export const SceneTracksLockup: React.FC<SceneProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const splitFrame = Math.round(durationInFrames * 0.48);
  const showLockup = frame >= splitFrame;

  const tracks = [
    ["Memecoins (9.7%)", "$AGENTES burn-on-miss"],
    ["Games (8.8%)", "In-chat Arena Pools"],
    ["Thesis (7.5%)", "Terrace + Hunch Odds"],
    ["NFTs (7.0%)", "NEP-171 Dynamic Badges"],
    ["Social (6.5%)", "Slack + Agent Threads"],
    ["Swarms (6.5%)", "@ada @theo @lia @kronos"],
    ["DeFi", "1Click Multi-Solver"],
    ["Privacy", "OutLayer Intel TDX"],
    ["Business", "Tab BNPL USDC.near"],
    ["Real World", "Corpus x402 H100 TEE"],
    ["Agents", "WASI wasm32-wasip2"],
    ["Security", "Kyvera ML-DSA-65"],
    ["Open", "MIT + .ergo-bundle"],
  ];

  const lockupFrame = Math.max(0, frame - splitFrame);
  const lockupIn = spring({ frame: lockupFrame, fps, config: { damping: 20, stiffness: 95 } });
  const creepScale = interpolate(lockupFrame, [0, Math.max(1, durationInFrames - splitFrame)], [1.0, 1.035], clamp);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <BayerDitherBackdrop mode="night-sky" primaryColor="#5aa8ff" secondaryColor="#00ec97" opacity={0.96} />

      {!showLockup ? (
        <div
          style={{
            position: "absolute",
            inset: "94px 72px 108px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <div style={{ fontFamily: MONO, fontSize: 13, color: TOKENS.nearGreen, letterSpacing: "0.1em" }}>
              FULL ECOSYSTEM COVERAGE · ZERO VAPORWARE
            </div>
            <div style={{ fontFamily: BRAND, fontSize: 48, fontWeight: 700, color: "#fff", marginTop: 6 }}>
              13 NEAR Hackathon Tracks. One Live Product.
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 14,
            }}
          >
            {tracks.map(([name, desc], i) => {
              const tIn = spring({
                frame: Math.max(0, frame - i * 4),
                fps,
                config: { damping: 18, stiffness: 140 },
              });
              const highlight = i < 6;
              return (
                <div
                  key={name}
                  style={{
                    transform: `translateY(${(1 - tIn) * 14}px)`,
                    opacity: tIn,
                    padding: "14px 16px",
                    borderRadius: 10,
                    backgroundColor: highlight ? "rgba(0, 236, 151, 0.11)" : "rgba(18, 22, 32, 0.88)",
                    border: highlight
                      ? "1px solid rgba(0, 236, 151, 0.50)"
                      : "1px solid rgba(255, 255, 255, 0.12)",
                  }}
                >
                  <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: highlight ? TOKENS.nearGreen : TOKENS.agent2 }}>
                    {name}
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 14, color: TOKENS.ink, marginTop: 4 }}>{desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            transform: `scale(${(0.95 + 0.05 * lockupIn) * creepScale})`,
            opacity: lockupIn,
          }}
        >
          <div
            style={{
              padding: "10px 18px",
              borderRadius: 999,
              backgroundColor: "rgba(0, 236, 151, 0.14)",
              border: "1px solid rgba(0, 236, 151, 0.45)",
              fontFamily: MONO,
              fontSize: 14,
              fontWeight: 700,
              color: TOKENS.nearGreen,
              letterSpacing: "0.08em",
            }}
          >
            MIT LICENSE · OPEN STACK · POST-QUANTUM VERIFIABLE
          </div>

          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 22 }}>
            <span style={{ fontFamily: BRAND, fontSize: 92, fontWeight: 700, color: "#ffffff", letterSpacing: "-0.04em" }}>
              Agentes
            </span>
            <span style={{ fontFamily: DOTO, fontSize: 82, fontWeight: 700, color: TOKENS.nearGreen }}>
              NEAR
            </span>
          </div>

          <div style={{ marginTop: 12, fontFamily: SANS, fontSize: 28, color: "#cbd5e1" }}>
            Slack for Teams + NEAR AI Agents
          </div>

          <div
            style={{
              marginTop: 28,
              padding: "12px 24px",
              borderRadius: 12,
              backgroundColor: "rgba(12, 16, 26, 0.88)",
              border: "1px solid rgba(255, 255, 255, 0.18)",
              fontFamily: MONO,
              fontSize: 20,
              color: "#ffffff",
            }}
          >
            github.com/harrymove-ctrl/agentes-near
          </div>
        </div>
      )}
    </div>
  );
};
