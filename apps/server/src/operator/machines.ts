import {
  issueManagedMachine,
  listMachineRequests,
  operatorMachines,
  PROVISIONING_REASONS,
  PROVISIONING_STATES,
  PROVISIONING_STEPS,
  revokeManagedMachine,
  setMachineEgressWaiting,
  setMachineStandby,
  setProvisioning,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, noContent, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const MAX_AHEAD_MS = 7 * 86_400_000;
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const Specs = z
  .object({
    cpus: z.number().int().min(1).max(1024),
    memoryGb: z.number().min(0).max(65536),
    diskGb: z.number().min(0).max(1_000_000),
  })
  .openapi("OperatorMachineSpecs", { description: "What the workspace is told it gets." });

const Provisioning = z
  .object({
    state: z.enum(PROVISIONING_STATES),
    step: z.enum(PROVISIONING_STEPS).nullable(),
    stage: z.string().nullable().openapi({ description: "With `preparing`: the stage you gave." }),
    reason: z.enum(PROVISIONING_REASONS).nullable(),
    since: z.string().nullable().openapi({ description: "When this state (and step or reason) began." }),
    requestedAt: z.string().openapi({
      description: "When its people started waiting: the computer's last removal, else the workspace's creation.",
    }),
    expectedReadyAt: z
      .string()
      .nullable()
      .openapi({ description: "With `preparing`: the earliest ready time you gave in this wait." }),
    specs: Specs.nullable(),
  })
  .openapi("OperatorProvisioning");

const MachineRequest = z
  .object({
    orgId: z.uuid(),
    orgName: z.string(),
    createdAt: z.string(),
    owner: z.object({ userId: z.string(), email: z.string() }).nullable().openapi({ description: "Its first owner." }),
    provisioning: Provisioning.nullable().openapi({ description: "What you last said about it; null: nothing yet." }),
  })
  .openapi("OperatorMachineRequest");

const RequestPage = z
  .object({
    requests: z.array(MachineRequest),
    next: z.string().nullable().openapi({ description: "`cursor` for the next page; null on the last one." }),
  })
  .openapi("OperatorMachineRequestPage");

const ProvisioningInput = z.object({
  state: z.enum(["preparing", "waiting", "problem"]).openapi({
    description: "`ready` is not yours to set: it comes with the computer's first hello.",
  }),
  step: z
    .enum(PROVISIONING_STEPS)
    .optional()
    .openapi({ description: "With `preparing`: reserving, starting, installing or connecting; ignored otherwise." }),
  stage: z.string().max(64).optional().openapi({
    description:
      "With `preparing`: what the computer is doing within `step` (ordering, wiping, starting, booting, updating, restarting, network, firewall, apps, connecting); ignored otherwise. Any word is kept: the apps say one they have no words for as its step.",
  }),
  reason: z
    .enum([...PROVISIONING_REASONS, "approval"])
    .optional()
    .openapi({
      description: "With `waiting`: capacity; ignored otherwise. `approval`, from an older client, reads as capacity.",
    }),
  expectedReadyAt: z.iso
    .datetime({ offset: true })
    .refine((at) => Date.parse(at) <= Date.now() + MAX_AHEAD_MS, "At most 7 days ahead")
    .optional()
    .openapi({
      description:
        "With `preparing`: when the computer should be ready, at most 7 days ahead; ignored otherwise. A wait counts down to the earliest time it was told: a later one, or a report without one, leaves it as it is, so people see the wait run over.",
    }),
  etaSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_AHEAD_MS / 1000)
    .optional()
    .openapi({
      description: "From an older client, in place of `expectedReadyAt`: read as that many seconds from now.",
    }),
  specs: Specs.optional().openapi({ description: "Kept from before when absent." }),
});

const Issued = z
  .object({
    machineId: z.uuid(),
    enrollCode: z.string().openapi({
      description:
        "Single use. The computer redeems it at `POST /api/machines/device/token` (`{ deviceCode }`) on the public address, like a confirmed connection code. Never log it.",
    }),
    expiresAt: z.string(),
  })
  .openapi("OperatorIssuedMachine");

const Machine = z
  .object({
    id: z.uuid(),
    kind: z.enum(["connected", "host", "managed"]),
    managed: z.boolean().openapi({ description: "The workspace's own computer, the one you issue." }),
    name: z.string(),
    online: z.boolean(),
    lastSeenAt: z.string().nullable(),
    runnerVersion: z.string(),
    protocol: z.number().int(),
    standby: z.boolean().openapi({
      description:
        "You put the workspace's computer in standby (`PUT …/standby`) and it hasn't connected since. False for every other computer.",
    }),
    busy: z.boolean().openapi({
      description:
        "The workspace's computer is in use now: a run of the workspace queued or running, a run waiting for this computer, a task running on it, someone in control of one of its agents' screens, or someone wanting it in the last 2 minutes (an open view of it asks every few seconds). Busy in standby: something waits for it. False for every other computer.",
    }),
    lastUsedAt: z.string().nullable().openapi({
      description:
        "When the workspace's computer was last used: the latest of the workspace's runs and this computer's tasks of the last 7 days, the last time something wanted it, and its people's last visit. Null for every other computer, or when nothing says.",
    }),
  })
  .openapi("OperatorMachine");

const MachineParams = OrgParams.extend({ machineId: z.uuid().openapi({ param: { name: "machineId", in: "path" } }) });

