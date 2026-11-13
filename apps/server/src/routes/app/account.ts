import { isLoopback } from "@agenteschat/client/lib/server";
import { isWorkAreaAnswer, WORK_AREA_ANSWERS } from "@agenteschat/client/lib/work-area";
import {
  acceptInvitation,
  accountDeletionPlan,
  addHostComputer,
  announceMembers,
  announceProfile,
  avatarFile,
  CODE_LENGTH,
  can,
  canCreateWorkspace,
  changeMemberRole,
  cloudNotice,
  countUsers,
  createInvitation,
  createOrganization,
  type DeletionDeps,
  getOrganization,
  hasPassword,
  invitationLogoFile,
  invitationState,
  isAgentesCloud,
  isEmailVerified,
  isValidTimeZone,
  joinStatus,
  listInvitations,
  listMembers,
  listMemberships,
  memberPasswordLink,
  myAccount,
  NotFoundError,
  needsWorkspaceAllowance,
  noticeInvitationAccepted,
  notificationCountsByOrg,
  ONBOARDING_STEPS,
  orgLogoFile,
  pinnedOwner,
  previewInvitation,
  queueInvitationEmail,
  removalPreview,
  removeAvatar,
  removeMember,
  removeOrgLogo,
  requireOwnerToDelete,
  requirePermission,
  resolvePermissions,
  restoreAccount,
  restoreWorkspace,
  revokeInvitation,
  rightHandId,
  saveOnboarding,
  scheduleAccountDeletion,
  scheduleDeletion,
  sendDeletionCode,
  setAvatar,
  setMyLocale,
  setMyWorkArea,
  setOrgLogo,
  settleJoinRequests,
  signInOptions,
  soleOwnerRefusal,
  toldReason,
  USER_LOCALES,
  unfinishedWorkspaces,
  updateMyProfile,
  updateOrganization,
  updateOrgSettings,
  WORKSPACE_MODES,
  workspaceContents,
  workspaceDeletions,
  workspaceMode,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  authUiConfig,
  deletionProof,
  mintPhoneSignIn,
  replacePassword,
  sessionUser,
  signedInLately,
  signupOpen,
  signupPolicy,
  workspacePolicy,
} from "../../auth";
import { requestLimitIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import { humanCheckRefusal } from "../../http/human-check";
import { imageFile } from "../../http/image-file";
import { releaseOf } from "../../version";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  iso,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { Invitation, Member, Organization, Role } from "./schemas";

const tags = ["Account"];
/** E-mail lookups on the sign-in screen: enough for typos and a few accounts, not for listing who has one. */
const SIGN_IN_OPTIONS_PER_IP = { limit: 30, windowMs: 10 * 60_000 };
/** A workspace's deletions in a day: deleting and restoring it over and over can't email its people all day. */
const DELETIONS_PER_DAY = { limit: 3, windowMs: 86_400_000 };
/** Workspaces a person makes in a day: making and deleting them over and over can't churn the Cloud's computers. */
const WORKSPACES_PER_DAY = { limit: 10, windowMs: 86_400_000 };
/** What proves it's you before deleting (ADR 0088 §2): the code emailed to you, or your password where no email goes. */
const Proof = z.object({
  code: z
    .string()
    .regex(new RegExp(`^\\d{${CODE_LENGTH}}$`))
    .optional(),
  password: z.string().min(1).max(128).optional(),
});
const PROOF_TEXT =
  "Proof that it's you: the `code` emailed by `POST …/deletion/code` (403 `reauth.code` without one; `reauth.code_wrong`, `reauth.code_expired` or `reauth.code_tries` when refused, and 429 `reauth.code_limit` for every code once the account's 10 wrong tries of the day are spent; it works once, for this deletion only). On a server that sends no email, `password` instead (403 `reauth.password` without it or wrong, 429 after 5 in 15 minutes).";
const Sent = json(
  z.object({
    email: z.string().openapi({ description: "Where it went: the account's own address." }),
    resendIn: z.number().int().openapi({ description: "Seconds before another can go." }),
  }),
  "Sent",
);
/** A join page loads its logo once (cached for good): room for an office opening a link at once, not for hosting it. */
const INVITE_LOGO_PER_IP = { limit: 60, windowMs: 60_000 };
const Name = z.string().trim().min(1).max(100);
const Context = z.string().max(20_000).openapi({ description: "Shared with every agent of the organization." });

/** `GET /me`: the signed-in person and their workspaces, also in the answers that finish a workspace's onboarding. */
const Me = z
  .object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable(),
      hasPassword: z.boolean().openapi({
        description:
          "Signs in with a password. False for social sign-ins only, and for the owner the desktop app signs in.",
      }),
      emailVerified: z.boolean().openapi({
        description: "The person opened the link that confirms their email address.",
      }),
      locale: z.string().nullable().openapi({
        description: "The app's language (`PATCH /me`); null until an app said one.",
      }),
      localeAuto: z.boolean().openapi({
        description: "The language follows each device's own until the person picks one (ADR 0122).",
      }),
      workArea: z.enum(WORK_AREA_ANSWERS).nullable().openapi({
        description:
          "The person's own area (`PUT /me/work-area`), asked once during the onboarding, or `skipped`; null until asked.",
      }),
      canCreateWorkspace: z.boolean().openapi({
        description:
          "`POST /organizations` would make a workspace for them. False on agentes.chat Cloud while sign-up is by invitation, unless early access allowed their account and its address is confirmed (ADR 0078). `org.create_refused` and `org.create_unpaid` (ADR 0079) can still refuse it.",
      }),
      deletion: z
        .object({
          dueAt: z.string().nullable().openapi({ description: "When it goes for good; null once that date passed." }),
          requestedAt: z.string().nullable(),
        })
        .optional()
        .openapi({
          description:
            "They deleted this account: the apps show only its waiting screen (`DELETE /account/deletion` restores it). No workspace answers meanwhile.",
        }),
    }),
    organizations: z.array(Organization),
  })
  .openapi("Me");

const RightHandId = z.uuid().nullable().openapi({
  description: "The right hand, whose DM the workspace opens in (ADR 0137); null when it has none.",
});
const Created = z.object({
  organization: Organization,
  generalChannelId: z.uuid(),
  rightHandId: RightHandId,
  me: Me.optional().openapi({ description: "`GET /me` as it is now." }),
});

