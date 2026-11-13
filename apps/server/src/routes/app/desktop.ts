import { desktopPicture, desktopStatus, TooManyError } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { BrowserHandoff } from "./browser";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agent desktop"];

const AgentParams = OrgParams.extend({ agentId: z.uuid() });

const DesktopStatus = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable().openapi({
      description:
        "Why it can't be shown now: `no_desktop`, `no_computer`, `offline`, `runner_outdated`, `not_allowed` (its switch is off), `desktop_unavailable`, `browser_only` (this person's roles give them its browser, not its whole computer).",
    }),
    detail: z.string().nullable().openapi({ description: "What the computer says it lacks (what to install)." }),
    running: z.boolean().openapi({
      description: "Whether it runs now. One that doesn't starts when a stream opens, and then stays on.",
    }),
    startedAt: z.string().nullable(),
    controllerUserId: z.string().nullable(),
    handoff: BrowserHandoff.nullable().openapi({
      description:
        "The open handoff holding the desktop: its own, or the browser's when the agent's browser runs on its desktop (`screen`).",
    }),
    viewers: z.number().int(),
    canControl: z.boolean().openapi({ description: "This person may take control of the desktop." }),
    controlRefusal: z.enum(["pairer", "owner_plan", "role", "not_allowed"]).nullable().openapi({
      description:
        "Why not: `pairer` (only the person who connected the computer), `owner_plan` (only the agent's owner and admins who manage agents while it thinks with the owner's plan), `role` (their roles give them the agents' browsers, not the whole computer), `not_allowed` (neither an admin nor its owner).",
    }),
    held: z.boolean().openapi({
      description: "The agent is held, or its workspace is on hold: people may watch, nobody takes control.",
    }),
    browserOnDesktop: z.boolean().openapi({ description: "The agent's browser runs on this desktop (ADR 0058 §7)." }),
  })
  .openapi("DesktopStatus");

const DesktopPicture = z
  .object({
    picture: z
      .object({
        data: z.string().openapi({ description: "A JPEG, base64." }),
        width: z.number().int(),
        height: z.number().int(),
        capturedAt: z.string(),
      })
      .nullable(),
    reason: z.enum(["stopped", "hidden", "unavailable"]).nullable().openapi({
      description:
        "Why there is none: `stopped` (its screen isn't running, and this never starts it), `hidden` (someone else is in control), `unavailable`.",
    }),
  })
  .openapi("DesktopPicture");

/** A person's refreshes, every agent together: a few tabs on the slowest computers stay under it. */
const PICTURES_PER_MINUTE = { limit: 120, windowMs: 60_000 };

/**
 * An agent's desktop (ADR 0058): its state. The live screen is a WebSocket (`/api/desktop`), which starts the
 * desktop when it isn't running; it then stays on. Taking control and handing back are the screens' routes
 * (`…/desktop/takeover`, `browser/handoffs/{id}/…`).
 */
export function desktopRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const desktopDeps = () => ({ db, hub: deps.extras?.sandbox?.machines?.hub, streams: deps.extras?.streams });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/desktop",
      tags,
      security,
      summary: "An agent's desktop: whether it can be shown and runs, who is in control, what this person may do",
      request: { params: AgentParams },
      responses: { 200: json(DesktopStatus), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await desktopStatus(desktopDeps(), c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/desktop/picture",
      tags,
      security,
      summary: "A recent picture of an agent's screen, for whoever may watch it; never starts a stopped one",
      request: { params: AgentParams },
      responses: { 200: json(DesktopPicture), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const userId = c.get("user").id;
      const limit = await deps.adapters.rateLimiter.consume(`desktop-picture:${userId}`, PICTURES_PER_MINUTE);
      if (!limit.allowed) throw new TooManyError("Slow down");
      return c.json(await desktopPicture(desktopDeps(), userId, orgId, agentId), 200);
    },
  );

  return app;
}
