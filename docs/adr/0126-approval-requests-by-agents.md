# 0126. Approval requests by agents

- Status: Accepted
- Date: 2026-11-02
- Amends: 0015 (who decides an approval), 0085 (roles as approvers)
- Code: `packages/engine/src/approval-requests.ts` (`request_approval`, `resolveApprovers`), `approvals.ts` (`decides`,
  `approverIds`, `seenBy`), `tools/gateway.ts` (`ToolDefinition.approvers`), `tools/run-policy.ts`, `executor.ts`
  (who refused), `context.ts` (`REQUEST_APPROVAL_LINE`); `apps/server/src/routes/app/approvals.ts` (`approvers`);
  `packages/client/src/lib/approval-words.ts` (`approvalWaitsFor`, `requesterDecidesLine`); web `ApprovalAsk.tsx`,
  `ApprovalItem.tsx`, `ApprovalsPage.tsx`; `management.ts` (`orgOverview`); phone `chat/cards.tsx`, `approvals/ApprovalSheet.tsx`; migration `0180_approval_requests.sql`

## Context

An agent's instructions often say something needs someone's approval ("queries on the sales database need the
board's approval"). Nothing let the agent ask for that: approvals (ADR 0015) were only made by the Tool Gateway for a
sensitive tool call, and went to the agent's owner and admins. So the agent asked the only way it had, `ask_user`:
a question card to the person who made the request, who answered "Aprovo" to their own request. The agent then
(rightly) refused, but nothing ever reached the people who decide, and it couldn't see Aprovações to send one there.

## Decision

1. **`request_approval`** is a built-in tool every agent and brain has (scope `""`, listed through the gateway, so the
   runner's MCP bridge offers it too): `summary` (the card's title), `details` (exactly what it will do once
   approved), the gateway's required `why`, and optionally `role` (a workspace role, ADR 0085, by name) or `people`
   (by @handle or name, `findMember`). It is `sensitive`, so the gateway makes a real approval row like any other:
   the card in the conversation, Aprovações, the notification and push (ADR 0046), the e-mail digest, the 24-hour
   expiry, the run waiting in `waiting_approval`. The workspace has no departments apart from roles: a department is a
   role.
2. **Who decides** (`approvals.approvers`, snapshot when asked, through `ToolDefinition.approvers`): the holders of the
   role and the people named; none named, the agent's owner and admins as for every approval. Whoever may approve
   actions (admins) may still decide any of them, so nothing gets stuck, but only those asked get the inbox item,
   push and e-mail. A role nobody holds, or one that isn't there, refuses the call with the workspace's roles, so the
   agent can correct it.
3. **The requester never approves their own request**, unless they approve by role: they hold the role named, or may
   approve every action. Named alone (or as the agent's owner), they are dropped from those asked, and with nobody
   left the admins are asked. When the requester may decide, the card says so ("Asked by someone who approves it by
   role"), before and after they decide. Others who can't decide read "Waiting for <approvers>".
4. **The decision wakes the agent** with who decided and their note: approved, the tool's result is "Approved by
   <name>, with the note: … Do exactly what was approved now: <details>"; refused, "<name> refused this action. Do
   not retry it. Reason: …" (now for every approval, not only these).
5. **Prompt**: when the agent's instructions, the workspace's rules or the person say something needs someone's
   approval, it asks with `request_approval` and waits, never with `ask_user` to the person who asked.
6. **Policy**: any run may ask (a routine's request goes where the routine reports, like its other approvals). In a
   mission's thread the mission's own `request_approval` (scope `sandbox:run`, ADR 0029) wins: its source comes first.
7. **The requester of a routine's run** is the routine's creator (`routineCreatorOf`), so a routine never gets its
   creator to approve its own request. An admin's own request is marked `requesterDecides`: admins may decide any
   approval, and the card says it is their own. The sidebar's count (`approvalsWaitingForMe`) and Aprovações (the
   chip, "Aprovar tudo", who decides) use the same people as `decides`.
8. **At most 5 requests an hour per agent** (the mission's `request_approval` limit): each one notifies and pushes
   every approver, so a loop or text the agent read can't flood them. Past it, the call is refused with a line the
   agent tells the person.
9. **Rules that ask a person**: a database connection's rules (ADR 0039) never ask for approval (they allow or
   refuse); connector tools set to `approval` are sensitive calls that already go to the agent's owner and admins,
   the same default approvers. Nothing else changes for them.

## Consequences

- The owner of the reported workspace gets the board's approvals in Aprovações and on the phone, and the member who
  asked sees who it waits for.
- The approvers are a snapshot: someone given the role after the request isn't asked (an admin still may decide).
- Migration 0180 adds `approvals.approvers` (jsonb, null for every other approval).

## Addendum: who decides, everywhere (2026-11-02)

The same `approvers` model now covers three more cases, so who may decide is the same in `decides`, `approverIds`, the
sidebar's count (`decidableBySql`), "Aprovar tudo" and Aprovações:

1. **Turning on access for good** (`request_permission`): decided by whoever gives the same access on the agent's
   page, `manage_agents` (and `manage_connectors` for a browser profile), not by `approve_actions` (`decidingKeys`; the
   web mirror is `approvalDecidingKeys`). The grant is recorded as the person's who approved it.
2. **A new owner**: an agent handed to someone else (`updateAgent`, or a member removed, `removeMember`) moves its
   approvals waiting or approved ahead to them (`repointApprovals`): the old owner no longer decides, the inbox item
   moves, and a `request_approval` that asked the owner says the new names.
3. **A person's own mailbox** (ADR 0038): its actions that ask go to the mailbox's owner (`approvers.userIds`). Asked by
   them, they decide it (and admins may); asked by anyone else, or by nobody, only they do (`approvers.required`):
   an email in their name is theirs to approve.

Also for a person's own mailbox: its tools are offered only to a run whose person is its owner or someone the agent
answers directly (a consultation for someone outside the agent's audience doesn't reach it), and an agent loses the
mailboxes others gave it when someone else widens its audience or it gets an owner who couldn't talk to it
(`dropForeignMailGrants`, audited); the mailbox's owner gives it again if they still want to. Every way the agent's
reach grows counts: its audience (`setAgentAudience`), "only me" turned off in its brain settings (`setAgentBrain`), and
someone joining one of its audience roles (`addMemberRolesInTx`, `dropMailIfWidened`/`dropMailForNewRoleMember`). A
routine's run (or a consultation rooted in one) answers for the routine's creator, as the Tool Gateway's `requestedBy`
does, and a mail watch stops feeding its routine once the agent can't read the mailbox. Whoever decides an approval
also finds it in Aprovações and opens it, in a channel they aren't in too.

A mailbox's owner who leaves the workspace (removed, leaving, or deleting their account) takes it from every agent in
the same transaction (`dropMailOfOwner`, audited `owner_left`), and its actions waiting or approved and not run are
canceled (`cancelMailboxApprovals`); rejoining doesn't give it back.
