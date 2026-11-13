import {
  attachFeedbackFiles,
  decideFeedbackOffer,
  dropFeedbackFile,
  FEEDBACK_ABOUT_MAX,
  FEEDBACK_FACT_MAX,
  FEEDBACK_FACTS,
  FEEDBACK_FILES,
  FEEDBACK_MAX,
  FEEDBACK_PER_HOUR,
  feedbackFileByToken,
  getMembership,
  NotFoundError,
  queueFeedback,
  sniffFeedbackFile,
  storeFeedbackFile,
  TooManyError,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestLimitIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import { version } from "../../version";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  MULTIPART_SLACK_BYTES,
  noContent,
  requireSession,
  security,
} from "./context";

const tags = ["System"];

const HOUR = 60 * 60_000;
/** Files a person adds in an hour, tried or kept: a few feedbacks' worth. Videos, the heavy ones, far fewer. */
const FILES_PER_HOUR = { limit: 30, windowMs: HOUR };
const VIDEOS_PER_HOUR = { limit: 4, windowMs: HOUR };
/** Links opened from one address in a minute: an email's reader opens a handful, a scan of tokens many. */
const OPENS_PER_MINUTE = { limit: 60, windowMs: 60_000 };

const FeedbackFile = z
  .object({
    id: z.uuid(),
    name: z.string(),
    size: z.number().int(),
    kind: z.enum(["image", "video"]),
    contentType: z.string(),
  })
  .openapi("FeedbackFile");

const FeedbackOffer = z
  .object({
    id: z.uuid(),
    forUserId: z.string().openapi({ description: "The person it goes in the name of: only they decide it." }),
    summary: z.string(),
    text: z.string(),
    state: z.enum(["offered", "sent", "dismissed"]),
    auto: z.literal(true).optional().openapi({ description: "Sent with the reply: they chose Always send." }),
    decidedAt: z.string().optional(),
  })
  .openapi("FeedbackOffer");

/**
 * The apps' feedback form (ADR 0160): what the person wrote goes by email to whoever runs the server
 * (`FEEDBACK_EMAIL`), through the outbox, with the pictures and the video they added. Without that address there is
 * no form and no route.
 */
