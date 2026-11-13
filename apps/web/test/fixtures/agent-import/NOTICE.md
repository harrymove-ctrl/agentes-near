# Agent import fixtures

The agent import tests (`apps/web/test/agent-import*.test.ts`, `auth-pages.test.tsx`) parse real files from the projects the import reads. Files copied from those projects are under their licenses, not under this repository's license. The folders listed under "Written for these tests" are ours, in the formats those projects document.

## OpenBot (CopilotKit)

From https://github.com/CopilotKit/OpenBot, MIT License, Copyright (c) 2026 CopilotKit (full text in `LICENSE-OpenBot`). Copied unchanged:

| File | Upstream path |
|---|---|
| `agents.yaml` | `examples/fintech/agents.yaml` |
| `brand.yaml` | `examples/fintech/brand.yaml` |
| `channels.yaml` | `examples/fintech/channels.yaml` |
| `knowledge.yaml` | `examples/fintech/knowledge.yaml` |
| `model.yaml` | `examples/fintech/model.yaml` |
| `skills.yaml` | `examples/fintech/skills.yaml` |
| `expense-review.yaml` | `examples/fintech/catalog/expense-review.yaml` |

## OpenMausBot

From https://github.com/milind-soni/OpenMausBot, Apache License 2.0. `LICENSE-OpenMausBot` has the license text, after the attribution from the project's NOTICE file:

```
OpenMausBot
Copyright 2026 Milind Soni and OpenMausBot contributors
```

| File | Upstream path | Changes |
|---|---|---|
| `signal-desk.md` | `shared/package-fixtures/legacy-botmrr.v1.md` | renamed |
| `sales-desk.openmaus.json` | `shared/package-fixtures/full-team.v2.json` | renamed and reformatted by Biome; same JSON content |
| `signal-desk.v1.openmaus.json` | `shared/package-fixtures/legacy-team.v1.json` | renamed and reformatted by Biome; same JSON content |
| `leaky-desk.openmaus.json` | `shared/package-fixtures/secret-in-soul.v2.json` | renamed and reformatted by Biome; same JSON content |

## OpenClaw

From https://github.com/openclaw/openclaw, MIT License, Copyright (c) 2026 OpenClaw Foundation (full text in `LICENSE-OpenClaw`). Copied unchanged:

| File | Upstream path |
|---|---|
| `openclaw-claw/CLAW.md` | `docs/reference/templates/roles/researcher/CLAW.md` |
| `openclaw-claw/workspace/AGENTS.md` | `docs/reference/templates/roles/researcher/workspace/AGENTS.md` |
| `openclaw-template-AGENTS.md` | `docs/reference/templates/AGENTS.md` |
| `openclaw-template-SOUL.md` | `docs/reference/templates/SOUL.md` |

## Hermes Agent

From https://github.com/NousResearch/hermes-agent, MIT License, Copyright (c) 2025 Nous Research (full text in `LICENSE-Hermes`). Copied unchanged:

| File | Upstream path |
|---|---|
| `hermes-SOUL.seed.md` | `SOUL.md` (the persona Hermes seeds into a new profile) |

## Logos

`LICENSE-Paperclip` (MIT License, Copyright (c) 2025 Paperclip AI) and `LICENSE-Lucide` (ISC License, from lucide-react 0.562.0, whose `paperclip` icon is the drawing) are the license texts of Paperclip's logo in `apps/web/public/brands/`. That folder's README lists every logo with its source and license.

## Written for these tests

| Folder | Format |
|---|---|
| `openmausbot-team/` | OpenMausBot's team file (`docs/headless-cli.md`) |
| `openbot-run/` | OpenBot.run's agent import archive (`openbot-agent-import` v1), from its documentation only: that project's license (PolyForm Noncommercial) keeps its files out of this repository |
| `openclaw-workspace/` | an OpenClaw workspace (`docs/concepts/agent-workspace.md`) |
| `hermes-profile/` | a Hermes Agent profile export (`website/docs/user-guide/profile-distributions.md`) |
| `paperclip-company/` | an Agent Companies package (Paperclip's `docs/companies/companies-spec.md`) |
