/**
 * A mission's size limits. Their own module (no imports): mission tools build their JSON schemas from
 * them when they load, and loading them must never wait on the missions module (an import cycle
 * through messages, steering and the run tools would leave them undefined).
 */
export const MISSION_LIMITS = {
  title: 120,
  goal: 2000,
  planItems: 60,
  itemTitle: 200,
  itemNote: 500,
  sendText: 8000,
  inbox: 50,
  repoDir: 300,
  /** Plan items in a mission view (the strip); the full plan is `GET …/plan`. */
  viewItems: 40,
  /** `GET …/tasks/{id}/output`: at most this many lines. */
  outputLines: 200,
  /** Findings of the investigation before the proposal (ADR 0037 round 2). */
  findings: 12,
  findingText: 600,
  findingRefs: 8,
  findingRef: 300,
  /** Plan items an agent may propose with the mission. */
  proposedPlan: 20,
} as const;
