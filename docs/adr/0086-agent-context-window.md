# 0086. An agent's context window

- Status: Accepted (built: the server, the runner, the web and the phone app). Amended 2026-10-31: §4 (the phone's model on a screen of its own), Consequences (a coding plan's window); 2026-10-31 by ADR 0094: §4 ("Usar em outros agentes" under "Configuração avançada")
- Date: 2026-10-30
- Extends: ADR 0041 (an agent's account and effort on its computer), the context budget (`fitContextWindow`, ADR 0051)
- Code: `packages/providers/src/context-limits.ts`, `packages/engine/src/brain-settings.ts`, `packages/engine/src/context-budget.ts`, `packages/engine/src/brains/claude-code.ts` (`contextFields`), migration `0131_agent_context_tokens`, `apps/server/runner/brain.ts`, `apps/server/runner/brain-codex.ts`, `apps/server/runner/brain-codex-app.ts`, `packages/client/src/lib/brain-advanced.ts`, `apps/web/src/pages/agent/Work.tsx`, `apps/mobile/src/features/ai/AgentAiScreen.tsx`, `apps/mobile/src/features/ai/AgentAdvancedScreen.tsx`, `apps/mobile/app/(app)/agent-model/[id].tsx`

## Context

Most models an agent thinks with read up to a million tokens. Every turn resends the whole conversation, so a long one costs more and answers slower as it grows; people who use Claude Code or Codex on their own often cap it lower (400K is common) and asked for the same here. Until now the API brain capped what it sends at 500K (`MAX_CONTEXT_TOKENS`) and the computer brains used their model's whole window, with no way to choose.

## Decision

1. **One setting per agent, any brain.** `agents.context_tokens` holds the most context the agent reads: 200K, 400K or 1M tokens (`CONTEXT_LIMITS`), or null for its model's own window ("Automático"). It is the agent's, not the brain's: switching brains or models keeps it. A limit past the model's window means that window: the smaller one wins at run time, so changing the model never needs it changed, and the apps only offer the sizes under the chosen model's window. It is set with the rest of "Quem pensa" (`PUT …/agents/{id}/brain`, `contextTokens`), audited in `agent.brain`.
2. **The API brain** compacts at the limit: `fitContextWindow` takes the smaller of the model's window and the limit, and an agent with a limit has no 500K cap (whoever chose 1M chose to pay for it). Old tool results give way to a placeholder as before.
3. **Computer brains** get it on each `brain.turn` as `contextTokens` (protocol 28, `CONTEXT_LIMIT_PROTOCOL`; an older runner never sees it and keeps its CLI's own window). The runner hands it to the CLI's own compaction: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in Claude Code's environment, `-c model_auto_compact_token_limit` for Codex (`exec` and the app-server). A turn with another limit starts a new process, resumed. The runner applies only a whole number between 50K and 10M (`isContextTokens`).
4. **In the apps it is advanced.** "Quem pensa" keeps the model, the account and a "Configuração avançada" row that says "Tudo no padrão" or only what differs; the row opens a smaller dialog with how it thinks (effort, context window) and who it answers ("Atende outras pessoas", answering through the API while the computer is away), saved with the rest on "Usar". Sizes are written `200K`, `400K`, `1M` in every language. On the phone "Pensa com" follows the same pattern: the model as a list, the account, and the row, which opens a screen of its own with the same groups (effort, context window, "Atende outras pessoas", the API when away) and "Voltar ao padrão", each choice saved at once like the rest of that screen.

   *Amended 2026-10-31:* on the phone the model is not a list on "Pensa com" but one "Modelo" row, first, with its model. It opens a screen of its own (`AgentModelScreen`): Automático, then the brain's models or every model of its coding plan, one list per maker on OpenCode Go, each tap saved at once.

   *Amended 2026-10-31 (ADR 0094):* under "Configuração avançada", on the web and the phone, a row "Usar em outros agentes" gives the same setup to the other agents picked.

## Consequences

- A long conversation on a smaller limit compacts sooner: cheaper and faster turns, less of the early conversation kept word for word.
- The API brain's 500K cap no longer applies to an agent that chose a limit; agents left on "Automático" keep it.
- The model catalog's windows now reach the apps (`contextWindow` on `GET …/models` and on each brain's model choices). *Amended 2026-10-31:* a coding plan's models are not among a brain's model choices, so the web reads a plan model's window from its catalog id: 1M where it ends in Claude Code's `[1m]` (`contextChoices` in `packages/client/src/lib/context-limits.ts`).
