#!/usr/bin/env python3
from __future__ import annotations
"""
Agentes NEAR Phase 5 Multi-Voice V-Drill Audio, Word-Boundary Lip-Sync,
and 4-Minute (240.0s) Step-by-Step Promotion Talk Pipeline (30 FPS, -14 LUFS).

1. Auto-bootstraps `uvx --from edge-tts` when `ELEVENLABS_API_KEY` is unset.
2. Synthesizes 4 distinct neural voices with word-level timestamps:
   - `alex` (`ALEX · FOUNDER`, `en-US-AndrewMultilingualNeural`, `+4%`, `#00EC97`)
   - `ada` (`ADA · 1CLICK QUANT`, `en-US-AvaMultilingualNeural`, `+5%`, `#38BDF8`)
   - `kronos` (`KRONOS · OUTLAYER TDX`, `en-US-BrianMultilingualNeural`, `+3%`, `#F59E0B`)
   - `mira_vi` (`MIRA · V-DRILL`, `vi-VN-HoaiMyNeural`, `+4%`, `#EC4899`)
3. Composes `generate_vdrill_score_and_foley(...)` featuring:
   - Vietnamese Minor Pentatonic Dan Tranh (16-string plucked zither harmonics D-F-G-A-C + pitch vibrato)
   - Airy Bamboo Flute (Sao Truc) counter-melody
   - Sliding 808 sub-bass portamento glides (phase-continuous root -> fifth -> octave)
   - UK/Viet-Drill 3-3-2 tresillo hi-hat counter-rhythm + triplet ratchets + rimshot/clap
   - Timed foley (`whooshes`, `pops`, `lasers`, `chimes`)
   - Smooth sidechain speech ducking (`duck_ctrl = 0.28` during speech, `1.0` between utterances)
4. Outputs `public/audio/demo-mix.wav` (240.000s = 7200f @ 30fps),
   `public/audio/teaser-mix.wav` (60.000s = 1800f @ 30fps),
   and `src/scene-manifest.json`.
"""

import asyncio
import base64
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

# Auto-bootstrap edge_tts via uvx when ELEVENLABS_API_KEY is unset and edge_tts is not in base python3
if not os.environ.get("ELEVENLABS_API_KEY", "").strip() and not os.environ.get("_AGENTES_UVX_BOOTSTRAPPED"):
    try:
        import edge_tts  # type: ignore # noqa: F401
    except ImportError:
        uvx_bin = shutil.which("uvx") or str(Path.home() / ".local" / "bin" / "uvx")
        if Path(uvx_bin).exists():
            env = dict(os.environ)
            env["_AGENTES_UVX_BOOTSTRAPPED"] = "1"
            os.execve(
                uvx_bin,
                [uvx_bin, "--from", "edge-tts", "python3", str(Path(__file__).resolve()), *sys.argv[1:]],
                env,
            )

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "public" / "audio"
MANIFEST_PATH = ROOT / "src" / "scene-manifest.json"
FPS = 30
SAMPLE_RATE = 44100

VOICES = {
    "alex": {
        "id": "alex",
        "label": "ALEX · FOUNDER",
        "role": "Founder Host",
        "accent": "#00EC97",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_ALEX", "nPczCjzI2devNBz1zQrb").strip(),
        "edge_voice": "en-US-AndrewMultilingualNeural",
        "edge_rate": "+4%",
        "say_voice": "Reed",
    },
    "ada": {
        "id": "ada",
        "label": "ADA · 1CLICK QUANT",
        "role": "@ada · 1Click Quant Agent",
        "accent": "#38BDF8",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_ADA", "cgSgspJ2msm6clMCkdW9").strip(),
        "edge_voice": "en-US-AvaMultilingualNeural",
        "edge_rate": "+5%",
        "say_voice": "Samantha",
    },
    "kronos": {
        "id": "kronos",
        "label": "KRONOS · OUTLAYER TDX",
        "role": "@kronos · OutLayer TDX Guard",
        "accent": "#F59E0B",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_KRONOS", "cjVigY5qzO86Huf0OWal").strip(),
        "edge_voice": "en-US-BrianMultilingualNeural",
        "edge_rate": "+3%",
        "say_voice": "Reed",
    },
    "mira_vi": {
        "id": "mira_vi",
        "label": "MIRA · V-DRILL",
        "role": "@mira · V-Drill Producer Tag",
        "accent": "#EC4899",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_MIRA", "cgSgspJ2msm6clMCkdW9").strip(),
        "edge_voice": "vi-VN-HoaiMyNeural",
        "edge_rate": "+4%",
        "say_voice": "Linh",
    },
}


