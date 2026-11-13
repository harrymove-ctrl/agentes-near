# 0041. Claude and Codex accounts on a connected computer, chosen per agent; effort per agent

- Status: Accepted (2026-10-20). Superseded in part by ADR 0059 (§2 who adds accounts, §4 who decides, §7 removing). Amended 2026-10-30: §1 (the computer's own sign-in is offered only where it is signed in), §2.7 (a sign-in through a restart of the server or a reconnect of its computer); 2026-10-31: §5.1 (a background task signs in with the agent's account, as its turns); 2026-11-04: §2.8 (a new sign-in where the person already has that account signs in to it again); Grok accounts (ADR 0142) and Gemini accounts (ADR 0143)
- Date: 2026-10-20
- Extends: ADR 0025 (connected computers), ADR 0027 (secrets, end to end), ADR 0032 (Claude Code and Codex as brains), ADR 0036 (desktop app)
- Out of scope for now: cloud computers, switching accounts by itself when a plan runs out

## Context

A computer brain (ADR 0032) runs `claude` or `codex` on the person's computer with the runner's environment. Every agent on that computer uses whichever account is signed in there (`~/.claude`, `~/.codex`). People have more than one account (a personal plan, a work seat) and want to pick which one each agent spends. Today that means signing out and in again in a terminal, for every agent at once.

Constraints:

- Anthropic does not let third-party products collect, store or intermediate Claude.ai credentials (see ADR 0027). Our code must not hold the token; our server must never see a sign-in code in the clear.
- Sign-in goes through the provider's own flow, run by its own CLI on the computer.
- Most users aren't technical: no terminal in the happy path, and they are often on another device (phone, another laptop).

What the CLIs do (checked 2026-10-20, Claude Code 2.1.304, Codex 0.163.0):

