# 0024. Git in the agents' computers through our proxy (the token never enters the machine)

- Status: Accepted. Superseded in part by ADR 0077 (2026-10-28): the cloud computer's credential (`sandboxes.id`, `git_token_gen`, issued on every start), its setup inside that computer and **Network**; connected computers (the addendum) are every agent's computer, and the proxy is mounted on every server
- Date: 2026-10-15

## Decision

Agents use real `git clone/commit/push` against private repositories from their computer (ADR 0021), but GitHub's credential stays on our server. The computer talks smart-HTTP git to **our** endpoint, which checks policy and forwards to GitHub with the org's token added server-side.

**Endpoint.** `/api/git/{orgId}/{connectionId}/{owner}/{repo}.git/{info/refs | git-upload-pack | git-receive-pack}`. It uses no session cookie and no CSRF: the computer signs in with HTTP Basic, and the password is our credential.

**Per-computer credential.**
- `agtgit1.<claims>.<hmac>`: an HMAC (key derived from `AGENTES_SECRET`, purpose `git-proxy`) over org, agent, computer (`sandboxes.id`), a revocation generation (`sandboxes.git_token_gen`) and an expiry (6 h).
- It is issued on every start of the computer and refreshed after 3 h of use (`sandboxes.git_token_issued_at`).
- Bumping the generation (`revokeComputerGitCredentials`) or deleting the computer kills every token at once.
- It is not a GitHub secret: it only works against our proxy, for that agent's policy.

**In the computer.** Set up as its user (no environment variables):
- `~/.config/agentes/git-token` (mode 600) and a three-line credential helper that prints it, configured only for our origin;
- `url.<proxy>.insteadOf https://github.com/` (and `git@github.com:`), so `git clone https://github.com/owner/repo` just works;
- commit author "Theo (agentes) <theo@agents.agentes.chat>", `push.autoSetupRemote`.

**Network.** Our host is always reachable from the computer. With the org's network `blocked` or `allowlist`, the provider gets an allowlist that includes our host. The computer row still shows the org's own mode.

**Policy (checked in the proxy on every request):**
- The agent needs `github:git.read` (fetch/clone) or `github:git.write` (push, which implies read) on that GitHub connection. These are grants of the connection, deniable like any other.
- Optional repository list (`agent_repositories`): `owner/name` or `owner/*`, in order. When an agent has any, only those repositories work, here and in the Tool Gateway for every GitHub tool (reads included). It replaced the `github:git.repo:…` grants (migration 0063). Admins set it; the agent's owner, when not an admin, may only narrow it (every entry already in reach, never back to every repository), like its access (ADR 0016).
- Push commands are read from the receive-pack request (pkt-lines) before anything is sent:
  - only `refs/heads/agentes/{handle}/…`, or another existing branch a person approved (addendum of 2026-10-31);
  - no tags and no deletes (`delete_branches` deletes, same addendum);
  - fast-forward only. We walk the pushed commits in the pack (our own small DEFLATE reader, because Node's zlib doesn't report how many bytes it consumed) from the new tip toward the old one. When the walk leaves the pack, GitHub's compare API must say `ahead` or `identical`.
- A refused push gets a proper `report-status` (inside side-band when negotiated), so `git push` prints the reason. It never reaches GitHub.
- Limits: a push of at most 100 MB and 100 ref updates (refused before any is looked up), a fetch request of at most 10 MB, at most 2 GB downloaded per request, at most 500k objects.
- Audit: `git.fetch` (repository), `git.push` (refs, from/to, commit count), `git.push_refused` (refs and reasons).