# ---------------------------------------------------------------------------
# 240.0s (7,200 frames @ 30 FPS) Master Visual Blocks & Narrated Utterances
# ---------------------------------------------------------------------------
DEMO_VISUALS = [
    # Ch 1 (0:00-0:34, 0..1020f): Hook & 3 Fatal Problems
    {
        "id": "v_ch1_act1",
        "chapter": 1,
        "chapter_title": "Ch 1 · Hook & 3 Fatal Problems",
        "kind": "act",
        "act": 1,
        "start_frame": 0,
        "duration_frames": 330,
    },
    {
        "id": "v_ch1_problems",
        "chapter": 1,
        "chapter_title": "Ch 1 · Hook & 3 Fatal Problems",
        "kind": "showcase",
        "start_frame": 330,
        "duration_frames": 360,
        "showcase": {
            "chapterBadge": "CHAPTER 01 · PROBLEM DIAGNOSIS",
            "headline": "Why Every AI Agent Team Hits 3 Fatal Walls",
            "accent": "#38BDF8",
            "bgStyle": "obsidian",
            "steps": [
                {
                    "badge": "STEP 01 · FRAGMENTED TABS",
                    "title": "Chat & Wallets Split Across 6 Disconnected Tabs",
                    "image": "photos/garment-cobalt-overshirt.jpg",
                    "metric": "6 TABS -> 1 SLACK",
                    "whatItIs": "Team discussions happen in Slack while wallets, solver quotes, and GPUs hide in separate tabs.",
                    "whyItHelps": "Agentes NEAR unifies human channels and 6 NEAR AI agents inside one self-hosted workspace.",
                    "cursorTarget": [520, 340],
                },
                {
                    "badge": "STEP 02 · RAW KEY EXPOSURE",
                    "title": "Raw Private Keys Risk Instant Treasury Drains",
                    "image": "photos/look-2-cream.jpg",
                    "metric": "$25.00/TX TDX CAP",
                    "whatItIs": "Giving an autonomous agent a raw private key lets a single bad prompt drain your wallet.",
                    "whyItHelps": "OutLayer Intel TDX hardware enclaves enforce a deterministic $25.00/tx spend cap.",
                    "cursorTarget": [780, 420],
                },
                {
                    "badge": "STEP 03 · OPAQUE EXECUTION",
                    "title": "Zero Verifiable Audit Trail on Agent Spend",
                    "image": "photos/look-4-sage.jpg",
                    "metric": "NEP-297 + ML-DSA-65",
                    "whatItIs": "Standard bot trades and GPU bills leave teams with unverified screenshots and blind trust.",
                    "whyItHelps": "Every action emits NEP-297 logs and FIPS 204 Kyvera ML-DSA-65 post-quantum proofs.",
                    "cursorTarget": [640, 500],
                },
            ],
        },
    },
    {
        "id": "v_ch1_act2",
        "chapter": 1,
        "chapter_title": "Ch 1 · Hook & 3 Fatal Problems",
        "kind": "act",
        "act": 2,
        "start_frame": 690,
        "duration_frames": 330,
    },
    # Ch 2 (0:34-1:10, 1020..2100f): Solution: Agentes NEAR & Ocelli 3-Col Workspace
    {
        "id": "v_ch2_act4",
        "chapter": 2,
        "chapter_title": "Ch 2 · One Slack + Ocelli 3-Col Workspace",
        "kind": "act",
        "act": 4,
        "start_frame": 1020,
        "duration_frames": 450,
    },
    {
        "id": "v_ch2_tour",
        "chapter": 2,
        "chapter_title": "Ch 2 · One Slack + Ocelli 3-Col Workspace",
        "kind": "showcase",
        "start_frame": 1470,
        "duration_frames": 630,
        "showcase": {
            "chapterBadge": "CHAPTER 02 · 3-COLUMN OCELLI WORKSPACE",
            "headline": "Self-Hosted Slack + 6 Autonomous NEAR Agents",
            "accent": "#00EC97",
            "bgStyle": "emerald",
            "steps": [
                {
                    "badge": "STEP 01 · LEFT CHANNEL RAIL",
                    "title": "1-Click Judge Sign-In & Protocol Channels",
                    "image": "photos/garment-cobalt-overshirt.jpg",
                    "metric": "#near-intents-arena",
                    "whatItIs": "Dedicated channels (#near-intents-arena, #outlayer-tee-vault, #compute-endowment) with 1-click sign-in.",
                    "whyItHelps": "Judges and engineers jump straight into live multi-agent rooms with zero wallet extension friction.",
                    "cursorTarget": [340, 380],
                },
                {
                    "badge": "STEP 02 · CENTER AGENT STREAM",
                    "title": "Mention @ada, @kronos, @theo, @lia, @mira, @zen",
                    "image": "photos/look-1-butter.jpg",
                    "metric": "6 LIVE TEE AGENTS",
                    "whatItIs": "Shared real-time stream where human teammates and 6 specialized NEAR AI agents collaborate.",
                    "whyItHelps": "Tag any agent with @ in plain English to quote swaps, audit enclave policies, or render motion.",
                    "cursorTarget": [680, 440],
                },
                {
                    "badge": "STEP 03 · RIGHT TELEMETRY RAIL",
                    "title": "Live NEP-413, 1Click & Block #277,497,700 Inspector",
                    "image": "photos/friends-photo.jpg",
                    "metric": "BLOCK #277,497,700",
                    "whatItIs": "3-column Ocelli dark-glass inspector displaying real-time RPC block height, solver spreads, and TDX state.",
                    "whyItHelps": "Verify every hardware attestation and on-chain receipt side-by-side with your team chat.",
                    "cursorTarget": [980, 360],
                },
            ],
        },
    },
    # Ch 3 (1:10-1:48, 2100..3240f): Feature 1 Step-by-Step (1Click Cross-Chain Solver Auctions)
    {
        "id": "v_ch3_act3",
        "chapter": 3,
        "chapter_title": "Ch 3 · 1Click Cross-Chain Solver Auctions",
        "kind": "act",
        "act": 3,
        "start_frame": 2100,
        "duration_frames": 360,
    },
    {
        "id": "v_ch3_1click",
        "chapter": 3,
        "chapter_title": "Ch 3 · 1Click Cross-Chain Solver Auctions",
        "kind": "showcase",
        "start_frame": 2460,
        "duration_frames": 780,
        "showcase": {
            "chapterBadge": "CHAPTER 03 · FEATURE 1 STEP-BY-STEP",
            "headline": "NEAR Intents 1Click Cross-Chain Solver Auctions",
            "accent": "#38BDF8",
            "bgStyle": "cobalt",
            "steps": [
                {
                    "badge": "STEP 01 · PROMPT @ADA SWAP",
                    "title": "Post '1,250 USDC -> wNEAR' in #near-intents-arena",
                    "image": "photos/look-1-butter.jpg",
                    "metric": "1,250 USDC INTENT",
                    "whatItIs": "Type a natural-language swap intent to @ada directly inside #near-intents-arena.",
                    "whyItHelps": "Eliminates manual bridge hops and slippage guesswork by broadcasting one signed intent.",
                    "cursorTarget": [580, 520],
                },
                {
                    "badge": "STEP 02 · SOLVER AUCTION +16 BPS",
                    "title": "1Click Beats Wintermute (+16 bps · 358.1357 wNEAR)",
                    "image": "photos/thumb-pier.jpg",
                    "metric": "358.1357 wNEAR",
                    "whatItIs": "1click.chaindefuser.com competes against wintermute-intent.near and rhea-liquidity.near in real time.",
                    "whyItHelps": "Multi-solver competition wins you +16 bps more output (358.1357 wNEAR) automatically.",
                    "cursorTarget": [760, 390],
                },
                {
                    "badge": "STEP 03 · 22S NEP-297 SETTLEMENT",
                    "title": "Atomic Settlement in 22s + Signed NEP-297 Log",
                    "image": "photos/garment-cobalt-overshirt.jpg",
                    "metric": "22S · NEP-297 LOG",
                    "whatItIs": "Winning solver settles cross-chain in 22 seconds at Block #277,497,700 with NEP-297 EVENT_JSON.",
                    "whyItHelps": "Your channel receives an immutable, accounting-ready receipt with zero manual reconciliation.",
                    "cursorTarget": [840, 480],
                },
            ],
        },
    },
    # Ch 4 (1:48-2:28, 3240..4440f): Feature 2 Step-by-Step (OutLayer Intel TDX $25/tx Guard)
    {
        "id": "v_ch4_act6",
        "chapter": 4,
        "chapter_title": "Ch 4 · OutLayer Intel TDX $25/tx Guard",
        "kind": "act",
        "act": 6,
        "start_frame": 3240,
        "duration_frames": 390,
    },
    {
        "id": "v_ch4_outlayer",
        "chapter": 4,
        "chapter_title": "Ch 4 · OutLayer Intel TDX $25/tx Guard",
        "kind": "showcase",
        "start_frame": 3630,
        "duration_frames": 810,
        "showcase": {
            "chapterBadge": "CHAPTER 04 · FEATURE 2 STEP-BY-STEP",
            "headline": "OutLayer Intel TDX Hardware Enclave Spend Guard",
            "accent": "#F59E0B",
            "bgStyle": "amber",
            "steps": [
                {
                    "badge": "STEP 01 · $25.00/TX ENCLAVE CAP",
                    "title": "Lock Per-Tx Ceiling in wasm32-wasip2 Intel TDX",
                    "image": "photos/look-2-cream.jpg",
                    "metric": "$25.00/TX POLICY",
                    "whatItIs": "Configure the BenchoSloshSlider spend cap at $25.00/tx inside an OutLayer Intel TDX enclave.",
                    "whyItHelps": "Private keys stay sealed inside hardware enclave memory and never touch the Node server.",
                    "cursorTarget": [640, 410],
                },
                {
                    "badge": "STEP 02 · $12 SAFE NEP-413 PASS",
                    "title": "Approve $12.00 Safe Intent in 4ms (NEP-413)",
                    "image": "photos/friends-photo.jpg",
                    "metric": "$12.00 · 4MS SIGNED",
                    "whatItIs": "A $12.00 swap sits safely under the $25.00 cap and receives a hardware NEP-413 signature in 4ms.",
                    "whyItHelps": "Authorized agent workflows run at full speed without human bottleneck on routine tasks.",
                    "cursorTarget": [540, 490],
                },
                {
                    "badge": "STEP 03 · $45 ROGUE DRAIN BLOCKED",
                    "title": "Deterministic Block ($45.00) + Kyvera ML-DSA-65 Proof",
                    "image": "photos/look-2-cream.jpg",
                    "metric": "$45.00 BLOCKED · PQ",
                    "whatItIs": "A $45.00 rogue drain triggers BLOCKED_PER_TX_CAP in hardware and logs a FIPS 204 ML-DSA-65 receipt.",
                    "whyItHelps": "Even a compromised LLM prompt cannot move a single cent above your enclave policy.",
                    "cursorTarget": [820, 500],
                },
            ],
        },
    },
    # Ch 5 (2:28-3:14, 4440..5820f): Feature 3 Step-by-Step (Winner Mechanics)
    {
        "id": "v_ch5_act5",
        "chapter": 5,
        "chapter_title": "Ch 5 · Endowment, Conviction Markets & Escrow",
        "kind": "act",
        "act": 5,
        "start_frame": 4440,
        "duration_frames": 390,
    },
    {
        "id": "v_ch5_mechanics",
        "chapter": 5,
        "chapter_title": "Ch 5 · Endowment, Conviction Markets & Escrow",
        "kind": "showcase",
        "start_frame": 4830,
        "duration_frames": 990,
        "showcase": {
            "chapterBadge": "CHAPTER 05 · FEATURE 3 STEP-BY-STEP",
            "headline": "Self-Funding Compute, Conviction Markets & Slashing Escrow",
            "accent": "#EC4899",
            "bgStyle": "magenta",
            "steps": [
                {
                    "badge": "STEP 01 · CORPUS X402 $1.84/HR H100",
                    "title": "$250K Endowment Yield Funds H100 TEE Compute",
                    "image": "photos/look-4-sage.jpg",
                    "metric": "$1.84/HR H100 TEE",
                    "whatItIs": "A $250,000 NEAR principal vault earns 14.2% APY to pay Corpus x402 H100 GPUs at $1.84/hr.",
                    "whyItHelps": "Your AI swarm runs 24/7 inference from yield alone without depleting treasury principal.",
                    "cursorTarget": [610, 380],
                },
                {
                    "badge": "STEP 02 · TERRACE + HUNCH MARKETS",
                    "title": "BACK YES 76c / FADE NO 24c · 38,420 $AGENTES Burned",
                    "image": "photos/look-3-terracotta.jpg",
                    "metric": "38,420 $AGENTES BURN",
                    "whatItIs": "In-chat Terrace & Hunch conviction markets stake wNEAR with deflationary $AGENTES burn-on-miss.",
                    "whyItHelps": "Forces agents to back every signal with real economic stake and rewards accurate calls.",
                    "cursorTarget": [740, 440],
                },
                {
                    "badge": "STEP 03 · KANMANI ESCROW + TAB BNPL",
                    "title": "Milestone Slashing Escrow, Tab 0% BNPL & NEP-171",
                    "image": "photos/look-4-sage.jpg",
                    "metric": "KANMANI + NEP-171",
                    "whatItIs": "Kanmani milestone escrow with slashing, Tab 0% BNPL compute credit, and NEP-171 badges.",
                    "whyItHelps": "Protects task bounties until tests pass and builds portable on-chain agent reputation.",
                    "cursorTarget": [860, 490],
                },
            ],
        },
    },
    # Ch 6 (3:14-3:44, 5820..6720f): Feature 4 Step-by-Step (@mira Motion Studio & V-Drill Synth)
    {
        "id": "v_ch6_studio",
        "chapter": 6,
        "chapter_title": "Ch 6 · @mira Motion Studio & V-Drill Synth",
        "kind": "showcase",
        "start_frame": 5820,
        "duration_frames": 900,
        "showcase": {
            "chapterBadge": "CHAPTER 06 · FEATURE 4 STEP-BY-STEP",
            "headline": "@mira Interactive Motion Studio & V-Drill Web Synth",
            "accent": "#A855F7",
            "bgStyle": "violet",
            "steps": [
                {
                    "badge": "STEP 01 · PROMPT @MIRA DIRECTOR",
                    "title": "Type Any Launch Brief into @mira Composer",
                    "image": "photos/look-5-greyblue.jpg",
                    "metric": "@MIRA AUTO-DIRECT",
                    "whatItIs": "Interactive @mira prompt bar at /ocelli with 6 one-click Auto-Direct choreography chips.",
                    "whyItHelps": "Instantly re-directs chapter BPM, palette tokens, and headline copy live in the browser.",
                    "cursorTarget": [560, 530],
                },
                {
                    "badge": "STEP 02 · 7-CHAPTER V-DRILL STAGE",
                    "title": "Scrub 60fps Canvas & 1080p MP4 with Dan Tranh + 808",
                    "image": "photos/look-5-greyblue.jpg",
                    "metric": "DAN TRANH + 808",
                    "whatItIs": "Dual-mode stage switching seamlessly between live 60fps Canvas2D and mastered 1080p MP4 film.",
                    "whyItHelps": "Preview Vietnamese pentatonic Dan Tranh zither + sliding 808 V-Drill synthesis on any chapter.",
                    "cursorTarget": [740, 360],
                },
                {
                    "badge": "STEP 03 · EMBEDDED IN SLACK SIDEBAR",
                    "title": "Launch Motion Studio Inside Workspace Sidebar",
                    "image": "photos/garment-cobalt-overshirt.jpg",
                    "metric": "/OCELLI + SIDEBAR",
                    "whatItIs": "Integrated directly into the Agentes NEAR left sidebar and NearControlModal film tab.",
                    "whyItHelps": "Product and engineering teams review, iterate, and ship launch videos inside one workspace.",
                    "cursorTarget": [420, 450],
                },
            ],
        },
    },
    # Ch 7 (3:44-4:00, 6720..7200f): Quickstart & ONE Workspace Lockup Finale
    {
        "id": "v_ch7_quickstart",
        "chapter": 7,
        "chapter_title": "Ch 7 · Quickstart & ONE Workspace Finale",
        "kind": "showcase",
        "start_frame": 6720,
        "duration_frames": 180,
        "showcase": {
            "chapterBadge": "CHAPTER 07 · 60-SECOND QUICKSTART",
            "headline": "Clone, Verify 8/8 NEAR Checks & Ship Across 13 Tracks",
            "accent": "#00EC97",
            "bgStyle": "emerald",
            "steps": [
                {
                    "badge": "STEP 01 · GIT CLONE MIT REPO",
                    "title": "git clone github.com/harrymove-ctrl/agentes-near",
                    "image": "photos/garment-cobalt-overshirt.jpg",
                    "metric": "MIT OPEN SOURCE",
                    "whatItIs": "Clone the public MIT repository and install workspace dependencies with bun install.",
                    "whyItHelps": "Zero proprietary lock-in; self-host your entire team + NEAR AI swarm anywhere.",
                    "cursorTarget": [520, 420],
                },
                {
                    "badge": "STEP 02 · BUN RUN CHECK:NEAR",
                    "title": "Pass All 8/8 Deterministic NEAR & TDX Checks",
                    "image": "photos/look-2-cream.jpg",
                    "metric": "NEAR CHECK 8/8 PASS",
                    "whatItIs": "Run 'bun run check:near' to verify 1Click quotes, OutLayer TDX caps, and ML-DSA-65 signatures.",
                    "whyItHelps": "Confirms every cryptographic invariant and API route in under 5 seconds.",
                    "cursorTarget": [700, 420],
                },
                {
                    "badge": "STEP 03 · 13/13 TRACKS LIVE",
                    "title": "bun run dev · agentes-near-production.up.railway.app",
                    "image": "photos/look-5-greyblue.jpg",
                    "metric": "13/13 NEAR TRACKS",
                    "whatItIs": "Start locally with 'bun run dev' or open the live Railway production deployment at /ocelli.",
                    "whyItHelps": "Ready for judges and teams today across all 13 NEAR hackathon prize tracks.",
                    "cursorTarget": [880, 420],
                },
            ],
        },
    },
    {
        "id": "v_ch7_act7",
        "chapter": 7,
        "chapter_title": "Ch 7 · Quickstart & ONE Workspace Finale",
        "kind": "act",
        "act": 7,
        "start_frame": 6900,
        "duration_frames": 300,
    },
]


