import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  DESKTOP_PROTOCOL,
  isStreamId,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  parseAccess,
  parseRunnerFrame,
  parseServerFrame,
  parseStreamControl,
  parseStreamHello,
  STREAM_LIMITS,
} from "../src/machine-protocol";

const hello = (extra: Record<string, unknown> = {}) =>
  parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "0.1.0",
      protocol: DESKTOP_PROTOCOL,
      os: "linux",
      arch: "x64",
      hostname: "box",
      workspace: "/srv/agents",
      exec: true,
      ...extra,
    }),
  );

const streamId = () => randomBytes(32).toString("base64url");
const token = `agm_${randomBytes(32).toString("base64url")}`;

describe("hello", () => {
  test("a runner that says nothing about desktops or a terminal has neither", () => {
    const frame = hello();
    expect(frame).toMatchObject({ type: "hello", protocol: DESKTOP_PROTOCOL });
    expect(frame).not.toHaveProperty("desktop");
    expect(frame).not.toHaveProperty("terminal");
    expect(frame).not.toHaveProperty("mode");
  });

  test("system mode only as `system`: anything else is single-user", () => {
    expect(hello({ mode: "system" })).toMatchObject({ mode: "system" });
    for (const mode of ["user", "System", true, 1]) expect(hello({ mode })).not.toHaveProperty("mode");
  });

  test("desktop and terminal availability, reasons cut, a size only when both sides are sane", () => {
    expect(
      hello({
        desktop: { available: true, width: 1280, height: 800, extra: "dropped" },
        terminal: { available: false, reason: "Needs Bun 1.3.5 or newer" },
      }),
    ).toMatchObject({
      desktop: { available: true, width: 1280, height: 800 },
      terminal: { available: false, reason: "Needs Bun 1.3.5 or newer" },
    });
    const desktop = (v: Record<string, unknown>) => (hello({ desktop: v }) as { desktop?: unknown } | null)?.desktop;
    expect(desktop({ available: "yes", reason: "x".repeat(2000) })).toEqual({
      available: false,
      reason: "x".repeat(500),
    });
    for (const size of [
      { width: 1280 },
      { width: 0, height: 800 },
      { width: 1280.5, height: 800 },
      { width: "1280", height: 800 },
      { width: 1280, height: 9000 },
    ]) {
      expect(desktop({ available: true, ...size })).toEqual({ available: true });
    }
    expect(hello({ desktop: "on" })).not.toHaveProperty("desktop");
  });

  test("the switches: on only when the machine says true", () => {
    const access = parseAccess({
      folders: [],
      tools: { claude: true, codex: false, commands: true, desktop: true, terminal: "true" },
    });
    expect(access?.tools).toEqual({ claude: true, codex: false, commands: true, desktop: true });
  });
});

test("the desktop ops are protocol 18 ops the runner accepts", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(DESKTOP_PROTOCOL);
  for (const op of [
    "desktop.session.start",
    "desktop.session.stop",
    "desktop.session.status",
    "stream.open",
  ] as const) {
    expect(MACHINE_OPS).toContain(op);
  }
  const open = { type: "request", id: "r1", op: "stream.open", streamId: streamId(), kind: "desktop", mode: "watch" };
  expect(parseServerFrame(JSON.stringify(open))).toMatchObject({ op: "stream.open", kind: "desktop" });
});

describe("data sockets", () => {
  test("stream ids are 32 random bytes in base64url", () => {
    expect(isStreamId(streamId())).toBe(true);
    for (const bad of [
      streamId().slice(1),
      `${streamId()}A`,
      `${streamId().slice(1)}=`,
      `${streamId().slice(1)}+`,
      `${streamId().slice(1)}/`,
      42,
      null,
    ]) {
      expect(isStreamId(bad)).toBe(false);
    }
  });

  test("stream.hello: the machine's token and a stream id, nothing else", () => {
    const id = streamId();
    expect(parseStreamHello(JSON.stringify({ type: "stream.hello", token, streamId: id, more: 1 }))).toEqual({
      type: "stream.hello",
      token,
      streamId: id,
    });
    for (const bad of [
      "not json",
      JSON.stringify({ type: "hello", token, streamId: id }),
      JSON.stringify({ type: "stream.hello", token, streamId: id.slice(2) }),
      JSON.stringify({ type: "stream.hello", token, streamId: `${id.slice(1)}!` }),
      JSON.stringify({ type: "stream.hello", token: "agr_x", streamId: id }),
      JSON.stringify({ type: "stream.hello", token: `agm_${"x".repeat(200)}`, streamId: id }),
      JSON.stringify({ type: "stream.hello", streamId: id }),
      JSON.stringify({ type: "stream.hello", token, streamId: id, pad: "x".repeat(600) }),
    ]) {
      expect(parseStreamHello(bad)).toBeNull();
    }
  });

  test("resize within the terminal's bounds; exit with a code or none", () => {
    const [minCols, maxCols] = STREAM_LIMITS.cols;
    const [minRows, maxRows] = STREAM_LIMITS.rows;
    const resize = (cols: unknown, rows: unknown) => parseStreamControl(JSON.stringify({ type: "resize", cols, rows }));
    expect(resize(80, 24)).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(resize(minCols, minRows)).toEqual({ type: "resize", cols: minCols, rows: minRows });
    expect(resize(maxCols, maxRows)).toEqual({ type: "resize", cols: maxCols, rows: maxRows });
    for (const [cols, rows] of [
      [minCols - 1, 24],
      [maxCols + 1, 24],
      [80, minRows - 1],
      [80, maxRows + 1],
      [80.5, 24],
      ["80", 24],
      [80, null],
    ]) {
      expect(resize(cols, rows)).toBeNull();
    }
    expect(parseStreamControl(JSON.stringify({ type: "exit", code: 0 }))).toEqual({ type: "exit", code: 0 });
    expect(parseStreamControl(JSON.stringify({ type: "exit", code: null }))).toEqual({ type: "exit", code: null });
    expect(parseStreamControl(JSON.stringify({ type: "exit", code: "1" }))).toBeNull();
    expect(parseStreamControl(JSON.stringify({ type: "exit" }))).toBeNull();
    expect(parseStreamControl(JSON.stringify({ type: "paste", text: "rm -rf /" }))).toBeNull();
    expect(parseStreamControl(JSON.stringify({ type: "resize", cols: 80, rows: 24, pad: "x".repeat(300) }))).toBeNull();
    expect(parseStreamControl("{")).toBeNull();
  });
});
