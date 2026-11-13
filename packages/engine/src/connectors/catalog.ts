import type { OutcomeKind } from "../context/outcomes";

/**
 * Connector catalog: which MCP servers agentes.chat knows, and how each of
 * their tools maps to one of OUR scopes (ADR 0016: MCP has no standard scopes).
 * A tool the server offers but this catalog doesn't list is never exposed.
 * `sensitive` tools always need a person's approval (merge, deploy and
 * rollback are sensitive whatever this says; see `isSensitive`).
 *
 * Tool names follow the public MCP servers of each vendor. Titles are
 * templates for approval cards: `{param}` is replaced by the call's value.
 */
export interface ConnectorScope {
  label: string;
  description: string;
}

export interface ConnectorTool {
  scope: string;
  sensitive?: boolean;
  /** Approval-card title template, e.g. "Merge PR #{pullNumber} in {owner}/{repo}". */
  title?: string;
  /** Outcome recorded when the call succeeds (ground truth for lessons); `subject` is a template. */
  onSuccess?: { kind: OutcomeKind; subject: string };
  /**
   * Served by agentes.chat under this exact name (the git tools), never taken from the vendor's MCP server: access
   * lists and denies it by that name.
   */
  ours?: boolean;
  /**
   * Where the agent's own words go on GitHub (ADR 0156): a `body` gets the agent's signature line when given
   * (`always`: an empty one too), a commit `message` the person's credit.
   */
  sign?: { field: "body" | "message"; always?: true };
}

/** Catalog groups (the app translates them, `connectors.category.*`): development, product, docs, data (analytics), payments, sales, support, marketing, automation, social. */
export type ConnectorCategory =
  | "dev"
  | "product"
  | "docs"
  | "data"
  | "payments"
  | "sales"
  | "support"
  | "marketing"
  | "automation"
  | "social";

export interface ConnectorDefinition {
  id: string;
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Its MCP endpoint (streamable HTTP). */
  serverUrl: string;
  auth: ("oauth" | "api_key")[];
  oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[]; scopeSeparator?: string };
  /** Sent with every request to its MCP server, besides the sign-in. */
  headers?: Record<string, string>;
  scopes: Record<string, ConnectorScope>;
  tools: Record<string, ConnectorTool>;
}

const s = (label: string, description: string): ConnectorScope => ({ label, description });