DEMO_UTTERANCES = [
    # Ch 1 (0..1020f = 0..34s)
    {
        "id": "u01_mira_intro",
        "chapter": 1,
        "speaker": "mira_vi",
        "start_frame": 0,
        "duration_frames": 120,
        "voice_offset_sec": 0.18,
        "step_badge": "V-DRILL TAG · @MIRA",
        "text": "Agentes NEAR trên beat Việt Drill. Đội ngũ của bạn và AI Agent trong cùng một Slack.",
        "caption": "Agentes NEAR on Viet-Drill: your team and AI agents inside one Slack.",
    },
    {
        "id": "u02_alex_hook",
        "chapter": 1,
        "speaker": "alex",
        "start_frame": 120,
        "duration_frames": 210,
        "voice_offset_sec": 0.18,
        "step_badge": "CH 01 · THE HOOK",
        "text": "Welcome to Agentes NEAR. Every AI agent team hits three fatal walls the moment they try to execute real on-chain work.",
        "caption": "Every AI agent team hits 3 fatal walls when executing real on-chain work.",
    },
    {
        "id": "u03_ada_problems",
        "chapter": 1,
        "speaker": "ada",
        "start_frame": 330,
        "duration_frames": 360,
        "voice_offset_sec": 0.22,
        "step_badge": "STEP 01-03 · 3 FATAL WALLS",
        "text": "First, fragmented chat and wallet tabs. Second, raw private keys exposed to rogue drains. And third, zero verifiable receipts when agents trade or rent GPUs.",
        "caption": "1) Fragmented tabs, 2) Raw key drain risk, 3) Zero verifiable audit receipts.",
    },
    {
        "id": "u04_kronos_99k",
        "chapter": 1,
        "speaker": "kronos",
        "start_frame": 690,
        "duration_frames": 330,
        "voice_offset_sec": 0.22,
        "step_badge": "99K INTENTS · 22S SWAP",
        "text": "Watch what happens when we give Ada a live NEAR wallet right inside Slack: ninety-nine thousand intents routed, settling twelve USDC to wNEAR in twenty-two seconds flat.",
        "caption": "99,412 intents routed in Slack: 12 USDC -> 3.40 wNEAR settled in 22s.",
    },
    # Ch 2 (1020..2100f = 34..70s)
    {
        "id": "u05_alex_solution",
        "chapter": 2,
        "speaker": "alex",
        "start_frame": 1020,
        "duration_frames": 450,
        "voice_offset_sec": 0.25,
        "step_badge": "CH 02 · ONE SLACK SOLUTION",
        "text": "Meet Agentes NEAR: one self-hosted Slack where your engineering team and six specialized NEAR AI agents collaborate across five live protocol surfaces.",
        "caption": "One self-hosted Slack uniting your team and 6 NEAR AI agents across 5 surfaces.",
    },
    {
        "id": "u06_ada_tour_1",
        "chapter": 2,
        "speaker": "ada",
        "start_frame": 1470,
        "duration_frames": 315,
        "voice_offset_sec": 0.22,
        "step_badge": "STEP 01-02 · CHANNELS & STREAM",
        "text": "Step one: sign in with one click and pick a channel on the left rail. Step two: tag Ada, Kronos, Theo, Lia, Mira, or Zen in the center stream.",
        "caption": "Step 1: 1-click channel sign-in. Step 2: Tag @ada, @kronos, @theo, @lia, @mira, @zen.",
    },
    {
        "id": "u07_alex_tour_2",
        "chapter": 2,
        "speaker": "alex",
        "start_frame": 1785,
        "duration_frames": 315,
        "voice_offset_sec": 0.20,
        "step_badge": "STEP 03 · 3-COL TELEMETRY",
        "text": "Step three: inspect live NEP-four-thirteen signatures, solver quotes, and block two-seven-seven-four-nine-seven-seven-hundred in the right Ocelli glass rail.",
        "caption": "Step 3: Inspect NEP-413 signatures and Block #277,497,700 in the right glass rail.",
    },
    # Ch 3 (2100..3240f = 70..108s)
    {
        "id": "u08_ada_cutline",
        "chapter": 3,
        "speaker": "ada",
        "start_frame": 2100,
        "duration_frames": 360,
        "voice_offset_sec": 0.22,
        "step_badge": "CH 03 · 1CLICK ENGINE",
        "text": "Feature one: NEAR Intents One-Click cross-chain solver auctions. Watch our node graph wire channel prompts directly into competing solver quotes.",
        "caption": "Feature 1: NEAR Intents 1Click solver auctions wired directly from Slack.",
    },
    {
        "id": "u09_ada_1click_steps",
        "chapter": 3,
        "speaker": "ada",
        "start_frame": 2460,
        "duration_frames": 390,
        "voice_offset_sec": 0.22,
        "step_badge": "STEP 01-02 · +16 BPS AUCTION",
        "text": "In step one, prompt Ada to swap twelve-fifty USDC into wNEAR. In step two, One-Click Chaindefuser beats Wintermute by sixteen basis points, quoting three-fifty-eight point one-three wNEAR.",
        "caption": "Step 1: Prompt 1,250 USDC swap. Step 2: 1Click beats Wintermute by +16 bps (358.1357 wNEAR).",
    },
    {
        "id": "u10_kronos_1click_settle",
        "chapter": 3,
        "speaker": "kronos",
        "start_frame": 2850,
        "duration_frames": 390,
        "voice_offset_sec": 0.22,
        "step_badge": "STEP 03 · 22S NEP-297 LOG",
        "text": "In step three, atomic settlement finishes in twenty-two seconds at block two-seven-seven-four-nine-seven-seven-hundred with signed NEP-two-nine-seven event logs.",
        "caption": "Step 3: 22s atomic settlement at Block #277,497,700 with NEP-297 EVENT_JSON.",
    },
    # Ch 4 (3240..4440f = 108..148s)
    {
        "id": "u11_mira_tdx_vi",
        "chapter": 4,
        "speaker": "mira_vi",
        "start_frame": 3240,
        "duration_frames": 150,
        "voice_offset_sec": 0.15,
        "step_badge": "V-DRILL TAG · OUTLAYER TDX",
        "text": "OutLayer Intel TDX: khóa cứng trần chi tiêu hai mươi lăm đô!",
        "caption": "OutLayer Intel TDX: hardware-locked $25.00 per-transaction spend cap!",
    },
    {
        "id": "u12_kronos_zine",
        "chapter": 4,
        "speaker": "kronos",
        "start_frame": 3390,
        "duration_frames": 240,
        "voice_offset_sec": 0.18,
        "step_badge": "CH 04 · HARDWARE ENCLAVE",
        "text": "Feature two: OutLayer Intel TDX hardware spend guard. Zero raw private keys ever touch application memory.",
        "caption": "Feature 2: OutLayer Intel TDX hardware enclave guard with zero raw key exposure.",
    },
    {
        "id": "u13_kronos_tdx_steps",
        "chapter": 4,
        "speaker": "kronos",
        "start_frame": 3630,
        "duration_frames": 390,
        "voice_offset_sec": 0.22,
        "step_badge": "STEP 01-02 · $25 CAP & 4MS PASS",
        "text": "Step one: lock your per-transaction policy at twenty-five dollars inside our wasm-thirty-two Intel TDX enclave. Step two: a twelve-dollar safe intent signs via NEP-four-thirteen in four milliseconds.",
        "caption": "Step 1: Lock $25.00/tx wasm32-wasip2 cap. Step 2: $12.00 safe intent signed in 4ms.",
    },
    {
        "id": "u14_alex_tdx_block",
        "chapter": 4,
        "speaker": "alex",
        "start_frame": 4020,
        "duration_frames": 420,
        "voice_offset_sec": 0.22,
        "step_badge": "STEP 03 · $45 DRAIN BLOCKED",
        "text": "Step three: when a rogue prompt attempts a forty-five dollar drain, OutLayer deterministically blocks it in hardware and seals the log with Kyvera ML-DSA-sixty-five post-quantum proof.",
        "caption": "Step 3: $45.00 rogue drain blocked in hardware + Kyvera ML-DSA-65 PQ signature.",
    },
    # Ch 5 (4440..5820f = 148..194s)
    {
        "id": "u15_ada_graph",
        "chapter": 5,
        "speaker": "ada",
        "start_frame": 4440,
        "duration_frames": 390,
        "voice_offset_sec": 0.22,
        "step_badge": "CH 05 · @ADA 5-TOOL GRAPH",
        "text": "Feature three: our Ada Tool Hub connects five self-sustaining economic primitives so your agent swarm funds its own compute.",
        "caption": "Feature 3: @ada 5-node tool graph connecting self-funding NEAR primitives.",
    },
    {
        "id": "u16_alex_endowment_terrace",
        "chapter": 5,
        "speaker": "alex",
        "start_frame": 4830,
        "duration_frames": 495,
        "voice_offset_sec": 0.24,
        "step_badge": "STEP 01-02 · X402 & TERRACE",
        "text": "Step one: our two-hundred-fifty-thousand-dollar Corpus Endowment harvests yield to stream Corpus x402 H100 TEE compute at one-eighty-four per hour. Step two: Terrace and Hunch conviction markets price YES at seventy-six cents with thirty-eight thousand AGENTES burned on misses.",
        "caption": "Step 1: $250K Endowment -> $1.84/hr H100. Step 2: Terrace YES 76c + 38,420 $AGENTES burned.",
    },
    {
        "id": "u17_kronos_kanmani_tab",
        "chapter": 5,
        "speaker": "kronos",
        "start_frame": 5325,
        "duration_frames": 495,
        "voice_offset_sec": 0.24,
        "step_badge": "STEP 03 · KANMANI + TAB BNPL",
        "text": "And step three: Kanmani milestone slashing escrow, Tab zero-percent compute credit, and NEP-one-seventy-one achievement badges keep every agent accountable.",
        "caption": "Step 3: Kanmani milestone slashing escrow + Tab 0% BNPL credit + NEP-171 badges.",
    },
    # Ch 6 (5820..6720f = 194..224s)
    {
        "id": "u18_mira_studio_vi",
        "chapter": 6,
        "speaker": "mira_vi",
        "start_frame": 5820,
        "duration_frames": 210,
        "voice_offset_sec": 0.18,
        "step_badge": "V-DRILL TAG · @MIRA STUDIO",
        "text": "Studio chuyển động Mira: tạo phim sản phẩm trực tiếp trên nền nhạc đàn tranh Việt Drill!",
        "caption": "@mira Motion Studio: direct product films live on Vietnamese Dan Tranh V-Drill!",
    },
    {
        "id": "u19_ada_studio_steps",
        "chapter": 6,
        "speaker": "ada",
        "start_frame": 6030,
        "duration_frames": 690,
        "voice_offset_sec": 0.24,
        "step_badge": "STEP 01-03 · @MIRA MOTION STUDIO",
        "text": "Feature four: inside our built-in Motion Studio at slash ocelli, prompt Mira in step one, scrub all seven chapters with live Dan Tranh and 808 V-Drill synthesis in step two, and launch it right from your Slack sidebar in step three.",
        "caption": "Step 1: Prompt @mira. Step 2: Scrub 7 chapters + V-Drill synth. Step 3: Open in Slack sidebar.",
    },
    # Ch 7 (6720..7200f = 224..240s)
    {
        "id": "u20_alex_quickstart",
        "chapter": 7,
        "speaker": "alex",
        "start_frame": 6720,
        "duration_frames": 180,
        "voice_offset_sec": 0.16,
        "step_badge": "STEP 01-03 · QUICKSTART 8/8",
        "text": "Clone our MIT repo, pass all eight-of-eight NEAR verification checks, and launch all thirteen tracks in seconds.",
        "caption": "git clone -> bun run check:near (8/8 PASS) -> bun run dev (13/13 NEAR tracks).",
    },
    {
        "id": "u21_alex_finale",
        "chapter": 7,
        "speaker": "alex",
        "start_frame": 6900,
        "duration_frames": 300,
        "voice_offset_sec": 0.22,
        "step_badge": "ONE WORKSPACE · AGENTES NEAR",
        "text": "Agentes NEAR. Your team and autonomous NEAR AI agents, together in one workspace. Try it live at slash ocelli today.",
        "caption": "Agentes NEAR · Live at /ocelli · MIT License · github.com/harrymove-ctrl/agentes-near",
    },
]


