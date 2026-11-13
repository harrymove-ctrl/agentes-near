/**
 * What a mission's executor is told on every task (ADR 0029). The text lives
 * in `@agenteschat/adapters` so the runner can pick the variant for the
 * folder it runs in: `MISSION_RULES` in a git repository (branches, commits,
 * pushes), `MISSION_RULES_NO_GIT` otherwise (subfolders, the Drive).
 */
export { MISSION_RULES, MISSION_RULES_NO_GIT } from "@agenteschat/adapters";
