import { describe, expect, test } from "bun:test";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import { type Home, isRefusedHome } from "../src/control/store";
import { createDesktopI18n } from "../src/i18n";

/** "Reconnect this Mac": which home the popover offers it for, and the words by platform. */

const status = (over: Partial<ControlStatus> = {}): ControlStatus => ({
  paired: true,
  org: { id: "o1", name: "Acme" },
  connection: "online",
  version: "0.1.0",
  protocol: 10,
  paused: { paused: false },
  executors: {},
  agents: [],
  ...over,
});
const home = (homeId: string, st: ControlStatus | null): Home => ({
  homeId,
  dir: `/tmp/${homeId}`,
  running: true,
  hello: null,
  status: st,
  jobs: [],
  requests: [],
  access: null,
  logo: null,
});

describe("reconnect this computer", () => {
  test("only a paired home the server refused offers it (not offline, outdated or unpaired)", () => {
    expect(isRefusedHome(home("a", status({ connection: "refused", refusedReason: "revoked" })))).toBe(true);
    expect(isRefusedHome(home("b", status({ connection: "offline" })))).toBe(false);
    expect(isRefusedHome(home("c", status({ connection: "outdated" })))).toBe(false);
    expect(isRefusedHome(home("d", status({ paired: false, connection: "refused" })))).toBe(false);
    expect(isRefusedHome(home("e", null))).toBe(false);
  });

  test("the banner speaks of coming back with the same agents, naming this computer", () => {
    const pt = createDesktopI18n("pt-BR", "mac");
    expect(pt.t("desktop.tray.reconnectMac")).toBe("Reconectar este Mac");
    expect(pt.t("desktop.tray.refusedBody")).toBe("Reconecte para voltar com os mesmos agentes e permissões.");
    expect(createDesktopI18n("en", "mac").t("desktop.tray.reconnectMac")).toBe("Reconnect this Mac");
    expect(createDesktopI18n("pt-BR", "linux").t("desktop.tray.reconnectMac")).toBe("Reconectar este computador");
    expect(createDesktopI18n("en", "linux").t("desktop.tray.reconnectMac")).toBe("Reconnect this computer");
  });
});
