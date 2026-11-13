import {
  EARLY_ACCESS_INVITE_MAX,
  EARLY_ACCESS_OUTCOMES,
  EARLY_ACCESS_STATES,
  EARLY_ACCESS_TTL_DAYS,
  type EarlyAccessInvitation,
  importWaitlist,
  inviteEarlyAccess,
  listEarlyAccess,
  resendEarlyAccess,
  revokeEarlyAccess,
  SIGNUP_MODES,
  setSignupMode,
  signupMode,
  WAITLIST_IMPORT_MAX,
  WAITLIST_LOCALES,
  waitlistCounts,
  waitlistNext,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
};
const notFound = { 404: errorResponse("No invitation with this id") };

const Locale = z.enum(WAITLIST_LOCALES).openapi("OperatorLocale", { description: "The language of the email." });
const Count = z.number().int().min(0);

const Signup = z
  .object({
    mode: z.enum(SIGNUP_MODES).openapi({
      description:
        "`invite`: only people with an invitation sign up (a workspace's, or early access). `open`: anyone. Always `invite` while this server is its agents' computer (`HOST_COMPUTER_TOKEN`).",
    }),
    forcedOpen: z
      .boolean()
      .openapi({ description: "`ALLOW_SIGNUP=true` on this server: sign-up is open whatever `mode` says." }),
    changedAt: z.string().nullable().openapi({ description: "When `mode` last changed; null: never." }),
    emails: z.boolean().openapi({ description: "This server sends email, so invitations can go out." }),
  })
  .openapi("OperatorSignup");

const Waitlist = z
  .object({
    unconfirmed: Count.openapi({ description: "Entries that never confirmed their address." }),
    confirmed: Count,
    waiting: Count.openapi({
      description: "Confirmed, with no invitation (in any state). Some may have an account: inviting one allows it.",
    }),
    invited: Count.openapi({ description: "Confirmed, with an invitation." }),
    signedUp: Count.openapi({ description: "Confirmed, whose invitation made an account or allowed the one it had." }),
    workspaceCreated: Count.openapi({ description: "Confirmed, whose account made a workspace." }),
  })
  .openapi("OperatorWaitlist");

const State = z.enum(EARLY_ACCESS_STATES).openapi("OperatorInvitationState", {
  description:
    "The first that holds: `revoked`, `workspace_created` (its account made a workspace), `signed_up` (its account exists: made with the link, or allowed), `expired` (the link no longer signs anyone up), else `sent`.",
});

const Invitation = z
  .object({
    id: z.uuid(),
    email: z.string(),
    locale: Locale,
    state: State,
    createdAt: z.string(),
    sentAt: z.string().openapi({ description: "The latest send." }),
    sends: z.number().int().min(1),
    expiresAt: z.string().openapi({ description: `${EARLY_ACCESS_TTL_DAYS} days after the latest send.` }),
    revokedAt: z.string().nullable(),
    usedAt: z
      .string()
      .nullable()
      .openapi({ description: "When an account was made with it, or the address's account was allowed." }),
    userId: z.string().nullable().openapi({ description: "That account; null once it is deleted." }),
    workspaceCreatedAt: z.string().nullable().openapi({ description: "When its account made its first workspace." }),
    workspaceId: z.uuid().nullable().openapi({ description: "That workspace; null once it is deleted." }),
  })
  .openapi("OperatorInvitation");

const InvitationParams = z.object({
  invitationId: z.uuid().openapi({ param: { name: "invitationId", in: "path" } }),
});

const invitationJson = (i: EarlyAccessInvitation) => ({
  ...i,
  createdAt: i.createdAt.toISOString(),
  sentAt: i.sentAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
  revokedAt: iso(i.revokedAt),
  usedAt: iso(i.usedAt),
  workspaceCreatedAt: iso(i.workspaceCreatedAt),
});

/**
 * Early access (ADR 0078): the live sign-up mode, the waiting list and the invitations, for the operator's console.
 * Every call is safe to repeat: setting a mode again changes nothing, an import again adds nothing, and an address
 * sent its link in the last 2 minutes gets no other.
 */
