import { DESKTOP_USE_PROTOCOL, type DesktopLookReply, type MachineRequest } from "@agenteschat/adapters";
import type { MachineCaller, MachineStatus } from "../src";
import { THUNAR } from "./screen-fixtures";

/** The desktop entries a fake computer lists (`desktop.apps`). */
export const APPS = [
  { id: "thunar.desktop", name: "Thunar File Manager", generic: "File Manager" },
  { id: "xfce4-terminal.desktop", name: "Xfce Terminal", generic: "Terminal Emulator" },
  { id: "org.xfce.mousepad.desktop", name: "Mousepad", generic: "Text Editor" },
  { id: "org.gnome.gedit.desktop", name: "gedit", generic: "Text Editor" },
];

export const lookOf = (snapshot: string, title = "Files - Thunar"): DesktopLookReply => ({
  snapshot,
  refs: {},
  address: "desktop://thunar/main",
  title,
  screen: { width: 1280, height: 800 },
});

/** A hub for one machine serving desktop use: its status as the test sets it, and every request it got. */
export function fakeHub(state: { machineId: string; orgId: string }) {
  const calls: MachineRequest[] = [];
  const s = {
    status: {} as Partial<MachineStatus>,
    look: lookOf(THUNAR),
    /** Per request, when it answers (else the defaults below). */
    respond: null as ((request: MachineRequest) => unknown) | null,
    error: null as Error | null,
  };
  const hub: MachineCaller = {
    async status(id) {
      if (id !== state.machineId) return null;
      return {
        id,
        orgId: state.orgId,
        name: "Box",
        online: true,
        execAllowed: true,
        os: "linux",
        protocol: DESKTOP_USE_PROTOCOL,
        executors: { desktop: { available: true }, desktopUse: { available: true } },
        paused: null,
        access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true } },
        ...s.status,
      };
    },
    async call(_id, request) {
      const r = request as MachineRequest;
      calls.push(r);
      if (s.error) throw s.error;
      const answer = s.respond?.(r);
      if (answer !== undefined) return answer as never;
      switch (r.op) {
        case "desktop.look":
          return s.look as never;
        case "desktop.act":
          return { look: s.look, settled: true } as never;
        case "desktop.capture":
          return {
            data: "JPEG",
            width: 1280,
            height: 800,
            screen: { width: 1280, height: 800 },
            region: r.region ?? null,
            marks: [],
          } as never;
        case "desktop.apps":
          return { apps: APPS } as never;
        default:
          return { size: 4 } as never;
      }
    },
  };
  return { hub, calls, s };
}
