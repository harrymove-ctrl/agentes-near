/**
 * The contract every Vault source keeps (ADR 0144), run on each source with a fake provider: `list` is metadata only,
 * `reveal` gives one value, and every failure is a `VaultSourceError` with a code whose text never carries a token,
 * a password or the provider's own words. The fakes put their secrets into their raw errors on purpose.
 */
import { describe, expect, test } from "bun:test";
import { createBitwardenSource } from "../src/vault/bitwarden";
import { createOnePasswordSource } from "../src/vault/onepassword";
import {
  type VaultConnection,
  type VaultSecretField,
  type VaultSource,
  VaultSourceError,
  type VaultSourceErrorCode,
} from "../src/vault/source";
import { createFakeBitwarden, createFakeOnePassword, FAKE_BW, FAKE_OP_TOKEN } from "./fixtures/vault-fakes";

const CODES: VaultSourceErrorCode[] = [
  "auth_failed",
  "locked",
  "many_vaults",
  "no_vault",
  "folder_missing",
  "not_found",
  "rate_limited",
  "unreachable",
  "unsupported",
  "invalid_input",
  "read_only",
];

/** What a source's access tokens look like in the fakes: they must never come out either. */
const ACCESS_TOKEN_SHAPE = "fake-access-token";

interface Harness {
  source: VaultSource;
  input: Record<string, string>;
  /** Credentials the provider refuses. */
  refusedInput: Record<string, string>;
  /** Every secret the fake holds. */
  secrets: string[];
  reveal: { ref: string; field: VaultSecretField; value: string };
  missingRef: string;
  /** The provider stops answering, with its secrets in the raw error. */
  breakDown(): void;
  heal(): void;
}

async function bitwardenHarness(): Promise<Harness> {
  const passwords = ["fake-contract-bw-pass-1", "fake-contract-bw-pass-2"];
  const fake = await createFakeBitwarden({
    logins: [
      {
        id: "7d0c1f9e-0000-4000-8000-000000000001",
        name: "Acme admin",
        folder: "Agents",
        username: "ana@acme.example",
        password: passwords[0],
        uris: [{ uri: "https://admin.acme.example/login", match: null }],
      },
      {
        id: "7d0c1f9e-0000-4000-8000-000000000002",
        name: "Personal",
        folder: "Personal",
        username: "bruno",
        password: passwords[1],
      },
    ],
  });
  return {
    source: createBitwardenSource({ fetch: fake.fetch, timeoutMs: 1_000 }),
    input: {
      server: "bitwarden.com",
      clientId: FAKE_BW.clientId,
      clientSecret: FAKE_BW.clientSecret,
      masterPassword: FAKE_BW.masterPassword,
      folder: "Agents",
    },
    refusedInput: {
      server: "bitwarden.com",
      clientId: FAKE_BW.clientId,
      clientSecret: "refusedSecret00000",
      masterPassword: FAKE_BW.masterPassword,
      folder: "Agents",
    },
    secrets: [FAKE_BW.clientSecret, FAKE_BW.masterPassword, "refusedSecret00000", ...passwords],
    reveal: { ref: "7d0c1f9e-0000-4000-8000-000000000001", field: "password", value: passwords[0] ?? "" },
    missingRef: "7d0c1f9e-0000-4000-8000-0000000000ff",
    breakDown: () => {
      fake.state.down = true;
    },
    heal: () => {
      fake.state.down = false;
    },
  };
}

async function onePasswordHarness(): Promise<Harness> {
  const secrets = ["fake-contract-op-pass-1", "fake-contract-op-key-2"];
  const refused = `ops_${"R".repeat(40)}`;
  const fake = createFakeOnePassword({
    items: [
      {
        id: "contractlogin0000000000001",
        title: "Acme admin",
        category: "Login",
        username: "ana@acme.example",
        password: secrets[0],
        websites: [{ url: "https://admin.acme.example", autofillBehavior: "ExactDomain" }],
      },
      { id: "contractkey000000000000002", title: "ACME_API_KEY", category: "ApiCredentials", credential: secrets[1] },
    ],
  });
  return {
    source: createOnePasswordSource({ loadSdk: async () => fake.sdk, timeoutMs: 1_000 }),
    input: { token: FAKE_OP_TOKEN },
    refusedInput: { token: refused },
    secrets: [FAKE_OP_TOKEN, refused, ...secrets],
    reveal: { ref: "contractlogin0000000000001", field: "password", value: secrets[0] ?? "" },
    missingRef: "contractmissing00000000099",
    breakDown: () => {
      fake.state.failOn = "all";
      fake.state.failWith = () => new Error(`error sending request: connection reset (${FAKE_OP_TOKEN})`);
    },
    heal: () => {
      fake.state.failOn = null;
    },
  };
}