# ---------------------------------------------------------------------------
# 60.0s (1,800 frames @ 30 FPS) X Launch Teaser Visuals & Utterances
# ---------------------------------------------------------------------------
TEASER_VISUALS = [
    {"id": "tv_1", "chapter": 1, "chapter_title": "Hook & Viet-Drill", "kind": "act", "act": 1, "start_frame": 0, "duration_frames": 240},
    {"id": "tv_2", "chapter": 2, "chapter_title": "99K Intents in Slack", "kind": "act", "act": 2, "start_frame": 240, "duration_frames": 240},
    {
        "id": "tv_3",
        "chapter": 3,
        "chapter_title": "1Click + OutLayer TDX Step-by-Step",
        "kind": "showcase",
        "start_frame": 480,
        "duration_frames": 300,
        "showcase": next(v["showcase"] for v in DEMO_VISUALS if v["id"] == "v_ch4_outlayer"),
    },
    {"id": "tv_4", "chapter": 4, "chapter_title": "Ocelli 3-Col Studio", "kind": "act", "act": 4, "start_frame": 780, "duration_frames": 270},
    {"id": "tv_5", "chapter": 5, "chapter_title": "@ada 5-Node Tool Graph", "kind": "act", "act": 5, "start_frame": 1050, "duration_frames": 270},
    {"id": "tv_6", "chapter": 6, "chapter_title": "OutLayer TDX Zine Drop", "kind": "act", "act": 6, "start_frame": 1320, "duration_frames": 240},
    {"id": "tv_7", "chapter": 7, "chapter_title": "ONE Workspace Finale", "kind": "act", "act": 7, "start_frame": 1560, "duration_frames": 240},
]

