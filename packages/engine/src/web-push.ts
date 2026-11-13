import { generateVapidKeys, type KeyWrapper, type VapidKeys } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { openSecret, type SealedSecret, SealedValueError, sealSecret } from "./crypto";
import { isPublicHostName } from "./net-guard";

const { instancePush } = schema;

/**
 * This installation's VAPID key pair for Web Push (ADR 0071): made the first time it's needed and kept
 * in `instance_push` (row 1), the private key sealed with the installation's key. Env vars, when both
 * are set, pin a pair instead (never stored).
 *
 * A stored key the installation's key can never open (`AGENTES_SECRET` changed) is replaced by a new pair:
 * push services refuse the subscriptions made for the old one, and pages subscribe again with the new public
 * key. What keeps it closed only for now (a key service that doesn't answer, a key wrapper this process
 * lacks) is an error to retry, never a reason to replace it; nor is a pair another server made minutes ago,
 * or two servers with different secrets would keep replacing each other's.
 */

const VAPID_AAD = "instance_push:vapid";

/** How long a process signs with its copy of the pair before reading the row again (another server may replace it). */
export const VAPID_RECHECK_MS = 60_000;

/** A stored pair younger than this is never replaced, even when this server can't open it. */
export const VAPID_KEEP_NEW_MS = 10 * 60_000;

/** The contact push services get from a server with no public address or sender of its own. */
export const VAPID_FALLBACK_SUBJECT = "https://agentes.chat";

export interface VapidConfig {
  PUBLIC_URL: string;
  EMAIL_FROM?: string;
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
}

/**
 * Who runs this server, as push services want it (RFC 8292 §2.1: an `https:` or `mailto:` URI): `PUBLIC_URL`
 * when it is https on a public name, else `mailto:` the sender address when its domain is public, else the
 * project's site. Push services check it: an `http:` contact or a local name (`localhost`, a LAN name), which
 * a server tried on one computer would send, can get every push refused.
 */
export function vapidSubject(config: Pick<VapidConfig, "PUBLIC_URL" | "EMAIL_FROM">): string {
  const site = urlOf(config.PUBLIC_URL);
  if (site?.protocol === "https:" && isPublicHostName(site.hostname)) return config.PUBLIC_URL.replace(/\/+$/, "");
  const from = config.EMAIL_FROM?.trim() ?? "";
  // `Name <ops@example.com>` or a bare address.
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from;
  const domain = /^[^\s@<>]+@([^\s@<>]+)$/.exec(address)?.[1];
  if (domain && isPublicHostName(domain)) return `mailto:${address}`;
  return VAPID_FALLBACK_SUBJECT;
}

function urlOf(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

interface Pair {
  publicKey: string;
  privateKey: string;
}

/** A process's copy of the stored pair: the sealed value it opened, and when it last read the row. */
interface Copy {
  sealed: string;
  pair: Pair;
  checkedAt: number;
}

const copies = new WeakMap<Database, Copy>();
const loading = new WeakMap<Database, Promise<Pair>>();

/**
 * Gets or makes this installation's VAPID key pair. Each process keeps the pair it opened and reads the row
 * again every `VAPID_RECHECK_MS`, opening it again only when another server replaced it. `wrappers[0]` seals
 * a new one.
 */
export async function vapidKeys(
  db: Database,
  wrappers: KeyWrapper[],
  config: VapidConfig,
  now = new Date(),
): Promise<VapidKeys> {
  const subject = vapidSubject(config);
  if (config.WEB_PUSH_VAPID_PUBLIC_KEY && config.WEB_PUSH_VAPID_PRIVATE_KEY) {
    return { publicKey: config.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: config.WEB_PUSH_VAPID_PRIVATE_KEY, subject };
  }
  const copy = copies.get(db);
  if (copy && now.getTime() - copy.checkedAt < VAPID_RECHECK_MS) return { ...copy.pair, subject };
  let load = loading.get(db);
  if (!load) {
    // A failure (database down, key service away) is tried again on the next call.
    load = storedVapidKeys(db, wrappers, now).finally(() => loading.delete(db));
    loading.set(db, load);
  }
  return { ...(await load), subject };
}

async function storedVapidKeys(db: Database, wrappers: KeyWrapper[], now: Date): Promise<Pair> {
  const sealer = wrappers[0];
  if (!sealer) throw new Error("no key wrapper to seal the VAPID key with");
  // Several replicas may race to make the pair: each replaces only what it read, and a loser reads the winner's.
  for (let attempt = 0; attempt < 4; attempt++) {
    const [row] = await db
      .select({
        publicKey: instancePush.vapidPublicKey,
        privateKey: instancePush.vapidPrivateKey,
        updatedAt: instancePush.updatedAt,
      })
      .from(instancePush)
      .where(eq(instancePush.id, 1));
    if (!row) {
      await db.insert(instancePush).values({ id: 1 }).onConflictDoNothing();
      continue;
    }
    if (row.publicKey && row.privateKey) {
      const copy = copies.get(db);
      if (copy?.sealed === row.privateKey) return keep(db, row.privateKey, copy.pair, now);
      const opened = await openStored(wrappers, row.privateKey);
      if (opened !== null) return keep(db, row.privateKey, { publicKey: row.publicKey, privateKey: opened }, now);
      if (now.getTime() - row.updatedAt.getTime() < VAPID_KEEP_NEW_MS) {
        throw new Error(
          "can't open the Web Push key another server just made: is AGENTES_SECRET the same on every server?",
        );
      }
    }
    const fresh = generateVapidKeys();
    const sealed = JSON.stringify(await sealSecret(sealer, fresh.privateKey, VAPID_AAD));
    const replaced = await db
      .update(instancePush)
      .set({ vapidPublicKey: fresh.publicKey, vapidPrivateKey: sealed, updatedAt: now })
      .where(
        and(
          eq(instancePush.id, 1),
          row.publicKey ? eq(instancePush.vapidPublicKey, row.publicKey) : isNull(instancePush.vapidPublicKey),
        ),
      )
      .returning({ id: instancePush.id });
    if (replaced.length > 0) return keep(db, sealed, fresh, now);
  }
  throw new Error("couldn't store this installation's VAPID key");
}

function keep(db: Database, sealed: string, pair: Pair, now: Date): Pair {
  copies.set(db, { sealed, pair, checkedAt: now.getTime() });
  return pair;
}

/**
 * The stored private key, or `null` when the installation's key can never open it (another `AGENTES_SECRET`,
 * a damaged value). Throws when it can't tell now: a key service that doesn't answer, a wrapper this process lacks.
 */
async function openStored(wrappers: KeyWrapper[], stored: string): Promise<string | null> {
  let sealed: SealedSecret;
  try {
    sealed = JSON.parse(stored) as SealedSecret;
  } catch {
    return null;
  }
  if (
    typeof sealed?.kekId !== "string" ||
    typeof sealed.ciphertext !== "string" ||
    typeof sealed.wrappedDataKey !== "string"
  ) {
    return null;
  }
  try {
    return await openSecret(wrappers, sealed, VAPID_AAD);
  } catch (error) {
    if (error instanceof SealedValueError) return null;
    throw error;
  }
}