**Upstream credential.** A GitHub App installation token for that one repository (1 h, cached) when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` are set and the app is installed there. Otherwise the org's GitHub connection token (OAuth, refreshed; or the API key). It goes out as `Basic x-access-token:…`, is never logged, and is never returned.

**Tools.**
- `git_clone(repo, dir?)` (`github:git.read`, and the computer must be granted) runs `git clone` in the workspace.
- `open_pull_request(repo, branch, title, body?, base?, draft?)` (`github:pr.write`) calls GitHub's REST API with the server-side credential.
- Merge stays approval-gated, as before.

## Consequences

- A fast-forward to an existing upstream commit that isn't in the pack needs the compare API; if GitHub can't answer, the push is refused (safe side).
- Deltified commits in a pack (rare for pushes) are not read. A walk that depends on them falls back to the compare API.
- The proxy holds a whole push in memory (up to the limit) to inspect it.

## Addendum (2026-10-18): the proxy on connected machines

ADR 0025 left connected machines out ("we never set up git on a person's machine"): an agent thinking with Claude Code on someone's Mac had no checkout, `git_clone` refused there, and a raw `git clone` used the machine's own credentials (and waited on a permission prompt). Our proxy is the safer path on a person's machine too: only the agent's repositories, GitHub's token never leaves the server, revocable at once, pushes only to `agentes/<handle>/…`. So connected machines use it, without touching the machine's global git config.

**Credential.** The same `agtgit1` HMAC with `kind: "machine"` (`k: "m"`): `sandboxId` is the machine id and the generation is a number from the machine token's hash (`machineGitGen`). The proxy accepts it only while the machine is paired with that token (not deleted, not re-paired) and the agent still uses that machine (`agents.machine_id`); scopes and the repository list are checked live, as for cloud computers. Lifetime 6 h; a fresh one goes with every `git.sync`.

**Runner op `git.sync` (protocol 11).** The server sends the proxy base URL, the credential, the commit author and a list of `{ repo, dir, clone }` (default `repos/<owner>/<name>` in the agent's folder), plus `existing` (also every checkout already under `repos/`) and a deadline. The runner:
- writes the credential to `<runner home>/git/<agent id>.token` (mode 600, outside the agent's folder);
- clones with `git clone --filter=blob:none --progress` (progress streamed as `output` frames), git spawned with an argv, `GIT_TERMINAL_PROMPT=0`;
- sets each checkout's local config: `remote.origin.url` = the proxy URL, `credential.helper` reset (empty) then a helper that prints the token file, the agent as author, `push.autoSetupRemote`. Nothing global changes; no GitHub token is ever written;
- on an existing checkout: `fetch --prune`, then fast-forward the default branch (checked out and clean: `merge --ff-only`; on another branch: its ref only if it is an ancestor). Never a merge, never over local work;
- answers per repository: `cloned`, `updated`, `missing` (not cloned, not asked) or `failed` (offline, refused by the proxy…, with `head` when the checkout is there but stale). Only a bad request fails the whole op.
- *Hardened (2026-10-29).* `git.sync` and `mission.worktree` run without the "commands" switch, in repositories the agent's file ops can reach, so the repository never chooses a program for them: every runner git command gets `-c core.hooksPath=<null device> -c core.fsmonitor=false -c protocol.ext.allow=never -c safe.bareRepository=explicit`; before working in an existing checkout (or a mission's repository and worktree) its own config (local and worktree scopes, includes followed) may hold only data keys (remote, branch, user, credential helper, core basics…), else that repository fails with the key named (filter and diff drivers, `core.sshCommand`, `core.pager`, includes, `url.*.insteadOf`…); and the `write` op and secret files refuse any path in a `.git` folder or onto a `.git` file (`apps/server/runner/git-guard.ts`). The person's global and system git config are theirs and stay in effect. A task's end-of-item commit (ADR 0044) runs only with commands on and keeps running the repository's hooks.
Older runners drop unknown ops, so the server never sends `git.sync` below protocol 11 (`git_clone` tells the agent to update the app).

**`git_clone` on a connected machine.** Scope `github:git.read` only (no `sandbox:run`, no approval); the Tool Gateway checks the repository list as for every GitHub tool. Long timeout (30 min), progress as `agent.tool.output`. In a mission's thread it refuses: the mission has its own folder.

**Before each chat turn of a computer brain** (Claude Code, Codex; not missions): `prepareAgentCode` sends `git.sync` with the agent's explicit repositories (`clone: false`) and `existing: true`, bounded to 20 s; any failure leaves the turn as before. The turn's `cwd` becomes the checkout the conversation names (newest message first, `owner/name` or a bare name), else the agent's first repository, else its first checkout; the agent's folder stays reachable (`--add-dir`, Codex `writable_roots`). The runner carries the Claude Code session file to the new folder's project, so a conversation keeps its session when its folder changes. The "# Your code" block (`codePrompt`, `git/repos.ts`) lists the checkouts with their paths and default branches, the branch rule and `open_pull_request`, and the granted repositories not cloned yet ("call git_clone first; it needs no approval").

**Permissions of the brain.** Outside missions the turn's branch prefix is `agentes/<handle>/` (what the proxy accepts). `git clone <https url> [dir]`, `git fetch` and `git pull` whose target is inside the agent's folders count as read-only calls (no person asked, `readOnlyCall`), unless they carry options that run programs or read other config (`-c`, `-u`, `--upload-pack`, `--config`, `--template`…) or name local paths and `ext::`/`file:` transports. The deny list is unchanged: no push to the default branch, no force push, no `gh pr merge`, no deploys.

**Machine access (ADR 0036).** The checkouts live inside the agent's own folder, which the runner always allows; no folder is widened on the server's word. The token file is in the runner's home, which agents can't read through the file tools.

## Addendum (2026-10-31): branches that aren't the agent's own

An agent picked seven orphan branches to delete and ran `git push origin --delete`. The proxy refused it before and after the person wrote "pode apagar", with no way to ask, and the agent told the person to run the command. Deleting and pushing to someone else's branch now become a person's approval, decided on the server. Merges stay `merge_pull_request`, which always asks.

**Two git tools** (`git/tools.ts`, scope `github:git.write`, sensitive, on the GitHub connection; in `serverGitTool`, so a GitHub MCP tool with the same name can't take their place, and in the catalog's tool map as `ours`: the connectors source never takes a GitHub MCP tool by these names, and access lists and denies them by the names agents call). Shared parts live in `git/branches.ts`: the branch-name check (`git check-ref-format`, never `refs/…`, `HEAD` or `@`), the grant key, GitHub's facts, the grant lookup and the token (the app's installation token when the app is installed on the repository, else the connection's).
- `delete_branches(repo, branches[1..50], why)`: one card for the batch ("Apagar 7 branches em owner/repo", the names as detail). The names must fit the card's 2000-character detail, so the card shows every branch it deletes; a longer list is refused ("ask in smaller batches"). Before the card and again right before deleting (`checkToolCall`), the repository must be in the agent's list, the names valid and unique, and GitHub must say, for each branch, that it exists under that name, isn't the default branch and isn't protected (classic protection, or a ruleset's `deletion` rule). Any failure refuses the whole call, naming the branches. Approved, each branch is deleted with `DELETE /repos/{o}/{r}/git/refs/heads/{b}`, one at a time; the output lists deleted and failed ones, and the call is an error if any failed. Only branch names are taken, so tags are never touched. The agent's own branches go through it too: one rule for every deletion. The client treats it as high risk (hold to approve) and it never offers "Aprovar sempre".
- `request_branch_push(repo, branch, why)`: refused before any card for the agent's own branch ("just push"), a branch GitHub doesn't have (an approval covers updating, never creating), the default branch and a protected one (classic protection, or any ruleset rule but `creation`, `deletion` and `non_fast_forward`): "push to your own branch and open a PR; merging asks a person". The card reads "Enviar para ana/fix em owner/repo (24 h, sem force push)". Approving lets the agent push fast-forwards to that existing branch through the proxy for 24 h after the decision; "Aprovar sempre" does it for good (agent, connection, repository, branch: `approval_rules` with tool `request_branch_push` and action `owner/repo:branch`, the repository in lower case) until someone removes it (ADR 0015). Removing it also ends the approvals of that branch decided before, the one it came from included: the agent asks again at once. The tool itself only answers "approved, push again (no force)"; under a rule it runs with no card.

**GitHub's facts** (`branchFacts`), asked with the server's token, ten branches at a time: `GET /repos/{o}/{r}` (default branch), `GET …/branches/{b}` (exists under that exact name, `protected`; a redirect means it was renamed) and `GET …/rules/branches/{b}` (the ruleset rules that apply). An unanswered question refuses. Rules GitHub won't list for the repository (403 or 404 without a rate limit, as on a plan without rulesets) count as none: GitHub still enforces what it has.

**The proxy** (`refRule` is now the fixed part, the grant comes after), per ref:
- tags: refused, as before;
- deletes, the agent's own branches included: refused, pointing to `delete_branches`;
- `agentes/{handle}/…`: as before;
- anything that isn't a branch: refused;
- any other `refs/heads/<b>`: creating it is refused; updating it needs a grant, an `approval_rules` row for that key or an approved `request_branch_push` of this agent and connection decided less than 24 h ago and after that key's rule was last removed (its params read through the same key; the removal is the `agent.approval_rule_removed` audit row). Grants are read once per push (`pushGrants`, three queries at most), and none at all while `request_branch_push` is denied to the agent on that connection (ADR 0015: a denial stops a rule before it is read). The proxy has no run, so any of the agent's runs may use it, like its own branches. No grant: refused, pointing to the tool. Granted: GitHub is asked at push time whether the branch is now the default or protected or gone (no answer refuses), then the fast-forward check runs as before. The walk reads a commit's parents as git does (`parse_commit_buffer`): only the `parent` lines right after its first line, `tree`. A `parent` line after the committer is a header git ignores, and counting it passed a root commit off as a fast-forward. Force pushes stay refused everywhere.

**What git prints.** Each kind is said once on a `remote: agentes:` line (a push of seven deletes says it once), and the `ng` reasons stay short. The deletion and other-branch messages come from `@agenteschat/adapters/command-policy` (`DELETE_BRANCHES_POINTER`, `otherBranchPointer`), so the computer and the proxy say exactly the same. Every refusal ends with the one `NO_TERMINAL_COMMANDS` line the mission refusals use too (a force push, a protected branch or a tag as well), said once. The `git_clone` description, the "# Your code" block and the `git.write` scope text name both tools.

**Audit.** `approval.approved` carries `always` with the key; `agent.approval_rule_removed` when someone removes a rule; each tool call writes `tool.call` with its input and approval id (a partial delete is `failed`, its reason naming the branches); `git.push` gains `grants` (per ref, the approval id or the rule id); `git.push_refused` keeps the refs and reasons. No new table: the 24 h grant is the approval row itself.

**Left out:** a "merged" check (the 24 h limit and update-only cover it), listing or revoking 24 h grants (they end on their own, and removing `git.write` stops every push at once), open-PR markers on the delete card, a no-card path for deleting the agent's own branches, a separate scope for deleting. **Flagged, not changed here:** GitHub's MCP writes (`push_files`, `create_or_update_file`, under `repo.write`) can commit to any branch, the default one included, with no card, though the scope text says "never to the default branch without a PR"; and the proxy refuses every force push, the agent's own branches included, so a rebased branch of its own can't be pushed.
