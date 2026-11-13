import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeBase64 } from "./composio-mail";

/** How old (or how far ahead) a webhook timestamp may be, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The HMAC keys of a secret: itself, and for a `whsec_<base64>` secret its decoded bytes too. */
const keysOf = (secret: string): (string | Uint8Array)[] =>
  secret.startsWith("whsec_") ? [secret, decodeBase64(secret.slice(6))] : [secret];

/**
 * Whether a Standard Webhooks delivery (Composio) is signed with `secret`: an HMAC-SHA256 of
 * `{webhook-id}.{webhook-timestamp}.{raw body}`, any `v1,` candidate of `webhook-signature` matching (a rotation
 * sends two), and a timestamp within 5 minutes of `nowMs`.
 */
export function verifyStandardWebhook(secret: string, headers: Headers, rawBody: string, nowMs = Date.now()) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = keysOf(secret).map((key) => createHmac("sha256", key).update(signed).digest());
  return signature
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const comma = part.indexOf(",");
      const version = comma === -1 ? "v1" : part.slice(0, comma);
      if (version !== "v1") return false;
      const received = Buffer.from(comma === -1 ? part : part.slice(comma + 1), "base64");
      return expected.some((digest) => digest.length === received.length && timingSafeEqual(digest, received));
    });
}