TEASER_UTTERANCES = [
    {
        "id": "tu01_mira",
        "chapter": 1,
        "speaker": "mira_vi",
        "start_frame": 0,
        "duration_frames": 90,
        "voice_offset_sec": 0.14,
        "step_badge": "V-DRILL TAG · @MIRA",
        "text": "Agentes NEAR trên beat Việt Drill!",
        "caption": "Agentes NEAR on Viet-Drill: Slack for Teams + NEAR AI Agents!",
    },
    {
        "id": "tu02_alex",
        "chapter": 1,
        "speaker": "alex",
        "start_frame": 90,
        "duration_frames": 150,
        "voice_offset_sec": 0.14,
        "step_badge": "ONE SLACK + 6 AGENTS",
        "text": "Your engineering team and six autonomous NEAR AI agents, together in one self-hosted Slack.",
        "caption": "Your team and 6 autonomous NEAR AI agents in one self-hosted Slack.",
    },
    {
        "id": "tu03_ada",
        "chapter": 2,
        "speaker": "ada",
        "start_frame": 240,
        "duration_frames": 240,
        "voice_offset_sec": 0.18,
        "step_badge": "99K INTENTS · +16 BPS",
        "text": "Route ninety-nine thousand intents in Slack: One-Click beats Wintermute by sixteen basis points and settles in twenty-two seconds.",
        "caption": "1Click beats Wintermute by +16 bps (358.1357 wNEAR) and settles in 22s.",
    },
    {
        "id": "tu04_kronos",
        "chapter": 3,
        "speaker": "kronos",
        "start_frame": 480,
        "duration_frames": 300,
        "voice_offset_sec": 0.18,
        "step_badge": "OUTLAYER TDX · $25 CAP",
        "text": "OutLayer Intel TDX locks a twenty-five-dollar hardware spend cap, signs twelve-dollar intents in four milliseconds, and blocks forty-five-dollar rogue drains.",
        "caption": "OutLayer TDX: $25/tx cap, $12 safe pass (4ms), $45 rogue drain blocked.",
    },
    {
        "id": "tu05_alex_studio",
        "chapter": 4,
        "speaker": "alex",
        "start_frame": 780,
        "duration_frames": 270,
        "voice_offset_sec": 0.18,
        "step_badge": "OCELLI 3-COL WORKSPACE",
        "text": "Explore our three-column Ocelli workspace, six agent studio emblems, and five live protocol surfaces.",
        "caption": "3-column Ocelli workspace + 6 agent emblems + 5 live protocol surfaces.",
    },
    {
        "id": "tu06_ada_mechanics",
        "chapter": 5,
        "speaker": "ada",
        "start_frame": 1050,
        "duration_frames": 270,
        "voice_offset_sec": 0.18,
        "step_badge": "X402 GPU + TERRACE BETS",
        "text": "Stream Corpus x402 H100 GPUs at one-eighty-four an hour and trade Terrace conviction markets with thirty-eight thousand AGENTES burned.",
        "caption": "Corpus x402 H100 ($1.84/hr) + Terrace markets (38,420 $AGENTES burned).",
    },
    {
        "id": "tu07_mira_pq",
        "chapter": 6,
        "speaker": "mira_vi",
        "start_frame": 1320,
        "duration_frames": 240,
        "voice_offset_sec": 0.18,
        "step_badge": "KYVERA ML-DSA-65 PQ",
        "text": "Bảo mật phần cứng Intel TDX và chữ ký hậu lượng tử ML-DSA-65!",
        "caption": "Intel TDX hardware enclave + FIPS 204 ML-DSA-65 post-quantum signatures!",
    },
    {
        "id": "tu08_alex_cta",
        "chapter": 7,
        "speaker": "alex",
        "start_frame": 1560,
        "duration_frames": 240,
        "voice_offset_sec": 0.18,
        "step_badge": "13 NEAR TRACKS · /OCELLI",
        "text": "Agentes NEAR. Thirteen NEAR tracks live at slash ocelli and open source on GitHub today.",
        "caption": "Agentes NEAR · 13 NEAR Tracks · Live at /ocelli · github.com/harrymove-ctrl/agentes-near",
    },
]