- `claude auth login` with `CLAUDE_CONFIG_DIR=<dir>` keeps that sign-in in `<dir>`. It works with plain pipes (no terminal needed), prints `If the browser didn't open, visit: <url>` (an OAuth URL whose redirect is Anthropic's code page, `platform.claude.com/oauth/code/callback`) and waits on `Paste code here if prompted >`. It also tries to open a browser on the computer itself with a local callback; signing in there finishes without a code.
- `claude auth status --json` reports `loggedIn`, `email`, `subscriptionType` (pro, max, team…).
- `claude --effort <low|medium|high|xhigh|max>` sets the effort of a session.
- `codex login --device-auth` with `CODEX_HOME=<dir>` prints a device link (`https://auth.openai.com/codex/device`) and a one-time code (15 minutes), and finishes by itself once the person enters the code anywhere. `codex login status` reports the sign-in.
- Codex takes the effort as `-c model_reasoning_effort="<level>"`.

## Decision

### 1. An account is a folder on the computer, signed in by the provider's own CLI

- Each account is `<runner home>/accounts/<kind>/<accountId>/`, used as `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). The CLI writes and keeps its own sign-in there; the runner never reads, copies or sends it. Folder mode 700, outside every agent workspace (the runner refuses `read` and `push` inside `<runner home>`).
- There is always **"Conta deste computador"**: no folder, the sign-in already in `~/.claude` / `~/.codex`, exactly as today. It is the default.

  *Amended 2026-10-30:* it is offered only where it can think for the agent: the computer's pairer owns the agent (ADR 0059 §3) and the runner reports that CLI signed in there. For Claude Code that is `claude auth status` at `hello` (`executors.claude.loggedIn`), or a usage it read with that sign-in unless that status says signed out; for Codex, the usage it read with it (`ownUsage.codex`, protocol 19), since `hello` says nothing of Codex's sign-in, so every place that offers it (Quem pensa, Connect an AI, the setup's AI step) asks the computers for their usage again when it opens. The apps list it otherwise only while the agent thinks with it, on its owner's computer or to someone who can't change the account; an owner with nothing to pick on someone else's computer reads who adds sign-ins there instead of an empty list. On a computer nobody connected (the Cloud workspace's; the server's own computer is its owner's) no person signs in at its terminal, so it is never offered there, and an agent that still thinks with it fails its run at once as not signed in: `not_logged_in` before any other check, no AI (ADR 0061), and its card says that the CLI isn't signed in on this computer and to connect an account of its plan on the agent's page (`meta.noAi.own`), its text and the conversation lists' previews say the same (`chat.body.no_ai_not_signed_in`), never "I'll answer when it's back". Connect an AI opened for one agent on a plan brain opens on that plan. Choosing a plan brain starts on the computer's own sign-in where it is offered, else on one of the person's accounts of that kind that thinks for nobody, else on its sign-in; creating an agent on a plan whose computer's own sign-in can't think for it opens that plan's sign-in for it.
- An account's sessions live in its folder. Changing an agent's account starts a new CLI session for its threads (the conversation itself is ours and continues). Rare, and accepted.
- The person's personal CLAUDE.md, skills and plugins don't load in an account folder. That matches the runner's `--setting-sources project` (`apps/server/runner/brain.ts`) anyway.

### 2. Adding an account from the web or the phone

1. Only the computer's owner sees **"Adicionar conta"**, at the end of the account dropdown in the agent's "Quem pensa".
2. The server asks the runner to start a sign-in (op `account`, action `begin`, `{ kind }`). The runner creates the folder, starts the CLI with pipes and answers with what the person needs:
   - Claude Code: `{ loginId, url, publicKey }`. The URL is the one the CLI prints; `publicKey` is an ephemeral key made as in ADR 0027 (private key stays on the computer).
   - Codex: `{ loginId, url, userCode }`.
3. The web shows it:
   - Claude Code: **"Entrar com Claude"** (opens the URL), then "Cole o código que o Claude mostrou". The browser encrypts the code with the computer's key (ADR 0027 crypto, AAD `loginId | orgId | account`); the server relays the ciphertext in memory and stores nothing; the runner decrypts it and writes it to the waiting CLI. If the person is at the computer and signs in through the browser the CLI opened there, it finishes without a code.
   - Codex: the link and the code to type there, with a line saying the person started this sign-in from agentes.chat (Codex warns against codes "a website gave you").
4. The runner watches the CLI. When it exits signed in, it runs the status command in that folder and answers with metadata only: email and plan. The server stores the account and tells the page (realtime), which picks it.
5. A sign-in expires in 15 minutes; the process is killed and the folder removed.
6. **Entrar de novo** on a signed-out account signs in again to that same account (`begin` with `again`): same id and folder, the agents keep it, and a failed retry leaves the folder as it was.
7. *Amended 2026-10-30:* the page asks for the sign-in's status every 2 s. A read can fail while our server restarts or the computer's runner reconnects (no answer, the proxy's 502 to 504 or 520 to 524, `machine.offline`, `machine.timeout`), yet the sign-in goes on: the runner keeps its logins across a reconnect, and the server keeps the `signing_in` row. Such a read shows **Reconectando…** where the steps wait, and the page keeps asking. Only after 90 s of failed reads in a row, counted from the first (`LOGIN_RECONNECT_MS`), does the sign-in fail, saying the computer didn't answer, with Tentar de novo: after a drop the runner dials again 1, 2, 4, 8, 16, then 32 s apart (±20 %), so a restart of up to about 30 s (`deploy/deploy.sh`) that misses the fifth dial (25 to 37 s) has it back at the sixth (up to 76 s). Counting from the first failure, not the last answer, keeps a page back from the background (a phone, an idle tab) from failing for the time it spent there. Any other failed read, and what the computer reports (the CLI exited without signing in, the code was wrong, the time ran out), shows at once, and an answer after the failure picks the same sign-in up again, each login of a key sent to several (All agents) too: only an end on the computer ends one. Claude's code or a plan's key that can't go for those same reasons says the computer didn't answer, never to check it, and waits for Enviar: it is never sent again by itself, since a call that got no answer may have reached the computer. A code that lands in the field while the computer isn't ready waits there for Enviar too. A place that hides the steps while their computer is offline (Connect an AI, the setup's AI step) keeps them while a sign-in is under way, so the same login is watched again when the computer is back: none is restarted or started twice. On the agent's page (Quem pensa), no brain on that computer reads as offline meanwhile. Web and phone share it (`loginRead` and `useAccountLogin` in `@agenteschat/client`).
8. *Amended 2026-11-04:* each new sign-in used to make a new account, so retrying (a check that failed, a computer that reconnected) left one computer with many accounts of the same plan. Before a new sign-in starts, when the person already has an account of that CLI and plan on that computer (theirs, signed in or signed out, and free to take: one for all of their agents there or one no agent thinks with, never another agent's own login, which signing in to again starts over; `reusableAccount` in `lib/ai-accounts.ts`), the block offers **Entrar de novo** on it as the primary action (the `begin` with `again` of §2.6: same id, same folder, its agents keep it) and **Outra conta** beside it for a new one. A signed-out one is already chosen, with Outra conta still there. The choice is made once, when the block opens, so the account signing in never changes it. It isn't offered where the person already picked another account, where a sign-in is for an account already named (signing in again, a turn of "All agents", a key to several logins), nor beside the agent page's own account list. Nothing is merged or deleted by itself: Configurações › Contas de IA groups the logins of one account (`groupPlans`) and flags those that think for no agent (`unusedCopies`; one stays when none does), with one click to remove them, by the usual removal (§7, ADR 0059). Web and phone share the helpers.

From the desktop app the same op runs locally: the CLI opens the computer's browser and finishes by itself.

### 3. Data

- **`machine_accounts`**: `org_id`, `machine_id`, `id`, `kind` (`claude_code` | `codex`), `label`, `email`, `plan`, `status` (`active` | `signed_out`), `created_by`, `created_at`, `last_used_at`. Nothing secret.
- **`agents.brain_account_id`**: nullable, FK `(org_id, brain_account_id)`; null = "Conta deste computador". It must belong to the agent's machine and match its brain kind (checked in code). Moving the agent to another computer, or changing brain kind, clears it.
- **`agents.brain_effort`**: nullable text (`low` | `medium` | `high` | `xhigh` | `max`); null = the CLI's or model's default.

### 4. Who decides

The subscription is personal: only the **computer's owner** adds or removes accounts and sets an agent's account. Others who can edit the agent see the account, locked. Effort is part of the brain settings and follows their rules. An agent never changes its own account or effort (no tool for it).

### 5. A turn

- `BrainTurnRequest` gains `account?: string` and `effort?: string`.
- Account: the runner sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to that folder (and looks up sessions there). A missing folder fails the turn with `account_missing`; a refused sign-in fails it with `not_logged_in`. Either way the runner asks the CLI again and reports the accounts (`accounts.changed`): only the computer says an account is signed out or gone, so a passing failure never sticks. **It never falls back to another account**; the model fallback (`brainFallback`) behaves as for any brain failure.
- Effort: `--effort <level>` (Claude Code), `-c model_reasoning_effort="<level>"` (Codex; `xhigh` and `max` map to `high`). The page offers Baixo, Médio, Alto, Máximo (`low`, `medium`, `high`, `max`). Effort for the organization's model brain (provider effort parameters through the Model Gateway) comes later.
- A live process is keyed by (agent, session, account, effort).
- Plan limit events carry the account, so the page says which account hit its limit.

### 5.1 A background task (amended 2026-10-31)

Background tasks (`start_task`, mission items, resumes) ran their Claude Code or Codex on the computer's own sign-in, while the agent's account went only to its turns and routes. Where each agent is its own OS user (the Cloud) that user has no sign-in of its own, so every such task failed within seconds with "Not logged in · Please run /login" (all 8 in one workspace in one evening), and the run woken by the failure read "run /login", which no agent can do. Now a task signs in as its agent's turns do.

- **Which account.** From runner protocol 31 (`TASK_ACCOUNTS_PROTOCOL`) a Claude Code or Codex `task.start` carries `account`: the account the agent's own turns of that CLI think with on that computer (`brainAccountFor`). Only that agent's own tasks carry it: never another agent's, a shell task, or a task of the other CLI. An older runner never gets it and starts the task on the computer's own sign-in, as before.
- **On the computer.** The runner signs the task's CLI in with the same code as a turn (`accountSignIn`): the account's folder as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and nothing else in the environment signing it in, a coding plan's key in the env under the plan's name with one of the plan's models, and Claude Code's endpoint and proxies pinned in the task's own `--settings` (`accountSettingsEnv`), so a project's settings can't send the sign-in elsewhere. In system mode root lends the folder to the agent's user, or hands over what it keeps for the account, as for a turn (ADR 0059 §2).
  - A token root keeps reaches the task's wrapper on its descriptor 3 and the CLI on its own descriptor 3, which Claude Code reads and closes. It is never in `spec.json`, the journal or any other file of the task, nor in an environment. The runner holds it in memory only while the task runs, for a retry with the other session flag, and the task's redaction hides it, and a plan's key too.
  - A folder that isn't there, or an account root has nothing for, refuses the start at once, in the turns' words.
  - A route on that sign-in answers `busy` while the task runs (ADR 0074 §3), and a task starting on a sign-in stops a route there first. A task on an account no longer makes a route on the computer's own sign-in busy.
  - When root says the agent thinks with another account or none, its worker cancels its tasks on any other account, as it closes its turns' processes: no process of that agent keeps a credential it no longer thinks with.
  - Sessions and Codex threads live in the CLI's home: on an account, a task resumes only one in that account's folder, and Codex threads are kept per account, as turns keep them.
- **Refused at once, by the turns' rules** (`computerBrainUnavailable`). Before anything reaches the runner, a task with nothing to sign in with doesn't start, and the agent reads why and what it can do (`TaskSignInError`: "Not started: …", `task.no_sign_in`):
  - on a computer nobody connected, no account of its own for that CLI (it hears which executor to use when it has an account for the other CLI there), or an account there on a runner before protocol 31, which would start the task on a sign-in that computer doesn't have;
  - a plan that isn't its owner's (ADR 0059 §3), where turns already check it: a task on an account of the agent's own, or of an agent that thinks with that CLI, on a computer someone connected whose own sign-in would think for another person's agent. An agent that thinks with something else (the platform model, the other CLI) keeps running tasks on that computer's own sign-in, as before;
  - its account signed out, or no account where `claude auth status` said the computer's own Claude Code is signed out.

  The refused start stays as a failed task saying why. A mission's queued item refused this way fails as any refused start does, and the mission hears it.
- **Still not signed in.** A CLI that finds nothing to sign in with anyway (the computer's own sign-in expired, an account refused) ends at once with "Not logged in". The runner puts what the agent can do in the task's result and last line instead: its owner signs in again or connects an account, and meanwhile the agent does the work in its own turn.
- **After a runner restart.** A task whose environment holds a coding plan's key (the journal says so, never the key) is watched with the key read again from the account's folder. When root kept the key, the restarted runner can't have it: it cancels the task, sends nothing the task says, and the agent reads why. A task on an account isn't retried with the other session flag (that needs the account's sign-in again, which the runner never stores); it ends as it ended.
- **Canceled for an account change.** A task canceled because its agent switched or removed the account says so first in its result and last line, so the agent knows to start it again.

### 6. No automatic rotation

When an account runs out of plan, the agent says so and waits, or uses the model fallback. It never moves to another account by itself: subscriptions are personal and rotating them to get around limits can break the providers' terms.

### 7. Removing an account

The owner sees which agents use it and confirms; those agents go back to "Conta deste computador". The runner runs the CLI's logout in that folder and deletes it.

### 8. Security, honestly

The CLI keeps the sign-in in the account folder, and the agent's commands run as the same user, so a hostile agent could reach it, as it can reach `~/.claude` today. The account is as safe as the computer, no more. Isolation (ADR 0030) raises that bar later.

## Consequences

- Positive: one subscription per agent, chosen per agent, added from the phone or the web without a terminal. Our code never holds a token; our server only relays an encrypted one-time code (Claude) or shows a device code (Codex).
- Positive: effort is a real per-agent knob for the computer brains.
- Negative: we read the CLIs' printed output (URL, prompt). It can change between versions: tests use fake CLIs, and on failure the page says so and offers the desktop app.
- Negative: a new runner protocol version, a migration, new UI on the agent page and in the desktop app.

## Alternatives considered

- **A long-lived token per account (`claude setup-token`) kept by the runner.** Simpler sessions, but our code would store a Claude.ai credential. Rejected.
- **The token in the agent's folder.** The agent's own tools read it. Rejected.
- **The token encrypted on our server.** Forbidden for Claude.ai credentials. Rejected.
- **Signing in only on the computer (desktop app).** Safe, but useless from the phone. Kept as the local path.
- **Our own OAuth with the provider's client id, so the redirect comes to us.** That would be passing ourselves off as the CLI. Rejected.

*Amended 2026-11-04:* an account can be a Grok one (`kind: "grok"`, runner protocol 43, ADR 0142): `grok login --device-auth` in its own folder, which is the CLI's `GROK_HOME`, the link and the one-time code shown like ChatGPT's; signed in when the folder holds `auth.json` and `grok models` doesn't say otherwise; `grok logout` before its folder goes. A Grok agent always thinks with one: the computer's own Grok sign-in is never used.

*Amended 2026-11-04:* an account can be a Gemini one (`kind: "antigravity"`, runner protocol 44, ADR 0143): `agy acp --login` in its own folder, which is the CLI's whole `HOME`, Google's link opened and its code pasted back sealed like Claude's; `provider: "enterprise"` for a Gemini Enterprise seat; signed in when `agy models` lists models; `agy -p /logout` before its folder goes. Linux computers only (elsewhere the CLI keeps every sign-in in one keychain). A Gemini agent always thinks with one.
