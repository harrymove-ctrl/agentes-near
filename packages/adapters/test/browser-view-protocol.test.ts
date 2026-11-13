import { expect, test } from "bun:test";
import {
  BROWSER_LIMITS,
  BROWSER_VIEW_PROTOCOL,
  BROWSER_VIEWPORT_PROTOCOL,
  browserViewportOf,
  decodeBrowserFrame,
  encodeBrowserFrame,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  parseRunnerFrame,
  parseServerFrame,
  parseStreamControl,
} from "../src/machine-protocol";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const META = {
  deviceWidth: 1280,
  deviceHeight: 800,
  pageScaleFactor: 1,
  url: "https://shop.example.com/",
  title: "Shop",
};

test("protocol 49: browser.view.open names the live view's data socket (ADR 0040 §7.1)", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_VIEW_PROTOCOL);
  expect(MACHINE_OPS).toContain("browser.view.open");
  const open = { type: "request", id: "r1", op: "browser.view.open", streamId: "x".repeat(43) };
  expect(parseServerFrame(JSON.stringify(open))).toMatchObject({ op: "browser.view.open", streamId: "x".repeat(43) });
  // The server's answer to each frame on that socket.
  expect(parseStreamControl(JSON.stringify({ type: "ack" }))).toEqual({ type: "ack" });
});

test("a frame's bytes: version, header length, JSON header, then the JPEG, read back as sent", () => {
  const bytes = encodeBrowserFrame({ seq: 7, metadata: META }, JPEG);
  expect(bytes[0]).toBe(1);
  const length = new DataView(bytes.buffer).getUint32(1);
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + length)))).toEqual({ seq: 7, metadata: META });
  expect([...bytes.subarray(5 + length)]).toEqual([...JPEG]);
  const back = decodeBrowserFrame(bytes);
  expect(back?.seq).toBe(7);
  expect(back?.metadata).toEqual(META);
  expect([...(back?.jpeg ?? [])]).toEqual([...JPEG]);
  // Read from inside a larger buffer too (a socket's message may be a view of one).
  const padded = new Uint8Array(bytes.byteLength + 8);
  padded.set(bytes, 4);
  expect(decodeBrowserFrame(padded.subarray(4, 4 + bytes.byteLength))?.seq).toBe(7);
});

test("bytes that aren't a frame read as null; the header is checked like a browser.frame", () => {
  const good = encodeBrowserFrame({ seq: 1, metadata: META }, JPEG);
  expect(decodeBrowserFrame(new Uint8Array([2, ...good.subarray(1)]))).toBeNull();
  expect(decodeBrowserFrame(good.subarray(0, 5))).toBeNull();
  // A header with no picture after it.
  const head = new TextEncoder().encode(JSON.stringify({ seq: 1, metadata: META }));
  const bare = new Uint8Array(5 + head.byteLength);
  bare[0] = 1;
  new DataView(bare.buffer).setUint32(1, head.byteLength);
  bare.set(head, 5);
  expect(decodeBrowserFrame(bare)).toBeNull();
  const noSize = encodeBrowserFrame({ seq: 1, metadata: { url: "x" } as never }, JPEG);
  expect(decodeBrowserFrame(noSize)).toBeNull();
  // An address and a title are cut to the limits, as on `browser.frame`.
  const long = encodeBrowserFrame(
    { seq: 1, metadata: { ...META, title: "t".repeat(BROWSER_LIMITS.title + 50) } },
    JPEG,
  );
  expect(decodeBrowserFrame(long)?.metadata.title).toHaveLength(BROWSER_LIMITS.title);
});

test("protocol 52: agentes:viewport's arguments, checked as the runner reads them", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_VIEWPORT_PROTOCOL);
  expect(browserViewportOf(["phone"])).toEqual({ device: "phone", width: 390, height: 844 });
  expect(browserViewportOf(["tablet"])).toEqual({ device: "tablet", width: 820, height: 1180 });
  // `desktop` alone: the window's own size, no emulation.
  expect(browserViewportOf(["desktop"])).toBeNull();
  expect(browserViewportOf(["phone", "375", "667"])).toEqual({ device: "phone", width: 375, height: 667 });
  expect(browserViewportOf(["desktop", "1440", "900"])).toEqual({ device: "desktop", width: 1440, height: 900 });
  for (const bad of [
    [],
    ["watch"],
    ["phone", "375"],
    ["phone", "199", "667"],
    ["phone", "375", "3841"],
    ["phone", "3e2", "667"],
    ["phone", "375.5", "667"],
    ["desktop", "1440", "900", "2"],
  ]) {
    expect(browserViewportOf(bad)).toBeUndefined();
  }
});

test("protocol 52 both ways: the server asks with browser.act, the runner's frames say the emulated device", () => {
  const act = {
    type: "request",
    id: "r1",
    op: "browser.act",
    agent: { id: "a1", handle: "dev" },
    command: "agentes:viewport",
    args: ["phone", "375", "667"],
    timeoutSeconds: 30,
  };
  expect(parseServerFrame(JSON.stringify(act))).toMatchObject({
    op: "browser.act",
    command: "agentes:viewport",
    args: ["phone", "375", "667"],
  });
  const metadata = { ...META, deviceWidth: 375, deviceHeight: 667, emulated: "phone" as const };
  const frame = { type: "browser.frame", agentId: "a1", seq: 3, data: "/9j/", metadata };
  expect(parseRunnerFrame(JSON.stringify(frame))).toMatchObject({ metadata: { emulated: "phone" } });
  expect(decodeBrowserFrame(encodeBrowserFrame({ seq: 3, metadata }, JPEG))?.metadata).toEqual(metadata);
  // Anything but a device is left out; a frame without it (an older runner) shows the page as it is.
  const odd = { ...frame, metadata: { ...metadata, emulated: "watch" } };
  expect(JSON.stringify(parseRunnerFrame(JSON.stringify(odd)))).not.toContain("emulated");
  expect(JSON.stringify(decodeBrowserFrame(encodeBrowserFrame({ seq: 3, metadata: META }, JPEG)))).not.toContain(
    "emulated",
  );
});
