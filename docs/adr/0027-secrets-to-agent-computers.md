# 0027. Secrets delivered to an agent's computer, end to end

- Status: Accepted (built 2026-10-16). Superseded in part by ADR 0077 (2026-10-28): the cloud computer's helper (`packages/engine/src/secret-helper.ts`) and its command wrapper; secrets reach connected computers through the runner (protocol 3). Amended 2026-10-31 (§7): a site's password is the browser's alone, and a request reaches the person where they wait and on the phone. Amended by ADR 0144 (2026-11-03): a site's password stays in the runner's memory only, a request may carry a username and ask for a code, and the card can save the value to the Vault
- Date: 2026-10-16

## Context

Agents work on computers: their cloud computer (ADR 0021, Daytona) or a connected machine (ADR 0025). Real work there keeps needing something only a person has:

- an OAuth code to finish a CLI sign-in (`claude`, `gh auth login`, `gcloud`, `vercel login`);
- a token for a CLI (npm, AWS, Vercel), a password, a 2FA code, the values of a `.env`.

Today the only way to hand one over is to paste it in the chat. Then the value:

- is stored in `messages` (and in search, summaries, exports);
- is shown to everyone in the conversation;
- goes into the model's context (a third party) and into run transcripts.

Organization credentials (ADR 0007) solve a different problem: secrets **our server** uses (provider keys, connector tokens), encrypted at rest and decrypted by us. Here the secret is for **the computer** only. Some providers also forbid us from holding it at all: Anthropic does not let third-party products "collect, store, or intermediate Claude.ai credentials or session tokens" (Claude Code legal and compliance page, 2026-10).

## Decision

### 1. The plaintext exists only in two places

The person's browser and the agent's computer. Our server, database, logs, outbox, pub/sub, the model and the chat never see it. The server relays ciphertext it cannot open, plus metadata (name, purpose, target, who, when).

### 2. The agent asks with a tool; the person answers in a card

- **`request_secret`** (built-in, scope `sandbox:run`: it needs a computer). Input:
  - `name`: `^[A-Z][A-Z0-9_]{0,63}$` (e.g. `GITHUB_TOKEN`);
  - `purpose`: one sentence shown to the person ("publicar o repositório no npm");
  - `target`: where it goes (section 4).
- The run suspends like `ask_user` (`waiting_input`) until the secret is delivered, declined or expires (15 min). The tool result is only metadata: `GITHUB_TOKEN delivered (env)`, `declined`, `expired`.
- **Who can answer:** only the person whose message started the run (`requested_for`). Everyone else in the conversation sees "Theo pediu um segredo a Walter" and nothing more. An agent can't request a secret for anyone else, and a run started by a routine or by another agent can't request one.
- **The card** (chat, `meta.secretRequestId`): agent, computer (its name; "computador na nuvem" or "MacBook do Walter"), `name`, `purpose`, target, a password field, Enviar / Recusar. After delivery it reads "GITHUB_TOKEN entregue a Theo · 16/10 01:30"; the value is never rendered again.
- **`secret_requests`** table (`org_id`, agent, run, channel, thread, `requested_for`, `name`, `purpose`, `target`, computer ref, `public_key`, `status` pending | delivered | declined | expired, `expires_at`, timestamps). There is no column for the value or the ciphertext.

### 3. Crypto: an ephemeral key per request, generated on the computer

1. On `request_secret`, the server asks the computer for a key pair for that request:
   - cloud computer: a dependency-free Node helper we install at `$HOME/.agentes-secrets/helper.mjs` (rewritten on each secret action, so a recreated computer gets it back; `packages/engine/src/secret-helper.ts`), run through `exec`;
   - connected machine: runner op `secret` with actions `keypair`, `deliver`, `discard`, `remove` (runner protocol 3; older runners are told to run `agentes-runner update`). Each agent's secrets live in `<runner home>/secrets/<agent id8>/`.
   The private key is written to `keys/<requestId>` (mode 600, folder 700) and never leaves the computer. The public key is stored on the request. Keys of requests nobody answered are pruned after an hour, the next time a key is made.
2. The browser encrypts with WebCrypto: ephemeral ECDH P-256 against the computer's key, HKDF-SHA256, AES-256-GCM. The AAD binds the ciphertext to `requestId | orgId | name | target`, so it can't be replayed onto another request or target.
3. `POST /api/app/secrets/{id}/deliver { epk, iv, ciphertext }` (cookie session + CSRF): the server checks requester, status, expiry and size (≤ 16 KB), forwards the payload to the computer in memory and stores nothing of it. The computer decrypts, writes the target, deletes the private key and answers `ok` (with the byte size only). Offline computer or failure: the request stays pending and the person can try again until it expires.
4. Declined: the server tells the computer to delete that private key. Expired or canceled: the key is pruned there (see 1).

### 4. Targets

