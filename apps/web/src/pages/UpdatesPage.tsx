import { useEffect, useRef, useState } from "react";
import "./updates.css";

interface ReleaseGroup {
  kind: "new" | "improved" | "verified";
  label: string;
  items: Array<{
    lead: string;
    detail: string;
    codes?: string[];
  }>;
}

interface ReleaseEntry {
  version: string;
  date: string;
  latest?: boolean;
  title: string;
  epics: string[];
  groups: ReleaseGroup[];
  actions: Array<{
    label: string;
    target: "workspace" | "team" | "decisions" | "approvals";
  }>;
}

interface PrdNoteRow {
  id: string;
  status: string;
  title: string;
  summary: string;
}

const RELEASES: ReleaseEntry[] = [
  {
    version: "0.4.0",
    date: "November 13, 2026",
    latest: true,
    title: "Agentes NEAR: Ocelli landing, dithercn engine & NEAR TEE settlement",
    epics: ["NEAR-1Click", "OutLayer-TDX", "x402-Endowment", "ML-DSA-65"],
    groups: [
      {
        kind: "new",
        label: "NEW",
        items: [
          {
            lead: "Ocelli-inspired public landing page (/ocelli) with dithercn shaders.",
            detail:
              "Built a 60fps ordered Bayer 4x4/8x8 shader engine (horizon, aurora, plasma, waves, dither-orb) plus tactile DitherCard, DitherStatCard, DitherGauge, DitherProgressBar, DitherHeatmap, DitherUptimeBar, MdxcnFrame, and spring-damped BenchoSloshSlider primitives.",
            codes: ["dithercn", "mdxcn", "slosh"],
          },
          {
            lead: "Live NEAR Intents 1Click, OutLayer Intel TDX & Corpus x402 channels.",
            detail:
              "Added #near-intents-arena, #compute-endowment, and #outlayer-tee-vault with live BACK/FADE conviction markets, deterministic $45 rogue drain blocking under a $25/tx hardware cap, and $1.84/hr H100 TEE compute pool funding.",
            codes: ["NEP-413", "NEP-171", "1Click"],
          },
        ],
      },
    ],
    actions: [
      { label: "Open workspace channels", target: "workspace" },
      { label: "Inspect ML-DSA-65 ledger", target: "decisions" },
    ],
  },
  {
    version: "0.3.0",
    date: "November 12, 2026",
    title: "CommandOSS roster, cleaner ZEN control & Updates log",
    epics: ["ZEN-E1", "ZEN-E2", "ZEN-F2.8", "M1"],
    groups: [
      {
        kind: "new",
        label: "NEW",
        items: [
          {
            lead: "Full CommandOSS Customer Zero roster.",
            detail:
              "Seeded all 11 CommandOSS team members (Daniel Lam as Head of CommandOSS, Tyr as Marketing & BD Lead, and Software Engineers Harry Phan, Nikola Le, Uy Le, Ben Ha, Hulk Nguyen, Rowan Nguyen, Ikaris Dinh, Toan Nguyen, and Henry Nguyen) with deterministic 32x32 pixel portraits alongside scoped External Guest access.",
            codes: ["ZEN-E1", "ZEN-E2", "F2.8", "M1"],
          },
          {
            lead: "Terminal showcase on ./team.",
            detail:
              "Added a 4-column pixel portrait grid inside the workspace Team page styled after commandoss.com so reviewers can inspect human owners, autonomous staff agents, and scoped external guests side by side.",
            codes: ["ZEN-E6", "ZEN-E7"],
          },
          {
            lead: "Updates & PRD traceability page.",
            detail:
              "Published this standalone /updates page with live deep links into the workspace, release-by-release notes, and a complete E1 through E16 coverage log.",
            codes: ["ZEN-E1..E16", "Q1..Q6"],
          },
        ],
      },
      {
        kind: "improved",
        label: "IMPROVED",
        items: [
          {
            lead: "Decluttered workspace sidebar & D1..D9 decision modal.",
            detail:
              "Moved Updates and ZEN Architecture directly into the native sidebar tool list so Home, Approvals, Threads, and Tasks never clip, and collapsed optional decision note inputs until clicked.",
            codes: ["D1..D9", "Q2"],
          },
        ],
      },
    ],
    actions: [
      { label: "Open ./team showcase", target: "team" },
      { label: "Review D1..D9 scorecard", target: "decisions" },
    ],
  },
  {
    version: "0.2.0",
    date: "November 12, 2026",
    title: "Autonomous workspace, BYOC & ML-DSA-65 ledger",
    epics: ["ZEN-E4", "ZEN-E8..E16", "M3", "M5=100%"],
    groups: [
      {
        kind: "new",
        label: "NEW",
        items: [
          {
            lead: "Self-hosted Slack-grade workspace on Bun and embedded PGlite.",
            detail:
              "Adapted agentes-chat into the local CommandOSS Ergo ZEN workspace with 4 autonomous agents (@ada, @theo, @lia, @astra) collaborating across #general, #release-2-4, #ops-triage, #zen-architecture, private #exec-security, and #client-shared.",
            codes: ["ZEN-E6", "ZEN-E8", "ZEN-E9", "M3"],
          },
          {
            lead: "Post-quantum ML-DSA-65 identity keys & hash-chained receipts.",
            detail:
              "Every human member, autonomous agent, and connected BYOC runner holds a NIST FIPS 204 ML-DSA-65 keypair. Every decision, message, routine run, and approval writes a signed, hash-chained receipt keeping guardrail M5 at 100%.",
            codes: ["ZEN-E13", "ZEN-AC14.6", "M5"],
          },
          {
            lead: "Payload-bound Hold to Approve gate, .ergo-bundle export & BYOC.",
            detail:
              "Wired Lia's production deployment gate on Approvals (D7), 1-click secret-free .ergo-bundle export stripping raw API keys (E15), and outbound-only WebSocket worker ergo-byoc-mac-studio-01 with zero inbound firewall ports (E16).",
            codes: ["ZEN-E14", "ZEN-E15", "ZEN-E16", "Q1"],
          },
        ],
      },
      {
        kind: "verified",
        label: "VERIFIED",
        items: [
          {
            lead: "48-assertion PGlite & cryptographic integration suite.",
            detail:
              "Verified keyless multi-provider routing (zroute.ai, Anthropic, OpenAI, Gemini), 1-nibble payload tamper detection at sequence check, private #exec-security isolation, and guest boundary enforcement.",
            codes: ["ZEN-E4", "ZEN-E9", "5/5 tests"],
          },
        ],
      },
    ],
    actions: [
      { label: "Open workspace channels", target: "workspace" },
      { label: "Inspect Hold to Approve gate", target: "approvals" },
    ],
  },
  {
    version: "0.1.0",
    date: "November 12, 2026",
    title: "ZEN PRD baseline, 10 EARS tiny PRDs & D1..D9 scorecard",
    epics: ["ZEN-E1..E7", "ZEN-E8..E16", "D1..D9"],
    groups: [
      {
        kind: "new",
        label: "NEW",
        items: [
          {
            lead: "10 EARS-compliant Tiny PRDs completing the stubbed ZEN specification.",
            detail:
              "Authored mandatory, observable EARS acceptance criteria for E8 (Sessions & Channels), E9 (Isolation & Collaboration), E10 (Durable Routines), E11 (Multi-Agent Coordination), E12 (5-Gear Supervision), E13 (Audit & Logging), E14 (Review & Verify), E15 (Stay Free), E16 (Bring Your Own Compute), and Section 6 (Quality Bar Q1..Q6) without renumbering E1..E7.",
            codes: ["ZEN-E8..E16", "Q1..Q6"],
          },
          {
            lead: "1-page Tech Lead Decision Scorecard (D1..D9).",
            detail:
              "Distilled all open questions (OQ1..OQ12) into 9 concrete architectural proposals stored on /Volumes/Dev/ergo-labs for engineering sign-off prior to ErgoAILabs repository creation.",
            codes: ["D1..D9", "OQ1..OQ12"],
          },
        ],
      },
    ],
    actions: [{ label: "Sign off D1..D9 in workspace", target: "decisions" }],
  },
];

