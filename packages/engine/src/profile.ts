import { currentQueryCount } from "@agenteschat/db";

export interface StageTiming {
  stage: string;
  ms: number;
  /** SQL statements issued during the stage (in this async context). */
  queries: number;
}

/** Splits a unit of work into timed stages with their query counts (per-run breakdown at debug level). */
export function createProfiler() {
  const stages: StageTiming[] = [];
  let at = performance.now();
  let queries = currentQueryCount();
  return {
    mark(stage: string) {
      const now = performance.now();
      const q = currentQueryCount();
      stages.push({ stage, ms: Math.round((now - at) * 10) / 10, queries: q - queries });
      at = now;
      queries = q;
    },
    stages,
    total: () => ({
      ms: Math.round(stages.reduce((n, s) => n + s.ms, 0) * 10) / 10,
      queries: stages.reduce((n, s) => n + s.queries, 0),
    }),
  };
}