- **`env`**: one line in `~/.agentes/secrets/env` (mode 600). Commands the agent runs see it as an environment variable: on Daytona our exec wrapper sources that file; the runner adds it to the child's environment.
- **`file`**: a path in the agent's workspace (e.g. `.npmrc`, `.env`), mode 600; paths outside it are refused.
- **`site`** (2026-10-31, §7): a password the agent's browser types on one site (ADR 0040 §5), never in a command's environment or a file.
- **`stdin`** (later): the input of a process that is waiting (a CLI sign-in in a session kept by the computer). Until then, interactive sign-ins use the computer's terminal shown in the app, which talks to the computer directly (Claude Code sign-in must complete through Anthropic's own flow).

### 5. Keeping the value away from the model afterwards

The agent has a shell on its computer, so it can read a secret it was given. We reduce, not prevent:

- **Redaction on the computer:** exact secret values (4+ characters) are replaced with `[secret:NAME]` in command output before it leaves the computer. Cloud computer: when the agent has secrets there, its commands run through the helper (`helper.mjs run`), which gives them the env values and filters stdout and stderr, holding back a tail so a value split across chunks is still caught; without the helper the command runs as is. Runner: in its output, live and final.
- The secrets store sits outside the workspace, so the file tools never see it. Files that hold a secret can't be read, exported or uploaded (`read_file`, `export_file`, `upload_file`; the runner refuses `read` and `push` of them too).
- Tool descriptions and the agent context say: never ask for passwords, tokens or codes in the chat; use `request_secret` and refer to secrets by name.

### 6. Lifecycle and audit

- The agent page lists the secrets on its computer (name, target, delivered by, when), never values, with **Remover** (deletes them on the computer). A cloud computer that is recreated loses its secrets, and the page says so. To rotate a secret, request it again.
- Audit entries: `secret.requested`, `secret.delivered`, `secret.declined`, `secret.expired`, `secret.removed`, with name and target, never the value.
- Limits: at most 3 pending requests per run and 50 secrets per computer.

### 7. A site's password for the browser alone; asked where people wait, on the phone too (2026-10-31)

- **Its own target.** A secret asked for a site (`request_secret` with `site`, the password the browser types, ADR 0040 §5) went in as `env`, like any other: a variable in every command the agent ran, Claude Code's and Codex's included, kept from being printed only by what the prompt says. It is now `{ kind: "site", site }` (the origin, `https://host[:port]`), bound in the AAD (`…|site:https://host`): the runner keeps it out of every command's environment and out of the files it writes for commands, and only the browser's password typing gets it (`browser_type_secret`, a `type_secret` step of `browser_do`), on that origin. The runner checks the origin against the one sealed with it, not only against the server's word. Redaction still covers its value. Secrets for commands (no `site`: API keys, CLI tokens, `.env` files) stay as they were, since agents use them in their commands.
- **A check, not a wall.** The value still sits in the runner's secret store (`~/.agentes-runner/secrets/<agent>/store.json` in personal mode, the worker's home in system mode), a file owned by the user the agent's commands run as, guarded only by the check on what a command names (`SECRET_PATH`). Once the browser types it, it is also in the page, which a command can read through Chrome's DevTools port on 127.0.0.1 (ADR 0040 §13). A command that builds the store's path at run time, or talks to that port, gets the value, and redaction catches only the literal value. The wall is the browser and the store under their own user (protected mode, ADR 0030).
- **Older runners.** A runner that keeps a site's password apart says so in its `keypair` answer (`sites: true`); only then does the server make the request `site`. An older runner gets `env` as before, and its card says so. No protocol bump: an older runner never sees the new target, and one whose runner was swapped for an older one between the key and the delivery refuses the box (its AAD names the site).
- **Said truly.** The card says where each kind goes: "Goes in as the variable NPM_TOKEN on Theo's computer", "Goes to the file .npmrc on Theo's computer", "Only Theo's browser types it, on shop.example.com. It stays out of Theo's commands." The agent's result says the same, and that a command needs it asked again without `site`. The agent's page lists it as "password for shop.example.com".
- Left out: what was delivered before keeps its kind until it is asked again (the runner can't tell an old site password from a command's variable, and moving one would take it from a command that uses it).
- **Asked where people wait.** Nothing but the card told the person, so requests expired unseen (24 of 120 in production by 2026-10-31). A request now notifies the one person who can answer (`secret_request`, in "Waiting for you", with a push, as `browser_ask_person` does): the secret's name and what it is for, never a field. It leaves the inbox when it is delivered, declined, expired or canceled, or its agent is deleted. Its push, its inbox row and the desktop app's notice open its conversation, where its card is.
- **On the phone.** The phone shows the web's card instead of the message's text ("Secret request: NAME" with nothing to type into): who is asked, what for, the name, where it goes, a secure field with Paste, Send and Decline, and the fuse to its deadline; everyone else sees who may answer. It seals on the phone with the same algorithm and bytes (pure-JS `@noble`, `apps/mobile/src/lib/secret-seal.ts`, as for AI sign-in codes, ADR 0041), so the server still only relays a box it can't open.

### 8. A refused key is asked for again; values stay out of what leaves the computer (2026-11-01)

