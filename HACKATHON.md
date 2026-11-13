# NEAR HACKATHON Reference (HACKATHON.md)

Official specification mirrored from `https://nearhackathon.com/HACKATHON.md` for AI coding agents and screening checks on `agentes-near`.

## Start Here

1. Build the project with the human lead. There is no sign-up before the hackathon: the only form is the final submission.
2. Make the repository public before development ends on `2026-11-14T23:59:00Z`.
3. The human publishes a public demo post on X stating the project was built at NEAR HACKATHON with the demo video or screenshots attached.
4. Submit once via `POST https://nearhackathon.com/api/applications` only after the human explicitly confirms the exact JSON payload.

## Key Facts

| Fact | Value |
| --- | --- |
| Event | NEAR HACKATHON |
| Website | https://nearhackathon.com |
| Hackathon starts | 2026-11-01T00:00:00Z |
| Development ends (submission deadline) | 2026-11-14T23:59:00Z |
| Judging starts | 2026-11-16T00:00:00Z |
| Results announced by | 2026-11-18T23:59:00Z |
| Submission form | https://nearhackathon.com/#apply |
| Submission API | POST https://nearhackathon.com/api/applications |
| NEAR docs | https://docs.near.org/ |
| Live specification | https://nearhackathon.com/HACKATHON.md |

## What the Human Decides (Never Auto-Submit)

1. Project name (2 to 80 characters).
2. Team lead name (2 to 80 characters).
3. Contact email (max 160 characters, at most 2 independent disclosed projects per email per Q-015).
4. Team size: one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`.
5. Tracks: all matching IDs from the 13 tracks (`defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open`).
6. Mainnet NEAR payout account (never invented by an agent).
7. Public repository URL (unique per submission).
8. Public X demo post URL (published by the human).
9. Project summary (`idea`, 20 to 2000 characters).
10. Explicit consent (`true` only after the human agrees to the contact notice verbatim).

## Rules Checklist (Q-001 through Q-017)

1. **Q-001 / Q-002 / Q-003 / Q-004 (Baseline & Window)**: Announcement window runs from 2026-10-19 to 2026-11-14. Existing open-source baselines and new NEAR features built in the window are allowed when disclosed in `README.md`.
2. **Q-005 (Libraries & Boilerplate)**: Open-source libraries, templates, and AI-assisted code are allowed when listed in `README.md`.
3. **Q-006 / Q-007 / Q-008 / Q-010 (1Click & Testnet)**: 1Click JWT is optional (0.2% default fee without JWT); `dry: true` quotes work for safe verification; Testnet RPC (`https://rpc.testnet.near.org`) is eligible across all tracks.
4. **Q-012 (Hosted Demo & Video)**: Public repository, reproducible README, X post with demo video, and hosted live URL kept up through 2026-11-18 (ideally 2026-11-25).
5. **Q-014 (License)**: MIT license at repository root (`LICENSE`) while preserving upstream `NOTICE` / AGPL-3.0 disclosures for `agentes-chat` baseline files.
6. **Q-015 (Independent Projects)**: One person may submit at most 2 independent projects if each `README.md` discloses any other project cleanly.
7. **Q-017 (Claude Code and Codex Screening)**: Automated screeners perform reproducibility checks, feature verification, and structured reporting before human judging. Provide crisp `Do X -> See Y` steps in `README.md`.

## Tracks Reference

| ID | Track | Focus |
| --- | --- | --- |
| `swarms` | AI Swarms | Coordination markets, bidding, collective purchasing, intent-based settlement |
| `agents` | Agent Economy | Agents earning, spending, negotiating, hiring, and paying for compute or APIs |
| `security` | AI Security & Defense | Spending limits, policy engines, sandboxed wallets, TEE attestation |
| `privacy` | Privacy & Private AI | Confidential computation, private finance, NEAR AI Cloud TEE |
| `social` | Social Money | Shared budgets, programmable rewards, community treasuries |
| `memecoins` | Memecoins With Mechanics | Token mechanics, burn-on-miss challenges, rule-bound treasuries |
| `defi` | Unstoppable DeFi | Cross-chain intent settlement via NEAR Intents 1Click |
| `business` | Autonomous Business | AI-native treasury, procurement, and revenue sharing |
| `nfts` | NFTs That Do Something | Dynamic NEP-171 credentials that level up with verified work |
| `games` | Games With Real Economies | Conviction loops, agent economies, zero-popup UX |
| `thesis` | Investment Thesis | Reproducible telemetry, live dashboards, onchain data |
| `realworld` | Real-World Money | Business workflows, BNPL/invoicing rails, stablecoin settlement |
| `open` | Open Innovation | Chain abstraction, post-quantum receipts, experimental systems |