/** Account, organizations, members and invitations. */
export function accountRoutes(deps: AppDeps) {
  const { db, config } = deps;
  /** `GET /me`'s body; null once the account is deleted (its cached session cookie outlives it for minutes). */
  const meBody = async (user: { id: string; name: string; email: string }): Promise<z.infer<typeof Me> | null> => {
    const [memberships, password, verified, creates, unfinished, account] = await Promise.all([
      listMemberships(db, user.id),
      hasPassword(db, user.id),
      isEmailVerified(db, user.id),
      canCreateWorkspace(db, user.id, workspacePolicy(config)),
      unfinishedWorkspaces(db, user.id),
      myAccount(db, user.id),
    ]);
    if (verified === null) return null;
    const onboardingOf = (orgId: string) => unfinished.find((u) => u.organization.id === orgId);
    const deletions = await workspaceDeletions(
      db,
      memberships.flatMap((m) => (m.standing?.deletionDueAt ? [m.orgId] : [])),
    );
    const now = Date.now();
    return {
      user: {
        id: user.id,
        name: account.name ?? user.name,
        email: user.email,
        image: account.image,
        hasPassword: password,
        emailVerified: verified,
        locale: account.locale,
        localeAuto: account.localeAuto,
        workArea: isWorkAreaAnswer(account.workArea) ? account.workArea : null,
        canCreateWorkspace: creates && !account.deletionDueAt,
        ...(account.deletionDueAt
          ? {
              deletion: {
                dueAt: account.deletionDueAt.getTime() > now ? account.deletionDueAt.toISOString() : null,
                requestedAt: iso(account.deletionRequestedAt),
              },
            }
          : {}),
      },
      organizations: memberships.map((m) => {
        const setup = onboardingOf(m.orgId);
        const deleting = deletions.get(m.orgId);
        return {
          id: m.orgId,
          name: m.orgName,
          role: m.role,
          permissions: [...m.permissions],
          rank: m.rank,
          logo: m.orgLogo ?? null,
          ...(m.orgCreatedAt ? { createdAt: m.orgCreatedAt.toISOString() } : {}),
          ...(m.start ? { start: m.start } : {}),
          showActivity: m.showActivity ?? false,
          agentStyle: m.agentStyle ?? null,
          chatPrefs: m.chatPrefs ?? {},
          mode: m.mode ?? "team",
          ...(m.standing
            ? { standing: { state: m.standing.state, reason: toldReason(m.standing), ...cloudNotice() } }
            : {}),
          ...(setup
            ? { onboarding: { step: setup.organization.onboardingStep, generalChannelId: setup.general.id } }
            : {}),
          ...(deleting
            ? {
                deletion: {
                  dueAt: deleting.dueAt.getTime() > now ? deleting.dueAt.toISOString() : null,
                  requestedAt: iso(deleting.requestedAt),
                  requestedBy: deleting.requestedBy,
                },
              }
            : {}),
        };
      }),
    };
  };
  /** What finishing a workspace's onboarding answers: where it opens (its right hand's DM) and `/me` as it is now. */
  const opened = async (user: { id: string; name: string; email: string }, orgId: string) => {
    const me = await meBody(user);
    return { rightHandId: await rightHandId(db, orgId), ...(me ? { me } : {}) };
  };
  const app = createAppRouter(deps);
  const session = requireSession(deps.auth);
  const deletion: DeletionDeps = {
    db,
    pubsub: deps.adapters.pubsub,
    hub: deps.extras?.sandbox?.machines?.hub,
    emails: deps.adapters.email.delivers ? { publicUrl: config.PUBLIC_URL, support: config.SUPPORT_EMAIL } : null,
  };
  const codes = {
    db,
    rateLimiter: deps.adapters.rateLimiter,
    emails: { publicUrl: config.PUBLIC_URL, support: config.SUPPORT_EMAIL },
  };
  /** The proof a deletion takes (`deletionProof`), read when it's asked: whether this server sends email now. */
  const prove = (c: { req: { raw: Request } }, userId: string, orgId: string | null, proof: z.infer<typeof Proof>) =>
    deletionProof(
      deps.auth,
      { db, rateLimiter: deps.adapters.rateLimiter, emailDelivers: deps.adapters.email.delivers === true },
      c.req.raw.headers,
      userId,
      orgId,
      proof,
    );
  for (const path of [
    "/me",
    "/me/unread",
    "/me/password",
    "/me/work-area",
    "/phone-sign-in",
    "/account",
    "/account/*",
    "/avatars/*",
    "/org-logos/*",
    "/organizations",
    "/organizations/*",
    "/invitations/:token/accept",
  ])
    app.use(path, session);

  // ── Public ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/auth-config",
      tags,
      summary: "Sign-in options for the login page",
      responses: {
        200: json(
          z.object({
            socialProviders: z.object({ google: z.boolean(), github: z.boolean(), apple: z.boolean() }),
            signupOpen: z
              .boolean()
              .openapi({ description: "Offer the sign-up form (invited people can always sign up)." }),
            firstRun: z.boolean().openapi({ description: "No account exists yet: show first-run setup." }),
            ownerClaim: z.boolean().openapi({
              description: "No account yet, and only the owner link (`OWNER_CLAIM_SHA256`) creates the first one.",
            }),
            passwordReset: z.boolean().openapi({ description: 'Offer "forgot password" (e-mail is configured).' }),
            termsUrl: z
              .string()
              .nullable()
              .openapi({ description: "Terms of service linked on the sign-in screen (TERMS_URL)." }),
            privacyUrl: z
              .string()
              .nullable()
              .openapi({ description: "Privacy policy linked on the sign-in screen (PRIVACY_URL)." }),
            supportEmail: z.string().nullable().openapi({
              description: "Where people write to whoever runs this server (SUPPORT_EMAIL): hold, suspension.",
            }),
            feedback: z.boolean().openapi({
              description: "The apps offer the feedback form (FEEDBACK_EMAIL is set): `POST /api/app/feedback`.",
            }),
            workspaceComputer: z.boolean().openapi({
              description:
                "Every workspace gets a computer of its own (MACHINE_PROVISIONING=external): a new person's setup has none to connect.",
            }),
            billingUrl: z.string().nullable().openapi({
              description:
                "The billing service (BILLING_URL, ADR 0079): owners and admins open a workspace's plan and billing there through `POST …/billing-link`. Null: no billing.",
            }),
            cloud: z.boolean().openapi({
              description:
                "One of agentes.chat's own servers (`cloud` in `GET /api/instance`): the apps show no About screen there, which every other server shows.",
            }),
            turnstileSiteKey: z.string().nullable().openapi({
              description:
                "The bot check's site key (`TURNSTILE_SITE_KEY`, ADR 0075): pages run Cloudflare Turnstile and send its token in `x-captcha-response`. Null: no check, and nothing loads from Cloudflare.",
            }),
            errorReports: z
              .object({ dsn: z.string(), environment: z.string(), release: z.string() })
              .nullable()
              .openapi({
                description:
                  "Where the app reports its own errors (`SENTRY_WEB_DSN`, a Sentry-compatible server, ADR 0104), and under which environment and release. Null: it reports nothing and loads no reporting code.",
              }),
            mobileErrorReports: z
              .object({ dsn: z.string(), environment: z.string(), release: z.string() })
              .nullable()
              .openapi({
                description:
                  "The same for the phone app (`SENTRY_MOBILE_DSN`, else `SENTRY_WEB_DSN`); `release` is the server's, the app files its reports under its own.",
              }),
          }),
        ),
      },
    }),
    async (c) => {
      const users = await countUsers(db);
      // The first account of an installation that waits for its owner's link or key is made there, not here.
      const ownerWaits = users === 0 && signupPolicy(config).ownerByLink;
      const reportsTo = (dsn: string | undefined) =>
        dsn ? { dsn, environment: config.SENTRY_ENVIRONMENT, release: releaseOf(config) } : null;
      return c.json(
        {
          ...authUiConfig(config),
          signupOpen: await signupOpen(db, config, users),
          firstRun: users === 0 && !ownerWaits,
          ownerClaim: users === 0 && Boolean(config.OWNER_CLAIM_SHA256),
          passwordReset: deps.adapters.email.delivers === true,
          workspaceComputer: config.MACHINE_PROVISIONING === "external",
          billingUrl: config.BILLING_URL ?? null,
          cloud: isAgentesCloud(config.PUBLIC_URL),
          turnstileSiteKey: deps.adapters.humanCheck?.siteKey ?? null,
          errorReports: reportsTo(config.SENTRY_WEB_DSN),
          mobileErrorReports: reportsTo(config.SENTRY_MOBILE_DSN ?? config.SENTRY_WEB_DSN),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/sign-in-options",
      tags,
      summary: "How an e-mail signs in (the login screen asks for the e-mail first)",
      description:
        "Tells whether the e-mail has an account, so it is rate limited per IP, and guarded by the bot check when this server has one (`human_check`, `human_check_blocked`).",
      request: {
        body: body(
          z.object({
            email: z.email().max(254),
            access: z.string().max(64).optional().catch(undefined).openapi({
              type: "string",
              maxLength: 64,
              description:
                "The token of an early-access link (`/signup?access=`, ADR 0078), when the page has one. Any other value counts as absent.",
            }),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            account: z.boolean(),
            password: z.boolean().openapi({ description: "The account has a password." }),
            providers: z
              .array(z.enum(["google", "github", "apple"]))
              .openapi({ description: "Social sign-ins linked." }),
            canSignUp: z.boolean().openapi({ description: "No account, and this e-mail may create one." }),
            accessExpired: z.literal(true).optional().openapi({
              description: "`access` is the link of an invitation to this same address, and it expired.",
            }),
          }),
        ),
        429: errorResponse("Too many attempts (`rate_limited`)"),
        ...errors,
      },
    }),
    async (c) => {
      const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      const limit = await deps.adapters.rateLimiter.consume(`sign-in-options:${ip}`, SIGN_IN_OPTIONS_PER_IP);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      const refused = await humanCheckRefusal(
        deps.adapters.humanCheck,
        c.req.raw.headers,
        "email-lookup",
        config.TRUSTED_PROXIES,
      );
      if (refused) return apiError(c, 403, refused.code, refused.message);
      const { email, access } = c.req.valid("json");
      return c.json(await signInOptions(db, email, signupPolicy(config), access), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/invitations/{token}",
      tags,
      summary: "Preview an invitation",
      description:
        "Public. For an invitation link (ADR 0068), also what the signed-in person's request stands at (`you`).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: json(
          z.object({
            orgName: z.string(),
            email: z.string().openapi({ description: "Empty for an org-wide invite link." }),
            role: Role,
            kind: z.enum(["email", "link"]),
            invitedBy: z.string().nullable().openapi({ description: "Who invited (their name), when known." }),
            mode: z
              .enum(WORKSPACE_MODES)
              .optional()
              .openapi({
                description:
                  "Who the workspace is for, `team` or `personal` (ADR 0159), so the page speaks of a team or of the " +
                  "person who invited. Absent on one that no longer works.",
              }),
            logo: z
              .string()
              .optional()
              .openapi({
                description:
                  "The workspace's logo, at an address that serves it for this invitation or link only, while " +
                  "it works. Absent without one, and while the workspace is paused or being deleted.",
              }),
            agents: z
              .array(
                z.object({
                  id: z.uuid(),
                  name: z.string(),
                  appearance: z.object({ color: z.string(), eyes: z.string(), accessory: z.string() }).nullable(),
                }),
              )
              .openapi({ description: "The organization's first agents (name and look)." }),
            moreAgents: z
              .number()
              .int()
              .positive()
              .optional()
              .openapi({ description: "How many more agents work there than `agents` names." }),
            closed: z
              .literal(true)
              .optional()
              .openapi({
                description:
                  "A link turned off, expired, or whose workspace is paused, or an invitation to a workspace paused " +
                  "or being deleted: nobody can ask or join.",
              }),
            expiresAt: z.string().optional().openapi({ description: "An email invitation: until when it works." }),
            account: z
              .object({
                exists: z.boolean(),
                password: z.boolean(),
                providers: z.array(z.enum(["google", "github", "apple"])),
              })
              .optional()
              .openapi({
                description:
                  "An email invitation: how its address signs in (ADR 0090), so the page asks only what is missing.",
              }),
            full: z.literal(true).optional().openapi({
              description: "An email invitation to a workspace with no seat left: said before anyone makes an account.",
            }),
            you: z
              .object({
                member: z.boolean(),
                orgId: z.uuid().optional().openapi({ description: "Only when a member." }),
                email: z.string(),
                request: z
                  .object({ status: z.enum(["pending", "approved", "denied"]), reason: z.string().nullable() })
                  .nullable()
                  .openapi({
                    description:
                      "The latest request for their address through a link, with its answer; always null while " +
                      "the address isn't confirmed.",
                  }),
              })
              .optional()
              .openapi({
                description:
                  "A link opened signed in: where they stand. On a link that no longer works, only a member's.",
              }),
          }),
        ),
        404: errors[404],
      },
    }),
    async (c) => {
      const token = c.req.valid("param").token;
      const invitation = await previewInvitation(db, token);
      if (!invitation) return apiError(c, 404, "not_found", "Invitation not found or expired");
      const user = invitation.kind === "link" ? await sessionUser(deps.auth, c.req.raw.headers) : null;
      const status = user ? await joinStatus(db, user, token) : null;
      // A link that no longer works still tells a member they're in; anyone else hears only that it doesn't work.
      const you = "closed" in invitation && !status?.member ? null : status;
      return c.json({ ...invitation, ...(you ? { you } : {}) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/invitations/{token}/state",
      tags,
      summary: "What an email invitation that no longer opens says (ADR 0090)",
      description:
        "Public, for the token's holder. `accepted` (with the workspace's id, to open it when signed in as a " +
        "member) or `expired` (when, and who invited). 404 for a token that matches none, a cancelled " +
        "invitation's included, and for one that still opens (read the preview).",
      request: { params: z.object({ token: z.string().max(200) }) },
      responses: {
        200: json(
          z.discriminatedUnion("state", [
            z.object({ state: z.literal("accepted"), orgId: z.uuid(), orgName: z.string(), at: z.string() }),
            z.object({
              state: z.literal("expired"),
              orgName: z.string(),
              invitedBy: z.string().nullable(),
              at: z.string(),
            }),
          ]),
        ),
        404: errors[404],
      },
    }),
    async (c) => {
      const found = await invitationState(db, c.req.valid("param").token);
      if (!found) return apiError(c, 404, "not_found", "Invitation not found");
      return c.json(found, 200);
    },
  );

  // The preview's `logo`: the workspace's current logo for whoever holds a working invitation or link, 404 otherwise.
  // No session guards it, so it is limited per address and only this server's own pages may show it.
  app.get("/invitations/:token/logo/:file", async (c) => {
    const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
    const limit = await deps.adapters.rateLimiter.consume(`invite-logo:${ip}`, INVITE_LOGO_PER_IP);
    if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests. Try again in a minute.");
    const file = await invitationLogoFile(
      { db, blobs: deps.adapters.platformBlobs },
      c.req.param("token"),
      c.req.param("file"),
    );
    return imageFile(file, { "cross-origin-resource-policy": "same-origin" });
  });

  // ── Signed in ─────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags,
      security,
      summary: "The signed-in person and their organizations",
      description:
        "401 with the session cookies expired once the account is deleted: a cached session cookie outlives it for minutes.",
      responses: { 200: json(Me), 401: errors[401] },
    }),
    async (c) => {
      const me = await meBody(c.get("user"));
      // A deleted account's session lives on in a cached cookie for minutes: its other tabs and devices learn it here.
      if (!me) {
        for (const cookie of expiredSessionCookies()) c.header("set-cookie", cookie, { append: true });
        return apiError(c, 401, "unauthorized", "Sign in to continue");
      }
      return c.json(me, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/unread",
      tags,
      security,
      summary: "Unread and waiting in each of the person's workspaces",
      description:
        "The inbox counts of `GET /organizations/{orgId}/notifications/count` for every workspace the person reads, in one call: the phone and desktop apps list workspaces from several servers with their unread counts (ADR 0154).",
      responses: {
        200: json(
          z.object({
            organizations: z.array(
              z.object({ orgId: z.string(), unread: z.number().int(), waiting: z.number().int() }),
            ),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) =>
      c.json(
        { organizations: await notificationCountsByOrg({ db, pubsub: deps.adapters.pubsub }, c.get("user").id) },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/me",
      tags,
      security,
      summary: "Change your app language",
      description:
        "The language of the apps on every device and of the emails and pushes sent to you (ADR 0122). `auto: true` when a device detected it (Automático: each device follows its own until you pick one), false when you picked it.",
      request: {
        body: body(z.object({ locale: z.enum(USER_LOCALES), auto: z.boolean().default(false) })),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { locale, auto } = c.req.valid("json");
      await setMyLocale(db, c.get("user").id, locale, auto, deps.adapters.pubsub);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/me/work-area",
      tags,
      security,
      summary: "Say your own area",
      description:
        "The person's own area, asked once during the onboarding (about the person, never a workspace): one of the ids, or `skipped` when they skipped the question. The operator API's account reads it.",
      request: { body: body(z.object({ area: z.enum(WORK_AREA_ANSWERS) })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await setMyWorkArea(db, c.get("user").id, c.req.valid("json").area);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/password",
      tags,
      security,
      summary: "Add a password, or set a new one",
      description:
        "For an account that signs in another way (Google, Apple, or the desktop app that runs this server), so it can also sign in with its email from other browsers, and to set a new password in place of one (ADR 0158 §4: the server's owner after Continue on this Mac, or anyone who just signed in). Needs a sign-in in the last 10 minutes (403 `reauth.sign_in`): a password proves it's the person, so a session alone can't set one. A new password ends every other session and cuts off the AI apps the old one let in.",
      request: { body: body(z.object({ password: z.string().min(8).max(128) })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const userId = c.get("user").id;
      if (!(await signedInLately(deps.auth, c.req.raw.headers, userId))) {
        return apiError(c, 403, "reauth.sign_in", "Sign in again to set a password");
      }
      const { password } = c.req.valid("json");
      if (await hasPassword(db, userId)) {
        const current = await deps.auth.api.getSession({
          headers: c.req.raw.headers,
          query: { disableCookieCache: true },
        });
        if (!current) return apiError(c, 401, "unauthorized", "Sign in to continue");
        await replacePassword(deps.auth, db, userId, password, current.session.token);
        return c.body(null, 204);
      }
      await deps.auth.api.setPassword({ body: { newPassword: password }, headers: c.req.raw.headers });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/phone-sign-in",
      tags,
      security,
      summary: "A one-time sign-in for the phone app",
      description:
        "For the QR code of “Abrir no celular”: `agenteschat://connect?server=…&token=…`. The phone trades the token at `POST /api/auth/sign-in/one-time-token` for a session of its own: once, within a few minutes, and only while this session lasts. Refused with 409 `phone.local_only` while a computer's own install (`INSTALL_MODE` desktop or native) has this computer's address (the desktop app's server with access from other devices off): no phone could reach it.",
      responses: {
        201: json(
          z.object({
            token: z.string(),
            server: z.string(),
            expiresIn: z.number().int().openapi({ description: "Seconds the token lasts, from this answer." }),
          }),
          "Created",
        ),
        401: errors[401],
        409: errorResponse("The server answers only on its own computer (`phone.local_only`)"),
        429: errorResponse("Too many codes"),
      },
    }),
    async (c) => {
      const server = new URL(config.PUBLIC_URL).origin;
      // A computer's own install (the desktop app's server, or one from the terminal) at an address only that computer
      // answers: a code would open nothing on the phone. Development servers keep theirs (a simulator reaches them).
      if (isLoopback(server) && (config.INSTALL_MODE === "desktop" || config.INSTALL_MODE === "native")) {
        return apiError(c, 409, "phone.local_only", "This server answers only on its own computer");
      }
      const current = await deps.auth.api.getSession({
        headers: c.req.raw.headers,
        query: { disableCookieCache: true },
      });
      if (!current) return apiError(c, 401, "unauthorized", "Sign in to continue");
      const limit = await deps.adapters.rateLimiter.consume(`phone-sign-in:${current.user.id}`, {
        limit: 30,
        windowMs: 3600_000,
      });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many codes. Try again later.");
      const { token, expiresIn } = await mintPhoneSignIn(deps.auth, current.session.token);
      return c.json({ token, server, expiresIn }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/account/deletion",
      tags,
      security,
      summary: "What deleting your account would do",
      description:
        "Everything `DELETE /account` would refuse, close, leave and remove, so the page can show it before anyone confirms.",
      responses: {
        200: json(
          z.object({
            closes: z
              .array(
                z.object({
                  id: z.uuid(),
                  name: z.string(),
                  agents: z
                    .number()
                    .int()
                    .optional()
                    .openapi({ description: "Its agents, unless already being deleted." }),
                  messages: z
                    .number()
                    .int()
                    .optional()
                    .openapi({ description: "Its messages, unless already being deleted." }),
                  deletion: z
                    .object({
                      dueAt: z
                        .string()
                        .nullable()
                        .openapi({ description: "When it goes for good; null once that date passed." }),
                    })
                    .optional()
                    .openapi({ description: "It is being deleted already, and keeps its date." }),
                }),
              )
              .openapi({
                description:
                  "Workspaces only they are in: they close now and are deleted for good 7 days later, or on their own date when already being deleted.",
              }),
            leaves: z
              .array(z.object({ id: z.uuid(), name: z.string(), role: Role }))
              .openapi({ description: "Workspaces with others in them, which they leave." }),
            soleOwner: z.array(z.object({ id: z.uuid(), name: z.string() })).openapi({
              description:
                "Workspaces they are the only owner of, with others in them and not being deleted: make someone else an owner, or delete the workspace, first (`sole_owner`).",
            }),
            computers: z.array(z.object({ orgId: z.uuid(), id: z.uuid(), name: z.string() })).openapi({
              description:
                "Computers they connected in the workspaces they leave, not in system mode: removed with the account.",
            }),
            staysBehind: z
              .array(z.object({ orgId: z.uuid(), kind: z.enum(["key", "connection", "mailbox"]), name: z.string() }))
              .openapi({
                description:
                  "Keys, connections and mailboxes they added to the workspaces they leave: the workspace's, so they stay. Disconnect one first if it's theirs.",
              }),
            serverOwner: z.boolean().openapi({
              description:
                "They set up this server: its own settings will have no owner here, only in its environment (ADR 0073).",
            }),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) => {
      const user = c.get("user");
      const [plan, owner] = await Promise.all([accountDeletionPlan(db, user.id), pinnedOwner(db)]);
      const contents = await workspaceContents(
        db,
        plan.closes.flatMap((o) => (o.dueAt ? [] : [o.id])),
      );
      const now = Date.now();
      return c.json(
        {
          ...plan,
          // As `GET /me` says it: no date once it passed.
          closes: plan.closes.map(({ dueAt, ...org }) =>
            dueAt
              ? { ...org, deletion: { dueAt: dueAt.getTime() > now ? dueAt.toISOString() : null } }
              : { ...org, ...contents.get(org.id) },
          ),
          serverOwner: owner === user.id,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/account/deletion/code",
      tags,
      security,
      summary: "Email a code to delete your account",
      description:
        "To your own address: the proof `DELETE /account` takes, for that only. It works for 10 minutes, and once. Refused with `sole_owner` first, as `DELETE /account` is. 60 s between two (`reauth.code_wait` with `retryIn`), 5 an hour and 10 a day per account, and none once its 10 wrong tries of the day are spent (`reauth.code_limit`). 409 `reauth.no_email` on a server that sends no email: the password is the proof there.",
      responses: {
        202: Sent,
        401: errors[401],
        403: errors[403],
        409: errorResponse(
          "Only owner of a workspace with others in it (`sole_owner`), or no email (`reauth.no_email`)",
        ),
        429: errorResponse("Too many codes (`reauth.code_wait`, `reauth.code_limit`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const refusal = soleOwnerRefusal(await accountDeletionPlan(db, user.id));
      if (refusal) throw refusal;
      if (deps.adapters.email.delivers !== true)
        return apiError(c, 409, "reauth.no_email", "This server doesn't send email. Give your password.");
      const sent = await sendDeletionCode(codes, user.id, null);
      deps.wakeWorkers?.();
      return c.json(sent, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/account",
      tags,
      security,
      summary: "Delete your account",
      description: `Deletes the signed-in person in 7 days: their sessions and phones end now, and no workspace answers them, but signing in shows a waiting screen with \`DELETE /account/deletion\` to restore it until then. Workspaces only they are in close now and go on the same date. At the date they leave the others, and the computers they connected there are removed (not in system mode). Messages they wrote stay without an author. What it would do: \`GET /account/deletion\`. Refused with \`sole_owner\` (params: \`organizations\`, their names, and \`orgIds\`) while they are the only owner of a workspace that has others in it and isn't being deleted, before the proof. ${PROOF_TEXT}`,
      request: { body: { ...body(Proof), required: false } },
      responses: {
        204: { description: "Scheduled; the session cookies are cleared" },
        400: errorResponse("A malformed code, or a wrong one (`reauth.code_wrong`)"),
        401: errors[401],
        403: errorResponse("Blocked, or no proof that it's you (`reauth.code`, `reauth.password`)"),
        409: errorResponse(
          "Only owner of a workspace with others in it (`sole_owner`), or a code refused (`reauth.code_expired`, `reauth.code_tries`)",
        ),
        429: errorResponse("Too many tries today (`reauth.code_limit`), or password tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      // Before the proof: a code would be spent for nothing while a workspace still needs its owner.
      const refusal = soleOwnerRefusal(await accountDeletionPlan(db, user.id));
      if (refusal) throw refusal;
      await prove(c, user.id, null, c.req.valid("json"));
      await scheduleAccountDeletion(deletion, user.id);
      deps.wakeWorkers?.();
      for (const cookie of expiredSessionCookies()) c.header("set-cookie", cookie, { append: true });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/account/deletion",
      tags,
      security,
      summary: "Restore your account",
      description:
        "Before its date only: the account is back as it was, with the workspaces that closed with it. Plans that stopped renewing stay that way. 409 `account.not_restorable` when it isn't being deleted or its date passed.",
      responses: {
        204: { description: "Restored" },
        401: errors[401],
        409: errorResponse("Not being deleted, or its date passed (`account.not_restorable`)"),
      },
    }),
    async (c) => {
      await restoreAccount(deletion, c.get("user").id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/me/avatar",
      tags,
      security,
      summary: "Set your photo (JPEG, PNG or WebP up to 2 MB; metadata is removed). It is yours in every organization.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            imageBase64: z
              .string()
              .min(1)
              .max(3_000_000)
              .openapi({ description: "The image bytes in base64 (a data: URL prefix is accepted)." }),
            contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
            portrait: z.string().max(400).optional().openapi({
              description:
                'For a portrait drawn in the app: the recipe it was drawn from ("1." and its values between dots). It is kept on the photo\'s address as a `#px=` fragment.',
            }),
          }),
        ),
      },
      responses: {
        200: json(z.object({ avatarUrl: z.string() })),
        429: errorResponse("Too many photo changes"),
        ...errors,
      },
    }),
    async (c) => {
      const user = c.get("user");
      await requirePermission(db, user.id, c.req.valid("param").orgId, "read");
      const limit = await deps.adapters.rateLimiter.consume(`avatar:${user.id}`, { limit: 10, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many photo changes. Try again later.");
      const avatar = await setAvatar({ db, blobs: deps.adapters.platformBlobs }, user.id, c.req.valid("json"));
      await announceProfile(db, deps.adapters.pubsub, user.id);
      return c.json(avatar, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/me/avatar",
      tags,
      security,
      summary: "Remove your photo (back to initials)",
      request: { params: OrgParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      await removeAvatar({ db, blobs: deps.adapters.platformBlobs }, c.get("user").id);
      await announceProfile(db, deps.adapters.pubsub, c.get("user").id);
      return c.body(null, 204);
    },
  );

  // The workspace logo: an admin uploads it; every member sees it.
  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/logo",
      tags,
      security,
      summary: "Set the workspace logo (JPEG, PNG or WebP up to 2 MB; metadata is removed). Admins.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            imageBase64: z
              .string()
              .min(1)
              .max(3_000_000)
              .openapi({ description: "The image bytes in base64 (a data: URL prefix is accepted)." }),
            contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
          }),
        ),
      },
      responses: {
        200: json(z.object({ logo: z.string() })),
        429: errorResponse("Too many logo changes"),
        ...errors,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { orgId } = c.req.valid("param");
      await requirePermission(db, user.id, orgId, "configure");
      const limit = await deps.adapters.rateLimiter.consume(`org-logo:${orgId}`, { limit: 20, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many logo changes. Try again later.");
      return c.json(
        await setOrgLogo({ db, blobs: deps.adapters.platformBlobs }, user.id, orgId, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/logo",
      tags,
      security,
      summary: "Remove the workspace logo (back to the agent mark). Admins.",
      request: { params: OrgParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await removeOrgLogo({ db, blobs: deps.adapters.platformBlobs }, c.get("user").id, c.req.valid("param").orgId);
      return c.body(null, 204);
    },
  );

  // The logo file, for the org's members.
  app.get("/org-logos/:orgId/:file", async (c) =>
    imageFile(
      await orgLogoFile(
        { db, blobs: deps.adapters.platformBlobs },
        c.get("user").id,
        c.req.param("orgId"),
        c.req.param("file"),
      ),
    ),
  );

  // A person's photo, for people who share an organization with them. The file
  // name is a content hash, so a new photo gets a new URL and the old one can be cached.
  app.get("/avatars/:userId/:file", async (c) =>
    imageFile(
      await avatarFile(
        { db, blobs: deps.adapters.platformBlobs },
        c.get("user").id,
        c.req.param("userId"),
        c.req.param("file"),
      ),
    ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations",
      tags,
      security,
      summary: "Create an organization (you become its owner)",
      description:
        "Its owner sets it up in the onboarding, already past its first step (`onboarding` in `GET /me` until `PATCH …/onboarding` says it's finished, or `finished` here). While they have one they haven't finished, that one comes back (200) instead of a new one, so a stale tab or a second press makes no other, even one waiting for its first plan; `timezone`, `memberTimezone` and `finished` apply to it as they would to a new one. The answer says where it opens (`rightHandId`) and carries `GET /me` as it is now, so an app opens it without asking again. 403 `org.create_refused` while your account is blocked or you are in a workspace suspended or on a hold the billing service didn't set; 403 `org.create_unpaid` (`params.orgId`) while you own a workspace waiting for its first plan; 403 `org.create_invite_only` on agentes.chat Cloud while sign-up is by invitation, unless early access allowed the person's account and its address is confirmed (ADR 0078). With BILLING_HOLD_NEW_WORKSPACES it starts on the `payment` hold (ADR 0079). 429 after 10 tries in a day; 401 once your account is deleted.",
      request: {
        body: body(
          z.object({
            name: Name,
            context: Context.optional(),
            teamSize: z.enum(["solo", "small", "medium", "large"]).optional(),
            timezone: z.string().max(64).optional().openapi({ description: "IANA zone, e.g. America/Sao_Paulo." }),
            memberTimezone: z.string().max(64).optional().openapi({
              description:
                "The owner's own zone in it (`PATCH …/me`), when it isn't the workspace's. An unknown one is left out.",
            }),
            finished: z.literal(true).optional().openapi({
              description: "Its onboarding is over at once (`PATCH …/onboarding`'s `finished`).",
            }),
            mode: z
              .enum(WORKSPACE_MODES)
              .optional()
              .openapi({ description: "Who it is for (ADR 0159): `team` (the default) or `personal`." }),
          }),
        ),
      },
      responses: {
        201: json(Created, "Created"),
        200: json(Created, "The workspace they are still setting up"),
        ...errors,
        429: errorResponse("More than 10 in a day (`rate_limited`)"),
      },
    }),
    async (c) => {
      const { teamSize, timezone, memberTimezone, finished, ...input } = c.req.valid("json");
      const user = c.get("user");
      const userId = user.id;
      if (!(await deps.adapters.rateLimiter.consume(`new-workspace:${userId}`, WORKSPACES_PER_DAY)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many new workspaces today. Try again tomorrow.");
      }
      const { organization, general, existing } = await createOrganization(db, userId, input, {
        holdForPayment: config.BILLING_HOLD_NEW_WORKSPACES,
        needsAllowance: await needsWorkspaceAllowance(db, userId, workspacePolicy(config)),
        onboarding: true,
      });
      if (!existing && config.HOST_COMPUTER_TOKEN) await addHostComputer(db, organization.id);
      if (teamSize || (timezone && isValidTimeZone(timezone))) {
        await updateOrgSettings(db, userId, organization.id, {
          ...(teamSize ? { teamSize } : {}),
          ...(timezone && isValidTimeZone(timezone) ? { timezone } : {}),
        });
      }
      if (memberTimezone && isValidTimeZone(memberTimezone))
        await updateMyProfile(db, userId, organization.id, { timezone: memberTimezone });
      if (finished) await saveOnboarding(db, userId, organization.id, { finished: true });
      const answer = {
        organization: {
          id: organization.id,
          name: organization.name,
          role: "owner" as const,
          permissions: [...resolvePermissions(true, [])],
          rank: null,
          context: organization.context,
          mode: existing ? await workspaceMode(db, organization.id) : (input.mode ?? "team"),
        },
        generalChannelId: general.id,
        ...(await opened(user, organization.id)),
      };
      return existing ? c.json(answer, 200) : c.json(answer, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/onboarding",
      tags,
      security,
      summary: "Save how far you got in setting up your workspace",
      description:
        "Its owner only (403 for anyone else). `step`: the furthest step reached, saved as each one is passed (a skipped one counts); it only moves forward, so an earlier one changes nothing. `finished`: the onboarding is over, for good; the answer then says where the workspace opens (`rightHandId`) and carries `GET /me` as it is now. Until then the apps open the onboarding instead of the workspace (`onboarding` in `GET /me`).",
      request: {
        params: OrgParams,
        body: body(z.object({ step: z.enum(ONBOARDING_STEPS).optional(), finished: z.literal(true).optional() })),
      },
      responses: {
        200: json(
          z.object({
            step: z.enum(ONBOARDING_STEPS).openapi({ description: "The furthest step reached." }),
            finished: z.boolean(),
            rightHandId: RightHandId.optional(),
            me: Me.optional(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const saved = await saveOnboarding(db, user.id, orgId, input);
      return c.json({ ...saved, ...(input.finished ? await opened(user, orgId) : {}) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}",
      tags,
      security,
      summary: "An organization you belong to",
      request: { params: OrgParams },
      responses: { 200: json(Organization), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const membership = await requirePermission(db, c.get("user").id, orgId, "read");
      const org = await getOrganization(db, orgId);
      return c.json(
        {
          id: orgId,
          name: membership.orgName,
          role: membership.role,
          permissions: [...membership.permissions],
          rank: membership.rank,
          // What the agents know of the workspace: only for who configures it.
          context: can(membership, "configure") ? (org?.context ?? "") : "",
          logo: org?.logo ?? null,
          mode: await workspaceMode(db, orgId),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}",
      tags,
      security,
      summary: "Rename or change the organization context",
      request: { params: OrgParams, body: body(z.object({ name: Name.optional(), context: Context.optional() })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await updateOrganization(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/deletion",
      tags,
      security,
      summary: "Delete a workspace (owners)",
      description: `It turns read-only for everyone now: its members still read it, every other change answers 403 \`org.deleting\` (restoring it, leaving it, read marks, the inbox and their own settings there stay open), and its people's apps hear an \`org.deleting\` org event. Its work stops, and it is deleted for good 7 days later. Until then any owner can restore it (\`DELETE …/deletion\`). ${PROOF_TEXT} A workspace takes 3 deletions a day (429). Already being deleted, it answers 202 with its date before any proof, and nobody is told again. 403 \`forbidden\` for anyone but an owner, \`org.suspended\` while suspended.`,
      request: { params: OrgParams, body: body(Proof) },
      responses: {
        202: json(
          z.object({
            deletion: z.object({ dueAt: z.string().openapi({ description: "When it goes for good." }) }),
          }),
          "Being deleted",
        ),
        ...errors,
        429: errorResponse(
          "Too many tries today (`reauth.code_limit`), or password tries or deletions of it today (`rate_limited`)",
        ),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { orgId } = c.req.valid("param");
      const due = (await requireOwnerToDelete(db, user.id, orgId)).standing?.deletionDueAt;
      if (due) return c.json({ deletion: { dueAt: due.toISOString() } }, 202);
      await prove(c, user.id, orgId, c.req.valid("json"));
      if (!(await deps.adapters.rateLimiter.consume(`org-deletion:${orgId}`, DELETIONS_PER_DAY)).allowed) {
        return apiError(c, 429, "rate_limited", "This workspace was deleted too many times today. Try again tomorrow.");
      }
      const { dueAt } = await scheduleDeletion(deletion, user.id, orgId, "owner");
      deps.wakeWorkers?.();
      return c.json({ deletion: { dueAt: dueAt.toISOString() } }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/deletion/code",
      tags,
      security,
      summary: "Email a code to delete a workspace (owners)",
      description:
        "To your own address: the proof `POST …/deletion` takes, for this workspace only. It works for 10 minutes, and once. 60 s between two (`reauth.code_wait` with `retryIn`), 5 an hour and 10 a day per account, and none once its 10 wrong tries of the day are spent (`reauth.code_limit`). 409 `reauth.no_email` on a server that sends no email: the password is the proof there. 403 `forbidden` for anyone but an owner, `org.suspended` while suspended.",
      request: { params: OrgParams },
      responses: {
        202: Sent,
        ...errors,
        429: errorResponse("Too many codes (`reauth.code_wait`, `reauth.code_limit`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { orgId } = c.req.valid("param");
      await requireOwnerToDelete(db, user.id, orgId);
      if (deps.adapters.email.delivers !== true)
        return apiError(c, 409, "reauth.no_email", "This server doesn't send email. Give your password.");
      const sent = await sendDeletionCode(codes, user.id, orgId);
      deps.wakeWorkers?.();
      return c.json(sent, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/deletion",
      tags,
      security,
      summary: "Restore a workspace being deleted (owners)",
      description:
        "Any owner, before its date; it opens again and its members are told. 409 `org.not_restorable` when it isn't being deleted or its date passed; 403 `forbidden` for anyone but an owner, `org.suspended` while suspended, `org.create_unpaid` (`params.orgId`) when it waits for its first plan and you own another that does; 404 once it is gone.",
      request: { params: OrgParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requireOwnerToDelete(db, c.get("user").id, orgId);
      await restoreWorkspace(deletion, c.get("user").id, orgId);
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/members",
      tags,
      security,
      summary: "People in the organization",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ members: z.array(Member) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      const members = await listMembers(db, orgId);
      return c.json(
        {
          // Status and availability only go out through `/people`, where a hidden person reads as offline.
          members: members.map(({ availability, statusText, statusEmoji, statusUntil, ...m }) => ({
            ...m,
            joinedAt: m.joinedAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  const MemberParams = OrgParams.extend({ userId: z.string() });
  /** The right hand's people card it was applied from, for the audit's "via" (ADR 0137 §4). */
  const ViaQuery = z.object({ via: z.uuid().optional() });
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/members/{userId}",
      tags,
      security,
      summary: "Make a member an owner, or not (owners)",
      description:
        "Only an owner does it; the last owner stays one. What anyone may do is their roles (`PUT …/roles`).",
      request: { params: MemberParams, query: ViaQuery, body: body(z.object({ role: Role })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await changeMemberRole(db, c.get("user").id, orgId, userId, c.req.valid("json").role, {
        pubsub: deps.adapters.pubsub,
        via: c.req.valid("query").via,
      });
      return c.body(null, 204);
    },
  );

  const Named = z.object({ id: z.string(), name: z.string() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/members/{userId}/removal",
      tags,
      security,
      summary: "What removing a member (or leaving) does",
      description: "Refused exactly as the removal would be. 404 when they aren't a member.",
      request: { params: MemberParams },
      responses: {
        200: json(
          z.object({
            heir: z.object({ userId: z.string(), name: z.string() }).nullable(),
            agents: z.array(Named),
            losePlan: z.array(Named),
            computers: z.array(Named),
            routines: z.number().int(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      const preview = await removalPreview(db, c.get("user").id, orgId, userId);
      if (!preview) throw new NotFoundError("That user is not a member");
      return c.json(preview, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/members/{userId}",
      tags,
      security,
      summary: "Remove a member (or leave)",
      request: { params: MemberParams, query: ViaQuery },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await removeMember(db, c.get("user").id, orgId, userId, {
        pubsub: deps.adapters.pubsub,
        via: c.req.valid("query").via,
      });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/members/{userId}/password-link",
      tags,
      security,
      summary: "A new-password link for a member (owners, servers without email)",
      description:
        "ADR 0158: the reset link the email would carry, for a member who forgot their password on a server that sends no email. It works once, for an hour, and ends the earlier one; the audit log keeps who made it, never the link. 403 for oneself, the server's owner (`password_link.server_owner`) and someone who also belongs to a workspace the caller doesn't own (`password_link.other_workspace`); 409 `password_link.email` where the server emails it.",
      request: { params: MemberParams },
      responses: {
        201: json(z.object({ url: z.string(), expiresAt: z.string() }), "Created"),
        ...errors,
        409: errorResponse("The server emails the person their own link (`password_link.email`)"),
        429: errorResponse("Too many links"),
      },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      const actorId = c.get("user").id;
      const limit = await deps.adapters.rateLimiter.consume(`password-link:${actorId}`, {
        limit: 20,
        windowMs: 3600_000,
      });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many links. Try again later.");
      const link = await memberPasswordLink(
        db,
        { publicUrl: config.PUBLIC_URL, emailDelivers: deps.adapters.email.delivers === true },
        actorId,
        orgId,
        userId,
      );
      return c.json({ url: link.url, expiresAt: link.expiresAt.toISOString() }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/invitations",
      tags,
      security,
      summary: "Pending invitations",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ invitations: z.array(Invitation) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "invite_people");
      const rows = await listInvitations(db, orgId);
      return c.json(
        {
          invitations: rows.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            roleIds: i.roleIds,
            expiresAt: i.expiresAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/invitations",
      tags,
      security,
      summary: "Invite someone by email",
      description: "Returns the invitation link to share. Only a hash of its token is stored.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            email: z.email(),
            role: Role.optional().openapi({ description: "`owner` invites an owner (owners only); else a member." }),
            roleIds: z
              .array(z.string().uuid())
              .max(50)
              .optional()
              .openapi({ description: "Roles they get on accepting, below your own (ADR 0085)." }),
          }),
        ),
      },
      responses: { 201: json(z.object({ invitation: Invitation, url: z.string() }), "Created"), ...errors },
    }),
    async (c) => {
      const { invitation, token } = await createInvitation(db, c.get("user").id, c.req.valid("param").orgId, {
        ...c.req.valid("json"),
        secret: config.AGENTES_SECRET,
      });
      const url = `${config.PUBLIC_URL.replace(/\/$/, "")}/invite/${token}`;
      await queueInvitationEmail(db, {
        orgId: invitation.orgId,
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        url,
        inviterId: c.get("user").id,
        secret: config.AGENTES_SECRET,
      });
      deps.wakeWorkers?.();
      return c.json(
        {
          invitation: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            roleIds: invitation.roleIds,
            expiresAt: iso(invitation.expiresAt) ?? "",
          },
          url,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/invitations/{invitationId}",
      tags,
      security,
      summary: "Revoke an invitation",
      request: { params: OrgParams.extend({ invitationId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, invitationId } = c.req.valid("param");
      await revokeInvitation(db, c.get("user").id, orgId, invitationId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/accept",
      tags,
      security,
      summary: "Accept an invitation (signed in with the invited email)",
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({
          mail: z
            .string()
            .max(100)
            .optional()
            .openapi({
              description:
                "The `mail` of the link in the invitation's own email (ADR 0090): accepted with it, the address counts " +
                "as confirmed. A copied link has none.",
            }),
        }),
      },
      responses: { 200: json(z.object({ orgId: z.uuid() })), ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const mail = { secret: config.AGENTES_SECRET, proof: c.req.valid("query").mail };
      const joined = await acceptInvitation(db, user, c.req.valid("param").token, new Date(), mail);
      await announceMembers(deps.adapters.pubsub, joined.orgId);
      // A request to join they had waiting closed as they joined: the admins' notice goes with the last one.
      await settleJoinRequests({ db, pubsub: deps.adapters.pubsub }, joined.orgId);
      await noticeInvitationAccepted(
        { db, pubsub: deps.adapters.pubsub },
        { orgId: joined.orgId, inviterId: joined.invitedBy, userId: user.id },
      );
      return c.json({ orgId: joined.orgId }, 200);
    },
  );

  return app;
}

/** Better Auth's session cookies, expired (plain and `__Secure-` names, as on http and https). */
function expiredSessionCookies() {
  const cookies: string[] = [];
  for (const prefix of ["", "__Secure-"]) {
    const secure = prefix ? "; Secure" : "";
    for (const name of ["session_token", "session_data", "dont_remember"])
      cookies.push(`${prefix}better-auth.${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  }
  return cookies;
}