const PRD_NOTES: PrdNoteRow[] = [
  {
    id: "ZEN-E1 .. E7",
    status: "Shipped in v0.2 + v0.3",
    title: "Identity, Workspaces, Multi-Model Providers & Agent Factory",
    summary:
      "Covers CommandOSS multi-tenant roles (Owner, Admin, Member, Scoped Guest F2.8), post-quantum identity fingerprints, keyless demo streaming across zroute.ai, Anthropic, OpenAI, and Gemini (E4), MCP connector policies (E5), and 4 autonomous personas (@ada, @theo, @lia, @astra) with versioned SKILL.md definitions (E6, E7).",
  },
  {
    id: "ZEN-E8 .. E9",
    status: "Tiny PRDs 01 & 02 · Live",
    title: "Sessions, Channels & Monotonic Policy Isolation",
    summary:
      "Separates public engineering and operations channels (#general, #release-2-4, #ops-triage, #zen-architecture) from private #exec-security and guest-scoped #client-shared so private context never bleeds across channel boundaries on shared agent staff.",
  },
  {
    id: "ZEN-E10 .. E12",
    status: "Tiny PRDs 03, 04 & 05 · Live",
    title: "Durable Routines, Multi-Agent Handoffs & 5-Gear Supervision",
    summary:
      "Runs journaled Postgres outbox steps and workspace-timezone schedules (F2.11 Asia/Ho_Chi_Minh), bounded @ada -> @theo -> @lia consultation chains without privilege escalation, and background agent_works continuity when every client device disconnects.",
  },
  {
    id: "ZEN-E13 .. E14",
    status: "Tiny PRDs 06 & 07 · Live",
    title: "Post-Quantum Audit Ledger & Payload-Bound Approvals",
    summary:
      "Maintains M5 = 100% action provenance using NIST FIPS 204 ML-DSA-65 signatures, detects single-nibble payload mutations immediately (ZEN-AC14.6), and binds human Hold to Approve signatures to the exact deployment payload hash (D7).",
  },
  {
    id: "ZEN-E15 .. E16",
    status: "Tiny PRDs 08 & 09 · Live",
    title: "Zero Vendor Lock-In (.ergo-bundle) & Outbound-Only BYOC",
    summary:
      "Exports portable .ergo-bundle archives containing agent personas, SKILL.md files, and provenance receipts with zero raw secret leakage, while connecting self-hosted compute nodes (ergo-byoc-mac-studio-01) over outbound WebSockets with zero inbound ports.",
  },
  {
    id: "Q1 .. Q6 & D1 .. D9",
    status: "Tiny PRD 10 · Interactive",
    title: "Platform Quality Bar & Tech Lead Decision Gate",
    summary:
      "Pairs sub-5-minute Customer Zero setup (Q1, M6), responsive desktop and mobile surfaces (Q2), and 48 automated PGlite assertions with an interactive D1..D9 sign-off ledger saved directly on /Volumes/Dev/ergo-labs.",
  },
];

