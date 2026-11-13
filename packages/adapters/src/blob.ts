/**
 * Object storage for files (artifact versions, uploads). Objects are private:
 * the app hands out short-lived signed URLs after its own org and visibility
 * checks, or streams the bytes itself when a store can't sign.
 *
 * Implementations: S3-compatible buckets (`createS3BlobStore`: Cloudflare R2,
 * AWS S3, MinIO, Wasabi…), a folder on the server's disk (`createDiskBlobStore`),
 * Postgres (`createPostgresBlobStore`, the fallback when neither is configured)
 * and memory (tests). Google Drive and OneDrive (OAuth into a folder the org
 * picks) are planned behind the same interface.
 */
export interface BlobStore {
  /** `s3`, `postgres`, `memory`… */
  readonly kind: string;
  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** The object's bytes as they are read, where the store can; without it, `get`. */
  stream?(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, at most `limit` (default 1000). */
  list(prefix: string, limit?: number): Promise<string[]>;
  /** Everything under the folder `prefix` (ends with `/`) at once, folders included, where the store can. */
  deletePrefix?(prefix: string): Promise<void>;
  /**
   * A short-lived URL that downloads the object, or null when this store
   * can't sign (the server streams it instead).
   */
  signedUrl(key: string, options: { expiresInSeconds: number; filename?: string }): Promise<string | null>;
}

/**
 * Where blobs of one organization go. `storageConfigId` null = platform
 * storage (with a per-org key prefix). Every read and write goes through a
 * resolver; each stored object records the config it was written to, so a
 * switch never breaks old files.
 */
export interface BlobLocation {
  storageConfigId: string | null;
  store: BlobStore;
  /** Key prefix for new objects of this org in this store (ends with `/`). */
  prefix: string;
}

export interface BlobStoreResolver {
  /** Where new objects of `orgId` are written. */
  forOrg(orgId: string): Promise<BlobLocation>;
  /** The store an existing object was written to. */
  forConfig(orgId: string, storageConfigId: string | null): Promise<BlobStore>;
}

/** Platform storage for every org, with a per-org prefix (core default and tests). */
export function singleStoreResolver(store: BlobStore, root = "orgs"): BlobStoreResolver {
  return {
    async forOrg(orgId) {
      return { storageConfigId: null, store, prefix: `${root}/${orgId}/` };
    },
    async forConfig() {
      return store;
    },
  };
}

/** In-memory store (tests and local experiments). `signedUrl` returns a fake URL unless `sign: false`. */
export function createMemoryBlobStore(options: { sign?: boolean; kind?: string } = {}) {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: BlobStore & { objects: typeof objects } = {
    kind: options.kind ?? "memory",
    objects,
    async put(key, body, { contentType }) {
      objects.set(key, { body: new Uint8Array(body), contentType });
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { body: new Uint8Array(o.body), contentType: o.contentType } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix, limit = 1000) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
    },
    async signedUrl(key, { expiresInSeconds }) {
      if (options.sign === false) return null;
      return `memory://${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
    },
  };
  return store;
}
