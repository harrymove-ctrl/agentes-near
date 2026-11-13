import type { Agent, ComputerDevice, DevicesList, Member, PhoneDevice } from "@agenteschat/client";
import { ORG_ID, seedState } from "../fake-api";

/**
 * The devices fixture of the mockups: workspace Acme, Sam Rivera (admin, the viewer) with a MacBook Pro, a Pixel 8
 * and an iPhone 16, Ana Costa's iMac and iPhone 15, the Windows build PC Rui Tanaka connected (the workspace's now),
 * build-box, and agents Lia and Theo.
 */
export const SAM = "u-sam";
export const ANA = "u-ana";
export const RUI = "u-rui";
export const LIA = "00000000-0000-4000-8000-0000000000b1";
export const THEO = "00000000-0000-4000-8000-0000000000b2";
export const MAC = "m-mac";
export const PIXEL = "p-pixel";
export const IPHONE = "p-iphone";
export const BUILD_PC = "m-buildpc";
export const IMAC = "m-imac";

const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const member = (userId: string, name: string, email: string, role: Member["role"]): Member => ({
  userId,
  name,
  email,
  image: null,
  role,
  joinedAt: "2026-10-01T12:00:00.000Z",
  handle: name.split(" ")[0]?.toLowerCase() ?? userId,
  timezone: "America/Sao_Paulo",
});

/** The fake app's state with the fixture's people and agents; Sam is the one signed in. */
export function acmeState() {
  const state = seedState();
  const sam = member(SAM, "Sam Rivera", "sam@acme.co", "owner");
  state.me = {
    ...state.me,
    user: { id: SAM, name: sam.name, email: sam.email, image: null },
    organizations: state.me?.organizations ?? [],
  } as typeof state.me;
  state.members = [
    sam,
    member(ANA, "Ana Costa", "ana@acme.co", "member"),
    member(RUI, "Rui Tanaka", "rui@acme.co", "member"),
  ];
  const agent = (id: string, name: string, role: string): Agent => ({
    ...(state.agents[0] as Agent),
    id,
    name,
    handle: name.toLowerCase(),
    role,
    ownerUserId: SAM,
  });
  state.agents = [agent(LIA, "Lia", "Mobile QA"), agent(THEO, "Theo", "Android and backend")];
  return state;
}

const everyone = { mode: "everyone" as const, userIds: [], roleIds: [] };
const onlyOwner = { mode: "owner" as const, userIds: [], roleIds: [] };

const computer = (d: Partial<ComputerDevice> & Pick<ComputerDevice, "id" | "name" | "os">): ComputerDevice => ({
  machineKind: "connected",
  arch: "arm64",
  hostname: d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  cpus: 8,
  memoryGb: 16,
  ownerUserId: SAM,
  belongsToWorkspace: false,
  systemMode: false,
  audience: onlyOwner,
  status: { kind: "ready" },
  maxTasks: 1,
  toolchains: {},
  lastSeenAt: null,
  mayUse: true,
  mayManage: true,
  phones: [],
  ...d,
});

const phone = (
  d: Partial<PhoneDevice> & Pick<PhoneDevice, "id" | "name" | "platform" | "hostMachineId">,
): PhoneDevice => ({
  phoneKind: "device",
  model: d.name,
  osVersion: "16",
  ownerUserId: SAM,
  audience: everyone,
  status: { kind: "ready" },
  transport: "usb",
  lastSeenAt: null,
  mayUse: true,
  mayManage: true,
  ...d,
});

/** The eight devices as of the mockups (times relative to `now`), and one computer asking to join. */
export function acmeDevices(now = new Date()): DevicesList {
  return {
    devices: [
      computer({
        id: "m-workspace",
        name: "Workspace computer",
        os: "linux",
        machineKind: "managed",
        cpus: 4,
        memoryGb: 8,
        ownerUserId: null,
        belongsToWorkspace: true,
        audience: everyone,
        mayManage: false,
      }),
      computer({
        id: MAC,
        name: "Sam's MacBook Pro",
        os: "darwin",
        cpus: 12,
        memoryGb: 36,
        toolchains: { xcode: "27.0", java: "21", git: "2.47", adb: "36.0" },
        phones: [
          phone({
            id: PIXEL,
            name: "Pixel 8",
            platform: "android",
            hostMachineId: MAC,
            status: {
              kind: "in_use",
              agentId: LIA,
              agentName: "Lia",
              userId: RUI,
              userName: "Rui Tanaka",
              label: "Recording a test video",
              since: ago(now, 10),
            },
          }),
          phone({
            id: IPHONE,
            name: "Sam's iPhone 16",
            model: "iPhone 16",
            platform: "ios",
            osVersion: "27.1",
            hostMachineId: MAC,
            audience: null,
            status: { kind: "needs_you", reason: "developer_mode_off" },
          }),
        ],
      }),
      computer({
        id: BUILD_PC,
        name: "Windows build PC",
        os: "windows",
        arch: "x86_64",
        cpus: 32,
        memoryGb: 64,
        ownerUserId: RUI,
        belongsToWorkspace: true,
        audience: everyone,
        status: { kind: "busy", running: 1, max: 1 },
        toolchains: { java: "21", androidSdk: "36", git: "2.47" },
      }),
      computer({
        id: "m-buildbox",
        name: "build-box",
        os: "linux",
        arch: "x86_64",
        cpus: 16,
        memoryGb: 64,
        belongsToWorkspace: true,
        systemMode: true,
        audience: everyone,
      }),
      computer({
        id: IMAC,
        name: "Ana's iMac",
        os: "darwin",
        cpus: 8,
        memoryGb: 24,
        ownerUserId: ANA,
        status: { kind: "offline", lastSeenAt: ago(now, 18) },
        lastSeenAt: ago(now, 18),
        mayUse: false,
        phones: [
          phone({
            id: "p-ana-iphone",
            name: "Ana's iPhone 15",
            model: "iPhone 15",
            platform: "ios",
            osVersion: "26.4",
            hostMachineId: IMAC,
            ownerUserId: ANA,
            audience: null,
            status: { kind: "offline", lastSeenAt: ago(now, 18), withHost: true },
            mayUse: false,
          }),
        ],
      }),
    ],
    requests: [
      {
        id: "r-ci",
        linkId: "link-ci",
        name: "ci-runner",
        hostname: "ci-runner",
        os: "linux",
        arch: "x86_64",
        ip: "203.0.113.7",
        location: "Frankfurt, Germany",
        createdAt: ago(now, 1),
        expiresAt: ago(now, -9),
      },
    ],
  };
}

export { ORG_ID };
