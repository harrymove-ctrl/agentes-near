import type { PubSub } from "@agenteschat/adapters";
import { getAgentCached } from "../agents";
import { connectorScope } from "../connectors/catalog";
import { activeConnections, type ConnectorDeps } from "../connectors/connections";
import { publishChannelEvent } from "../events";
import { computerPreparing } from "../machine-provisioning";
import { missionOfRun } from "../mission-context";
import { replyThreadOf } from "../runs";
import { NO_COMPUTER_MESSAGE, PREPARING_COMPUTER_MESSAGE, type SandboxDeps } from "../sandbox";
import { APPROVAL_DETAIL_CHARS } from "../tools/gateway";
import type { CallCheck, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import {
  BRANCH_PUSH_TOOL,
  type BranchBlock,
  branchBlock,
  branchFacts,
  branchPath,
  DELETE_BRANCHES_TOOL,
  githubHeaders,
  githubToken,
  pushGrantKeyOf,
  validBranch,
} from "./branches";
import type { GitHubAppConfig } from "./github-app";
import { noTokenMessage } from "./github-call";
import { recordGitHubItem } from "./github-events";
import { cloneOnMachine } from "./machine";
import { parseRepo } from "./repos";
import { signatureLine, signedBody } from "./signature";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

export interface GitToolDeps {
  sandbox: SandboxDeps;
  connectors: ConnectorDeps;
  app?: GitHubAppConfig | null;
  /** GitHub's REST API (tests: a fake). */
  github?: { apiUrl: string; fetch: typeof fetch };
  /** Live clone progress on a connected machine (`agent.tool.output`). */
  pubsub?: PubSub;
}

/** git's progress lines (`\r`-separated) as a few live lines: at most one per second, the last one wins. */
function progressPublisher(pubsub: PubSub | undefined, c: ToolContext) {
  if (!pubsub || !c.toolUseId) return undefined;
  const toolUseId = c.toolUseId;
  let last = "";
  let sentAt = 0;
  let sent = 0;
  return (_stream: "stdout" | "stderr", chunk: string) => {
    const line = chunk
      .split(/[\r\n]+/)
      .filter((l) => l.trim())
      .at(-1);
    if (line) last = line.trim();
    const now = Date.now();
    if (!last || now - sentAt < 1000 || sent > 300) return;
    sentAt = now;
    sent++;
    const text = `${last}\n`;
    last = "";
    void publishChannelEvent(pubsub, {
      type: "agent.tool.output",
      channelId: c.channelId,
      threadId: replyThreadOf(c),
      runId: c.runId,
      agentId: c.agentId,
      toolUseId,
      stream: "stderr",
      text,
    }).catch(() => undefined);
  };
}

/** A branch GitHub keeps agents off, in the words a refusal names it with. */
const BLOCKED: Record<BranchBlock, string> = {
  missing: "not on GitHub",
  default: "the default branch",
  protected: "protected",
};

/**
 * Git in the agent's computer (ADR 0024), through our proxy:
 * - `git_clone` (`github:git.read`): on the agent's connected computer, the runner's `git.sync` (protocol 11)
 *   clones it into the agent's folder (`repos/owner/name`) with our proxy credential, with no other scope and no
 *   approval (ADR 0024 addendum). Pushes from there go through the proxy too;
 * - `open_pull_request` (`github:pr.write`): opens a PR from a pushed branch
 *   with the org's GitHub credential (server side). Merging stays approval-gated;
 * - `delete_branches` and `request_branch_push` (`github:git.write`, sensitive): what a person approves for
 *   branches that aren't the agent's own (`branches.ts`). The default branch and protected ones are never offered.
 * Offered only when GitHub is connected in the organization.
 */
export function createGitToolSource(deps: GitToolDeps): ToolSource {
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  return {
    name: "git",
    async tools(ctx: ToolContext): Promise<ToolDefinition[]> {
      const connection = (await activeConnections(ctx.db, ctx.orgId)).find((c) => c.connector === "github");
      if (!connection) return [];
      const repoInput = { type: "string", minLength: 3, maxLength: 200, description: "owner/name" };
      const branchInput = { type: "string", minLength: 1, maxLength: 200, description: "A branch name, not refs/…" };
      const tokenFor = (c: ToolContext, repo: { owner: string; repo: string }, access: "read" | "write") =>
        githubToken(deps, github, { db: c.db, orgId: c.orgId }, connection, repo, { contents: access });
      /** GitHub's answers on these branches, or why they couldn't be read. */
      const factsOf = async (c: ToolContext, repo: { owner: string; repo: string }, branches: string[]) => {
        const token = await tokenFor(c, repo, "read");
        if (!token) return noTokenMessage(connection, `${repo.owner}/${repo.repo}`);
        return (
          (await branchFacts(github, token, repo, branches)) ??
          `GitHub didn't answer about ${repo.owner}/${repo.repo}'s branches. Nothing was asked: try again in a moment.`
        );
      };
      const deleteCheck = async (input: Record<string, unknown>, c: ToolContext): Promise<CallCheck> => {
        const repo = parseRepo(str(input.repo));
        if (!repo) return { ok: false, message: "repo must be owner/name" };
        const branches = strings(input.branches);
        const invalid = branches.filter((b) => !validBranch(b));
        if (invalid.length > 0) {
          return {
            ok: false,
            message: `Not branch names: ${invalid.join(", ")}. Name branches only (fix/login), never refs/… or tags.`,
          };
        }
        const twice = [...new Set(branches.filter((b, i) => branches.indexOf(b) !== i))];
        if (twice.length > 0)
          return { ok: false, message: `Named more than once: ${twice.join(", ")}. Name each branch once.` };
        // The card lists every name it deletes: a list it would cut is refused.
        if (branches.join("\n").length > APPROVAL_DETAIL_CHARS) {
          return { ok: false, message: "These names don't fit on one card. Ask in smaller batches." };
        }
        const facts = await factsOf(c, repo, branches);
        if (typeof facts === "string") return { ok: false, message: facts };
        const blocked = branches.flatMap((b) => {
          const block = branchBlock(facts, b, true);
          return block ? [`${b} (${BLOCKED[block]})`] : [];
        });
        if (blocked.length > 0) {
          return {
            ok: false,
            message: `Refused, nothing was asked or deleted: ${blocked.join(", ")}. The default branch and protected branches are never deleted. Ask again without them.`,
          };
        }
        return { ok: true };
      };
      const pushCheck = async (input: Record<string, unknown>, c: ToolContext): Promise<CallCheck> => {
        const repo = parseRepo(str(input.repo));
        if (!repo) return { ok: false, message: "repo must be owner/name" };
        const branch = str(input.branch);
        if (!validBranch(branch)) {
          return {
            ok: false,
            message: `${branch} isn't a branch name. Name the branch only (fix/login), never refs/… or a tag.`,
          };
        }
        const self = await getAgentCached(c.db, c.orgId, c.agentId);
        const handle = self?.handle ?? "";
        if ([handle, ...(self?.previousHandles ?? [])].some((h) => branch.startsWith(`agentes/${h}/`))) {
          return { ok: false, message: `${branch} is your own branch: just push to it, nothing to ask.` };
        }
        const facts = await factsOf(c, repo, [branch]);
        if (typeof facts === "string") return { ok: false, message: facts };
        const block = branchBlock(facts, branch, false);
        if (block === "missing") {
          return {
            ok: false,
            message: `${branch} isn't on GitHub, and an approval only covers updating an existing branch, never creating one. Push to agentes/${handle}/<topic> and open a pull request.`,
          };
        }
        if (block) {
          return {
            ok: false,
            message: `${branch} is ${BLOCKED[block]}: push to agentes/${handle}/<topic> and open a pull request; merging asks a person.`,
          };
        }
        return { ok: true };
      };
      return [
        {
          name: "git_clone",
          description:
            "Clone a GitHub repository into your folder on your computer (repos/<owner>/<name>; already there: it is updated). No approval needed. Real git through our proxy: commit and push from there to branches agentes/<your handle>/…, then open_pull_request. Delete branches with delete_branches; to push to someone else's branch, ask with request_branch_push first.",
          scope: connectorScope("github", "git.read"),
          connectionId: connection.id,
          connector: { key: "github", via: "native", tool: "git_clone" },
          connectorLabel: connection.label,
          service: "github",
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              dir: {
                type: "string",
                maxLength: 200,
                description: "Folder in your workspace (default: repos/<owner>/<name>)",
              },
            },
            required: ["repo"],
            additionalProperties: false,
          },
          async execute(input, c) {
            try {
              const repo = parseRepo(str(input.repo));
              if (!repo) return { content: "repo must be owner/name", isError: true };
              const given = str(input.dir).trim();
              if (given.startsWith("/") || given.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(given))
                return { content: "dir must stay in the workspace", isError: true };
              const [agent, mission] = await Promise.all([getAgentCached(c.db, c.orgId, c.agentId), missionOfRun(c)]);
              // A connected machine (not in a mission's own folder): through the proxy with our credential.
              if (agent?.machineId && !mission) {
                const machines = deps.sandbox.machines;
                const git = deps.sandbox.git;
                if (!machines || !git) return { content: "Connected computers are not available here.", isError: true };
                const r = await cloneOnMachine(
                  {
                    db: c.db,
                    hub: machines.hub,
                    git,
                    github: deps.app ? { app: deps.app, http: github } : null,
                    ...(deps.sandbox.now ? { now: deps.sandbox.now } : {}),
                  },
                  { orgId: c.orgId, agentId: c.agentId, machineId: agent.machineId },
                  {
                    repo: `${repo.owner}/${repo.repo}`,
                    ...(given ? { dir: given } : {}),
                    ...(c.signal ? { signal: c.signal } : {}),
                    onOutput: progressPublisher(deps.pubsub, c),
                  },
                );
                const where = r.path ?? r.dir;
                if (r.status === "cloning") {
                  return {
                    content: `${r.repo} is still downloading into ${where} on your computer (${r.message ?? "in progress"}). It goes on by itself; call git_clone again for it when you need the code, to wait for it.`,
                    data: { repo: r.repo, dir: r.dir, machineId: agent.machineId, status: r.status },
                  };
                }
                if (r.status === "failed" && !r.head) {
                  return { content: `git clone failed: ${r.message ?? "unknown error"}`, isError: true };
                }
                const what =
                  r.status === "cloned"
                    ? `Cloned ${r.repo} into ${where}`
                    : r.status === "failed"
                      ? `${r.repo} is already at ${where}, but it couldn't be updated (${r.message ?? "unknown error"})`
                      : `${r.repo} was already at ${where}; updated it`;
                return {
                  content: `${what} (branch ${r.branch ?? "?"}${r.head ? ` at ${r.head}` : ""}${r.message && r.status !== "failed" ? `; ${r.message}` : ""}).\nWork there (cd ${where}); create a branch agentes/${agent.handle}/<topic> to push, then open_pull_request.`,
                  data: { repo: r.repo, dir: r.dir, machineId: agent.machineId, status: r.status },
                };
              }
              if (mission) {
                return {
                  content: mission.machineId
                    ? "In a mission, work in the mission's own folder on its computer (its repository is set up there)."
                    : "This mission has no computer yet: its owner chooses one first.",
                  isError: true,
                };
              }
              const preparing = await computerPreparing({ ...deps.sandbox, db: c.db }, c.orgId);
              return { content: preparing ? PREPARING_COMPUTER_MESSAGE : NO_COMPUTER_MESSAGE, isError: true };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: "open_pull_request",
          description:
            "Open a pull request on GitHub from a branch you pushed (agentes/<your handle>/…). Merging is separate and always needs a person's approval.",
          scope: connectorScope("github", "pr.write"),
          connectionId: connection.id,
          connector: { key: "github", via: "native", tool: "open_pull_request" },
          connectorLabel: connection.label,
          service: "github",
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              branch: { type: "string", minLength: 1, maxLength: 200 },
              title: { type: "string", minLength: 1, maxLength: 256 },
              body: { type: "string", maxLength: 60_000 },
              base: { type: "string", maxLength: 200, description: "Default: the repository's default branch" },
              draft: { type: "boolean" },
            },
            required: ["repo", "branch", "title"],
            additionalProperties: false,
          },
          describe: (input) => ({ title: `Open a pull request in ${str(input.repo)}: ${str(input.title)}` }),
          async execute(input, c) {
            try {
              const repo = parseRepo(str(input.repo));
              if (!repo) return { content: "repo must be owner/name", isError: true };
              const token = await githubToken(deps, github, { db: c.db, orgId: c.orgId }, connection, repo, {
                pull_requests: "write",
                contents: "read",
              });
              if (!token) return { content: noTokenMessage(connection, `${repo.owner}/${repo.repo}`), isError: true };
              const headers = { ...githubHeaders(token), "content-type": "application/json" };
              let base = str(input.base);
              if (!base) {
                const info = await github.fetch(`${github.apiUrl}/repos/${repo.owner}/${repo.repo}`, { headers });
                if (!info.ok)
                  return { content: `GitHub answered ${info.status} for ${repo.owner}/${repo.repo}`, isError: true };
                base = ((await info.json()) as { default_branch?: string }).default_branch ?? "main";
              }
              const res = await github.fetch(`${github.apiUrl}/repos/${repo.owner}/${repo.repo}/pulls`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  title: str(input.title),
                  head: str(input.branch),
                  base,
                  body: signedBody(str(input.body), await signatureLine(c.db, c)),
                  draft: input.draft === true,
                }),
              });
              const body = (await res.json().catch(() => ({}))) as {
                html_url?: string;
                number?: number;
                message?: string;
                errors?: { message?: string }[];
              };
              if (!res.ok) {
                const why = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ");
                return { content: `GitHub refused the pull request (${res.status}): ${why}`, isError: true };
              }
              if (typeof body.number === "number")
                await recordGitHubItem(c, {
                  repo: `${repo.owner}/${repo.repo}`,
                  number: body.number,
                  authored: true,
                }).catch(() => {});
              return {
                content: `Opened PR #${body.number}: ${body.html_url}`,
                data: { pullRequest: { number: body.number, url: body.html_url, repo: `${repo.owner}/${repo.repo}` } },
              };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: DELETE_BRANCHES_TOOL,
          description:
            "Delete branches on GitHub, your own included: the only way agents delete branches (git push --delete is refused). A person approves the whole list on one card, then they're deleted. Never tags, the default branch or a protected branch.",
          scope: connectorScope("github", "git.write"),
          connectionId: connection.id,
          connector: { key: "github", via: "native", tool: DELETE_BRANCHES_TOOL },
          connectorLabel: connection.label,
          sensitive: true,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              branches: { type: "array", minItems: 1, maxItems: 50, items: branchInput },
            },
            required: ["repo", "branches"],
            additionalProperties: false,
          },
          describe: (input) => {
            const branches = strings(input.branches);
            return {
              title: `Apagar ${branches.length} ${branches.length === 1 ? "branch" : "branches"} em ${str(input.repo)}`,
              detail: branches.join("\n"),
            };
          },
          checkCall: deleteCheck,
          async execute(input, c) {
            try {
              const repo = parseRepo(str(input.repo));
              if (!repo) return { content: "repo must be owner/name", isError: true };
              const token = await tokenFor(c, repo, "write");
              if (!token) return { content: noTokenMessage(connection, `${repo.owner}/${repo.repo}`), isError: true };
              const deleted: string[] = [];
              const missed: string[] = [];
              // One at a time: parallel ref updates in one repository may conflict on GitHub.
              for (const branch of strings(input.branches)) {
                const res = await github
                  .fetch(`${github.apiUrl}/repos/${repo.owner}/${repo.repo}/git/refs/heads/${branchPath(branch)}`, {
                    method: "DELETE",
                    headers: githubHeaders(token),
                  })
                  .catch(() => null);
                if (res?.status === 204) deleted.push(branch);
                else missed.push(`${branch} (${res ? `GitHub answered ${res.status}` : "no answer"})`);
              }
              const lines = [
                ...(deleted.length > 0 ? [`Deleted on GitHub: ${deleted.join(", ")}.`] : []),
                ...(missed.length > 0 ? [`Not deleted: ${missed.join(", ")}.`] : []),
              ];
              return {
                content: lines.join("\n"),
                ...(missed.length > 0 ? { isError: true } : {}),
                data: { repo: `${repo.owner}/${repo.repo}`, deleted, failed: missed },
              };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: BRANCH_PUSH_TOOL,
          description:
            "Ask a person to let you push to a GitHub branch that isn't yours (agentes/<your handle>/… needs no asking). Once they approve, push again with git: fast-forwards to that existing branch, for 24 h or for good if they choose. Never the default branch or a protected one, never a new branch, never a force push.",
          scope: connectorScope("github", "git.write"),
          connectionId: connection.id,
          connector: { key: "github", via: "native", tool: BRANCH_PUSH_TOOL },
          connectorLabel: connection.label,
          sensitive: true,
          inputSchema: {
            type: "object",
            properties: { repo: repoInput, branch: branchInput },
            required: ["repo", "branch"],
            additionalProperties: false,
          },
          describe: (input) => ({
            title: `Enviar para ${str(input.branch)} em ${str(input.repo)} (24 h, sem force push)`,
          }),
          rememberTarget: pushGrantKeyOf,
          checkCall: pushCheck,
          // The grant is the approval itself (or the rule): the proxy reads it on the next push.
          execute: async (input) => ({
            content: `Approved: push to ${str(input.branch)} in ${str(input.repo)} again now with git (fast-forward only, no force push).`,
          }),
        },
      ];
    },
  };
}