export const CONNECTOR_CATALOG: Record<string, ConnectorDefinition> = {
  github: {
    id: "github",
    category: "dev",
    label: "GitHub",
    description: "Repositories, pull requests, issues and Actions.",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org", "workflow", "project"],
      scopeSeparator: " ",
    },
    // The remote server loads only context, repos, issues, pull_requests and users unless asked (its docs/remote-server.md).
    headers: {
      "X-MCP-Toolsets":
        "context,repos,issues,pull_requests,users,actions,projects,discussions,labels,code_security,dependabot,secret_protection,security_advisories,governance",
    },
    scopes: {
      "repo.read": s("Read code", "Read files and commits and search the code."),
      "repo.write": s("Write code", "Create branches and push commits (never to the default branch without a PR)."),
      "git.read": s(
        "Clone repositories (git)",
        "Clone and update repositories on the agent's computer with git, through our proxy; the GitHub token never enters the machine.",
      ),
      "git.write": s(
        "Push branches (git push)",
        "Push commits to agentes/{agent}/… branches: never to the default branch, no force push, no tags. Deleting branches (delete_branches) and pushing to someone else's branch (request_branch_push) ask for approval first.",
      ),
      "pr.read": s("Read pull requests", "List and read pull requests and their checks."),
      "pr.write": s("Open pull requests", "Open pull requests and comment on them."),
      "pr.merge": s(
        "Merge pull requests",
        "Merge a pull request. Asks for approval, except in the repositories chosen on the agent's page.",
      ),
      "issues.read": s("Read issues", "List and read GitHub issues."),
      "issues.write": s("Write issues", "Create issues and comment."),
      "actions.read": s("Read Actions", "List workflows and runs and read their jobs and logs."),
      "actions.run": s("Run workflows", "Start GitHub Actions workflows (they may deploy). Always asks for approval."),
      "projects.read": s("Read Projects", "List and read GitHub Projects, their fields and items."),
      "projects.write": s("Write Projects", "Add items to GitHub Projects and move or edit them."),
      "repo.admin": s(
        "Manage repositories",
        "Create repositories and protect their branches with rulesets. Deleting a repository and adding a ruleset always ask for approval.",
      ),
      "discussions.read": s("Read discussions", "List and read GitHub Discussions and their comments."),
      "discussions.write": s("Write in discussions", "Comment and reply in GitHub Discussions and mark answers."),
      "security.read": s(
        "Read security alerts",
        "Read code scanning, Dependabot and secret scanning alerts and security advisories. Secret alerts show the leaked secret.",
      ),
      "org.read": s("Read teams", "List the members of an organization's teams."),
    },
    tools: {
      git_clone: { scope: "git.read", ours: true },
      open_pull_request: { scope: "pr.write", ours: true },
      delete_branches: { scope: "git.write", ours: true },
      request_branch_push: { scope: "git.write", ours: true },
      get_file_contents: { scope: "repo.read" },
      search_code: { scope: "repo.read" },
      search_commits: { scope: "repo.read" },
      search_repositories: { scope: "repo.read" },
      list_commits: { scope: "repo.read" },
      get_commit: { scope: "repo.read" },
      list_branches: { scope: "repo.read" },
      list_tags: { scope: "repo.read" },
      list_releases: { scope: "repo.read" },
      get_latest_release: { scope: "repo.read" },
      repository_ruleset_read: { scope: "repo.read" },
      create_branch: { scope: "repo.write" },
      push_files: { scope: "repo.write", sign: { field: "message" } },
      create_or_update_file: { scope: "repo.write", sign: { field: "message" } },
      create_repository: { scope: "repo.admin" },
      delete_repository: { scope: "repo.admin", sensitive: true, title: "Delete {owner}/{repo}" },
      // A ruleset is branch protection: who may push or merge from then on.
      create_repository_ruleset: { scope: "repo.admin", sensitive: true, title: "Create ruleset {name}" },
      pull_request_read: { scope: "pr.read" },
      list_pull_requests: { scope: "pr.read" },
      search_pull_requests: { scope: "pr.read" },
      create_pull_request: { scope: "pr.write", sign: { field: "body", always: true } },
      update_pull_request: { scope: "pr.write", sign: { field: "body" } },
      update_pull_request_branch: { scope: "pr.write" },
      add_comment_to_pending_review: { scope: "pr.write" },
      add_reply_to_pull_request_comment: { scope: "pr.write", sign: { field: "body" } },
      // Its `submit_pending` and `create` methods can approve a pull request: never approved for good.
      pull_request_review_write: {
        scope: "pr.write",
        sensitive: true,
        sign: { field: "body" },
        title: "Review PR #{pullNumber} in {owner}/{repo}",
      },
      merge_pull_request: {
        scope: "pr.merge",
        sensitive: true,
        title: "Merge PR #{pullNumber} in {owner}/{repo}",
        onSuccess: { kind: "pr_merged", subject: "{owner}/{repo}#{pullNumber}" },
      },
      issue_read: { scope: "issues.read" },
      list_issues: { scope: "issues.read" },
      search_issues: { scope: "issues.read" },
      list_issue_types: { scope: "issues.read" },
      get_label: { scope: "issues.read" },
      list_label: { scope: "issues.read" },
      issue_write: { scope: "issues.write", sign: { field: "body" } },
      sub_issue_write: { scope: "issues.write" },
      add_issue_comment: { scope: "issues.write", sign: { field: "body" } },
      update_issue_comment: { scope: "issues.write", sign: { field: "body" } },
      label_write: { scope: "issues.write" },
      list_discussions: { scope: "discussions.read" },
      get_discussion: { scope: "discussions.read" },
      get_discussion_comments: { scope: "discussions.read" },
      list_discussion_categories: { scope: "discussions.read" },
      discussion_comment_write: { scope: "discussions.write", sign: { field: "body" } },
      actions_list: { scope: "actions.read" },
      actions_get: { scope: "actions.read" },
      get_job_logs: { scope: "actions.read" },
      actions_run_trigger: {
        scope: "actions.run",
        sensitive: true,
        title: "Run {method} in {owner}/{repo}",
      },
      list_code_scanning_alerts: { scope: "security.read" },
      get_code_scanning_alert: { scope: "security.read" },
      list_dependabot_alerts: { scope: "security.read" },
      get_dependabot_alert: { scope: "security.read" },
      list_secret_scanning_alerts: { scope: "security.read" },
      get_secret_scanning_alert: { scope: "security.read" },
      list_repository_security_advisories: { scope: "security.read" },
      list_org_repository_security_advisories: { scope: "security.read" },
      projects_list: { scope: "projects.read" },
      projects_get: { scope: "projects.read" },
      projects_write: { scope: "projects.write" },
      get_team_members: { scope: "org.read" },
    },
  },
  sentry: {
    id: "sentry",
    category: "dev",
    label: "Sentry",
    description: "Errors, issues and events.",
    serverUrl: "https://mcp.sentry.dev/mcp",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://sentry.io/oauth/authorize/",
      tokenUrl: "https://sentry.io/oauth/token/",
      scopes: ["org:read", "project:read", "event:read", "event:write"],
      scopeSeparator: " ",
    },
    scopes: {
      "issues.read": s("Read errors", "Search issues and events and read their details."),
      "issues.write": s("Triage errors", "Resolve, assign or ignore Sentry issues."),
    },
    tools: {
      find_projects: { scope: "issues.read" },
      search_issues: { scope: "issues.read" },
      search_events: { scope: "issues.read" },
      get_issue_details: { scope: "issues.read" },
      update_issue: { scope: "issues.write" },
    },
  },
  linear: {
    id: "linear",
    category: "product",
    label: "Linear",
    description: "Issues, projects and comments.",
    serverUrl: "https://mcp.linear.app/mcp",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read", "write"],
      scopeSeparator: ",",
    },
    scopes: {
      "issues.read": s("Read issues", "List and read Linear issues and projects."),
      "issues.write": s("Write issues", "Create and update issues and comments."),
    },
    tools: {
      list_issues: { scope: "issues.read" },
      get_issue: { scope: "issues.read" },
      list_projects: { scope: "issues.read" },
      create_issue: { scope: "issues.write" },
      update_issue: { scope: "issues.write" },
      create_comment: { scope: "issues.write" },
    },
  },
};

/** Our scope string for a connector scope, as stored in `agent_scopes`: `github:pr.merge`. */
export const connectorScope = (connector: string, scope: string) => `${connector}:${scope}`;

/** Fills an approval title template with the call's parameters. */
export function fillTitle(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = input[key];
    return v === undefined || v === null ? "?" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}