def _words_from_elevenlabs_alignment(alignment: dict, text: str) -> list[dict]:
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    if not chars or len(chars) != len(starts) or len(chars) != len(ends):
        return []
    words: list[dict] = []
    cur_chars: list[str] = []
    w_start = 0.0
    w_end = 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if cur_chars:
                words.append({"word": "".join(cur_chars), "start": round(float(w_start), 3), "end": round(float(w_end), 3)})
                cur_chars = []
        else:
            if not cur_chars:
                w_start = float(s)
            cur_chars.append(ch)
            w_end = float(e)
    if cur_chars:
        words.append({"word": "".join(cur_chars), "start": round(float(w_start), 3), "end": round(float(w_end), 3)})
    return words


def synth_clip_elevenlabs(text: str, out_mp3: Path, api_key: str, voice_id: str) -> tuple[bool, list[dict]]:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    payload = json.dumps(
        {
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {
                "stability": 0.46,
                "similarity_boost": 0.82,
                "style": 0.18,
                "use_speaker_boost": True,
            },
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        audio_b64 = body.get("audio_base64", "")
        if not audio_b64:
            return False, []
        out_mp3.write_bytes(base64.b64decode(audio_b64))
        words = _words_from_elevenlabs_alignment(body.get("alignment") or {}, text)
        return out_mp3.exists() and out_mp3.stat().st_size > 500, words
    except Exception as exc:
        print(f"[voice] ElevenLabs notice ({exc}); using studio neural voice.")
        return False, []


async def _edge_tts_synth_async(
    text: str,
    voice_name: str,
    rate: str,
    out_mp3: Path,
    boundary: str | None = "WordBoundary",
) -> list[dict]:
    import edge_tts  # type: ignore

    kwargs: dict = {"rate": rate}
    if boundary:
        kwargs["boundary"] = boundary
    communicate = edge_tts.Communicate(text, voice_name, **kwargs)
    words: list[dict] = []
    audio_chunks = bytearray()
    async for chunk in communicate.stream():
        ctype = chunk.get("type")
        if ctype == "audio":
            audio_chunks.extend(chunk["data"])
        elif ctype == "WordBoundary":
            start_s = float(chunk["offset"]) / 10_000_000.0
            dur_s = float(chunk["duration"]) / 10_000_000.0
            words.append(
                {
                    "word": str(chunk["text"]),
                    "start": round(start_s, 3),
                    "end": round(start_s + max(0.04, dur_s), 3),
                }
            )
    out_mp3.write_bytes(bytes(audio_chunks))
    return words


def synth_clip_edge_neural(text: str, out_wav: Path, tmp_dir: Path, speaker_cfg: dict) -> tuple[bool, list[dict]]:
    try:
        import edge_tts  # type: ignore # noqa: F401
    except ImportError:
        return False, []

    mp3_path = tmp_dir / f"{out_wav.stem}_edge.mp3"
    attempts = [
        ("WordBoundary", speaker_cfg["edge_rate"]),
        ("SentenceBoundary", speaker_cfg["edge_rate"]),
        (None, "+0%"),
    ]
    last_exc: Exception | None = None
    for attempt_idx, (boundary_mode, rate_val) in enumerate(attempts):
        try:
            if attempt_idx > 0:
                time.sleep(0.35 * attempt_idx)
            if mp3_path.exists():
                mp3_path.unlink()
            words = asyncio.run(
                _edge_tts_synth_async(
                    text=text,
                    voice_name=speaker_cfg["edge_voice"],
                    rate=rate_val,
                    out_mp3=mp3_path,
                    boundary=boundary_mode,
                )
            )
            if not mp3_path.exists() or mp3_path.stat().st_size < 400:
                continue
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    str(mp3_path),
                    "-af",
                    "highpass=f=80,equalizer=f=3200:width_type=q:w=1.2:g=1.5,acompressor=threshold=-19dB:ratio=2.2:attack=8:release=110",
                    "-ar",
                    str(SAMPLE_RATE),
                    "-ac",
                    "2",
                    str(out_wav),
                ],
                check=True,
            )
            if not words:
                words = _proportional_words(text, probe_duration(out_wav))
            time.sleep(0.15)
            return True, words
        except Exception as exc:
            last_exc = exc
            continue
    print(f"[voice] edge-tts notice ({last_exc}); falling back to macOS say.")
    return False, []


def _proportional_words(text: str, dur: float) -> list[dict]:
    tokens = [t for t in text.split() if t]
    if not tokens:
        return []
    weights = [max(1, len(t)) for t in tokens]
    total_w = sum(weights)
    cursor = 0.0
    out: list[dict] = []
    usable = max(0.3, dur - 0.08)
    for tok, w in zip(tokens, weights):
        span = usable * (w / total_w)
        out.append({"word": tok, "start": round(cursor, 3), "end": round(cursor + span * 0.92, 3)})
        cursor += span
    return out


def synth_clip_macos_say(text: str, out_wav: Path, tmp_dir: Path, speaker_cfg: dict) -> list[dict]:
    aiff_path = tmp_dir / f"{out_wav.stem}.aiff"
    subprocess.run(
        ["say", "-v", speaker_cfg["say_voice"], "-r", "184", "-o", str(aiff_path), text],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(aiff_path),
            "-af",
            "highpass=f=85,lowpass=f=11500,acompressor=threshold=-18dB:ratio=2.3:attack=8:release=110",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "2",
            str(out_wav),
        ],
        check=True,
    )
    dur = probe_duration(out_wav)
    return _proportional_words(text, dur)


