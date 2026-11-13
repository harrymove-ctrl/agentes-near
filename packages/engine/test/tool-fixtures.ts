import type { ToolDefinition, ToolSource } from "../src";

/** A fake GitHub-like tool source: records executions, no network. */
export function fakeGithub() {
  const executed: { tool: string; input: Record<string, unknown> }[] = [];
  const tool = (name: string, scope: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    name,
    description: `${name} (fake)`,
    scope,
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, pr: { type: "integer", minimum: 1 } },
      required: ["repo", "pr"],
      additionalProperties: false,
    },
    async execute(input) {
      executed.push({ tool: name, input });
      return { content: `${name} ok: ${input.repo}#${input.pr}`, data: { ok: true } };
    },
    ...extra,
  });
  const tools = [
    tool("github_get_pr", "github:pr.read"),
    tool("github_merge_pr", "github:pr.merge", {
      describe: (i) => ({ title: `Merge PR #${i.pr} in ${i.repo}`, detail: `github.merge · ${i.repo} · PR ${i.pr}` }),
    }),
    tool("github_close_pr", "github:pr.write", { sensitive: true }),
    tool("github_broken", "github:pr.read", {
      execute: async () => {
        throw new Error("upstream 502");
      },
    }),
  ];
  const source: ToolSource = { name: "fake-github", tools: async () => tools };
  return { source, executed, tools };
}

export const ALL_GITHUB_SCOPES = ["github:pr.read", "github:pr.merge", "github:pr.write"].map((scope) => ({
  connectionId: null,
  scope,
}));
