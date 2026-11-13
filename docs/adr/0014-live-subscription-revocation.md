# 0014. Membership changes revoke live WebSocket subscriptions

- Status: Accepted
- Date: 2026-10-14
- Extends 0010.

## Decision

Engine functions that remove access publish an `OrgEvent` on the server-side topic `org:{orgId}`:

- `removeChannelMember` → `{ type: "membership.revoked", userId, channelId }`
- `removeMember` (leaving or removed from the org) → `{ type: "membership.revoked", userId }`
- archiving a channel → `{ type: "channel.archived", channelId }`

Each WebSocket connection listens to its org topic. A channel revocation for its person drops that subscription and sends `{"type":"unsubscribed","channelId","reason":"revoked"}`; an org revocation drops all of them, sends `{"type":"error","code":"membership_revoked"}` and closes with code 4403; an archived channel is dropped for everyone (`reason: "archived"`). A revocation that arrives while a subscribe is being authorized marks it, so a stale "allowed" can't win the race.

Connections also listen to `user:{orgId}:{userId}` and forward those events as `{"type":"event","scope":"user","event"}` (approvals waiting for that person, DMs).

## Consequences

- The database stays the authority: subscribe and every HTTP request still re-check access. Events only shorten the window from "until reconnect" to "now".
- Publishing is best effort; a lost event degrades to the old behaviour.