// 4x4 Bayer ordered dithering matrix (0..15) for authentic pixel-sky gradients
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const SKY_PALETTE: Array<[number, number, number]> = [
  [5, 6, 10],
  [8, 17, 44],
  [13, 30, 74],
  [24, 52, 116],
  [44, 84, 168],
  [74, 122, 212],
];

function UpdatesSkyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const pixelScale = 4;
    let raf = 0;
    let width = 0;
    let height = 0;

    const stars = Array.from({ length: 68 }, (_, i) => ({
      rx: ((i * 73 + 19) % 997) / 997,
      ry: ((i * 139 + 41) % 613) / 613,
      phase: (i * 0.67) % (Math.PI * 2),
      cross: i % 9 === 0,
    }));

    const resize = () => {
      width = Math.max(120, Math.ceil(window.innerWidth / pixelScale));
      height = Math.max(100, Math.ceil(window.innerHeight / pixelScale));
      canvas.width = width;
      canvas.height = height;
    };

    const draw = (timeMs: number) => {
      const t = timeMs * 0.00025;
      const img = ctx.createImageData(width, height);
      const data = img.data;

      const moonX = Math.round(width * 0.835);
      const moonY = Math.round(Math.min(height * 0.25, 62));
      const moonR = 9.5;

      for (let y = 0; y < height; y++) {
        const ny = y / height;
        for (let x = 0; x < width; x++) {
          const nx = x / width;

          // Layered night-cloud bands rising toward top-right around the crescent moon
          const wave1 = Math.sin(nx * 5.2 + t) * 0.5 + 0.5;
          const wave2 = Math.cos((nx * 3.4 - ny * 4.1) - t * 0.7) * 0.5 + 0.5;
          const dxMoon = (x - moonX) / (width * 0.28);
          const dyMoon = (y - moonY) / (height * 0.28);
          const moonGlow = Math.exp(-(dxMoon * dxMoon + dyMoon * dyMoon) * 2.1);

          const skyHeightMask = Math.max(0, 1 - ny * 1.18);
          let level =
            skyHeightMask * (0.28 + wave1 * 0.34 + wave2 * 0.28) +
            moonGlow * 0.72;
          level = Math.max(0, Math.min(0.999, level));

          const scaled = level * (SKY_PALETTE.length - 1);
          const baseIdx = Math.floor(scaled);
          const frac = scaled - baseIdx;
          const threshold = ((BAYER_4X4[y & 3]?.[x & 3] ?? 0) + 0.5) / 16;
          const colorIdx = Math.min(
            SKY_PALETTE.length - 1,
            baseIdx + (frac > threshold ? 1 : 0),
          );
          let [r, g, b] = SKY_PALETTE[colorIdx] ?? [5, 6, 10];

          // Pixel-dithered crescent moon at top right
          const mdx = x - moonX;
          const mdy = y - moonY;
          const distMain = Math.sqrt(mdx * mdx + mdy * mdy);
          const distCut = Math.sqrt((mdx + 4.2) * (mdx + 4.2) + (mdy - 1.2) * (mdy - 1.2));
          if (distMain <= moonR && distCut > moonR * 0.86) {
            const edge = (moonR - distMain) / 2.5;
            if (edge > threshold * 0.65) {
              if (distCut < moonR * 1.04) {
                r = 166;
                g = 198;
                b = 250;
              } else {
                r = 244;
                g = 246;
                b = 251;
              }
            }
          }

          const offset = (y * width + x) * 4;
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = 255;
        }
      }

      ctx.putImageData(img, 0, 0);

      // Crisp pixel stars and cross glints
      for (const s of stars) {
        const sx = Math.floor(s.rx * width);
        const sy = Math.floor(s.ry * height * 0.78);
        const twinkle = 0.45 + 0.55 * Math.sin(timeMs * 0.0016 + s.phase);
        if (twinkle < 0.35) continue;
        ctx.fillStyle =
          twinkle > 0.84
            ? "rgba(244, 246, 251, 0.92)"
            : "rgba(143, 178, 245, 0.58)";
        ctx.fillRect(sx, sy, 1, 1);
        if (s.cross && twinkle > 0.72) {
          ctx.fillStyle = "rgba(182, 208, 252, 0.52)";
          ctx.fillRect(sx - 1, sy, 1, 1);
          ctx.fillRect(sx + 1, sy, 1, 1);
          ctx.fillRect(sx, sy - 1, 1, 1);
          ctx.fillRect(sx, sy + 1, 1, 1);
        }
      }
    };

    resize();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    draw(1200);

    if (!reduced) {
      let lastPaint = 0;
      const loop = (now: number) => {
        if (now - lastPaint >= 120) {
          lastPaint = now;
          draw(now);
        }
        raf = window.requestAnimationFrame(loop);
      };
      raf = window.requestAnimationFrame(loop);
    }

    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="up-sky-wrap" aria-hidden="true">
      <canvas ref={canvasRef} className="up-sky-canvas" />
      <div className="up-sky-vignette" />
    </div>
  );
}

