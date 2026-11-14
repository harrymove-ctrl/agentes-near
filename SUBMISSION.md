# NEAR HACKATHON Submission Packet

Prepared for **Agentes NEAR** (`https://github.com/harrymove-ctrl/agentes-near`) in accordance with [HACKATHON.md](HACKATHON.md).

## Pre-Submission Checklist

| Gate | Requirement | Status |
| --- | --- | --- |
| Public GitHub Repo | `https://github.com/harrymove-ctrl/agentes-near` with root `LICENSE` | Live & pushed (`harrymove-ctrl`) |
| Hosted Live URL | `https://agentes-near-production.up.railway.app/ocelli` | Live on Railway (HTTP 200) |
| Demo Video | AI Video Maker (`avm` v6.0.0) 1080p 60fps MP4 (`demo-90` 2m16s / 136.0s 8-scene live step-by-step product tour in Obsidian Enclave recorded via headless Chromium + 2x Retina plates: 1-click `#near-intents-arena` entry, `@kronos` live stream, 1Click multi-solver quotes, OutLayer Intel TDX `$25` cap with `$12` pass and `$45` block, Terrace conviction markets, Corpus `x402` + Kanmani `NEP-171` credentials, `@mira` 60fps motion studio, and live `bun run check:near` `8/8` terminal proof, plus `x-teaser-30s` 44.0s 5-scene X demo cut, Kokoro Michael voice + 120 BPM V-Drill beat at -14 LUFS) | Rendered and QA verified (`v6.0.0` release assets + `/video/*.mp4`) |
| X Demo Post | Published manually by human lead with video attached | Ready to paste below |
| API Submission | `POST https://nearhackathon.com/api/applications` confirmed explicitly by human | Never auto-submitted |

## Ready-to-Paste X Demo Post Copy

Use or edit this draft when posting manually on X (`https://x.com`), attaching `agentes-near-x-teaser.mp4` (44s) or `agentes-near-demo.mp4` (2m16s):

```text
Built Agentes NEAR at NEAR HACKATHON: self-hosted Slack where human teams and autonomous AI agents share channels with hardware-enforced spending limits.

1. OutLayer Intel TDX spend guard (live slider, $12 safe intent passes with NEP-413, $45 rogue drain blocked)
2. NEAR Intents 1Click multi-solver cross-chain quotes
3. NEAR AI Cloud Confidential TEE attestation + Testnet RPC probes
4. In-chat Terrace conviction markets, Corpus x402 GPU compute endowment ($1.84/hr), ML-DSA-65 receipts, and AI Video Maker 2m16s (136s) 60fps live step-by-step product tour plus @mira interactive Canvas2D studio on /ocelli

Live demo: https://agentes-near-production.up.railway.app/ocelli
Code: https://github.com/harrymove-ctrl/agentes-near
Video: https://github.com/harrymove-ctrl/agentes-near/releases/tag/v6.0.0
```

## Official Submission API Payload Template

Do NOT send `POST https://nearhackathon.com/api/applications` until the human lead fills in personal details (`email`, `nearAddress`, `demoUrl`), generates a fresh UUID for `requestId` (`uuidgen | tr A-Z a-z`), reads the verbatim consent notice (`"I agree that the organizers may use these details to review our submission and contact us about this hackathon."`), and explicitly confirms submission.

```json
{
  "requestId": "<GENERATE_ONCE_WITH_UUIDGEN_LOWERCASE>",
  "projectName": "Agentes NEAR",
  "leadName": "Harry Phan",
  "email": "<HUMAN_EMAIL>",
  "size": "1",
  "tracks": [
    "security",
    "swarms",
    "agents",
    "privacy",
    "defi",
    "memecoins",
    "social",
    "nfts",
    "games",
    "thesis",
    "business",
    "realworld",
    "open"
  ],
  "nearAddress": "<HUMAN_MAINNET_NEAR_ACCOUNT>",
  "projectUrl": "https://github.com/harrymove-ctrl/agentes-near",
  "demoUrl": "<HUMAN_X_POST_URL>",
  "idea": "Agentes NEAR is a self-hosted Slack workspace where human teams and autonomous AI agents (@ada, @theo, @lia, @kronos) collaborate inside channels governed by OutLayer Intel TDX hardware spend guards, NEAR Intents 1Click multi-solver quotes, NEAR AI Cloud Confidential TEE attestation, and post-quantum ML-DSA-65 receipts. Teams adjust live policy caps with BenchoSloshSlider, watch $45 rogue drains get blocked deterministically while $12 safe intents settle with NEP-413 signatures, back or fade in-chat Terrace conviction markets in wNEAR and $AGENTES, fund 24/7 x402 H100 GPU compute pools, and verify Kanmani slashing escrow with dynamic NEP-171 agent credential NFTs.",
  "consent": false
}
```

## Human Confirmation Command (Run Only After Explicit Approval)

```sh
curl -sS -X POST https://nearhackathon.com/api/applications \
  -H 'Content-Type: application/json' \
  -d @submission-payload.json
```

Keep `submission-payload.json` out of git so personal email and `requestId` values are never committed.
