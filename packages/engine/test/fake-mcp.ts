import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpConnect, mcpSessionOver } from "../src";

/**
 * An in-process MCP server shaped like GitHub's (no network). Records every
 * call and the auth headers each session was opened with.
 */
export function fakeGithubMcp(options: { issueWrite?: boolean; writes?: boolean } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const sessions: { serverUrl: string; headers: Record<string, string> }[] = [];
  const pr = { owner: z.string(), repo: z.string(), pullNumber: z.number().int() };

  const build = () => {
    const server = new McpServer({ name: "fake-github", version: "1" });
    server.registerTool("pull_request_read", { description: "Get a pull request", inputSchema: pr }, async (args) => {
      calls.push({ tool: "pull_request_read", args });
      return { content: [{ type: "text", text: `PR #${args.pullNumber}: fix token refresh (checks passing)` }] };
    });
    server.registerTool(
      "merge_pull_request",
      { description: "Merge a pull request", inputSchema: { ...pr, merge_method: z.string().optional() } },
      async (args) => {
        calls.push({ tool: "merge_pull_request", args });
        return { content: [{ type: "text", text: `Merged PR #${args.pullNumber}` }] };
      },
    );
    // Not in our catalog (a person's stars): must never reach an agent.
    server.registerTool(
      "star_repository",
      { description: "Star a repository", inputSchema: { repo: z.string() } },
      async (args) => {
        calls.push({ tool: "star_repository", args });
        return { content: [{ type: "text", text: "starred" }] };
      },
    );
    server.registerTool(
      "issue_read",
      { description: "Get an issue", inputSchema: { number: z.number() } },
      async () => ({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      }),
    );
    if (options.issueWrite) {
      server.registerTool(
        "issue_write",
        {
          description: "Create a new or update an existing issue in a GitHub repository.",
          inputSchema: { owner: z.string(), repo: z.string(), title: z.string().optional() },
        },
        async (args) => {
          calls.push({ tool: "issue_write", args });
          return { content: [{ type: "text", text: "Created issue #1" }] };
        },
      );
    }
    // What agents do on GitHub (ADR 0156): bodies, commit messages, account-wide calls, Projects, administration.
    if (options.writes) {
      const repo = { owner: z.string(), repo: z.string() };
      const tools: Record<string, Record<string, z.ZodType>> = {
        add_issue_comment: { ...repo, issue_number: z.number(), body: z.string() },
        update_issue_comment: { ...repo, comment_id: z.number(), body: z.string() },
        issue_write: { ...repo, method: z.string(), title: z.string().optional(), body: z.string().optional() },
        create_pull_request: {
          ...repo,
          title: z.string(),
          head: z.string(),
          base: z.string(),
          body: z.string().optional(),
        },
        push_files: { ...repo, branch: z.string(), files: z.array(z.unknown()), message: z.string() },
        list_issue_types: { owner: z.string() },
        projects_list: { owner: z.string() },
        label_write: { ...repo, method: z.string(), name: z.string() },
        discussion_comment_write: {
          ...repo,
          method: z.string(),
          discussionNumber: z.number().optional(),
          body: z.string().optional(),
        },
        list_code_scanning_alerts: repo,
        list_org_repository_security_advisories: { org: z.string() },
        get_team_members: { org: z.string(), team_slug: z.string() },
        create_repository: { name: z.string(), organization: z.string().optional() },
        delete_repository: repo,
        create_repository_ruleset: { ...repo, name: z.string(), rules: z.array(z.unknown()) },
      };
      for (const [name, inputSchema] of Object.entries(tools)) {
        server.registerTool(name, { description: name, inputSchema }, async (args) => {
          calls.push({ tool: name, args });
          // GitHub's server answers a new pull request with its id and link only.
          const text =
            name === "create_pull_request"
              ? JSON.stringify({ id: "1", url: `https://github.com/${args.owner}/${args.repo}/pull/12` })
              : `${name} done`;
          return { content: [{ type: "text", text }] };
        });
      }
    }
    return server;
  };

  const connect: McpConnect = async (connection, headers) => {
    sessions.push({ serverUrl: connection.serverUrl, headers });
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, calls, sessions };
}
