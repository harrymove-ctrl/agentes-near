/**
 * A PEM private key from an env var: the PEM itself, the PEM with newlines
 * written as `\n`, or base64 of the whole PEM file (one line, easy to paste
 * into a hosting panel). Throws when it's none of these.
 */
export function parsePemKey(raw: string): string {
  const value = raw.trim();
  if (value.includes("-----BEGIN")) return value.replace(/\\n/g, "\n");
  const decoded = Buffer.from(value, "base64").toString("utf8").trim();
  if (!decoded.includes("-----BEGIN")) {
    throw new Error("must be a PEM key, a PEM key with \\n for newlines, or base64 of the PEM file");
  }
  return decoded.replace(/\\n/g, "\n");
}

/** What a Firebase service account key gives the server to send Android pushes (ADR 0152). */
export interface FirebaseServiceAccount {
  projectId: string;
  clientEmail: string;
  /** PKCS #8 PEM. */
  privateKey: string;
  tokenUri: string;
}

/**
 * A Firebase service account key from an env var: the JSON file's contents, or base64 of the file.
 * Throws when it isn't one, without echoing any of it (it holds a private key).
 */
export function parseFirebaseServiceAccount(raw: string): FirebaseServiceAccount {
  const value = raw.trim();
  const text = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("must be a service account's JSON key, or base64 of the file");
  }
  const account = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (account.type !== "service_account") {
    throw new Error('must be a service account\'s JSON key ("type": "service_account")');
  }
  const { project_id, client_email, private_key, token_uri } = account;
  if (typeof project_id !== "string" || !project_id) throw new Error("the service account has no project_id");
  if (typeof client_email !== "string" || !client_email.includes("@")) {
    throw new Error("the service account has no client_email");
  }
  if (typeof private_key !== "string" || !private_key.includes("BEGIN PRIVATE KEY")) {
    throw new Error("the service account has no private_key");
  }
  return {
    projectId: project_id,
    clientEmail: client_email,
    privateKey: private_key.replace(/\\n/g, "\n"),
    tokenUri:
      typeof token_uri === "string" && token_uri.startsWith("https://")
        ? token_uri
        : "https://oauth2.googleapis.com/token",
  };
}