export function registerOperatorMachines(api: OpenAPIHono, { db, config, pubsub, emails }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/machine-requests",
      tags,
      summary: "Workspaces waiting for their computer, oldest first",
      description:
        "Active workspaces whose computer isn't ready (one on hold, suspended or being deleted is never listed). Empty unless `MACHINE_PROVISIONING=external`.",
      request: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          cursor: z.string().max(200).optional(),
        }),
      },
      responses: { 200: json(RequestPage), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const page = await listMachineRequests(db, config.MACHINE_PROVISIONING, c.req.valid("query"));
      return c.json(
        { ...page, requests: page.requests.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/provisioning",
      tags,
      summary: "Say how far the workspace's computer is",
      description:
        "Its people see it live, with the time left and the stage. The time `since` restarts only when the state, step or reason change. One wait counts down to the earliest ready time you gave it: a later one changes nothing they see, so a part running long reads as running over, until another state, a removal or a hold starts a new wait. A ready time over a minute ahead (the wait's earliest), `waiting` or `problem` tells the owners they'll get an email when it's ready (when this server sends email). Refused (409 `provisioning.ready`) once the computer is ready, until it is removed, and (403 `org.paused`, `org.suspended`, `org.deleting`) unless the workspace is active and not being deleted: one held, suspended or being deleted waits for no computer, and what you last said of it is gone.",
      request: { params: OrgParams, body: body(ProvisioningInput) },
      responses: {
        204: noContent[204],
        ...errors,
        403: errorResponse("The workspace isn't active"),
        409: errorResponse("The computer is ready"),
      },
    }),
    async (c) => {
      const { expectedReadyAt, ...input } = c.req.valid("json");
      const found = await setProvisioning({ db, pubsub, emails }, c.req.valid("param").orgId, {
        ...input,
        ...(expectedReadyAt ? { expectedReadyAt: new Date(expectedReadyAt) } : {}),
      });
      if (!found) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/machines",
      tags,
      summary: "The workspace's computer, and a code for it to connect with",
      description:
        "One per workspace: the first call makes it, every later one issues a new code for the same computer (an earlier unused code stops working), and one removed comes back. The code lives 10 minutes; once redeemed, the computer's first hello makes it ready and gives it the workspace's agents that have no computer. Refused (403 `org.paused`, `org.suspended`, `org.deleting`) unless the workspace is active and not being deleted.",
      request: { params: OrgParams, body: body(z.object({ name: z.string().trim().max(80).optional() })) },
      responses: { 200: json(Issued), ...errors, 403: errorResponse("The workspace isn't active") },
    }),
    async (c) => {
      const issued = await issueManagedMachine({ db }, c.req.valid("param").orgId, c.req.valid("json"));
      if (!issued) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ ...issued, expiresAt: issued.expiresAt.toISOString() }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/machines",
      tags,
      summary: "The workspace's computers, its own and the ones its people connected",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ machines: z.array(Machine) })), ...errors },
    }),
    async (c) => {
      const machines = await operatorMachines(db, c.req.valid("param").orgId);
      if (!machines) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(
        { machines: machines.map((m) => ({ ...m, lastSeenAt: iso(m.lastSeenAt), lastUsedAt: iso(m.lastUsedAt) })) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/machines/{machineId}/standby",
      tags,
      summary: "Say the workspace's computer is in standby, or no longer",
      description:
        "Say it when you put the computer to sleep (`true`), or that it no longer is (`false`; its first hello clears it too). In standby nothing is wrong to its people: it opens as it wakes, and it is never listed as disconnected. Whatever wants it meanwhile (a run, a person opening it, a request to it) records `machine.wake_wanted` in the events feed, at most every 10 seconds per computer: wake it then. A run waits up to a minute for it before it tells its people the computer isn't answering. `true` again keeps the first time it was said. 404 when the workspace has no such managed computer.",
      request: { params: MachineParams, body: body(z.object({ standby: z.boolean() })) },
      responses: { 200: json(z.object({ standby: z.boolean() }).openapi("OperatorStandby")), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const set = await setMachineStandby({ db, pubsub }, orgId, machineId, c.req.valid("json").standby);
      if (!set) return apiError(c, 404, "not_found", "This workspace has no managed computer with this id");
      return c.json(set, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/machines/{machineId}/egress-waiting",
      tags,
      summary: "Say the workspace's computer's agents wait for their way out, or no longer",
      description:
        "Say it (`true`) when the computer's network sends its agents out only through a proxy and none works now, so their connections are refused for a while; `false` once one works. Its people see a line saying so on the computer, never an error, while it is online. `true` again keeps the first time it was said; removing the computer ends it. A change comes as `machine.updated`. 404 when the workspace has no such managed computer.",
      request: { params: MachineParams, body: body(z.object({ waiting: z.boolean() })) },
      responses: { 200: json(z.object({ waiting: z.boolean() }).openapi("OperatorEgressWaiting")), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const set = await setMachineEgressWaiting({ db, pubsub }, orgId, machineId, c.req.valid("json").waiting);
      if (!set) return apiError(c, 404, "not_found", "This workspace has no managed computer with this id");
      return c.json(set, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/machines/{machineId}",
      tags,
      summary: "Take the workspace's computer away",
      description:
        "Before wiping or retiring it: its token and unused codes stop working, its connection closes, its agents are left with no computer, and an active workspace is a request again, waiting from now (one held or suspended waits for none). 404 when the workspace has no such managed computer (also when it was already removed).",
      request: { params: MachineParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      if (!(await revokeManagedMachine({ db, pubsub, emails }, orgId, machineId))) {
        return apiError(c, 404, "not_found", "This workspace has no managed computer with this id");
      }
      return c.body(null, 204);
    },
  );
}
