import { type BrowserFrameMetadata, isBrowserDevice } from "./live";

/**
 * A live view frame as bytes, as the frame socket brings it (ADR 0040 §7.1): a version byte (1), the header's length
 * (4 bytes, big endian), the header as UTF-8 JSON (`{seq, metadata}`), then the JPEG. The server writes it with
 * `encodeBrowserFrame` (`packages/adapters/src/machine-protocol.ts`); this is the apps' own reading of that layout,
 * so the client depends on no server package.
 */
export interface BrowserFrameBytes {
  seq: number;
  metadata: BrowserFrameMetadata;
  /** The JPEG, a view into the bytes received (no copy), over an `ArrayBuffer` so it is a `Blob` part as it is. */
  jpeg: Uint8Array<ArrayBuffer>;
}

const VERSION = 1;
const HEADER_MAX = 16 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A frame socket's binary message, checked; null when it isn't a frame. */
export function decodeBrowserFrameBytes(data: ArrayBuffer | Uint8Array<ArrayBuffer>): BrowserFrameBytes | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 6 || bytes[0] !== VERSION) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  if (length > HEADER_MAX || 5 + length >= bytes.byteLength) return null;
  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + length)));
  } catch {
    return null;
  }
  if (!isObject(head) || !num(head.seq) || !isObject(head.metadata)) return null;
  const m = head.metadata;
  if (!num(m.deviceWidth) || !num(m.deviceHeight)) return null;
  return {
    seq: head.seq,
    metadata: {
      deviceWidth: m.deviceWidth,
      deviceHeight: m.deviceHeight,
      ...(num(m.pageScaleFactor) ? { pageScaleFactor: m.pageScaleFactor } : {}),
      ...(num(m.capturedAt) ? { capturedAt: m.capturedAt } : {}),
      ...(typeof m.url === "string" ? { url: m.url } : {}),
      ...(typeof m.title === "string" && m.title ? { title: m.title } : {}),
      ...(isBrowserDevice(m.emulated) ? { emulated: m.emulated } : {}),
    },
    jpeg: bytes.subarray(5 + length),
  };
}

/** Bytes as base64, in pieces small enough for `String.fromCharCode` (`btoa` is in browsers and Hermes). */
function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

const dataUrls = new WeakMap<object, string | null>();

/**
 * A frame's picture as a `data:` URL, whichever way it came (an image view that only takes addresses), made once per
 * frame however often a screen draws it.
 */
export function browserFrameDataUrl(frame: { data?: string; jpeg?: Uint8Array }): string | null {
  const known = dataUrls.get(frame);
  if (known !== undefined) return known;
  const base64 = frame.data ?? (frame.jpeg ? base64Of(frame.jpeg) : null);
  const url = base64 ? `data:image/jpeg;base64,${base64}` : null;
  dataUrls.set(frame, url);
  return url;
}