export function UpdatesPage() {
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [openingTarget, setOpeningTarget] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Updates · Ergo (ZEN)";
    let cancelled = false;
    void fetch("/api/app/me", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as { organizations?: Array<{ id: string }> } | null;
      })
      .then((me) => {
        if (!cancelled && me?.organizations?.[0]?.id) {
          setActiveOrgId(me.organizations[0].id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const buildPath = (
    orgId: string,
    target: "workspace" | "team" | "decisions" | "approvals",
  ): string => {
    if (target === "team") return `/org/${orgId}/team`;
    if (target === "approvals") return `/org/${orgId}/approvals`;
    if (target === "decisions") return `/org/${orgId}/home?zen=1`;
    return `/org/${orgId}/home`;
  };

  const openTarget = async (
    target: "workspace" | "team" | "decisions" | "approvals",
  ) => {
    if (activeOrgId) {
      window.location.assign(buildPath(activeOrgId, target));
      return;
    }
    setOpeningTarget(target);
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
          window.location.assign(buildPath(orgId, target));
          return;
        }
      }
      window.location.assign("/");
    } finally {
      setOpeningTarget(null);
    }
  };

  return (
    <div className="up-root" data-testid="ergo-updates-page">
      <UpdatesSkyCanvas />

      <div className="up-shell">
        <header className="up-nav">
          <a
            href="#top"
            className="up-brand"
            onClick={(e) => {
              e.preventDefault();
              void openTarget("workspace");
            }}
          >
            <span>ergo</span>
            <span className="up-brand-sub">zen</span>
          </a>

          <nav className="up-nav-links" aria-label="Ergo Updates navigation">
            <button
              type="button"
              className="up-nav-link"
              onClick={() => void openTarget("workspace")}
            >
              Workspace
            </button>
            <button
              type="button"
              className="up-nav-link"
              onClick={() => void openTarget("team")}
            >
              Team
            </button>
            <button
              type="button"
              className="up-nav-link"
              onClick={() => void openTarget("decisions")}
            >
              Decisions
            </button>
            <a href="/ocelli" className="up-nav-link">
              Landing
            </a>
            <a href="#prd-coverage" className="up-nav-link">
              PRD Epics
            </a>
            <a href="/updates" className="up-nav-link" data-active="true" aria-current="page">
              Updates
            </a>
            <button
              type="button"
              className="up-cta"
              data-testid="updates-open-workspace"
              disabled={openingTarget !== null}
              onClick={() => void openTarget("workspace")}
            >
              {openingTarget ? "Opening..." : "Open Workspace"}
            </button>
          </nav>
        </header>

        <section className="up-hero" id="top">
          <p className="up-eyebrow">Updates</p>
          <h1 className="up-title">Notes from the ZEN lab.</h1>
          <p className="up-lead">
            What shipped in the Ergo (Codename ZEN) proof of concept, release by release,
            mapped to every PRD epic from E1 through E16. Built locally on /Volumes/Dev/ergo-labs
            for CommandOSS as Customer Zero.
          </p>
          <div className="up-hero-pills">
            <span className="up-stat-pill">
              <span className="up-stat-dot" />
              M5 Provenance: 100% ML-DSA-65
            </span>
            <span className="up-stat-pill">
              <span className="up-stat-dot" />
              11 CommandOSS Members + 4 Agents
            </span>
            <span className="up-stat-pill">
              <span className="up-stat-dot" />
              Epics E1..E16 + D1..D9 Covered
            </span>
          </div>
        </section>

        <section className="up-sheet" aria-labelledby="up-releases-heading">
          <div className="up-sheet-head">
            <h2 className="up-sheet-label" id="up-releases-heading">
              Releases
            </h2>
            <p className="up-sheet-caption">ergo-labs / experiments / zen-poc</p>
          </div>

          <div className="up-timeline">
            {RELEASES.map((rel) => (
              <article
                key={rel.version}
                className="up-release"
                data-testid={`release-${rel.version}`}
              >
                <span className="up-release-marker" aria-hidden="true" />

                <div className="up-release-rail">
                  <div className="up-ver-row">
                    <span className="up-ver">{rel.version}</span>
                    <span className="up-date">{rel.date}</span>
                  </div>
                  {rel.latest && <span className="up-latest-pill">Latest</span>}
                  <h3 className="up-release-title">{rel.title}</h3>
                  <div className="up-epic-chips">
                    {rel.epics.map((ep) => (
                      <span key={ep} className="up-epic-chip">
                        {ep}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="up-release-body">
                  {rel.groups.map((grp) => (
                    <div key={grp.label} className="up-group">
                      <span className="up-tag" data-kind={grp.kind}>
                        {grp.label}
                      </span>
                      <ul className="up-list">
                        {grp.items.map((item) => (
                          <li key={item.lead} className="up-list-item">
                            <strong>{item.lead}</strong> {item.detail}{" "}
                            {item.codes?.map((c) => (
                              <span key={c} className="up-code" style={{ marginRight: 5 }}>
                                {c}
                              </span>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}

                  <div className="up-actions-row">
                    {rel.actions.map((act) => (
                      <button
                        key={act.label}
                        type="button"
                        className="up-pill-btn"
                        onClick={() => void openTarget(act.target)}
                      >
                        {act.label}
                      </button>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section
          className="up-sheet"
          id="prd-coverage"
          aria-labelledby="up-prd-heading"
        >
          <div className="up-sheet-head">
            <h2 className="up-sheet-label" id="up-prd-heading">
              Ergo PRD Coverage (Codename ZEN · 2026-10-29)
            </h2>
            <p className="up-sheet-caption">EARS mandatory &amp; observable criteria</p>
          </div>

          <div className="up-log-list">
            {PRD_NOTES.map((row) => (
              <div key={row.id} className="up-log-row">
                <div className="up-log-meta">
                  <span className="up-log-id">{row.id}</span>
                  <span className="up-log-status">{row.status}</span>
                </div>
                <div className="up-log-content">
                  <h3>{row.title}</h3>
                  <p>{row.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer className="up-footer">
          <div>
            <a
              href="#top"
              className="up-brand"
              onClick={(e) => {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <span>ergo</span>
              <span className="up-brand-sub">zen</span>
            </a>
            <p className="up-footer-desc">
              Autonomous agent staff that run 24/7 on any model and any machine, with
              post-quantum provenance for every action.
            </p>
          </div>

          <div className="up-footer-col">
            <h4>Workspace</h4>
            <div className="up-footer-links">
              <button
                type="button"
                className="up-footer-link"
                onClick={() => void openTarget("workspace")}
              >
                Open Workspace
              </button>
              <button
                type="button"
                className="up-footer-link"
                onClick={() => void openTarget("team")}
              >
                CommandOSS ./team
              </button>
              <button
                type="button"
                className="up-footer-link"
                onClick={() => void openTarget("approvals")}
              >
                Hold to Approve Gate
              </button>
              <button
                type="button"
                className="up-footer-link"
                onClick={() => void openTarget("decisions")}
              >
                Tech Lead D1..D9
              </button>
            </div>
          </div>

          <div className="up-footer-col">
            <h4>ZEN PRD</h4>
            <div className="up-footer-links">
              <a href="#up-releases-heading" className="up-footer-link">
                Releases (v0.1 to v0.3)
              </a>
              <a href="#prd-coverage" className="up-footer-link">
                Epics E1..E16 Matrix
              </a>
              <button
                type="button"
                className="up-footer-link"
                onClick={() => void openTarget("decisions")}
              >
                ML-DSA-65 Ledger
              </button>
            </div>
          </div>

          <div className="up-footer-col">
            <h4>Experiment</h4>
            <div className="up-footer-links">
              <span className="up-footer-link" style={{ cursor: "default" }}>
                /Volumes/Dev/ergo-labs
              </span>
              <span className="up-footer-link" style={{ cursor: "default" }}>
                Customer Zero: CommandOSS
              </span>
              <button
                type="button"
                className="up-footer-link"
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              >
                Back to top ↑
              </button>
            </div>
          </div>
        </footer>

        <div className="up-footer-bottom">
          <span>ErgoAILabs · Local ZEN Architecture Experiment (0 external pushes)</span>
          <span>Updated November 12, 2026 · v0.3.0</span>
        </div>
      </div>
    </div>
  );
}
