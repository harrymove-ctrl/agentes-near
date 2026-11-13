import { createHash, createHmac } from "node:crypto";
import type { S3Fetch } from "./s3";

type FakeObject = { body: Uint8Array; contentType: string };

const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function xmlError(status: number, code: string, message: string) {
  const xml = `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return new Response(xml, { status, headers: { "content-type": "application/xml" } });
}

/** Signature fields of a request, from the `authorization` header or the presigned query. */
function signatureFields(url: URL, headers: Headers) {
  const presigned = url.searchParams.get("X-Amz-Signature");
  if (presigned) {
    return {
      presigned: true,
      credential: url.searchParams.get("X-Amz-Credential") ?? "",
      amzDate: url.searchParams.get("X-Amz-Date") ?? "",
      signedHeaders: url.searchParams.get("X-Amz-SignedHeaders") ?? "",
      signature: presigned,
    };
  }
  const auth = headers.get("authorization") ?? "";
  return {
    presigned: false,
    credential: /Credential=([^,]+)/.exec(auth)?.[1] ?? "",
    amzDate: headers.get("x-amz-date") ?? "",
    signedHeaders: /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? "",
    signature: /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? "",
  };
}

/**
 * An in-process S3 server for tests (no network): path-style and
 * virtual-hosted requests, SigV4 checked against the expected key pair and
 * region, PUT / GET / DELETE / ListObjectsV2, and switches for the failures a
 * storage test must explain (wrong key, missing bucket, wrong region, no
 * write or delete permission).
 */
export function createFakeS3(options: {
  /** Host of the endpoint, e.g. `s3.example.com`. */
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: string[];
}) {
  const buckets = new Map<string, Map<string, FakeObject>>();
  for (const name of options.buckets) buckets.set(name, new Map());
  const state = { denyWrite: false, denyDelete: false, requests: 0 };

  function checkSignature(method: string, url: URL, headers: Headers, body: Uint8Array): Response | null {
    const f = signatureFields(url, headers);
    const [akid = "", date = "", region = ""] = f.credential.split("/");
    if (akid !== options.accessKeyId) return xmlError(403, "InvalidAccessKeyId", "The access key does not exist.");
    if (region !== options.region) {
      return xmlError(400, "AuthorizationHeaderMalformed", `The region '${region}' is wrong.`);
    }
    const names = f.signedHeaders.split(";");
    const headerValue = (n: string) => (n === "host" ? url.host : (headers.get(n) ?? ""));
    const canonicalHeaders = names.map((n) => `${n}:${headerValue(n).trim()}\n`).join("");
    const pairs: string[] = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== "X-Amz-Signature") pairs.push(`${rfc3986(k)}=${rfc3986(v)}`);
    }
    pairs.sort();
    const payloadHash = f.presigned ? "UNSIGNED-PAYLOAD" : (headers.get("x-amz-content-sha256") ?? "");
    if (!f.presigned && payloadHash !== sha(body)) return xmlError(400, "XAmzContentSHA256Mismatch", "Bad hash");
    const lines = [method, url.pathname, pairs.join("&"), canonicalHeaders, names.join(";"), payloadHash];
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", f.amzDate, scope, sha(lines.join("\n"))].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, date), region), "s3"), "aws4_request");
    const expected = createHmac("sha256", key).update(stringToSign).digest("hex");
    if (f.signature !== expected) return xmlError(403, "SignatureDoesNotMatch", "The signature does not match.");
    return null;
  }

  /** Bucket and key of a request URL (path-style or virtual-hosted). */
  function route(url: URL): { bucket: string; key: string } {
    const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (url.host === options.host) {
      const [bucket = "", ...rest] = segments;
      return { bucket, key: rest.join("/") };
    }
    if (url.host.endsWith(`.${options.host}`)) {
      return { bucket: url.host.slice(0, -options.host.length - 1), key: segments.join("/") };
    }
    throw new TypeError(`fetch failed: unknown host ${url.host}`);
  }

  async function readBody(init: RequestInit): Promise<Uint8Array> {
    if (init.body instanceof Uint8Array) return init.body;
    if (!init.body) return new Uint8Array();
    return new Uint8Array(await new Response(init.body).arrayBuffer());
  }

  function listXml(bucket: Map<string, FakeObject>, url: URL) {
    const prefix = url.searchParams.get("prefix") ?? "";
    const max = Number(url.searchParams.get("max-keys") ?? "1000");
    const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix)).slice(0, max);
    const escapeXml = (k: string) => k.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const contents = keys.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`);
    return `<?xml version="1.0"?><ListBucketResult>${contents.join("")}</ListBucketResult>`;
  }

  const fetch: S3Fetch = async (input, init) => {
    state.requests++;
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = await readBody(init);
    const target = route(url);
    const denied = checkSignature(method, url, headers, body);
    if (denied) return denied;
    const bucket = buckets.get(target.bucket);
    if (!bucket) return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");

    if (method === "PUT") {
      if (state.denyWrite) return xmlError(403, "AccessDenied", "Access Denied");
      bucket.set(target.key, { body, contentType: headers.get("content-type") ?? "application/octet-stream" });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      if (state.denyDelete) return xmlError(403, "AccessDenied", "Access Denied");
      bucket.delete(target.key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && target.key === "" && url.searchParams.get("list-type") === "2") {
      return new Response(listXml(bucket, url), { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (method === "GET") {
      const object = bucket.get(target.key);
      if (!object) return xmlError(404, "NoSuchKey", "The specified key does not exist.");
      return new Response(object.body, { status: 200, headers: { "content-type": object.contentType } });
    }
    return xmlError(405, "MethodNotAllowed", "Not supported by the fake");
  };

  return { fetch, buckets, state };
}