def probe_duration(path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    ).strip()
    return float(out or "1.0")


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def generate_vdrill_score_and_foley(
    out_wav: Path,
    duration_sec: float,
    speech_windows: list[tuple[float, float]],
    whoosh_times: list[float],
    pop_times: list[float],
    laser_times: list[float],
    chime_times: list[float],
) -> None:
    """
    Synthesizes a 140 BPM (half-time 70 BPM feel) Vietnamese Drill (V-Drill) Score + Foley Bed:
    1. Vietnamese Minor Pentatonic Dan Tranh (16-string plucked zither harmonics D-F-G-A-C + pitch vibrato)
    2. Airy Bamboo Flute (Sao Truc) pentatonic phrases on bar transitions
    3. Phase-continuous sliding 808 sub-bass portamento glides (root -> fifth -> octave)
    4. UK/Viet-Drill syncopated 3-3-2 tresillo hi-hat counter-rhythm + triplet ratchets + rimshot/claps
    5. Smooth sidechain speech ducking (`duck_ctrl = 0.28` during speech, `1.0` between utterances)
    """
    total_samples = int(duration_sec * SAMPLE_RATE)
    bpm = 118.0
    beat_sec = 60.0 / bpm
    sixteenth_sec = beat_sec / 4.0
    triplet_sec = beat_sec / 3.0
    bar_sec = beat_sec * 4.0

    # D Minor Pentatonic (Ngu Cung Oan / Hoi: D - F - G - A - C)
    # 4-bar progression: Dm(add9) -> Bbmaj7 -> Gm9 -> A7sus4
    progression = [
        {"bass_midi": 38.0, "pad": [50, 57, 60, 65], "dan_tranh": [62, 65, 67, 69, 72, 74, 69, 65]},  # Dm
        {"bass_midi": 34.0, "pad": [46, 53, 57, 62], "dan_tranh": [65, 69, 72, 74, 72, 69, 67, 65]},  # Bb
        {"bass_midi": 43.0, "pad": [55, 58, 62, 65], "dan_tranh": [67, 69, 72, 74, 77, 74, 72, 69]},  # Gm
        {"bass_midi": 33.0, "pad": [45, 52, 57, 60], "dan_tranh": [69, 72, 69, 67, 65, 62, 65, 69]},  # Asus4
    ]

    rng = random.Random(20261116)
    noise_table = [rng.uniform(-1.0, 1.0) for _ in range(16384)]

    whoosh_idx = [int(t * SAMPLE_RATE) for t in whoosh_times]
    pop_idx = [int(t * SAMPLE_RATE) for t in pop_times]
    laser_idx = [int(t * SAMPLE_RATE) for t in laser_times]
    chime_idx = [int(t * SAMPLE_RATE) for t in chime_times]

    # Precompute smooth sidechain ducking gain at 100 Hz control rate
    ctrl_rate = 100
    ctrl_len = int(duration_sec * ctrl_rate) + 4
    duck_ctrl = [1.0] * ctrl_len
    for s_start, s_end in speech_windows:
        i0 = max(0, int((s_start - 0.12) * ctrl_rate))
        i1 = min(ctrl_len - 1, int((s_end + 0.18) * ctrl_rate))
        for k in range(i0, i1 + 1):
            duck_ctrl[k] = 0.28
    # 3-pass moving average for silky sidechain release
    for _ in range(3):
        smoothed = list(duck_ctrl)
        for k in range(3, ctrl_len - 3):
            smoothed[k] = sum(duck_ctrl[k - 3 : k + 4]) / 7.0
        duck_ctrl = smoothed

    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)

        buf = bytearray()
        two_pi = 2.0 * math.pi
        bass_phase = 0.0

        for i in range(total_samples):
            t = i / SAMPLE_RATE
            fade_in = min(1.0, t / 0.6)
            fade_out = min(1.0, (duration_sec - t) / 1.6)
            master_env = max(0.0, min(fade_in, fade_out))

            c_idx = min(ctrl_len - 1, int(t * ctrl_rate))
            duck = duck_ctrl[c_idx]

            bar_num = int(t / bar_sec)
            chord = progression[bar_num % 4]

            beat_num = int(t / beat_sec)
            beat_dt = t - beat_num * beat_sec
            sixteenth_num = int(t / sixteenth_sec)
            sixteenth_dt = t - sixteenth_num * sixteenth_sec
            triplet_num = int(t / triplet_sec)
            triplet_dt = t - triplet_num * triplet_sec
            step16 = sixteenth_num % 16

            # 1. Syncopated V-Drill Kick (steps 0, 6, 10, 12)
            kick = 0.0
            if step16 in (0, 6, 10, 12) and sixteenth_dt < 0.15:
                pitch = 146.0 * math.exp(-sixteenth_dt * 36.0) + 46.0
                kick = 0.26 * math.exp(-sixteenth_dt * 18.0) * math.sin(two_pi * pitch * sixteenth_dt)

            # 2. Sliding 808 Sub-Bass Portamento Glide (root -> +7 fifth -> +12 octave)
            root_midi = chord["bass_midi"]
            glide_semitones = 0.0
            if step16 in (6, 7):
                u_g = min(1.0, sixteenth_dt / 0.11)
                glide_semitones = 7.0 * (1.0 - math.exp(-u_g * 4.5))
            elif step16 in (14, 15):
                u_g = min(1.0, sixteenth_dt / 0.11)
                glide_semitones = 12.0 * (1.0 - math.exp(-u_g * 5.0))
            bass_hz = midi_to_hz(root_midi + glide_semitones)
            bass_phase = (bass_phase + two_pi * bass_hz / SAMPLE_RATE) % two_pi
            bass_pump = 0.52 + 0.48 * (1.0 - math.exp(-beat_dt * 11.0))
            bass = 0.21 * bass_pump * math.tanh(1.65 * math.sin(bass_phase))

            # 3. UK/Viet-Drill 3-3-2 Tresillo Hi-Hat Counter-Rhythm & Triplet Ratchets
            hat = 0.0
            if (beat_num % 4 == 3) and triplet_dt < 0.040:
                n = noise_table[(i * 5) & 16383]
                hat = 0.072 * math.exp(-triplet_dt * 80.0) * n
            elif step16 in (0, 3, 6, 8, 11, 14) and sixteenth_dt < 0.046:
                n = noise_table[(i * 3) & 16383]
                hat = 0.058 * math.exp(-sixteenth_dt * 72.0) * n

            # 4. Snappy Drill Rimshot / Clap on Beat 3 (step 8) & Syncopated Ghost Snare (steps 4, 15)
            snare = 0.0
            if step16 in (4, 8, 15) and sixteenth_dt < 0.12:
                n = noise_table[(i * 7) & 16383]
                rim = math.sin(two_pi * 320.0 * sixteenth_dt) * math.exp(-sixteenth_dt * 42.0)
                amp_s = 0.14 if step16 == 8 else 0.08
                snare = amp_s * (0.65 * n * math.exp(-sixteenth_dt * 28.0) + 0.55 * rim)

            # 5. Vietnamese Dan Tranh (16-String Plucked Zither Harmonics + Pitch Vibrato)
            dan_l = 0.0
            dan_r = 0.0
            if step16 in (0, 2, 3, 6, 8, 10, 11, 14) and sixteenth_dt < 0.24:
                note_midi = chord["dan_tranh"][(sixteenth_num // 2) % 8]
                # Subtle "nhan nha" pitch bend vibrato after initial pluck
                vib_semi = 0.14 * math.sin(two_pi * 6.2 * sixteenth_dt) * min(1.0, sixteenth_dt / 0.06)
                dt_hz = midi_to_hz(note_midi + vib_semi)
                # Bright metallic-silk zither harmonic series (f + 2f + 3f + 4f)
                env_1 = math.exp(-sixteenth_dt * 14.0)
                env_2 = math.exp(-sixteenth_dt * 22.0)
                env_3 = math.exp(-sixteenth_dt * 34.0)
                pluck_sig = 0.105 * (
                    env_1 * math.sin(two_pi * dt_hz * sixteenth_dt)
                    + 0.48 * env_2 * math.sin(two_pi * dt_hz * 2.0 * sixteenth_dt)
                    + 0.26 * env_3 * math.sin(two_pi * dt_hz * 3.0 * sixteenth_dt)
                    + 0.12 * env_3 * math.sin(two_pi * dt_hz * 4.0 * sixteenth_dt)
                )
                pan_d = 0.5 + 0.38 * math.sin(sixteenth_num * 0.95)
                dan_l = pluck_sig * pan_d
                dan_r = pluck_sig * (1.0 - pan_d)

            # 6. Airy Sao Truc (Vietnamese Bamboo Flute) + Warm Silk Pad
            pad_l = 0.0
            pad_r = 0.0
            flute_vib = 1.0 + 0.0025 * math.sin(two_pi * 5.4 * t)
            flute_hz = midi_to_hz(chord["dan_tranh"][0] + 12) * flute_vib
            flute_gate = 0.5 + 0.5 * math.sin(two_pi * (t / (bar_sec * 2.0)))
            flute_sig = 0.024 * flute_gate * (
                math.sin(two_pi * flute_hz * t) + 0.25 * math.sin(two_pi * flute_hz * 2.0 * t)
            )
            pad_l += flute_sig * 0.65
            pad_r += flute_sig * 0.35

            for p_i, m in enumerate(chord["pad"]):
                hz = midi_to_hz(m)
                s1 = math.sin(two_pi * hz * 0.999 * t)
                s2 = math.sin(two_pi * hz * 1.001 * t + 0.4)
                amp = 0.036 / (1.0 + 0.2 * p_i)
                pad_l += amp * s1
                pad_r += amp * s2

            music_l = (kick + bass + hat + snare + dan_l + pad_l) * duck * master_env
            music_r = (kick + bass + hat + snare + dan_r + pad_r) * duck * master_env

            # 7. Un-ducked Surgical Foley SFX Layer
            sfx_l = 0.0
            sfx_r = 0.0

            for ws in whoosh_idx:
                dt = (i - ws) / SAMPLE_RATE
                if -0.16 <= dt < 0.30:
                    u = (dt + 0.16) / 0.46
                    w_env = math.sin(math.pi * u) ** 1.5
                    n_val = noise_table[i & 16383]
                    sweep = math.sin(two_pi * (150.0 + 340.0 * u) * (dt + 0.18))
                    sfx_l += 0.14 * w_env * (0.45 * n_val + 0.55 * sweep) * (1.0 - 0.45 * u)
                    sfx_r += 0.14 * w_env * (0.45 * n_val + 0.55 * sweep) * (0.55 + 0.45 * u)

            for ps in pop_idx:
                dt = (i - ps) / SAMPLE_RATE
                if 0.0 <= dt < 0.07:
                    freq = 400.0 + 460.0 * (dt / 0.07)
                    p_val = 0.16 * math.exp(-dt * 44.0) * math.sin(two_pi * freq * dt)
                    sfx_l += p_val
                    sfx_r += p_val

            for ls in laser_idx:
                dt = (i - ls) / SAMPLE_RATE
                if 0.0 <= dt < 0.28:
                    freq = 680.0 - 440.0 * (dt / 0.28)
                    l_val = 0.16 * math.exp(-dt * 11.0) * math.sin(two_pi * freq * dt)
                    sfx_l += l_val * 0.9
                    sfx_r += l_val * 1.1

            for cs in chime_idx:
                dt = (i - cs) / SAMPLE_RATE
                if 0.0 <= dt < 0.50:
                    c_env = math.exp(-dt * 7.0)
                    ch_l = 0.12 * c_env * (
                        math.sin(two_pi * 587.33 * dt)
                        + 0.7 * math.sin(two_pi * 880.00 * dt)
                        + 0.5 * math.sin(two_pi * 1174.66 * dt)
                    )
                    ch_r = 0.12 * c_env * (
                        math.sin(two_pi * 587.33 * dt)
                        + 0.7 * math.sin(two_pi * 1046.50 * dt)
                        + 0.5 * math.sin(two_pi * 1318.51 * dt)
                    )
                    sfx_l += ch_l
                    sfx_r += ch_r

            out_l = max(-0.96, min(0.96, music_l + sfx_l))
            out_r = max(-0.96, min(0.96, music_r + sfx_r))
            buf.extend(struct.pack("<hh", int(out_l * 32767), int(out_r * 32767)))

        wf.writeframes(bytes(buf))


def build_cut_mix(
    utterances: list[dict],
    total_frames: int,
    out_wav: Path,
    whooshes: list[float],
    pops: list[float],
    lasers: list[float],
    chimes: list[float],
    api_key: str | None,
) -> tuple[str, list[dict]]:
    duration_sec = total_frames / FPS
    used_provider = "macos_neural_say"
    enriched_utterances: list[dict] = []

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp_dir = Path(tmp_str)
        clip_records: list[tuple[Path, int, float]] = []
        speech_windows: list[tuple[float, float]] = []

        for utt in utterances:
            speaker_key = utt["speaker"]
            speaker_cfg = VOICES[speaker_key]
            clip_wav = tmp_dir / f"{utt['id']}.wav"
            max_slot_sec = (utt["duration_frames"] / FPS) - utt["voice_offset_sec"] - 0.16
            words: list[dict] = []

            if api_key and speaker_key != "mira_vi":
                mp3_path = tmp_dir / f"{utt['id']}_el.mp3"
                ok, el_words = synth_clip_elevenlabs(
                    utt["text"], mp3_path, api_key, speaker_cfg["elevenlabs_id"]
                )
                if ok:
                    used_provider = "elevenlabs_plus_edge_vi_vdrill"
                    words = el_words
                    subprocess.run(
                        [
                            "ffmpeg",
                            "-y",
                            "-loglevel",
                            "error",
                            "-i",
                            str(mp3_path),
                            "-ar",
                            str(SAMPLE_RATE),
                            "-ac",
                            "2",
                            str(clip_wav),
                        ],
                        check=True,
                    )

            if not clip_wav.exists():
                ok_edge, edge_words = synth_clip_edge_neural(utt["text"], clip_wav, tmp_dir, speaker_cfg)
                if ok_edge:
                    if used_provider == "macos_neural_say":
                        used_provider = "studio_neural_4voice_edge_tts_vdrill"
                    words = edge_words

            if not clip_wav.exists():
                words = synth_clip_macos_say(utt["text"], clip_wav, tmp_dir, speaker_cfg)

            clip_dur = probe_duration(clip_wav)
            tempo = 1.0
            fitted_wav = clip_wav
            if clip_dur > max_slot_sec and max_slot_sec > 0.8:
                tempo = min(1.30, max(1.01, clip_dur / max_slot_sec))
                fitted_wav = tmp_dir / f"{utt['id']}_fit.wav"
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-loglevel",
                        "error",
                        "-i",
                        str(clip_wav),
                        "-af",
                        f"atempo={tempo:.3f}",
                        str(fitted_wav),
                    ],
                    check=True,
                )
                clip_dur = probe_duration(fitted_wav)

            if not words:
                words = _proportional_words(utt["text"], clip_dur)
            elif tempo > 1.001:
                words = [
                    {
                        "word": w["word"],
                        "start": round(w["start"] / tempo, 3),
                        "end": round(w["end"] / tempo, 3),
                    }
                    for w in words
                ]

            abs_voice_start = (utt["start_frame"] / FPS) + utt["voice_offset_sec"]
            speech_windows.append((abs_voice_start, abs_voice_start + clip_dur))
            start_ms = int(abs_voice_start * 1000)
            clip_records.append((fitted_wav, start_ms, clip_dur))

            enriched = dict(utt)
            enriched["speaker_label"] = speaker_cfg["label"]
            enriched["speaker_role"] = speaker_cfg["role"]
            enriched["speaker_accent"] = speaker_cfg["accent"]
            enriched["voice_duration_sec"] = round(clip_dur, 3)
            enriched["words"] = words
            enriched_utterances.append(enriched)

        bed_wav = tmp_dir / "bed.wav"
        generate_vdrill_score_and_foley(
            bed_wav,
            duration_sec=duration_sec,
            speech_windows=speech_windows,
            whoosh_times=whooshes,
            pop_times=pops,
            laser_times=lasers,
            chime_times=chimes,
        )

        inputs = ["-i", str(bed_wav)]
        filter_parts = ["[0:a]volume=0.95[bed]"]
        mix_labels = ["[bed]"]

        for idx, (wav_path, start_ms, _dur) in enumerate(clip_records, start=1):
            inputs.extend(["-i", str(wav_path)])
            lbl = f"v{idx}"
            filter_parts.append(f"[{idx}:a]adelay={start_ms}|{start_ms},volume=1.46[{lbl}]")
            mix_labels.append(f"[{lbl}]")

        amix_count = len(mix_labels)
        filter_parts.append(
            f"{''.join(mix_labels)}amix=inputs={amix_count}:normalize=0,"
            f"loudnorm=I=-14:TP=-1.5:LRA=9,apad,atrim=0:{duration_sec:.3f}[out]"
        )

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                *inputs,
                "-filter_complex",
                ";".join(filter_parts),
                "-map",
                "[out]",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                str(out_wav),
            ],
            check=True,
        )

    return used_provider, enriched_utterances


