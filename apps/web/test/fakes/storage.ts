/**
 * Test fake — file storage ("Configurações → Armazenamento").
 * Mirrors these endpoints:
 * - `GET  /api/app/organizations/{orgId}/storage` → StorageConfig
 * - `PUT  …/storage` `{ kind: "agentes" } | { kind: "s3", s3: S3Input }` (s3 needs a passing test of the same settings)
 * - `POST …/storage/test` S3Input → `{ ok, steps: [{ step: "write" | "read" | "list" | "delete", ok, error? }] }`
 * - `POST …/storage/migrate` (start or resume) and `GET …/storage/migrate` (status) → StorageMigration
 * The mock never reaches a bucket. A bucket named with "negado" fails the
 * write step; with "lista" the list step; with "instavel" the copy stops at
 * half once (resume continues). Where the server keeps files itself is
 * `platform` (its disk, no folder, unless a test says otherwise), and what
 * the workspace's files take is `usage` (none yet, no disk told, unless a
 * test says otherwise): a finished copy moves what this server held to the
 * bucket's side.
 */
import type {
  ApiClient,
  S3Input,
  StorageConfig,
  StorageMigration,
  StoragePlatform,
  StorageStep,
  StorageTestResult,
  StorageUsage,
} from "@agenteschat/client";
import { clone } from "./context";

const STEPS: StorageStep[] = ["write", "read", "list", "delete"];
const TOTAL = 120;
const sig = (s: S3Input) => JSON.stringify([s.endpoint, s.region, s.bucket, s.prefix ?? "", s.pathStyle]);
const hint = (v: string | undefined, prev?: string) => (v ? v.slice(-4) : (prev ?? ""));

export function createMockStorage(
  platform: () => StoragePlatform | undefined = () => undefined,
  usage: () => StorageUsage | undefined = () => undefined,
): ApiClient["storage"] {
  const configs = new Map<string, StorageConfig>();
  const passed = new Map<string, string>();
  const flakyDone = new Set<string>();
  const get = (orgId: string) => {
    let c = configs.get(orgId);
    if (!c) {
      c = {
        kind: "agentes",
        s3: null,
        migration: null,
        platform: platform() ?? { kind: "disk", folder: null },
        usage: usage() ?? { platformBytes: 0, ownBucketBytes: 0, disk: null },
      };
      configs.set(orgId, c);
    }
    return c;
  };
  return {
    get: async (orgId) => clone(get(orgId)),
    test: async (orgId, input) => {
      const fail: Partial<Record<StorageStep, string>> = {};
      if (!/^https?:\/\//.test(input.endpoint)) fail.write = "Endereço inválido: use https://…";
      else if (input.bucket.includes("negado")) fail.write = "AccessDenied: a chave não pode escrever neste bucket.";
      else if (input.bucket.includes("lista")) fail.list = "AccessDenied: falta a permissão s3:ListBucket.";
      let broken = false;
      const steps = STEPS.map((step) => {
        if (broken) return { step, ok: false, error: null };
        if (fail[step]) {
          broken = true;
          return { step, ok: false, error: fail[step] };
        }
        return { step, ok: true, error: null };
      });
      const result: StorageTestResult = { ok: steps.every((s) => s.ok), steps };
      if (result.ok) passed.set(orgId, sig(input));
      return result;
    },
    save: async (orgId, input) => {
      const c = get(orgId);
      if (input.kind === "agentes") {
        Object.assign(c, { kind: "agentes", s3: null, migration: null });
        return clone(c);
      }
      if (passed.get(orgId) !== sig(input.s3))
        throw new Error("Teste a conexão com estas configurações antes de ativar.");
      const prev = c.s3;
      c.kind = "s3";
      c.s3 = {
        endpoint: input.s3.endpoint,
        region: input.s3.region,
        bucket: input.s3.bucket,
        prefix: input.s3.prefix,
        pathStyle: input.s3.pathStyle,
        accessKeyIdHint: hint(input.s3.accessKeyId, prev?.accessKeyIdHint),
        secretHint: hint(input.s3.secretAccessKey, prev?.secretHint),
      };
      c.migration = null;
      return clone(c);
    },
    migrate: async (orgId) => {
      const c = get(orgId);
      const m: StorageMigration =
        c.migration?.status === "failed"
          ? { ...c.migration, status: "running", error: null }
          : { status: "running", copied: 0, total: TOTAL, error: null };
      c.migration = m;
      return clone(m);
    },
    migration: async (orgId) => {
      const c = get(orgId);
      const m = c.migration;
      if (m?.status === "running") {
        m.copied = Math.min(m.total, m.copied + 40);
        if (c.s3?.bucket.includes("instavel") && !flakyDone.has(orgId) && m.copied >= m.total / 2) {
          flakyDone.add(orgId);
          m.status = "failed";
          m.error = "A conexão com o bucket caiu. Retome para continuar de onde parou.";
        } else if (m.copied >= m.total) {
          m.status = "done";
          if (c.usage)
            c.usage = { ...c.usage, platformBytes: 0, ownBucketBytes: c.usage.ownBucketBytes + c.usage.platformBytes };
        }
      }
      return m ? clone(m) : null;
    },
  };
}
