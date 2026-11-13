import { describe, expect, test } from "bun:test";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import { appServer, homeServer, serverKind, serverName } from "../src/control/server";
import type { Home } from "../src/control/store";

const home = (status: Partial<ControlStatus> | null): Home => ({
  homeId: "h1",
  dir: "/tmp/h1",
  running: true,
  hello: null,
  status: status
    ? {
        paired: true,
        connection: "online",
        version: "0.7.0",
        protocol: 12,
        paused: { paused: false },
        executors: {},
        agents: [],
        browsers: [],
        ...status,
      }
    : null,
  jobs: [],
  requests: [],
  access: null,
  logo: null,
});

describe("the servers this app opens", () => {
  test("https anywhere, plain http only on this computer", () => {
    expect(appServer("agentes.tail1234.ts.net")).toBe("https://agentes.tail1234.ts.net");
    expect(appServer("http://127.0.0.1:4310")).toBe("http://127.0.0.1:4310");
    expect(appServer("http://localhost:3000/login")).toBe("http://localhost:3000");
    expect(appServer("http://192.168.1.20:3000")).toBeNull();
    expect(appServer("http://chat.example.com")).toBeNull();
  });

  test("each kind of server, and how it reads", () => {
    expect(serverKind("https://app.agentes.chat")).toBe("cloud");
    expect(serverKind("http://127.0.0.1:4310")).toBe("here");
    expect(serverKind("https://agentes.tail1234.ts.net")).toBe("tailnet");
    expect(serverKind("https://chat.example.com")).toBe("own");
    expect(serverName("https://app.agentes.chat")).toBe("agentes.chat");
    expect(serverName("https://chat.example.com:8443")).toBe("chat.example.com:8443");
    expect(serverName("http://127.0.0.1:4310")).toBe("127.0.0.1:4310");
  });

  test("a home's server, as an origin", () => {
    expect(homeServer(home({ server: "https://chat.example.com/" }))).toBe("https://chat.example.com");
    expect(homeServer(home({ server: "http://192.168.1.20" }))).toBeNull();
    expect(homeServer(home(null))).toBeNull();
  });
});
