import { createHash, createHmac } from "node:crypto";
import type { BlobStore } from "./blob";

/** The HTTP transport (global `fetch` by default; a fake S3 server in tests). */
export type S3Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Settings of an S3-compatible bucket (R2, AWS S3, MinIO, Wasabi…). */
export interface S3Settings {
  /** `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-east-1.amazonaws.com`… */
  endpoint: string;
  /** `auto` for R2. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. */
  pathStyle: boolean;
}

/** How long a streamed object may take: the whole read, at the pace of whoever receives it. */
const STREAM_TIMEOUT_MS = 10 * 60_000;

export type StorageErrorCode =
  | "auth"
  | "bucket_missing"
  | "region"
  | "permission"
  | "network"
  | "not_found"
  | "invalid_endpoint"
  | "other";

/** A storage failure with a code the app can explain ("The key was not accepted"…). */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (path: string) => path.split("/").map(enc).join("/");

function amzDates(now: Date) {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, ""); // 20261014T120000Z
  return { amzDate: iso, date: iso.slice(0, 8) };
}

function signingKey(secret: string, date: string, region: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

/** SigV4 signature of a canonical request. */
function signature(settings: S3Settings, canonicalRequest: string, amzDate: string, date: string) {
  const scope = `${date}/${settings.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = signingKey(settings.secretAccessKey, date, settings.region);
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

const canonicalQuery = (query: Record<string, string>) =>
  Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k] ?? "")}`)
    .join("&");

/** Where a key lives: host and path, path-style or virtual-hosted. */
function locate(s: S3Settings, key: string) {
  const base = new URL(s.endpoint);
  const objectPath = key ? `/${encodePath(key)}` : "/";
  if (s.pathStyle) {
    const prefix = base.pathname.replace(/\/$/, "");
    return { origin: base.origin, host: base.host, path: `${prefix}/${enc(s.bucket)}${key ? objectPath : "/"}` };
  }
  const host = `${s.bucket}.${base.host}`;
  return { origin: `${base.protocol}//${host}`, host, path: objectPath };
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const AUTH_CODES = ["InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken"];
const REGION_CODES = ["AuthorizationHeaderMalformed", "PermanentRedirect", "IllegalLocationConstraintException"];

/** Turns an S3 error response into a StorageError with a clear code. */
export function s3Error(status: number, body: string): StorageError {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
  const message = decodeXml(/<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? "");
  const text = `${code || `HTTP ${status}`}${message ? `: ${message}` : ""}`;
  if (AUTH_CODES.includes(code) || status === 401) return new StorageError("auth", text, status);
  if (code === "NoSuchBucket") return new StorageError("bucket_missing", text, status);
  if (REGION_CODES.includes(code) || status === 301) return new StorageError("region", text, status);
  if (code === "AccessDenied" || status === 403) return new StorageError("permission", text, status);
  if (code === "NoSuchKey" || status === 404) return new StorageError("not_found", text, status);
  return new StorageError("other", text, status);
}

/**
 * A minimal S3 client (SigV4 over `fetch`): put, get, delete, list and
 * presigned GET. No SDK, so the transport can be swapped in tests.
 */
export function createS3BlobStore(
  settings: S3Settings,
  options: { fetch?: S3Fetch; now?: () => Date; timeoutMs?: number } = {},
): BlobStore {
  const http: S3Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  let endpoint: URL;
  try {
    endpoint = new URL(settings.endpoint);
  } catch {
    throw new StorageError("invalid_endpoint", "The endpoint is not a valid URL");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    throw new StorageError("invalid_endpoint", "The endpoint must be an https URL");

  async function send(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string,
    init: { query?: Record<string, string>; body?: Uint8Array; contentType?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const { origin, host, path } = locate(settings, key);
    const query = init.query ?? {};
    const { amzDate, date } = amzDates(now());
    const payloadHash = sha256Hex(init.body ?? new Uint8Array());
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(init.contentType ? { "content-type": init.contentType } : {}),
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
    const signedHeaders = names.join(";");
    const qs = canonicalQuery(query);
    const canonicalRequest = [method, path, qs, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credential = `${settings.accessKeyId}/${date}/${settings.region}/s3/aws4_request`;
    const signed = signature(settings, canonicalRequest, amzDate, date);
    const fields = [`Credential=${credential}`, `SignedHeaders=${signedHeaders}`, `Signature=${signed}`];
    const authorization = `AWS4-HMAC-SHA256 ${fields.join(", ")}`;
    // `host` is signed but set by the transport.
    const sendHeaders = Object.fromEntries(Object.entries(headers).filter(([n]) => n !== "host"));
    try {
      return await http(`${origin}${path}${qs ? `?${qs}` : ""}`, {
        method,
        headers: { ...sendHeaders, authorization },
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs ?? options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new StorageError("network", `Could not reach the storage endpoint: ${reason}`);
    }
  }

  const fail = async (res: Response) => s3Error(res.status, await res.text().catch(() => ""));

  async function object(key: string, timeoutMs?: number) {
    const res = await send("GET", key, { ...(timeoutMs ? { timeoutMs } : {}) });
    if (res.status === 404) {
      const err = await fail(res);
      if (err.code === "not_found") return null;
      throw err;
    }
    if (!res.ok) throw await fail(res);
    return res;
  }

  return {
    kind: "s3",
    async put(key, body, { contentType }) {
      const res = await send("PUT", key, { body, contentType });
      if (!res.ok) throw await fail(res);
    },
    async get(key) {
      const res = await object(key);
      if (!res) return null;
      return {
        body: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    async stream(key) {
      return (await object(key, STREAM_TIMEOUT_MS))?.body ?? null;
    },
    async delete(key) {
      const res = await send("DELETE", key);
      if (!res.ok && res.status !== 404) throw await fail(res);
    },
    async list(prefix, limit = 1000) {
      const res = await send("GET", "", {
        query: { "list-type": "2", prefix, "max-keys": String(Math.min(1000, limit)) },
      });
      if (!res.ok) throw await fail(res);
      const xml = await res.text();
      return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1] ?? "")).slice(0, limit);
    },
    async signedUrl(key, { expiresInSeconds, filename }) {
      const { origin, host, path } = locate(settings, key);
      const { amzDate, date } = amzDates(now());
      const expires = Math.max(1, Math.min(604_800, Math.round(expiresInSeconds)));
      const safeName = filename?.replace(/["\\\r\n]/g, "_");
      const query: Record<string, string> = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${settings.accessKeyId}/${date}/${settings.region}/s3/aws4_request`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(expires),
        "X-Amz-SignedHeaders": "host",
        ...(safeName ? { "response-content-disposition": `attachment; filename="${safeName}"` } : {}),
      };
      const qs = canonicalQuery(query);
      const canonicalRequest = ["GET", path, qs, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
      return `${origin}${path}?${qs}&X-Amz-Signature=${signature(settings, canonicalRequest, amzDate, date)}`;
    },
  };
}
