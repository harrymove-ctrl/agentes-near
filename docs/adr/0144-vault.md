# 0144. The Vault: logins, keys and contacts agents use, personal or the team's, from any source

- Status: Accepted (built: the server, the runner, the web and the phone app)
- Addendum, 2026-11-10: §9, logins agents save in a connected password manager (sources may write)
- Date: 2026-11-03
- Amends: ADR 0027 (§7: a site's password is kept in the runner's memory only, never in `store.json`; a request may
  carry a username and ask for a code; the card can save the value to the Vault), ADR 0040 and 0054 (the browser
  types a Vault login), ADR 0133 (Chrome's own password manager is off in agent profiles)
- Builds on: ADR 0007 (sealed values at rest), ADR 0002 (adapters and modules), ADR 0053 (who is behind a run),
  ADR 0085 and 0125 (roles as an audience), ADR 0110 (browser profiles), ADR 0117 (injection hardening)
- Code: schema `packages/db/src/schema/vault.ts` (`vault_items`, `vault_connections`, `vault_uses`), migration
  `0214_vault`; engine `packages/engine/src/vault/*` (access, items, connections, sync, CSV import, uses, the agent
  tools in `tools.ts`); sources `packages/adapters/src/vault/*` (the port `source.ts`, the site rule `site.ts`,
  `onepassword.ts`, `bitwarden.ts`); the box's additional data `vaultAad` in `packages/adapters/src/secret-box.ts`;
  protocol 45 (`VAULT_PROTOCOL`, `vault.key`, `agentes:type_vault`, `exec.vault`), protocol 48 (`vault.password`) and
  the runner's in-memory store
  `apps/server/runner/vault.ts`; routes `apps/server/src/routes/app/vault.ts`; client `packages/client/src/vault/*`;
  web `apps/web/src/components/vault/*`; phone `apps/mobile/src/features/vault/*`

## Context

Agents sign in to sites, call APIs and fill in forms for people. Until now each password or key reached them through
a request card (`request_secret`, ADR 0027): typed by one person, for one run, kept on the computer. Nothing was kept
for next time, nothing could be shared with a team, and the values people already keep in a password manager
weren't reachable. A site's password also sat in the runner's `store.json` as plain text.

People need one place for what agents use, which works for a team (who may use what, on whose behalf) and for one
person (my own logins, used only when I ask), and which reads the password manager a company already has.

## Decision

### 1. What the Vault holds

- **Login**: website, where it may be typed (`exact`, the default: that origin only; or `site`: any HTTPS page of
  the same registrable domain, by the public suffix list with private suffixes, so one `*.github.io` site never fills
  another's), username, password.
- **Key**: a variable name (`SECRET_NAME`, never a reserved name), a description, the value.
- **Contact**: name, company, tax id, email, phone and address. Not a secret: agents read the fields and type them.
  Still sealed at rest, as personal data.

No authenticator seed is stored: a login that keeps its second factor next to its password stops being two factors.
A code from a text message or an email is asked of the person when it's needed (§6).

### 2. Personal or the team's, and one rule for use

Each item is **personal** (its owner alone sees, edits and deletes it) or **the team's** (created and edited
with `manage_credentials`; its audience, everyone or roles or people, says who sees it). Each item also lists the
agents that may use it, or all of them.

An agent may use an item in a run when:
- the agent is on the item's list; and
- personal: the person behind the run (who asked, else the routine's creator, ADR 0053) is the owner;
- team: that person is in the audience, or nobody is behind the run and the audience is everyone.

The check runs at every use, with no cache: someone who leaves a role or the workspace stops counting at once. A
person who leaves takes their personal items and connections with them. New team items start open to everyone and
to no agent; an item saved from a request card starts with the agent that asked.

**A saved value never comes back to a person.** Once a password or a key is saved, no answer carries it to anyone:
not its owner, not the people who manage credentials. An item's page says one is saved (a key, by its last four
characters), and changing it means typing a new one. Only an agent's computer gets it, sealed for one use (§4), so a
value leaves a person's screen once, as it is typed, and never comes back to one. A contact isn't a secret:
whoever sees the item reads it.

Two narrower rules:
- **Routines type logins but give no key to a command.** A run a routine feeds (ADR 0053 §3: its own run, or one its
  report or work woke) never sends a credential, and a command holding a key could send it anywhere, so `run_code`
  with `keys` is refused there ("A routine can't use Vault keys in commands…"). A saved login it may still type in
  the browser: that value never reaches the model or a command.
- **A shared browser profile (ADR 0110) takes only what all its agents may use, for anyone.** A session signed in
  there is every granted agent's, whoever each one works for, so a personal login is never typed in one, nor a team
  login open only to some people or roles; a team login open to everyone, only when it is shared with all agents or
  with each agent the profile is granted to (the grants read at the fill).

What agents change: a contact they keep for the person behind the run, a login's username, an item's description,
on that person's own items, or on the team's only when that person manages credentials, as in the app. An agent
deletes only what it saved itself; everything people saved, people delete in Settings › Vault.

### 3. Sources

A source (`VaultSource`, `packages/adapters/src/vault/source.ts`) connects, lists metadata and reveals one value on
demand; one that can also keeps a new login and changes one it holds (§9). Nothing else knows which source an item comes from: access, history, the box to the computer and the
runner's checks are the same for all.

- **Built-in**, always on, needs only Postgres: values sealed like every org credential (ADR 0007), with additional
  data that binds org, item, owner and version (`vault-item|org|item|owner|version`), so a row moved or restored onto
  another owner doesn't open.
- **1Password**: a service account the person creates with access to one vault only (the connection refuses one
  that sees more). Overviews are listed every 10 minutes; a full item is read only when it's new or changed, since
  service accounts have read limits. Passwords are read at use and kept nowhere.
- **Bitwarden and Vaultwarden**: a client of their API written here (no CLI to download), with the account's API key
  and master password, reading the logins of one folder. The master password opens the whole account, so the screen
  asks for an account made only for agents. A self-hosted server's address is typed by a person, so every request
  goes through the server's guarded fetch (`publicHttpsFetch`): https only, every address the host resolves to
  public, the socket pinned to the address checked, no redirect; a refused address is `invalid_input`. The key
  derivation the account's server asks for is capped (Argon2id's memory times its iterations at most 256 MiB, e.g.
  64 MiB with 4 iterations; heavier is `unsupported`) and runs one at a time per workspace, two at most across the
  process; every call into a source has a 60 s deadline.
