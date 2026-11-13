# 0006. Better Auth for people; our own organizations, roles and agents

- Status: Accepted. Revised by ADR 0068: a workspace's invitation link only lets people ask to join, an admin approves each person, and only an email invitation opens sign-up. Amended by ADR 0078: a live sign-up mode, and early-access invitations that open sign-up for one address. Revised by ADR 0085: the fixed owner / admin / member table became roles that add up (owner stays a flag), and permissions are resolved per person
- Date: 2026-10-14

## Decision

- **Better Auth** handles people: users, sessions (HttpOnly cookie, same origin as the web app), email + password, optional Google/GitHub, rate limiting. Mounted at `/api/auth/*`, tables `users`, `sessions`, `accounts`, `verifications` via the Drizzle adapter. Its secret derives from `AGENTES_SECRET`.
- **A provider joins an existing account** by its address only once that account's address is confirmed (Better Auth's `requireLocalEmailVerified`, kept on): whoever made an unconfirmed password account may not own the address, and linking would let them in. Confirming the address wouldn't stop them either, since their password would keep working in the account the provider then joins. So the refusal (`account_not_linked`) comes back to the sign-in page with the provider's address, which says to sign in with the password or make a new one by email (the forgot-password step, with its bot check and 3 emails an hour per address). A password reset confirms the address, since its link reached the mailbox (`onPasswordReset`), and ends every session (`revokeSessionsOnPasswordReset`): the provider joins only once the password nobody proved is gone. Where the server sends no email, only the password. Better Auth refuses the same way when the provider hasn't confirmed its own address: where the account here is confirmed, that comes back as `provider_email_unverified` instead (`authHandler`), which says to confirm it at the provider or sign in with the email.
- **agentes.chat owns tenancy:** `organizations` (with `context`, injected into every agent prompt), `organization_members` (owner / admin / member) and `organization_invitations` (7-day links, only the SHA-256 of the token stored, accepted only by the invited email). The Better Auth organization plugin is not used.
- **Permissions** (`@agenteschat/engine` `can`, `requirePermission`), checked on every request:
  - member: `read`, `post`, `create_channels`
  - admin: + `configure`, `manage_agents`, `manage_credentials`, `view_usage`, `manage_members`
  - owner: + `manage_owners`. An organization always keeps an owner.
- **Channel access** is one function, `requireChannelAccess` (org member + channel in that org + channel member), used by the HTTP API and the WebSocket.
- **Agents are not users.** They live in `agents`; messages have a polymorphic author (`person` | `agent`). Agent permissions will come from their scopes (Tool Gateway), never from roles or prompts.
- **Sign-up policy (self-host):** the first account may always sign up and becomes owner of any existing organizations; afterwards sign-up needs `ALLOW_SIGNUP=true`, the operator API's live mode `open`, a pending invitation (an email invitation: an invitation link never opens it, ADR 0068), or an early-access link sent to that address (ADR 0078). The Cloud keeps public sign-up closed until billing ships (ADR 0068). An install that leaves an owner link or the desktop app's owner key (`OWNER_CLAIM_SHA256`, `OWNER_KEY_SHA256`) keeps the first account for them (ADR 0060 §6).
- **App API** `/api/app/*` is private to our web app: cookie session, CSRF protection (writes need our `Origin` and a JSON body), described in the OpenAPI document so the web app can generate a typed client.

## Consequences

- No external identity provider; self-host stays one container + Postgres.
- Composite foreign keys `(org_id, id)` keep channel memberships, messages, runs and usage from pointing across organizations.
- Later: Better Auth `jwt` + `oauthProvider` for MCP clients.
