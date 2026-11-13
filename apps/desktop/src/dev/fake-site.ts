/**
 * The server's devices API as the fake host answers `siteFetch` (design work and tests): this computer in each fake
 * workspace, its phones (the Pixel an agent uses for Rui, the iPhone that needs Developer Mode), an iPhone on its
 * Wi-Fi it could use, the people and roles of "Specific people or roles", and confirming a runner's code. Writes
 * change it; `calls` keeps every request.
 */
import type { ComputerDevice, DeviceAudience, PhoneDevice, WifiIphone } from "@agenteschat/client";
import type { SiteAnswer } from "../host/types";

const json = (status: number, body: unknown): SiteAnswer => ({ status, body: JSON.stringify(body) });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ONLY_ME: DeviceAudience = { mode: "owner", userIds: [], roleIds: [] };

export interface FakeSite {
  answer(method: string, path: string, body?: string): SiteAnswer;
  readonly calls: { method: string; path: string; body?: unknown }[];
  /** The next answers are the server's 401 (signed out there). */
  signedOut: boolean;
}

type FakeMachine = { machineId: string; name: string };

/** `confirm`: the runner showing `userCode` joins `orgId` (`POST …/machines/device/{userCode}/confirm`). */
export function createFakeSite(
  machineOf: (orgId: string) => FakeMachine | null,
  confirm: (orgId: string, userCode: string) => FakeMachine | null = () => null,
): FakeSite {
  const computers = new Map<string, ComputerDevice>();
  /** Every identifier made up. */
  const nearby: WifiIphone[] = [
    { serial: "00008120-000A1B2C3D4E5F60", model: "iPhone 14", name: "Ana's iPhone 14", osVersion: "27.0" },
  ];
  const computer = (orgId: string) => {
    const known = computers.get(orgId);
    if (known) return known;
    const machine = machineOf(orgId);
    if (!machine) return null;
    const phone = (p: Partial<PhoneDevice> & Pick<PhoneDevice, "id" | "name" | "platform" | "status">) =>
      ({
        phoneKind: "device",
        model: p.name,
        osVersion: p.platform === "ios" ? "27.1" : "16",
        hostMachineId: machine.machineId,
        ownerUserId: "u_sam",
        audience: p.platform === "ios" ? null : { mode: "everyone", userIds: [], roleIds: [] },
        transport: "usb",
        lastSeenAt: minutesAgo(0),
        mayUse: true,
        mayManage: true,
        ...p,
      }) as PhoneDevice;
    const made: ComputerDevice = {
      id: machine.machineId,
      machineKind: "connected",
      name: machine.name,
      os: "darwin",
      arch: "arm64",
      hostname: "sams-macbook-pro",
      cpus: 12,
      memoryGb: 36,
      ownerUserId: "u_sam",
      belongsToWorkspace: false,
      systemMode: false,
      audience: ONLY_ME,
      status: { kind: "ready" },
      maxTasks: 3,
      toolchains: { xcode: "27.0", java: "21", adb: "36.0.2" },
      lastSeenAt: minutesAgo(0),
      mayUse: true,
      mayManage: true,
      phones: [
        phone({
          id: "0b6c5a8e-0000-4000-8000-000000000001",
          name: "Pixel 8",
          platform: "android",
          status: {
            kind: "in_use",
            agentId: "ag_ada",
            agentName: "Ada",
            userId: "u_rui",
            userName: "Rui Tanaka",
            label: "Recording a test video",
            since: minutesAgo(10),
          },
        }),
        phone({
          id: "0b6c5a8e-0000-4000-8000-000000000002",
          name: "Sam's iPhone 16",
          model: "iPhone 16",
          platform: "ios",
          status: { kind: "needs_you", reason: "developer_mode_off" },
        }),
      ],
    };
    computers.set(orgId, made);
    return made;
  };

  const site: FakeSite = {
    calls: [],
    signedOut: false,
    answer(method, path, body) {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : undefined;
      site.calls.push({ method, path, ...(parsed ? { body: parsed } : {}) });
      if (site.signedOut) return json(401, { error: { code: "auth.unauthorized", message: "Sign in" } });
      const [, , , , orgId = "", ...rest] = path.split("/");
      if (method === "POST" && rest[0] === "machines" && rest[3] === "confirm") {
        const joined = confirm(orgId, rest[2] ?? "");
        return joined
          ? json(201, { id: joined.machineId, name: joined.name })
          : json(404, { error: { code: "machine.code_invalid", message: "This code expired." } });
      }
      const mine = computer(orgId);
      const route = `${method} ${rest.join("/")}`;
      if (route === "GET devices") return json(200, { devices: mine ? [mine] : [], requests: [] });
      if (route === "GET members")
        return json(200, {
          members: [
            { userId: "u_sam", name: "Sam Rivera", email: "sam@example.com", image: null },
            { userId: "u_ana", name: "Ana Costa", email: "ana@example.com", image: null },
            { userId: "u_rui", name: "Rui Tanaka", email: "rui@example.com", image: null },
          ],
        });
      if (route === "GET roles")
        return json(200, {
          roles: [
            { id: "r_mobile", kind: "custom", name: "Mobile team", icon: "phone", color: "teal", position: 0 },
            { id: "r_all", kind: "everyone", name: "Everyone", icon: "people", color: "indigo", position: 1 },
          ],
          areas: [],
          colors: [],
          icons: [],
        });
      if (!mine) return json(404, { error: { code: "not_found", message: "Not found" } });
      const [kind, id, action, serial] = rest.slice(1);
      if (kind === "computers" && id === mine.id && action === "wifi-iphones") {
        const picked = nearby.find((p) => p.serial === serial);
        if (method === "PUT" && picked) {
          nearby.splice(nearby.indexOf(picked), 1);
          mine.phones.push({
            id: `0b6c5a8e-0000-4000-8000-${picked.serial.slice(-12)}`,
            platform: "ios",
            phoneKind: "device",
            name: picked.name ?? picked.model,
            model: picked.model,
            osVersion: picked.osVersion,
            hostMachineId: mine.id,
            ownerUserId: "u_sam",
            audience: null,
            status: { kind: "preparing", reason: "helper_missing" },
            transport: "wifi",
            lastSeenAt: minutesAgo(0),
            mayUse: true,
            mayManage: true,
          });
        }
        if (method === "GET" || (method === "PUT" && picked)) return json(200, { available: nearby });
      }
      if (method === "PATCH" && kind === "computers" && id === mine.id) {
        Object.assign(mine, parsed);
        return json(200, mine);
      }
      const phone = mine.phones.find((p) => p.id === id);
      if (method === "PATCH" && kind === "phones" && phone) {
        Object.assign(phone, parsed);
        return json(200, phone);
      }
      if (method === "DELETE" && kind === "phones" && phone) {
        mine.phones = mine.phones.filter((p) => p !== phone);
        return { status: 204, body: "" };
      }
      if (method === "POST" && kind === "phones" && phone && action === "stop") {
        phone.status = { kind: "ready" };
        return { status: 204, body: "" };
      }
      return json(404, { error: { code: "not_found", message: "Not found" } });
    },
  };
  return site;
}