export function registerOperatorAccess(api: OpenAPIHono, { db, config, emails }: OperatorDeps) {
  const signupJson = async () => {
    const { mode, changedAt } = await signupMode(db);
    return {
      // A mode saved as `open` before the server became its agents' computer opens nothing (`signupOpenToAll`).
      mode: config.HOST_COMPUTER_TOKEN ? ("invite" as const) : mode,
      forcedOpen: config.ALLOW_SIGNUP,
      changedAt: iso(changedAt),
      emails: emails === true,
    };
  };

  api.openapi(
    createRoute({
      method: "get",
      path: "/signup",
      tags,
      summary: "Who may sign up",
      responses: { 200: json(Signup), 401: errors[401] },
    }),
    async (c) => c.json(await signupJson(), 200),
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/signup",
      tags,
      summary: "Open sign-up to everyone, or back to invitation only",
      description:
        "Takes effect at once, with no restart. Setting the current mode changes nothing. On agentes.chat Cloud, while it is `invite`, only the accounts early access allowed make workspaces, as many as they like; `open` lets every account make workspaces, each with its own computer. Refused (409 `signup.host_computer`) to open while this server is its agents' computer (`HOST_COMPUTER_TOKEN`).",
      request: { body: body(z.object({ mode: z.enum(SIGNUP_MODES) })) },
      responses: {
        200: json(Signup),
        ...errors,
        409: errorResponse("This server is its agents' computer (`signup.host_computer`)"),
      },
    }),
    async (c) => {
      const { mode } = c.req.valid("json");
      if (mode === "open" && config.HOST_COMPUTER_TOKEN) {
        return apiError(
          c,
          409,
          "signup.host_computer",
          "This server is its agents' computer (HOST_COMPUTER_TOKEN): people join only by invitation",
        );
      }
      await setSignupMode(db, mode);
      return c.json(await signupJson(), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/waitlist",
      tags,
      summary: "The waiting list against the invitations",
      responses: { 200: json(Waitlist), 401: errors[401] },
    }),
    async (c) => c.json(await waitlistCounts(db), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/waitlist/next",
      tags,
      summary: "The next confirmed entries still waiting, oldest first",
      description:
        "A read: invite exactly these (`POST /early-access/invitations`), so a retry never invites more than you saw. An address with an account is among them: inviting it allows the account. Skips addresses sign-up wouldn't take and those of blocked accounts; they still count as waiting.",
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: {
        200: json(
          z
            .object({
              entries: z.array(
                z.object({
                  email: z.string(),
                  locale: Locale,
                  joinedAt: z.string().openapi({ description: "When it joined the list (or the imported time)." }),
                }),
              ),
            })
            .openapi("OperatorWaitlistNext"),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const entries = await waitlistNext(db, c.req.valid("query").limit);
      return c.json({ entries: entries.map((e) => ({ ...e, joinedAt: e.joinedAt.toISOString() })) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/waitlist/import",
      tags,
      summary: "Add confirmed addresses to the waiting list",
      description: `In one transaction, up to ${WAITLIST_IMPORT_MAX} entries, deduplicated on the address in lower case. New ones join confirmed, at \`joinedAt\` (a future one reads as now) or else in the list's order; an unconfirmed entry is confirmed; anything else is \`unchanged\`, so a repeat changes nothing. \`invalid\` holds the indexes of the entries that aren't addresses (sign-up's own rule), never the addresses. Imported entries are never sent to the email provider's contacts.`,
      request: {
        body: body(
          z.object({
            entries: z
              .array(
                z.object({
                  email: z.string().max(320),
                  locale: Locale.optional().openapi({ description: "English when absent." }),
                  joinedAt: z.iso.datetime({ offset: true }).optional(),
                }),
              )
              .min(1)
              .max(WAITLIST_IMPORT_MAX),
          }),
        ),
      },
      responses: {
        200: json(
          z
            .object({
              added: Count,
              confirmed: Count.openapi({ description: "Entries already there, unconfirmed until now." }),
              unchanged: Count.openapi({ description: "Already confirmed, or repeated in this call." }),
              invalid: z.array(z.number().int().min(0)),
            })
            .openapi("OperatorWaitlistImport"),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { entries } = c.req.valid("json");
      const result = await importWaitlist(
        db,
        entries.map((e) => ({ ...e, joinedAt: e.joinedAt ? new Date(e.joinedAt) : undefined })),
      );
      return c.json(result, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/early-access/invitations",
      tags,
      summary: "Invite addresses to create an account and make workspaces",
      description: `Each address, up to ${EARLY_ACCESS_INVITE_MAX}, gets an email with a link to sign up with that address only, valid ${EARLY_ACCESS_TTL_DAYS} days, in the language of its invitation, else of its waiting-list entry, else \`locale\`, else English. An address that has an account gets no link: the account is allowed at once, and an email in its language says so (none to a blocked account). An allowed account makes workspaces once its address is confirmed. One invitation per address: inviting it again sends the same invitation a new link (the old one stops working), unless \`resend\` is false. Answers come in the request's order, once per address. Outcomes: \`invalid_email\`, \`signed_up\` (its invitation made an account or allowed one already, so nothing went out), \`allowed\`, \`already_invited\` (with \`resend: false\`), \`recent\` (sent in the last 2 minutes, so nothing went out), \`resent\`, \`invited\`. Refused (409 \`early_access.no_email\`) on a server that sends no email.`,
      request: {
        body: body(
          z.object({
            emails: z.array(z.string().max(320)).min(1).max(EARLY_ACCESS_INVITE_MAX),
            locale: Locale.optional(),
            resend: z.boolean().default(true),
          }),
        ),
      },
      responses: {
        200: json(
          z
            .object({
              results: z.array(
                z.object({
                  email: z.string(),
                  outcome: z.enum(EARLY_ACCESS_OUTCOMES),
                  invitationId: z.uuid().optional(),
                }),
              ),
            })
            .openapi("OperatorInvitationResults"),
        ),
        ...errors,
        409: errorResponse("This server sends no email (`early_access.no_email`)"),
      },
    }),
    async (c) => {
      if (!emails) return noEmail(c);
      const input = c.req.valid("json");
      return c.json({ results: await inviteEarlyAccess(db, { ...input, publicUrl: config.PUBLIC_URL }) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/early-access/invitations",
      tags,
      summary: "The invitations, newest first",
      description: "`counts` count every invitation by state, whatever `state` and `q` say.",
      request: {
        query: z.object({
          state: State.optional(),
          q: z.string().max(320).optional().openapi({ description: "Any part of the address, in any case." }),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().max(200).optional(),
        }),
      },
      responses: {
        200: json(
          z
            .object({
              invitations: z.array(Invitation),
              counts: z.object({
                sent: Count,
                expired: Count,
                signedUp: Count,
                workspaceCreated: Count,
                revoked: Count,
              }),
              next: z.string().nullable().openapi({ description: "`cursor` for the next page; null on the last one." }),
            })
            .openapi("OperatorInvitationPage"),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const page = await listEarlyAccess(db, c.req.valid("query"));
      return c.json({ ...page, invitations: page.invitations.map(invitationJson) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/early-access/invitations/{invitationId}/resend",
      tags,
      summary: "Send an invitation again, with a new link",
      description: `The old link stops working, the invitation is no longer revoked and runs ${EARLY_ACCESS_TTL_DAYS} days from now. Within 2 minutes of the previous send nothing goes out (\`sent: false\`). When the address has an account by now, no link goes: the account is allowed at once and an email says so (none to a blocked account), and the answer is the invitation, now \`signed_up\`, with \`sent: false\`. Refused (409) once it was used (\`early_access.used\`), and on a server that sends no email (\`early_access.no_email\`).`,
      request: { params: InvitationParams },
      responses: {
        200: json(z.object({ invitation: Invitation, sent: z.boolean() }).openapi("OperatorInvitationResend")),
        ...errors,
        ...notFound,
        409: errorResponse("Used, or no email (`early_access.*`)"),
      },
    }),
    async (c) => {
      if (!emails) return noEmail(c);
      const { invitation, sent } = await resendEarlyAccess(db, c.req.valid("param").invitationId, config.PUBLIC_URL);
      return c.json({ invitation: invitationJson(invitation), sent }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/early-access/invitations/{invitationId}/revoke",
      tags,
      summary: "Revoke an invitation",
      description:
        "Its link stops working, and its account can make no more workspaces while sign-up is by invitation. The workspaces it made stay. Revoking again answers the same.",
      request: { params: InvitationParams },
      responses: {
        200: json(z.object({ invitation: Invitation }).openapi("OperatorInvitationRevoke")),
        ...errors,
        ...notFound,
      },
    }),
    async (c) => {
      const invitation = await revokeEarlyAccess(db, c.req.valid("param").invitationId);
      return c.json({ invitation: invitationJson(invitation) }, 200);
    },
  );
}

const noEmail = (c: Parameters<typeof apiError>[0]) =>
  apiError(c, 409, "early_access.no_email", "This server sends no email, so no invitation can go out");