const HARNESSES: [string, () => Promise<Harness>][] = [
  ["bitwarden", bitwardenHarness],
  ["onepassword", onePasswordHarness],
];

async function connected(h: Harness): Promise<VaultConnection> {
  const result = await h.source.connect(h.input);
  return { id: `contract-${h.source.kind}`, orgId: "org-contract", config: result.config, secret: result.secret };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
}

/** A failure is ours: a coded `VaultSourceError` whose every visible part carries no secret. */
function expectClean(err: unknown, secrets: string[]) {
  expect(err).toBeInstanceOf(VaultSourceError);
  if (!(err instanceof VaultSourceError)) return;
  expect(CODES).toContain(err.code);
  expect(err.cause).toBeUndefined();
  const visible = [err.message, String(err), JSON.stringify(err), err.stack ?? "", err.retryAt ?? ""].join("\n");
  for (const secret of [...secrets, ACCESS_TOKEN_SHAPE]) expect(visible).not.toContain(secret);
}

for (const [name, make] of HARNESSES) {
  describe(`Vault source contract: ${name}`, () => {
    test("describes a connect card whose secret fields are secret", async () => {
      const h = await make();
      const d = h.source.describe();
      expect(d.kind).toBe(h.source.kind);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.kinds.length).toBeGreaterThan(0);
      expect(d.steps.length).toBeGreaterThan(0);
      for (const field of d.fields) {
        expect(field.id.length).toBeGreaterThan(0);
        expect(field.label.length).toBeGreaterThan(0);
        if (/token|secret|password/i.test(field.id)) expect(field.kind).toBe("secret");
      }
      // The card is a copy: changing it changes nothing for the next caller.
      d.steps.push("changed");
      expect(h.source.describe().steps).not.toContain("changed");
    });

    test("connect keeps what is secret in `secret` only", async () => {
      const h = await make();
      const result = await h.source.connect(h.input);
      const shown = JSON.stringify({ label: result.label, config: result.config });
      for (const secret of [...h.secrets, ACCESS_TOKEN_SHAPE]) expect(shown).not.toContain(secret);
      expect(Object.keys(result.secret).length).toBeGreaterThan(0);
    });

    test("list is metadata only", async () => {
      const h = await make();
      const items = await h.source.list(await connected(h));
      expect(items.length).toBeGreaterThan(0);
      const listed = JSON.stringify(items);
      for (const secret of [...h.secrets, ACCESS_TOKEN_SHAPE]) expect(listed).not.toContain(secret);
      const kinds = h.source.describe().kinds;
      for (const item of items) {
        expect(item.ref.length).toBeGreaterThan(0);
        expect(item.title.length).toBeGreaterThan(0);
        expect(kinds).toContain(item.kind);
        for (const website of item.websites ?? []) {
          expect(website.url.startsWith("https://")).toBe(true);
          expect(["exact", "site"]).toContain(website.match);
        }
      }
    });

    test("reveal gives exactly the one value asked for", async () => {
      const h = await make();
      const connection = await connected(h);
      expect(await h.source.reveal(connection, h.reveal.ref, h.reveal.field)).toBe(h.reveal.value);
    });

    test("every failure is a coded VaultSourceError that never carries a secret", async () => {
      const h = await make();
      const connection = await connected(h);
      const errors: unknown[] = [];
      errors.push(await failure(() => h.source.connect(h.refusedInput)));
      errors.push(await failure(() => h.source.connect({})));
      errors.push(await failure(() => h.source.reveal(connection, h.missingRef, h.reveal.field)));
      errors.push(await failure(() => h.source.reveal(connection, "../../etc/passwd", h.reveal.field)));
      errors.push(
        await failure(() => h.source.list({ ...connection, secret: {}, config: {} } satisfies VaultConnection)),
      );
      h.breakDown();
      errors.push(await failure(() => h.source.list(connection)));
      errors.push(await failure(() => h.source.connect(h.input)));
      h.heal();
      for (const err of errors) expectClean(err, h.secrets);
      expect((errors[0] as VaultSourceError).code).toBe("auth_failed");
      expect((errors[2] as VaultSourceError).code).toBe("not_found");
      expect((errors[5] as VaultSourceError).code).toBe("unreachable");
    });
  });
}
