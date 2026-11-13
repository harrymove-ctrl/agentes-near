import { expect, test } from "bun:test";
import { browserFrameDataUrl, decodeBrowserFrameBytes, frameMetadata, parseBrowserLiveMessage } from "../src/index";

/** The layout the server writes (`encodeBrowserFrame`): version, header length, JSON header, JPEG. */
function frameBytes(header: unknown, jpeg: number[], version = 1) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(5 + head.byteLength + jpeg.length);
  out[0] = version;
  new DataView(out.buffer).setUint32(1, head.byteLength);
  out.set(head, 5);
  out.set(jpeg, 5 + head.byteLength);
  return out;
}

// A JPEG's start with its size (SOF0: 600 tall, 1280 wide) is all `frameMetadata` reads.
const JPEG = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00, 0xff, 0xd9];
const META = { deviceWidth: 1280, deviceHeight: 720, url: "https://shop.example.com/", title: "Shop" };

test("a frame socket's bytes read back as the frame the server sent", () => {
  const decoded = decodeBrowserFrameBytes(frameBytes({ seq: 4, metadata: META }, JPEG).buffer);
  expect(decoded?.seq).toBe(4);
  expect(decoded?.metadata).toEqual(META);
  expect([...(decoded?.jpeg ?? [])]).toEqual(JPEG);
  // Anything else isn't a frame.
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 4, metadata: META }, JPEG, 2))).toBeNull();
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 4, metadata: { url: "x" } }, JPEG))).toBeNull();
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 4, metadata: META }, []))).toBeNull();
  expect(decodeBrowserFrameBytes(new Uint8Array([1, 0, 0]))).toBeNull();
});

test("when the computer captured a frame comes along both ways, to measure how late pictures arrive", () => {
  const metadata = { ...META, capturedAt: 1_700_000_000_123 };
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 5, metadata }, JPEG))?.metadata.capturedAt).toBe(1_700_000_000_123);
  const parsed = parseBrowserLiveMessage({ type: "browser.frame", agentId: "a1", seq: 5, data: "/9j/", metadata });
  expect(parsed?.type === "browser.frame" ? parsed.metadata.capturedAt : null).toBe(1_700_000_000_123);
  // Anything but a number is left out.
  const odd = { ...META, capturedAt: "soon" };
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 5, metadata: odd }, JPEG))?.metadata).toEqual(META);
});

test("a frame with bytes is a live view frame like one with base64; both draw and map clicks the same", () => {
  const jpeg = new Uint8Array(JPEG);
  const fromBytes = parseBrowserLiveMessage({ type: "browser.frame", agentId: "a1", seq: 1, jpeg, metadata: META });
  expect(fromBytes).toMatchObject({ type: "browser.frame", seq: 1, jpeg });
  const base64 = Buffer.from(jpeg).toString("base64");
  const fromText = parseBrowserLiveMessage({
    type: "browser.frame",
    agentId: "a1",
    seq: 1,
    data: base64,
    metadata: META,
  });
  expect(fromText).toMatchObject({ data: base64 });
  expect(parseBrowserLiveMessage({ type: "browser.frame", agentId: "a1", seq: 1, metadata: META })).toBeNull();
  // The picture's own aspect sets the page's height either way.
  expect(frameMetadata({ jpeg, metadata: META }).deviceHeight).toBe(600);
  expect(frameMetadata({ data: base64, metadata: META }).deviceHeight).toBe(600);
  // One address for an image view, the same either way, made once per frame.
  const frame = { jpeg, metadata: META };
  expect(browserFrameDataUrl(frame)).toBe(`data:image/jpeg;base64,${base64}`);
  expect(browserFrameDataUrl(frame)).toBe(browserFrameDataUrl(frame));
  expect(browserFrameDataUrl({ data: base64 })).toBe(`data:image/jpeg;base64,${base64}`);
});

test("a frame says the device the agent's page is emulated as, either way it came; anything else is left out", () => {
  const metadata = { ...META, deviceWidth: 390, deviceHeight: 844, emulated: "phone" };
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 6, metadata }, JPEG))?.metadata.emulated).toBe("phone");
  const parsed = parseBrowserLiveMessage({ type: "browser.frame", agentId: "a1", seq: 6, data: "/9j/", metadata });
  expect(parsed?.type === "browser.frame" ? parsed.metadata.emulated : null).toBe("phone");
  const odd = { ...META, emulated: "watch" };
  expect(decodeBrowserFrameBytes(frameBytes({ seq: 6, metadata: odd }, JPEG))?.metadata).toEqual(META);
});