- **Modules** add sources through `AgentesModule.adapters()` (`vaultSources`, merged by kind).

A source's items are indexed (`vault_items`, metadata only) and follow the connection's default access until someone
changes theirs. An item gone from its source is marked missing, not deleted, so its history stays. The workspace's
item limit counts them too: at it, the items already indexed stay and new ones wait, the connection showing
`too_many_items` ("Remove items before syncing more") until a later sync finds room; what is missing is decided by
the source's list alone.

### 4. Filling without asking

A saved login is typed without a person's yes each time. The guards are elsewhere:

1. **The model never gets a value.** Tools return names, sites and usernames; a value never enters a tool argument
   or result, a message, a log, an audit row, an event or an outbox payload.
2. **A one-use key in the computer's memory.** For each fill the engine asks the agent's runner for a key
   (`vault.key`, protocol 45). The runner keeps the private key in memory only, for 2 minutes and one opening, in the
   agent's own worker in system mode, so root never sees the value. The server seals the password to it with the
   ADR 0027 box and additional data `agentes-vault|v1|key|agent|fill:<rule>`, which the runner rebuilds from its own
   record: a box replayed to another key, agent or site rule doesn't open.
3. **The runner checks the frame that owns the field, when it types.** In one browser invocation it focuses the
   field, checks that its frame's origin and every ancestor's match the rule, that it is a password field and that
   neither its form nor a submit button of it (`formmethod`) sends by GET, marks that field with a one-time
   attribute, fills the element carrying the mark (a page that moved on has none) and takes the mark off. The value
   is dropped when the batch ends. The page's own scripts can patch the DOM the check reads; they can't fake
   `location`, `ancestorOrigins` or `top`, so what the check guarantees is the origins the value goes to, and the
   field checks catch honest mistakes (a script of the rule's own site could read the field anyway). A field inside
   an embedded frame (the ref is the frame itself) gets nothing (`in_frame`): the agent asks the person to sign in
   there through the browser hand-off (`browser_ask_person`).
4. **A typed value doesn't leave in an address.** Before a password is typed, its Chrome pauses every request and
   the fill waits until Chrome acknowledged that on every page and frame, those opened since an earlier fill too
   (unconfirmed, or refused by one still open: nothing is typed); for 2 minutes then, a request whose URL carries
   the value (raw or encoded) is stopped, and the agent is told. A fill that was refused takes the guard back.
   A dedicated worker has no `Fetch` of its own and its requests pause on its page's session, so it isn't asked.
5. **Replies are redacted.** For 10 minutes the value is removed from every browser reply and error, browser
   profiles' included.
6. **Chrome keeps nothing.** Its own password manager, sign-in and form autofill are off in every agent profile.
7. **Every use is recorded** on the item (who, where, for whom) and in the audit log.

Keys follow the same path to step 2, then go into the environment of one command only (`run_code` with `keys`,
`exec.vault`), with its output redacted, and are kept nowhere; never in a run a routine feeds (§2). Computer brains,
whose own shells can't take a value for one command, reach the same path through a tool. A key's use is recorded
once the computer took the command with it: an answer came back (any exit code), or none did (the link dropped, no
answer in time). Not when the command never reached the computer or the runner refused it before opening the keys
(the command policy, a switch, a key it couldn't open).

What agents read of an item (its title, username, description, a contact's fields) was written by people, agents,
password managers or CSV files: `vault_list` gives each item's text in its own `untrustedBlock` and counts as
reading outside text (ADR 0117). No other tool text carries it: refusals, `vault_save`'s answers and a browser plan's
report name an item by its id and what the server checked when it was saved, a login's site and a key's variable
name (`vaultItemName`: "Typed the Vault login for github.com"). `vault_list` records a read only for the contacts it
shows.

### 5. What it doesn't protect against

- **The agent's own code on the same computer.** A key exists for its commands to use. A typed password sits in the
  page, which a script running as the same user can read through Chrome's debugging port. Redaction, the outbound
  checks (ADR 0117) and the field going unreadable to the agent's tools narrow it; running the browser as another
  system user would close it, and is left for when browser profiles move to their own users (ADR 0110, phase 2).
- **The server itself.** It opens built-in values and uses the connections' credentials, as it does for model keys.
  The database alone opens nothing; the database and the server's key together open everything. A module can keep
  that key in a KMS (ADR 0007).
- **An agent already signed in** can do wrong things with the session, as a person could. Sensitive actions keep
  asking for approval (ADR 0015).
- **A session stays in the agent's browser.** A session an agent opens stays in its own browser for its later work,
  so on an agent several people use, people give it logins meant to be shared, not personal ones.

### 6. The request card

`request_secret` keeps its card and gains:
- **Save to the Vault**, checked by default for a site's password and for a key, never for a file or a code:
  personal or the team's (the team's only with `manage_credentials`), and the agents that may use it, starting with
  the one that asked. The card delivers the box as before and then sends the value once, over TLS, to be sealed in
  the Vault: the only moment the server gets a value a person typed.
- A **username** the agent gives when it knows it, shown on the card and kept with the login.
- A **label** in the agent's words ("Senha da Conta Google"). The `name` is the agent's own: people read the label, or
  one the apps derive from the kind and site, on the card, in notifications, the Vault, the audit and Atividade.
- A **code** mode (`digits`), with one box per digit, typed by the runner into one field or one field per digit.

A site's password from a request is no longer written to `store.json`: the runner keeps it in memory for 15
minutes (`SITE_SECRET_TTL_MS`, the protocol's), and drops any site entry left in the file when it loads. The server
counts it gone after the same 15 minutes: the agent isn't told it still holds it, the agent's page doesn't list it,
a new request doesn't "replace" it, and an agent that tries to type it hears plainly that it was kept in memory only
and is gone (ask again, or save it to the Vault). Keys and files asked with `request_secret` (`env`, `file`) are
unchanged.

### 7. Screens

In Portuguese the feature is called **Cofre**; every other language keeps **Vault** as its name.

Settings › Vault, on the web and the phone: Team, Personal and Connections, each item with who may use it and its
last use (a contact by its title and description: the list carries no contact's details, so it opens no contact's
seal); an item's page with its fields (a password or a key always behind its dots, §2; a contact whose saved
details don't open on this server says so, and is never changed on top of nothing, for a person to save them again),
who has access in one sentence and its recent uses; a new item on that same page, empty (its kind and fields, who may
use it beside them); a CSV import from a browser or password manager export (web), which keeps nothing of the file;
and one card per source to connect, generated from what the source describes.
The apps reload the Vault on `vault.changed`, sent when an item, a connection or an access changes, never for a use
alone (a fill, a key or a read): agents at work don't make every open app reload it.

### 8. Passwords agents make

An agent making an account of its own needs no person: asked to invent a password, a person gives one the agent can't
keep, and a form sent with a password nobody kept is a locked account. `browser_make_password` (browser and `vault:write`
scopes) and, for what a command uses, `vault_make_password` (a key, through `run_code`'s `keys`):

1. The engine makes a key pair for this one call and sends `vault.password` (protocol 48, `VAULT_PASSWORD_PROTOCOL`)
   with its public half, the agent's rules (`length`, `classes`) and a request id. An older runner never gets it, and
   the agent reads that its computer needs an update.
2. In the agent's own process (its worker in system mode) the runner makes the password from the OS's random source,
   at least one character of each class, and answers it sealed with the ADR 0027 box, bound by `madePasswordAad`
   (request and agent). Root, the hub and anything relaying hold a box. No command line, log, argument or tool result
   carries the value, and the model never sees it.
3. The engine opens the box in memory and seals the value into the Vault, as the card's "Save to the Vault" does for a
   person's value (§5: the server sees built-in values, the database alone opens nothing). Only then is it typed.
4. Typing is the ordinary login path of §4 (`agentes:type_vault`, once per field, password and confirmation): the same
   origin, frame and field checks, guard, redaction and use record.

Saving comes first so no form can go out with a value the Vault doesn't hold. A save that fails types nothing. A fill
that leaves a field empty puts the Vault back as it was and says not to send the form. A password that replaces another
keeps the old one sealed behind it (`previous_secrets`, its own version in its own seal, 5 at most): the site may have
turned the new one down, or a retry may have run after an accepted change, so `undo` brings the old one back. Past 5,
the oldest stays: it is what the site had before any of these tries, and a page's words reach the agent. `undo` puts
what it replaces at the far end, so more of them step through every value and none is lost, and `vault_list` says when
an item has some. A person's new value clears them.

What it makes: for a login, the page's own origin with `match: site`, since sign-up and sign-in are often on different
hosts of one site, and the `username` it must give. The same login again (the person's own first, then the team's) takes the
new value, on the terms of §2, and an agent may always change what it made. A new one is the team's, open to everyone,
for this agent, or for every agent of the shared browser profile it is made in: the session it opens stays in the
agent's browser for all its work (§5), so the agent's next run needs it whoever asked. It shows in Settings, Vault with
its site and username, where people replace it as any other, and the value comes back to nobody (§2). Every step is in
the audit log, never with the value. Desktop apps stay out: nothing types a password there.

### 9. Logins agents save in a connected password manager

A workspace whose agents' logins all live in 1Password expects a login an agent makes to land there too, and an agent
that can't tell where an item is kept tells people the wrong place. So places are named, and sources may write.

**Every item says where it is kept.** `vault_list` puts the place on each item (`kept in the Vault`, `kept in
1Password · "Agents"`: the brand and what the connection reads, as one short quoted line) and, when a password manager
is connected, lists the places with whether each takes a new login and where a login the agent makes will go. The
tools that answer about one item (`vault_save`, `browser_make_password`) name its place the same way.

**Where a new login goes** (`destinationFor`, `packages/engine/src/vault/agents.ts`), for a password an agent makes
(§8):

1. The place the person named (`save_in` on `browser_make_password`: `vault`, or a connected password manager by its
   name, what it reads, both, or its id). A place that can't take it is refused, saying why; nothing goes elsewhere
   quietly.
2. Else the one connected password manager the run uses by default (the connection's own access gives this agent use
   for the person behind the run) that takes new logins: that is where the agent's logins live.
3. Else the Vault: no password manager, more than one that takes new logins (the agent is told to name one), only
   read-only ones, or one a shared browser profile couldn't type from (§2: the connection must be the team's, open to
   everyone, for every agent of the profile).

The answer always names the place and, when a rule chose it, why. The same site and username again changes the login
where it is: in a password manager when its source can change one (the old password is read first and sealed behind
the row here, `previous_secrets`, so `undo` writes it back, as for a Vault item); when it can't, the new password is
kept in the Vault as a new login and the answer says the one in the password manager still has the old password. A
login made in a password manager follows that connection's access, like everything read from it, and is indexed from
the write's own answer (`indexSourceItem`), so it shows at once, without waiting for the next sync. A key
(`vault_make_password`) is always the Vault's. `vault_save` changes a login's username in a password manager that
takes changes, on the same terms as in the Vault (the owner's own, or the team's for who manages credentials).

Nothing is deleted from a password manager, ever. A login made there whose form was never filled stays, and the next
call replaces its password.

**The same permission as the Vault.** Writing to a password manager needs what writing to the Vault needs (the
`vault:write` scope checked by the tools, §8), replaces only what the run could replace in the Vault (its own, the
person's, or the team's for who manages credentials), and leaves the same trail: `vault.item_created` and
`vault.item_changed` in the audit log with the source's kind, a use on the item, never a value. No value is in a
source's answer, an error or a log: a source returns metadata, and its failures are our words (§3).

**Read-only connections.** A source refuses a write its credential may not make as `read_only`. The engine remembers
it on the connection (`config.readOnly`, cleared when a person connects it again, since `connect` returns a new
config), the connection shows "read-only" in Settings, Vault, Connections, `vault_list` says so, and the rule stops
trying it. The refusal the agent gets says the cause and the way out: the token can only read, and someone who
manages the connection reconnects it with one that also writes. Nothing tells a read-only credential from one that
writes before the first write (1Password's SDK shows no permissions), so it is found then.

What each provider allowed, read in its documentation on 2026-11-10 (no live account was used: the request shapes
are the documented ones, exercised against fakes):

- **1Password, service account token** (what a connection holds). Creates and edits items through the SDK
  (`items.create`, `items.put`; `@1password/sdk` 0.5.0) when the service account was made with read and write access
  to the vault ("Read & Write" on the Developer page; `--vault name:read_items,write_items` in the CLI). Permissions
  can't be changed after creation: a read-only one is replaced by a new service account. A login is created as the
  documented `Login` item (`username` Text and `password` Concealed built-in fields, a website with its autofill
  behavior, notes); a change puts back the item exactly as read with one field's value changed. A refused write is
  recognised by 1Password's words about permissions (documented: "don't have the right permissions"), or a bare 403.
  Docs: <https://www.1password.dev/sdks/manage-items/>, <https://www.1password.dev/service-accounts/get-started/>,
  <https://www.1password.dev/service-accounts/security/>.
- **Bitwarden and Vaultwarden, personal API key and master password.** The API key is the whole account's (scope
  `api`), and the master password gives the account's key, so there is no read-only kind. A new login is a
  `POST /ciphers` as Bitwarden's own clients send it (`CipherRequestModel` in bitwarden/server,
  `cipher.request.ts` in bitwarden/clients): every text an EncString of type 2 under the account's key
  (`bitwarden-crypto.ts`, the primitives the reads use, round-tripped in tests), in the agents' folder, a website
  with its checksum. That endpoint is the product's own API, not a documented public one (the public API covers
  organizations, not items; the documented way is the CLI's `bw create item`, <https://bitwarden.com/help/cli/>),
  as the reads already are. A login already there is **not** changed: `PUT /ciphers/{id}` replaces the whole login
  (passkeys, attachments, custom fields, history), and what this client doesn't read it can't send back.

Left out: saving a person's typed password from the request card (§6) into a password manager (the card's "Save to
the Vault" still means the Vault: where it goes and who may use it are the person's choices on that card, and a
password manager's access is the connection's); keys in a password manager; changing a Bitwarden login; deleting or
archiving anything; a description or notes on a made login; telling a read-only credential before the first write.

### 10. A connection starts open to every agent, and an agent can tell "connected" from "no access"

A team connection used to start with no agent, like a team item, and connecting asked only "the team's or personal".
The person finished connecting, asked an agent for a login, and the agent answered as if nothing were connected: its
empty answer was the same in both cases. The product's defaults are open, and admins narrow them.

- **Default at connect.** A connection made without an access gets `DEFAULT_CONNECTION_ACCESS`: `allAgents` for both
  scopes (a team one: everyone in the workspace asks, any agent uses, a personal one: its owner asks, any agent
  uses). `allAgents` is a standing choice, not a list taken that day, so an agent created later is in. Items saved
  by hand keep §2's default (a team item: no agent yet): a person saves those one at a time and picks there.
- **The end of connecting.** The same as a tool's: "<name> connected", one sentence on who can use it (the access
  sentence the server's rule gives), "Ajustar" (the connection's default access) and "Pronto". On the phone, the
  same note and buttons on the connect screen.
- **Connections made before.** Nothing changes for them. One no agent may use (`allAgents` off and no agent picked)
  says so on its row, with the way to its access for who manages it.
- **What an agent is told.** `vault_list` adds, for each connection the person behind the run may know of (their
  own personal one, a team one whose audience they are in) that this agent is not shared with: the manager's name
  and the connection's label, team or personal, whether any item was read from it ("has items", never how many),
  and who gives access (its owner, or whoever manages credentials). No item of it, in any form. A connection the run
  may not know exists (§2's `hidden`) is never named.
- **Who changes it.** Unchanged: its owner for a personal one, `manage_credentials` for a team one, checked on the
  server. Anyone else gets "not found".
- The right hand has no Vault tools (`vault:read` is not among its fixed grants), so it gets this only once that
  scope is granted to it.

## Consequences

- Agents find what they need before asking (`vault_list`), and a password typed once in a card can serve the next
  time.
- Old runners (protocol < 45) never receive a Vault value; the agent is told the computer needs an update.
- More values pass through the server than with request cards alone. The Vault is opt-in per item, and the card says
  so.
- Left for later: the browser under its own system user, usage alerts to an item's owner (first use on a new site,
  bursts), Bitwarden organization collections, 1Password's desktop app as a source.
