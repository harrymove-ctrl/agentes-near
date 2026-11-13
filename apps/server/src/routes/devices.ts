import { pairAddress } from "@agenteschat/adapters";
import {
  approveDeviceJoin,
  cancelWifiPairing,
  connectLinkInfo,
  connectLinkState,
  createConnectLink,
  deleteMachine,
  denyDeviceJoin,
  forgetPhone,
  listDevices,
  lookForPhones,
  normalizeUserCode,
  openConnectLink,
  pickIphoneOverWifi,
  startWifiPairing,
  stopPhone,
  updateComputerDevice,
  updatePhoneDevice,
  ValidationError,
  wifiIphones,
  wifiPairingState,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  expiredLinkScript,
  expiredLinkScriptPowerShell,
  installScript,
  installScriptPowerShell,
} from "../../runner/install-script";
import { requestLimitIp } from "../http/client-ip";
import { apiError, errorResponse } from "../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./app/context";

const tags = ["Devices"];

const Audience = z
  .object({
    mode: z.enum(["everyone", "people", "owner"]),
    userIds: z.array(z.string().max(64)).max(500),
    roleIds: z.array(z.uuid()).max(100),
  })
  .openapi("DeviceAudience", {
    description:
      "Who may point their agents at it: `owner` (its owner and agents working for them), `everyone`, or `people` (these people and roles, plus the owner).",
  });

const Reason = z.string().openapi({ description: "A code the apps word (`PhoneReason` in the machine protocol)." });

const Status = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready") }),
    z.object({
      kind: z.literal("in_use"),
      agentId: z.string().nullable(),
      agentName: z.string().nullable(),
      userId: z.string().nullable(),
      userName: z.string().nullable(),
      label: z.string().optional(),
      since: z.string(),
    }),
    z.object({ kind: z.literal("busy"), running: z.number().int(), max: z.number().int() }),
    z.object({ kind: z.literal("needs_you"), reason: Reason }),
    z.object({ kind: z.literal("preparing"), reason: Reason }),
    z.object({ kind: z.literal("paused"), until: z.string().nullable() }),
    z.object({ kind: z.literal("offline"), lastSeenAt: z.string().nullable(), withHost: z.boolean().optional() }),
    z.object({ kind: z.literal("unsupported"), reason: Reason }),
  ])
  .openapi("DeviceStatus");

const Phone = z
  .object({
    id: z.uuid(),
    platform: z.enum(["android", "ios"]),
    phoneKind: z.enum(["device", "emulator", "simulator"]),
    name: z.string(),
    model: z.string(),
    osVersion: z.string(),
    hostMachineId: z.uuid().nullable(),
    ownerUserId: z.string().nullable(),
    audience: Audience.nullable().openapi({ description: "null: it follows its computer's rule (an iPhone)." }),
    status: Status,
    transport: z.enum(["usb", "wifi", "local"]).nullable(),
    lastSeenAt: z.string().nullable(),
    mayUse: z.boolean().openapi({ description: "Your agents may use it." }),
    mayManage: z.boolean().openapi({ description: "You may change it (its owner, or an admin who only narrows)." }),
  })
  .openapi("PhoneDevice");

const Computer = z
  .object({
    id: z.uuid(),
    machineKind: z.enum(["connected", "host", "managed"]),
    name: z.string(),
    os: z.string(),
    arch: z.string(),
    hostname: z.string(),
    cpus: z.number().nullable(),
    memoryGb: z.number().nullable(),
    ownerUserId: z.string().nullable(),
    belongsToWorkspace: z.boolean(),
    systemMode: z.boolean().openapi({ description: "Each agent works as its own OS user there (a server install)." }),
    audience: Audience,
    status: Status,
    maxTasks: z.number().int().nullable(),
    toolchains: z.record(z.string(), z.string()),
    lastSeenAt: z.string().nullable(),
    mayUse: z.boolean(),
    mayManage: z.boolean(),
    phones: z.array(Phone),
  })
  .openapi("ComputerDevice");

