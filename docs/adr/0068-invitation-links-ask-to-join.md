# 0068. An invitation link asks to join; an admin approves

- Status: Accepted (built: server, web, the shared client and the phone app). Revised by ADR 0072: on a server that sends email, an address proves itself with a code before it asks, and an approval lets in at once only a confirmed account whose address was proven. Amended by ADR 0078: an early-access link also opens sign-up, for the address it was sent to. Revised by ADR 0090: a proven ask carries a password, and an approval makes that account
- Date: 2026-10-26
- Revises: ADR 0006 (the organization-wide invitation link, and the sign-up policy's link path)

## Context

A workspace's invitation link let anyone signed in who opened it join as a member, with nobody asked, and its token
opened sign-up on a server with closed sign-up. Links get pasted in group chats and forwarded. Any account can create
a workspace, and on agentes.chat, where public sign-up stays closed until billing ships, every workspace gets a paid
computer: a leaked link handed computers to strangers. Email invitations are bound to one address and accepted only
by an account with it.

## Decision

1. **A link only lets people ask.** Accepting with a link's token is refused (`invitation.ask_to_join`). Email
   invitations are unchanged: they join directly.
2. **Asking needs no account.** Signed out, a person gives a name (1 to 80 characters), an email and an optional
   note (up to 200, shown in the app only, never in an email or a push); signed in, their account asks. Requests
   live in `organization_join_requests` (`invite-requests.ts`).
3. **Owners and admins answer** in Settings › Members, or in the phone app's Requests sheet: approve with a role
   (member or admin, member by default) or deny with an optional reason the person is told by email.
4. **An approval lets in only whoever controls the address.** A signed-in account with that address confirmed
   (`users.email_verified`, not blocked) joins at once. Every other request gets an email invitation to the address
   with that role (`sendInvitation`, 7 days), worded as the answer; an address that already has an invitation gets
   that one again, never a second, with the higher of the two roles, and an owner's invitation goes out again only
   from an owner (the invite form follows the same rule). Someone who types a colleague's name and email gets
   nothing: the invitation goes to the colleague's mailbox.
5. **A link no longer opens sign-up**; only an email invitation does (`isSignupAllowed`). The `x-invite-token`
   header and `inviteToken` on the sign-in options are gone.
6. **Admins are told three ways:** the in-app notice `join_request` (waiting, one row per workspace that merges a
   burst while unread, no actor, the newest name in `latest.title`), a push for the row's first event only, and an
   email at most once an hour per workspace (key `join-request:{orgId}:{hour}` per language). The email's Approve
   and Deny open the request in Members (`?request={id}&do=approve|deny`); a link in an email never acts by itself,
   because mail scanners open every link. On the phone, the push, the Activity card and `agenteschat://join-requests`
   open the Requests sheet. A request closes when its address joins another way, and the notices close when nothing
   is left waiting.
7. **The person is told by email** whatever the answer ("You're in", an approval with the invitation to accept, or
   not approved with the admin's note), in the account's language or the one of the page they asked from. A
   signed-in person whose address is confirmed also sees it on the link's page, which checks every 15 s while open;
   an approval shows there only while it means something (they're in, or its invitation still waits). A request
   typed for their address shows there as waiting only once they ask, which makes it theirs: approved before that,
   it sends an invitation. An account whose address isn't confirmed hears the answer by email only, like a typed
   request.
8. **Limits.** 10 asks an hour per IP (`join.rate_limited`), and 20 new requests an hour per link
   (`join.link_busy`, per server process, like every rate limit here): a proven ask counts only when it files one,
   and on a server without email every ask does, so asks without a right code (ADR 0072) can't use up a link's
   hour; at most 50
   waiting per workspace (counted under an advisory lock, so it holds across replicas); one waiting request per
   address (a partial unique index); a denied address can't ask again through a link while the denial is kept;
   requests close unanswered after 14 days; rows are deleted 90 days after their answer or expiry, in the daily
   tick. A typed request, or one from an account whose address isn't confirmed (anyone can sign up with an address
   that isn't theirs), gets the same answer after the same work whatever the address (already a member, already
   waiting or denied): the reply checks only the link and the cap, and a job (`join_request.file`) looks at the
   address and files the request. A full workspace refuses every such address alike. So a link never tells whoever
   holds it who works at a workspace or who was turned down, not even by how long the answer takes. A paused
   workspace's link says only that it no longer works.
9. **One link per workspace, shown again whenever needed.** Its token is an HMAC of its id under a key derived from
   `AGENTES_SECRET` (purpose `invite-links`, as the git proxy's credential, ADR 0024); only the token's hash is
   stored. `POST …/invite-links` returns the active link or makes one, so the onboarding and Members show the same
   link. Links work for 30 days. Turning one off closes the requests made through it, without emails.
10. **Audit.** The request row is the trail (who asked, through which link, who answered, when, with which role or
    reason); `audit_log` records `join_request.approved`, `join_request.denied` and `invite_link.turned_off`, and
    invitations sent by an approval are `invitation.created { fromRequest: true }` in the operator feed.

## Consequences

- Links made before this keep their address and work as request links until they expire (7 days at most). Their
  random token can't be shown again: Members lists them as earlier links, to turn off.
- An expired link loses "ask for a new invitation": its page says it no longer works. Expired email invitations
  keep it.
- A phone build from before this gets 409 when it taps Join on a link; the app and the server move together.
- A self-hosted server without email still works: approving a typed request hands the admin the invitation link,
  and the approved person's page says an admin will send it.
- Hourly limits are per replica; the cap and the one-per-address rule are in the database.
- No captcha and no disposable-domain list: both need outside services, and approval plus the cap bound the harm.

## Alternatives considered

- Sign up first, then ask: the link would have to open sign-up again, and an unconfirmed account could be approved
  into someone else's address.
- One-click Approve and Deny links in the email: mail scanners follow them.
- A role chosen per link: one choice at approval, when the admin knows who it is, is enough.
- Keeping 7-day links: approval makes a link safe for the month a team takes to arrive.
