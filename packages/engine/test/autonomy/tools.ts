import type { ToolSource } from "../../src";

/** A fake `open_pull_request` (workspace code change: refused to a turn that can't act), recording each call. */
export function openPullRequestTool(): ToolSource & { executed: Record<string, unknown>[] } {
  const executed: Record<string, unknown>[] = [];
  return {
    name: "fake-pr",
    executed,
    tools: async () => [
      {
        name: "open_pull_request",
        description: "Opens a pull request (fake).",
        scope: "github:pr.write",
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string" }, title: { type: "string" } },
          required: ["repo", "title"],
          additionalProperties: false,
        },
        async execute(input) {
          executed.push(input);
          return { content: `PR #230 opened in ${String(input.repo)}` };
        },
      },
    ],
  };
}

/** A fake `deploy` that always fails the same way (a run that retries it goes in circles). */
export function deployTool(): ToolSource {
  return {
    name: "fake-deploy",
    tools: async () => [
      {
        name: "deploy",
        description: "Deploys (fake).",
        scope: "context:read",
        inputSchema: { type: "object", properties: { env: { type: "string" } } },
        execute: async () => ({ content: "Permission denied: this agent can't deploy.", isError: true }),
      },
    ],
  };
}