export function feedbackRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/feedback", requireSession(deps.auth));
  app.use("/feedback/*", requireSession(deps.auth));
  const files = { db, blobs: adapters.platformBlobs };
  // Before a byte of an upload is read: is there a form at all, is this person within their hour, and does the body
  // say it is too large. Then the body is read only up to the largest file, whatever its length claimed.
  const uploadMax = FEEDBACK_FILES.videoBytes + MULTIPART_SLACK_BYTES;
  const tooLarge = (c: Context) => apiError(c, 413, "feedback.file_too_large", "The file is too large");
  app.use("/feedback/files", async (c, next) => {
    if (c.req.method !== "POST") return next();
    if (!config.FEEDBACK_EMAIL) return apiError(c, 404, "not_found", "Not found");
    if (Number(c.req.header("content-length") ?? 0) > uploadMax) return tooLarge(c);
    if (!(await adapters.rateLimiter.consume(`feedback-file:${c.get("user").id}`, FILES_PER_HOUR)).allowed)
      return apiError(c, 429, "rate_limited", "Too many files for now");
    return next();
  });
  app.use("/feedback/files", bodyLimit({ maxSize: uploadMax, onError: tooLarge }));
  const address = () => {
    if (!config.FEEDBACK_EMAIL) throw new NotFoundError("Not found");
    return config.FEEDBACK_EMAIL;
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/feedback/files",
      tags,
      summary: "Add a picture or a video to the feedback being written",
      description:
        `A picture (PNG, JPEG, GIF, WebP, HEIC; ${FEEDBACK_FILES.imageBytes / 1024 / 1024} MB) or a video (MP4, MOV, WebM; ${FEEDBACK_FILES.videoBytes / 1024 / 1024} MB), told by its own bytes. ` +
        "Kept for an hour unless a feedback is sent with it (`files`).",
      security,
      request: {
        body: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: z.object({ file: z.any().openapi({ type: "string", format: "binary" }) }),
            },
          },
        },
      },
      responses: {
        200: json(FeedbackFile),
        400: errors[400],
        401: errors[401],
        404: errors[404],
        413: errorResponse("The file is too large (`feedback.file_too_large`)"),
        429: errorResponse("Too many (`rate_limited`, `feedback.files_pending`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const file: unknown = c.req.valid("form").file;
      if (!(file instanceof File)) throw new ValidationError("send the file in the field file", "feedback.file_type");
      if (file.size > FEEDBACK_FILES.videoBytes) return tooLarge(c);
      const bytes = new Uint8Array(await file.arrayBuffer());
      // A video by what it is, whatever its size: the heavy kind has its own, smaller, hour.
      const video = sniffFeedbackFile(bytes)?.kind === "video";
      if (video && !(await adapters.rateLimiter.consume(`feedback-video:${user.id}`, VIDEOS_PER_HOUR)).allowed)
        throw new TooManyError("Too many videos for now");
      try {
        return c.json(await storeFeedbackFile(files, user.id, { name: file.name, bytes }), 200);
      } catch (error) {
        if (error instanceof ValidationError && error.code === "feedback.file_too_large")
          return apiError(c, 413, error.code, error.message, error.params);
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/feedback/files/{fileId}",
      tags,
      summary: "Take a file back before the feedback is sent",
      security,
      request: { params: z.object({ fileId: z.uuid().openapi({ param: { name: "fileId", in: "path" } }) }) },
      responses: { ...noContent, 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      address();
      await dropFeedbackFile(files, c.get("user").id, c.req.valid("param").fileId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/feedback",
      tags,
      summary: "Send feedback to whoever runs this server",
      description:
        "One email to `FEEDBACK_EMAIL` with the text, the person's name and address (to answer them), the workspace's name when `orgId` is one of theirs, what they reported (`about`), what the app knew of where they were (`facts`), their files as links good for thirty days, and this server's version. 404 when the server takes no feedback (`auth-config.feedback` is false), 429 past ten an hour.",
      security,
      request: {
        body: body(
          z.object({
            id: z.uuid().openapi({ description: "Made by the app for this message: sent again, it goes once." }),
            text: z.string().trim().min(1).max(FEEDBACK_MAX),
            orgId: z.uuid().optional().openapi({ description: "The workspace the person was in." }),
            where: z.string().max(200).optional().openapi({ description: "The screen they were on (a path)." }),
            app: z.string().max(60).optional().openapi({ description: "The app that sent it, e.g. `web`." }),
            about: z
              .object({
                kind: z.string().min(1).max(40),
                label: z.string().max(120).optional(),
                text: z.string().max(FEEDBACK_ABOUT_MAX).optional(),
              })
              .optional()
              .openapi({ description: "The thing the feedback is about, and what it says, as the form showed it." }),
            facts: z
              .array(z.tuple([z.string().min(1).max(40), z.string().max(FEEDBACK_FACT_MAX)]))
              .max(FEEDBACK_FACTS)
              .optional()
              .openapi({ description: "What the app knew of where the person was, as the form listed it." }),
            files: z
              .array(z.uuid())
              .max(FEEDBACK_FILES.images + FEEDBACK_FILES.videos)
              .optional()
              .openapi({ description: "Files added with `POST /feedback/files`." }),
          }),
        ),
      },
      responses: { ...noContent, 400: errors[400], 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const to = address();
      const user = c.get("user");
      const input = c.req.valid("json");
      if (!(await adapters.rateLimiter.consume(`feedback:${user.id}`, FEEDBACK_PER_HOUR)).allowed)
        throw new TooManyError("Too much feedback for now");
      // Only a workspace of theirs is named: an id from anywhere else says nothing.
      const member = input.orgId ? await getMembership(db, user.id, input.orgId) : null;
      await db.transaction(async (tx) => {
        const attached = await attachFeedbackFiles(tx, {
          userId: user.id,
          orgId: member?.orgId ?? null,
          ids: input.files ?? [],
          publicUrl: config.PUBLIC_URL,
        });
        await queueFeedback(tx, {
          orgId: member?.orgId ?? null,
          key: `${user.id}:${input.id}`,
          feedback: {
            to,
            name: user.name,
            email: user.email,
            orgName: member?.orgName,
            text: input.text,
            where: input.where,
            app: input.app,
            about: input.about,
            facts: [...(member ? ([["Role", member.role]] as [string, string][]) : []), ...(input.facts ?? [])],
            files: attached,
            version,
          },
        });
      });
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/feedback/offers/{messageId}",
      tags,
      summary: "Send or dismiss a report an agent offered",
      description:
        "A report an agent offered about the app on its own (a reply's `meta.feedbackOffer`), decided by the person it is for, once: `send` queues the same email as the form's, in their name, with the agent's text; `dismiss` puts it away. Decided already, it answers with how it stands. 403 for anyone else, 409 when the server takes no feedback, 429 past ten an hour.",
      security,
      request: {
        params: z.object({ messageId: z.uuid().openapi({ param: { name: "messageId", in: "path" } }) }),
        body: body(
          z.object({
            orgId: z.uuid(),
            decision: z.enum(["send", "dismiss"]),
          }),
        ),
      },
      responses: {
        200: json(z.object({ offer: FeedbackOffer })),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const offer = await decideFeedbackOffer(
        { db, pubsub: adapters.pubsub, rateLimiter: adapters.rateLimiter, to: config.FEEDBACK_EMAIL, version },
        {
          orgId: input.orgId,
          messageId: c.req.valid("param").messageId,
          userId: c.get("user").id,
          decision: input.decision,
        },
      );
      if (offer.state === "sent") deps.wakeWorkers?.();
      return c.json({ offer }, 200);
    },
  );

  return app;
}

/**
 * `GET /api/feedback-files/{token}`: a file of a sent feedback, for whoever has its email, while it lasts. No
 * session: the reader is whoever runs the server, in their mail. Always a download, never shown by this origin, so a
 * file made to look like a picture runs nothing here.
 */
export function registerFeedbackFiles(api: OpenAPIHono, deps: AppDeps) {
  api.get("/feedback-files/:token", async (c) => {
    const from = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
    if (!(await deps.adapters.rateLimiter.consume(`feedback-open:${from}`, OPENS_PER_MINUTE)).allowed)
      return apiError(c, 429, "rate_limited", "Slow down");
    const file = await feedbackFileByToken({ db: deps.db, blobs: deps.adapters.platformBlobs }, c.req.param("token"));
    if (!file) return apiError(c, 404, "not_found", "Not found");
    return c.body(new Uint8Array(file.body), 200, {
      "content-type": file.contentType,
      "content-length": String(file.size),
      "content-disposition": `attachment; filename="${file.name.replace(/["\\]/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    });
  });
}
