import type { KeyWrapper, RelayCredentials } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { openSecret, type SealedSecret, SealedValueError, sealSecret } from "./crypto";

const { instancePush } = schema;

/** Binds the sealed relay secret to its column, so it can't be swapped for another sealed value. */
const RELAY_SECRET_AAD = "instance_push:relay";

/**
 * This installation's credentials at the push relay (ADR 0152), in the `instance_push` row (id 1). The
 * secret is sealed with the installation's key: `wrappers()` gives the current key wrappers, the first
 * one sealing (read on each call, since modules may replace them after boot). Credentials from another
 * relay (`url` changed) or that can never open (`AGENTES_SECRET` changed, a damaged value) read as none, so
 * the sender registers again; a key service that doesn't answer now is an error to retry, not a reason to.
 *
 * The row's `updatedAt` is left alone: it dates the Web Push pair (`vapidKeys` won't replace a pair younger
 * than ten minutes), not these credentials.
 */
export function relayCredentials(db: Database, wrappers: () => KeyWrapper[], url: string): RelayCredentials {
  return {
    async get() {
      const [row] = await db
        .select({
          relayUrl: instancePush.relayUrl,
          relayInstanceId: instancePush.relayInstanceId,
          relaySecret: instancePush.relaySecret,
        })
        .from(instancePush)
        .where(eq(instancePush.id, 1))
        .limit(1);
      if (!row || row.relayUrl !== url || !row.relayInstanceId || !row.relaySecret) return null;
      let sealed: SealedSecret;
      try {
        sealed = JSON.parse(row.relaySecret) as SealedSecret;
      } catch {
        return null;
      }
      // Sealed by a key this server no longer has (a key service swapped with no legacy wrapper): never opens.
      if (!wrappers().some((w) => w.id === sealed.kekId)) return null;
      try {
        return { instanceId: row.relayInstanceId, secret: await openSecret(wrappers(), sealed, RELAY_SECRET_AAD) };
      } catch (error) {
        if (error instanceof SealedValueError) return null;
        throw error;
      }
    },
    async save(credentials) {
      const [sealer] = wrappers();
      if (!sealer) throw new Error("no key wrapper to seal the push relay's secret");
      const sealed = JSON.stringify(await sealSecret(sealer, credentials.secret, RELAY_SECRET_AAD));
      const values = { relayUrl: url, relayInstanceId: credentials.instanceId, relaySecret: sealed };
      await db
        .insert(instancePush)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: instancePush.id, set: values });
    },
    async clear() {
      await db
        .update(instancePush)
        .set({ relayUrl: null, relayInstanceId: null, relaySecret: null })
        .where(eq(instancePush.id, 1));
    },
  };
}