const JoinRequest = z
  .object({
    id: z.uuid(),
    linkId: z.uuid(),
    name: z.string(),
    hostname: z.string(),
    os: z.string(),
    arch: z.string(),
    ip: z.string(),
    location: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("JoinRequest");

const ConnectLink = z
  .object({
    id: z.uuid(),
    code: z.string().openapi({ example: "K7QM-4ZPA" }),
    expiresAt: z.string(),
    commands: z.object({ unix: z.string(), windows: z.string() }),
  })
  .openapi("ConnectLink");

const ConnectLinkState = z
  .object({
    status: z.enum(["waiting", "asking", "joined", "denied", "expired"]),
    request: JoinRequest.optional(),
    machineId: z.uuid().optional(),
  })
  .openapi("ConnectLinkState");

const WifiPairing = z
  .object({
    id: z.string(),
    way: z.enum(["qr", "code"]),
    state: z.enum(["waiting", "pairing", "connecting", "connected", "failed"]),
    reason: z
      .enum([
        "mdns_off",
        "same_wifi",
        "refused",
        "timed_out",
        "outdated",
        "adb_missing",
        "canceled",
        "failed",
        "update",
      ])
      .optional(),
    qr: z
      .string()
      .optional()
      .openapi({ description: "Only when it starts: Android's `WIFI:T:ADB;S:…;P:…;;` QR text." }),
    phoneId: z.uuid().optional().openapi({ description: "Connected: the phone in `GET …/devices`." }),
    expiresAt: z.string(),
  })
  .openapi("WifiPairing");

const WifiIphones = z
  .object({
    available: z.array(
      z.object({ serial: z.string(), model: z.string(), name: z.string().optional(), osVersion: z.string() }),
    ),
    update: z.literal(true).optional(),
  })
  .openapi("WifiIphones");

const MachineParams = OrgParams.extend({ machineId: z.uuid() });
const WifiIphoneParams = MachineParams.extend({ serial: z.string().min(1).max(200) });
const PairingParams = MachineParams.extend({ pairingId: z.uuid() });
const PhoneParams = OrgParams.extend({ phoneId: z.uuid() });
const LinkParams = OrgParams.extend({ linkId: z.uuid() });
const RequestParams = OrgParams.extend({ requestId: z.uuid() });

/** New connect links per person: a few tries while setting up a server, never a stream. */
const LINK_LIMIT = { limit: 20, windowMs: 10 * 60_000 };
/** Wi-Fi pairings per person: each runs adb on the computer for up to 2 minutes. */
const PAIR_LIMIT = { limit: 30, windowMs: 10 * 60_000 };
/** Installer fetches per address (`/i/{code}`): a person retrying, not someone guessing codes. */
const SCRIPT_LIMIT = { limit: 30, windowMs: 60_000 };

/**
 * Bring your own devices in the apps (session + CSRF like the rest of `/api/app`): the list, a device's name and who
 * can use it, removing a computer, forgetting or stopping a phone, connect links and the computers asking to join.
 */
export function deviceAppRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const hub = () => {
    const machines = deps.extras?.sandbox?.machines?.hub;
    if (!machines) throw new ValidationError("Connected computers are not available on this server");
    return machines;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/devices",
      tags,
      security,
      summary:
        "The workspace's devices: computers (the workspace's own first) with their phones, and computers asking to join",
      description:
        "Every member sees every device; `requests` only the maker of their link and admins. Changes come as the `devices.changed` org event and the `machine.*` ones: refetch.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ devices: z.array(Computer), requests: z.array(JoinRequest) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await listDevices(db, orgId, c.get("user").id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/devices/computers/{machineId}",
      tags,
      security,
      summary: "Rename a computer, change who can use it, mark it the workspace's",
      description:
        "Its owner: anything. An admin: rename, mark it the workspace's, and narrow who can use someone's own computer (`device.widen_forbidden` otherwise). Never the workspace's computer (`machine.managed`).",
      request: {
        params: MachineParams,
        body: body(
          z.object({
            name: z.string().min(1).max(80).optional(),
            audience: Audience.optional(),
            belongsToWorkspace: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(Computer), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const device = await updateComputerDevice(
        { db, pubsub },
        c.get("user").id,
        orgId,
        machineId,
        c.req.valid("json"),
      );
      return c.json(device, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/devices/computers/{machineId}",
      tags,
      security,
      summary: "Remove a computer (its owner or an admin): its token stops working at once",
      request: { params: MachineParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      await deleteMachine({ db, pubsub }, c.get("user").id, orgId, machineId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/devices/phones/{phoneId}",
      tags,
      security,
      summary: "Rename a phone or change who can use it",
      description:
        "Its owner, or an admin who only narrows. An iPhone follows its computer's rule (`device.follows_host` for `audience`).",
      request: {
        params: PhoneParams,
        body: body(z.object({ name: z.string().min(1).max(80).optional(), audience: Audience.optional() })),
      },
      responses: { 200: json(Phone), ...errors },
    }),
    async (c) => {
      const { orgId, phoneId } = c.req.valid("param");
      return c.json(
        await updatePhoneDevice({ db, pubsub }, c.get("user").id, orgId, phoneId, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/devices/phones/{phoneId}",
      tags,
      security,
      summary: "Forget a phone (its owner or an admin); it comes back if its computer sees it again",
      description: "An iPhone used over Wi-Fi also stops being used over Wi-Fi: it comes back only if picked again.",
      request: { params: PhoneParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, phoneId } = c.req.valid("param");
      await forgetPhone({ db, pubsub, hub: hub() }, c.get("user").id, orgId, phoneId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/phones/{phoneId}/stop",
      tags,
      security,
      summary: "Take a phone back from the agent using it (its owner, an admin, or the person the agent works for)",
      request: { params: PhoneParams, body: body(z.object({}).strict()) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, phoneId } = c.req.valid("param");
      await stopPhone({ db, pubsub, hub: hub() }, c.get("user").id, orgId, phoneId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/computers/{machineId}/wifi-pairings",
      tags,
      security,
      summary: "Pair an Android phone with this computer over Wi-Fi (its owner or an admin)",
      description:
        "Without a body: Android's QR for Wireless debugging › Pair device with QR code. With `address` and `code`: the six digits and the address Pair device with pairing code shows. The computer finds the phone, pairs and connects it, for up to 2 minutes; one at a time. Ask `GET` for where it stands.",
      request: {
        params: MachineParams,
        body: body(
          z
            .object({
              address: z
                .string()
                .max(80)
                .regex(/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:%.\w]{2,60}\]):\d{1,5}$/)
                .refine((a) => pairAddress(a) !== null, "Not an IP address and port")
                .openapi({ example: "192.168.1.20:37099" }),
              code: z.string().regex(/^\d{6}$/),
            })
            .partial()
            .refine((v) => (v.address === undefined) === (v.code === undefined), "address and code go together"),
        ),
      },
      responses: { 201: json(WifiPairing, "Started"), 429: errorResponse("Too many pairings"), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const userId = c.get("user").id;
      const limit = await deps.adapters.rateLimiter.consume(`device-pair:user:${userId}`, PAIR_LIMIT);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many pairings. Try again in a few minutes.");
      const started = await startWifiPairing({ db, hub: hub() }, userId, orgId, machineId, c.req.valid("json"));
      return c.json(started, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/devices/computers/{machineId}/wifi-pairings/{pairingId}",
      tags,
      security,
      summary: "Where a Wi-Fi pairing stands: waiting for the phone, pairing, connecting, connected or failed",
      request: { params: PairingParams },
      responses: { 200: json(WifiPairing), ...errors },
    }),
    async (c) => {
      const { orgId, machineId, pairingId } = c.req.valid("param");
      return c.json(await wifiPairingState({ db, hub: hub() }, c.get("user").id, orgId, machineId, pairingId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/computers/{machineId}/phone-looks",
      tags,
      security,
      summary: "Look for a cabled phone the computer has no driver for",
      description:
        "A phone guide waits for a phone plugged into this computer: for the next minute, the computer also looks for one it has no USB driver for (Windows), which then shows as needing the person (`no_driver`). Read only. Ask again while the guide stays open.",
      request: { params: MachineParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      await lookForPhones({ db, hub: hub() }, c.get("user").id, orgId, machineId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/devices/computers/{machineId}/wifi-iphones",
      tags,
      security,
      summary: "iPhones on this Mac's Wi-Fi it could use (its owner or an admin)",
      description:
        "The iPhones on the Mac's network that already trust it (they did over a cable once) and aren't used yet. None is used until picked with `PUT`. `update`: the Mac's agentes.chat is too old for this. An offline Mac lists none.",
      request: { params: MachineParams },
      responses: { 200: json(WifiIphones), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      return c.json(await wifiIphones({ db, hub: hub() }, c.get("user").id, orgId, machineId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/devices/computers/{machineId}/wifi-iphones/{serial}",
      tags,
      security,
      summary: "Use an iPhone on this Mac's Wi-Fi (its owner or an admin)",
      description:
        "From now on the Mac reaches it through CoreDevice's own tunnel, and it shows up among the Mac's phones, connected over Wi-Fi. Forgetting the phone stops it. Answers the iPhones still on offer.",
      request: { params: WifiIphoneParams, body: body(z.object({}).strict()) },
      responses: { 200: json(WifiIphones), ...errors },
    }),
    async (c) => {
      const { orgId, machineId, serial } = c.req.valid("param");
      return c.json(
        await pickIphoneOverWifi({ db, pubsub, hub: hub() }, c.get("user").id, orgId, machineId, serial),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/devices/computers/{machineId}/wifi-pairings/{pairingId}",
      tags,
      security,
      summary: "Stop a Wi-Fi pairing (the dialog closed)",
      request: { params: PairingParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId, pairingId } = c.req.valid("param");
      await cancelWifiPairing({ db, hub: hub() }, c.get("user").id, orgId, machineId, pairingId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/connect-links",
      tags,
      security,
      summary: "A one-line install for a new computer: works once, for 10 minutes, and the computer still asks to join",
      request: { params: OrgParams, body: body(z.object({ kind: z.enum(["server", "computer"]) })) },
      responses: { 201: json(ConnectLink, "Made"), 429: errorResponse("Too many links"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      const limit = await deps.adapters.rateLimiter.consume(`device-link:user:${userId}`, LINK_LIMIT);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many links. Try again in a few minutes.");
      const link = await createConnectLink({ db }, deps.config.PUBLIC_URL, userId, orgId, c.req.valid("json").kind);
      return c.json(link, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/devices/connect-links/{linkId}",
      tags,
      security,
      summary:
        "Where the computer that ran a link is (its maker, or an admin): waiting, asking to join, joined, denied, expired",
      request: { params: LinkParams },
      responses: { 200: json(ConnectLinkState), ...errors },
    }),
    async (c) => {
      const { orgId, linkId } = c.req.valid("param");
      return c.json(await connectLinkState({ db }, c.get("user").id, orgId, linkId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/requests/{requestId}/approve",
      tags,
      security,
      summary: "Let a computer asking to join in (only the maker of its link), with its name and who can use it",
      description:
        "Who can use it defaults to everyone for a server link and to Only the maker for a computer link. The computer gets its token on its next poll.",
      request: {
        params: RequestParams,
        body: body(z.object({ name: z.string().min(1).max(80).optional(), audience: Audience.optional() })),
      },
      responses: { 200: json(z.object({ machineId: z.uuid() })), ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      const joined = await approveDeviceJoin({ db, pubsub }, c.get("user").id, orgId, requestId, c.req.valid("json"));
      return c.json(joined, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/requests/{requestId}/deny",
      tags,
      security,
      summary: "Refuse a computer asking to join (the maker of its link, or an admin)",
      request: { params: RequestParams, body: body(z.object({}).strict()) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      await denyDeviceJoin({ db, pubsub }, c.get("user").id, orgId, requestId);
      return c.body(null, 204);
    },
  );

  return app;
}

/**
 * `GET /api/machines/connect-links/{code}` (no session, no CSRF: it only reads): the workspace and the maker of a
 * link, for the desktop app's own "Connect this computer to …?" before it asks to join with it. Unknown, used and
 * expired give the same 404, and a try counts like the install line's.
 */
export function registerConnectLinkInfo(api: OpenAPIHono, deps: AppDeps) {
  const { db, config, adapters } = deps;
  api.openapi(
    createRoute({
      method: "get",
      path: "/machines/connect-links/{code}",
      tags,
      summary: "A connect link's workspace and maker, while it waits for its computer",
      request: { params: z.object({ code: z.string().openapi({ example: "K7QM-4ZPA" }) }) },
      responses: {
        200: json(
          z
            .object({
              org: z.object({ name: z.string() }),
              by: z.object({ name: z.string() }),
              kind: z.enum(["server", "computer"]),
              expiresAt: z.string(),
            })
            .openapi("ConnectLinkInfo"),
        ),
        404: json(z.object({ error: z.literal("link_expired") }), "Unknown, used or expired"),
        429: errorResponse("Too many tries from this address"),
      },
    }),
    async (c) => {
      const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      if (!(await adapters.rateLimiter.consume(`device-link-info:${ip}`, SCRIPT_LIMIT)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many tries from this address. Wait a minute and try again.");
      }
      const info = await connectLinkInfo(db, c.req.valid("param").code);
      return info ? c.json(info, 200) : c.json({ error: "link_expired" as const }, 404);
    },
  );
}

const SH = { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" };
const PS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

/**
 * `curl -fsSL <server>/i/<code> | sh` and `irm <server>/i/<code>/ps | iex`, at the root like `/install` (no session):
 * the installer with the link baked in. A code that is unknown, used or expired still answers a script, one that
 * says so: piped into a shell, an error page would run as commands. Too many tries fail the download itself (429),
 * which `curl -f` and `irm` stop on.
 */
export function registerConnectScripts(app: OpenAPIHono, deps: AppDeps) {
  const { db, config, adapters } = deps;
  const serve = (ps: boolean) => async (c: Context) => {
    const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
    if (!(await adapters.rateLimiter.consume(`device-script:${ip}`, SCRIPT_LIMIT)).allowed) {
      return c.text("Too many tries from this address. Wait a minute and run it again.\n", 429, {
        "cache-control": "no-store",
      });
    }
    const link = await openConnectLink(db, c.req.param("code") ?? "");
    const headers = ps ? PS : SH;
    if (!link) return c.body(ps ? expiredLinkScriptPowerShell() : expiredLinkScript(), 200, headers);
    // Only the code's own letters reach the script, whatever the address said.
    const code = normalizeUserCode(c.req.param("code") ?? "");
    const options = { link: `${code.slice(0, 4)}-${code.slice(4)}` };
    return c.body(
      ps ? installScriptPowerShell(config.PUBLIC_URL, options) : installScript(config.PUBLIC_URL, options),
      200,
      headers,
    );
  };
  app.get("/i/:code", serve(false));
  app.get("/i/:code/ps", serve(true));
}