def main() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip() or None

    demo_whooshes = [0.0, 11.0, 23.0, 34.0, 49.0, 70.0, 82.0, 108.0, 121.0, 148.0, 161.0, 194.0, 224.0, 230.0]
    demo_pops = [12.0, 15.0, 18.0, 50.0, 56.0, 62.0, 83.0, 91.0, 99.0, 122.0, 130.0, 138.0, 162.0, 173.0, 184.0, 195.0, 205.0, 215.0, 225.0, 227.0, 229.0]
    demo_lasers = [18.5, 110.0, 136.0, 141.0]
    demo_chimes = [28.0, 96.0, 103.0, 129.0, 168.0, 218.0, 234.0]

    provider_demo, enriched_demo_utts = build_cut_mix(
        utterances=DEMO_UTTERANCES,
        total_frames=7200,
        out_wav=AUDIO_DIR / "demo-mix.wav",
        whooshes=demo_whooshes,
        pops=demo_pops,
        lasers=demo_lasers,
        chimes=demo_chimes,
        api_key=api_key,
    )

    teaser_whooshes = [0.0, 8.0, 16.0, 26.0, 35.0, 44.0, 52.0]
    teaser_pops = [3.0, 16.5, 19.5, 22.5, 27.0, 36.0, 45.0, 53.0]
    teaser_lasers = [21.5, 46.0]
    teaser_chimes = [12.0, 24.0, 39.0, 56.0]

    provider_teaser, enriched_teaser_utts = build_cut_mix(
        utterances=TEASER_UTTERANCES,
        total_frames=1800,
        out_wav=AUDIO_DIR / "teaser-mix.wav",
        whooshes=teaser_whooshes,
        pops=teaser_pops,
        lasers=teaser_lasers,
        chimes=teaser_chimes,
        api_key=api_key,
    )

    manifest = {
        "fps": FPS,
        "width": 1920,
        "height": 1080,
        "voice_provider": provider_demo or provider_teaser,
        "score_style": "viet_drill_dan_tranh_808_glide_118bpm",
        "demo_total_frames": 7200,
        "teaser_total_frames": 1800,
        "voices": VOICES,
        "demo_visuals": DEMO_VISUALS,
        "demo_utterances": enriched_demo_utts,
        "teaser_visuals": TEASER_VISUALS,
        "teaser_utterances": enriched_teaser_utts,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"[audio] Built Phase 5 4-voice V-Drill demo-mix.wav (240.0s @ -14 LUFS) "
        f"and teaser-mix.wav (60.0s @ -14 LUFS) via {provider_demo}"
    )


if __name__ == "__main__":
    main()