- **Asking again.** Nothing told an agent what to do when a key it holds is refused, so a wrong or expired key stayed until a person removed it. The agent's rules ("How you work") and `request_secret`'s description now say: when a key it was given is refused (a 401, or a 403 saying the key is invalid or expired), first check it was sent as the API's docs say (header, prefix, test or live address); then ask once for a new one under the same name, its purpose saying in one line, in the person's language, what failed ("TYPESAFE_API_KEY was refused (401). Can you send a new one?"). Not when the call works, and if the new one is refused too, say what failed and stop. It is prompt only: no extra model call, no output parsing. A run a routine or another agent started still can't ask (§5), so it says what failed instead.
- **The agent knows its keys by name.** Its context lists the keys delivered to it on its current computer and still there ("# Secrets on your computer", ADR 0017: names and where each goes, never a value), so it asks again under the name it holds instead of a new one that would leave the refused key in place. This is context only; managing keys is the Vault's (below).
- **Who may swap a key, and only once.** A key serves every run of the agent (every channel, every routine), so a request under a held name is refused when the person asked is neither the one who gave the held key, nor the agent's owner, nor an admin: the agent is told to say what failed and who gave it. Otherwise one member's 403 would quietly put their own token in place of the owner's for everyone. And a request under a name whose held value is itself the replacement this same run asked for is refused too ("refused too. Don't ask for it again"), so a key that keeps failing for another reason (a missing scope, the wrong header) never loops through people.
- **The card says it replaces.** A request made while the agent holds that name on that computer (a delivered, not removed request, same agent, name and machine) is saved with `replaces` (migration 0166). While it is pending, the card's "where it goes" line adds "Replaces the key Theo already has under this name." / "Substitui a chave com esse nome que Theo já tem.", on the web and the phone (`secretWhere`); answered or closed, it says only where the value goes. The agent's result after delivery says the new value replaced the one it had. Delivery works as before: the newest delivery wins and the older rows are marked removed.
- **Redaction gaps closed in the runner.** Command output, background tasks, MCP results, Claude Code and Codex events, the desktop's text and the activity log were redacted already. Four paths that leave the computer were not: `read` (a file a command wrote the value into, such as `env > dump.txt`, came back whole through `read_file`); the agent browser's answers (a one-time code just typed into a text field, or a page that shows the key, came back in `get`, a snapshot or an `eval`); a Claude Code tool call's input, redacted on its JSON text, which missed a value with a quote, a backslash or a newline (JSON escapes them), and is now redacted string by string; and a Codex app-server turn's streamed text, sent one batch at a time, so a value cut between two batches left in two unredacted halves: each batch now keeps back the longest secret's length minus one, as Claude Code's does. No protocol change.
- **Still not covered.** Inside a Claude Code or Codex turn, the brain's own model reads its tool output on the computer before our redaction, so an agent that prints a value shows it to that model (the prompt forbids it; Claude Code can't rewrite a shell tool's output). A file pushed to the Drive (`upload_file`) goes as it is, unless it is the secret's own file. A screenshot can show a value. A value that straddles the cut in a long command output can leave a piece of itself. A key whose giver left the workspace is replaced only when its owner or an admin is the one asked. A pending card still says it replaces when the held key is removed before the answer. And a transformed value (base64, split) is still missed.
- Out of scope, for a future Vault module: listing, replacing or removing keys from the app beyond what §6 has, and encryption at rest on the computer.

## Consequences

- Positive: one safe way to give a computer what only a person has, the same for cloud computers and connected machines. The chat, search and the model stay clean, and we never hold users' credentials, which some providers require.
- Negative: we trust the code of our server, not just its storage. A compromised server could hand the browser its own public key instead of the computer's. Showing a fingerprint wouldn't help people in practice; the direct terminal remains the path where even that relay is gone.
- Negative: redaction is best effort. A transformed value (base64, split strings) can still reach the model if the agent prints it.
- Negative: new runner protocol 3 and a helper installed in cloud computers.

## Alternatives considered

- **Paste it in the chat.** What happens today: stored, shown and sent to the model. Rejected.
- **An organization vault on our server, injected at exec time** (like ADR 0007). Simpler, and right for secrets the organization manages (it may come later as "segredos da organização"), but the server sees the plaintext. That isn't acceptable for personal credentials and is forbidden for Claude sign-ins.
- **A form served by the computer itself** (a Daytona preview URL, straight from browser to computer). It bypasses our server entirely, but it only exists for Daytona, not for connected machines, and every computer would need to run a small web server. We keep that direct path only for the interactive terminal.

## Addendum: connectors first

A key for a service we connect natively is the wrong first move: it leaves the connector's scopes, the approvals and the git proxy behind. The Tool Gateway decides this before the card (`tools/connector-first.ts`), from the connector catalog: a `request_secret` naming such a service (its variable, its site, or the purpose of a variable that says nothing) opens no card. It answers in one line with the way in, by how the agent stands with the service: its tools, `request_permission` for a connection it lacks, `offer_connect_app` for one the workspace hasn't, or how an admin does it.

What goes on as before: a service this server can't connect, a one-time code, a file of the project (`.env`, `.npmrc`), a key the agent already holds (given or in the Vault), and a key a person asked for. That last one is checked, not trusted: the agent repeats the call with `person_said`, and those words must be in a person's recent message in the conversation.
