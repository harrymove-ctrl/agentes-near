/**
 * Wraps and unwraps data keys for envelope encryption of provider credentials
 * (docs/adr/0007-provider-credentials.md). Core: a key derived from
 * AGENTES_SECRET (`local:v1`, in `@agenteschat/engine`). Cloud: a KMS module.
 * `aad` binds the wrapped key to its owner (org and credential ids).
 */
export interface KeyWrapper {
  /** Stored next to each wrapped key, so old keys stay readable after rotation. */
  readonly id: string;
  wrap(dataKey: Uint8Array, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Uint8Array>;
}

/**
 * Supplies the platform's own provider key for agents without an org
 * credential. Core has none (self-hosters bring their own key); Cloud resells
 * tokens through this hook.
 */
export interface PlatformCredentials {
  resolve(orgId: string, provider: string): Promise<{ apiKey: string; workspaceId?: string } | null>;
  /** Whether a platform key exists for this org and provider, without fetching it. Defaults to `resolve !== null`. */
  available?(orgId: string, provider: string): Promise<boolean>;
}

export const noPlatformCredentials: PlatformCredentials = { resolve: async () => null };

/**
 * Platform keys from the deployment's environment (Cloud): one key per
 * provider, used by every organization that has no key of its own. Usage is
 * still recorded per organization.
 */
export function envPlatformCredentials(
  keys: Record<string, { apiKey?: string; workspaceId?: string } | undefined>,
): PlatformCredentials {
  return {
    async resolve(_orgId, provider) {
      const k = keys[provider];
      return k?.apiKey ? { apiKey: k.apiKey, ...(k.workspaceId ? { workspaceId: k.workspaceId } : {}) } : null;
    },
    async available(_orgId, provider) {
      return Boolean(keys[provider]?.apiKey);
    },
  };
}
