# 0158. Passwords on a server that sends no email

- Status: Accepted
- Date: 2026-11-09
- Amends: 0006 (password reset only by email), 0060 §6 (the owner key signs the desktop app's owner in)
- Code: engine `password-link.ts` (`issuePasswordLink`, `memberPasswordLink`, `passwordLinkByEmail`); server
  `routes/app/account.ts` (`POST …/members/{userId}/password-link`, `POST /me/password` replaces a password after a
  fresh sign-in), `auth.ts` (`onPasswordReset` on every server), `native.ts` and `main.ts` (`password-link`); web
  `pages/AuthPage.tsx` (the server line, the forgot step without email), `pages/MembersPage.tsx`
  (`PasswordLinkDialog`), `components/AddPassword.tsx`

## Context

A server that sends no email (the desktop app's own server, most self-hosted ones) hid "Esqueci a senha": the reset
link only travelled by email. Whoever forgot their password there had no way back in, and nothing said so. The
server's owner signs in on its computer without a password (0060 §6) but could not set a new one: a password could
only be added to an account that had none.

## Decision

1. **"Esqueci a senha" always shows.** Without email, its step says the way instead of sending: on the server the
   desktop app runs on this computer, "Continuar neste Mac" and then a new password; anyone else asks one of their
   workspace's owners for a new-password link.
2. **A workspace owner makes the link** (Membros › the person › "Gerar link de senha nova"): Better Auth's own reset
   token (a `reset-password:<token>` verification), so `/reset-password?token=` and `POST /api/auth/reset-password`
   take it as they take the emailed one. It works once, for an hour; a new one ends the earlier one. Refused on a
   server that emails (the person asks for their own), for oneself, for the server's owner (who signs in on its
   computer) and for anyone who also belongs to a workspace the actor doesn't own, so no owner takes over an account
   they don't answer for. The workspace's audit log keeps who made it, for whom and until when, never the link.
3. **The command line**: `agentes-server password-link <email> [--data <folder>]` (with the server stopped: its
   database is the folder's) and `main.ts password-link <email>` (Docker) print a link for that account. Whoever runs
   the server already reads its database.
4. **A fresh sign-in may replace a password** (`POST /me/password`, a sign-in in the last 10 minutes, as adding one
   needs): the owner after "Continuar neste Mac", or anyone who just signed in.
5. **What a reset does**: every server cuts off the AI apps and personal tokens the old password let in (0119) and
   every other session; only an emailed link confirms the address (an owner's link proves nothing about the mailbox).

## Consequences

- Nobody on a server without email is locked out for good: the owner through the computer, others through an owner,
  and the operator through the command line.
- An owner who can make a link can sign in as that member until they notice; the audit log and the rule about other
  workspaces bound it.
