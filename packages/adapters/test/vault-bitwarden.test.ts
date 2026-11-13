import { describe, expect, test } from "bun:test";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { OutboundAddressError } from "../src/outbound-url";
import { createBitwardenSource, derivationQueue } from "../src/vault/bitwarden";
import {
  ARGON2_MAX_WORK_MIB_ITERATIONS,
  BitwardenCryptoError,
  constantTimeEqual,
  decryptBytes,
  decryptString,
  decryptUserKey,
  deriveMasterKey,
  encryptBytes,
  encryptString,
  fromBase64,
  kdfSupported,
  stretchMasterKey,
  symmetricKeyFrom,
  toBase64,
} from "../src/vault/bitwarden-crypto";
import { type VaultConnection, VaultSourceError } from "../src/vault/source";
import { createFakeBitwarden, FAKE_BW, type FakeBitwardenOptions, type FakeLogin } from "./fixtures/vault-fakes";

/*
 * Published test vectors from Bitwarden's open-source SDK (repository bitwarden/sdk-internal): the KDF and stretch
 * vectors from the bitwarden-crypto crate's own tests, and the two accounts from bitwarden-core's test fixtures
 * (their protected user keys, and the first account's private key and public key).
 */
const SDK_PASSWORD = "67t9b5g67$%Dh89n";
const SDK_SALT = "test_key";
const SDK_PBKDF2_KEY = [
  31, 79, 104, 226, 150, 71, 177, 90, 194, 80, 172, 209, 17, 129, 132, 81, 138, 167, 69, 167, 254, 149, 2, 27, 39, 197,
  64, 42, 22, 195, 86, 75,
];
const SDK_ARGON2_KEY = [
  207, 240, 225, 177, 162, 19, 163, 76, 98, 106, 179, 175, 224, 9, 17, 240, 20, 147, 237, 47, 246, 150, 141, 184, 62,
  225, 131, 242, 51, 53, 225, 242,
];
const SDK_STRETCHED_ENC = [
  111, 31, 178, 45, 238, 152, 37, 114, 143, 215, 124, 83, 135, 173, 195, 23, 142, 134, 120, 249, 61, 132, 163, 182, 113,
  197, 189, 204, 188, 21, 237, 96,
];
const SDK_STRETCHED_MAC = [
  221, 127, 206, 234, 101, 27, 202, 38, 86, 52, 34, 28, 78, 28, 185, 16, 48, 61, 127, 166, 209, 247, 194, 87, 232, 26,
  48, 85, 193, 249, 179, 155,
];
/** The master password hash (PBKDF2 of the master key, one round, salted with the password) for `asdfasdf`. */
const SDK_SERVER_HASH = "wmyadRMyBZOH7P/a/ucTCbSghKgdzDpPqUnu/DAVtSw=";

const SDK_ACCOUNT = {
  email: "test@bitwarden.com",
  password: "asdfasdfasdf",
  iterations: 600_000,
  userKey:
    "2.Q/2PhzcC7GdeiMHhWguYAQ==|GpqzVdr0go0ug5cZh1n+uixeBC3oC90CIe0hd/HWA/pTRDZ8ane4fmsEIcuc8eMKUt55Y2q/fbNzsYu41YTZzzsJUSeqVjT8/iTQtgnNdpo=|dwI+uyvZ1h/iZ03VQ+/wrGEFYVewBUUl/syYgjsNMbE=",
  privateKey:
    "2.yN7l00BOlUE0Sb0M//Q53w==|EwKG/BduQRQ33Izqc/ogoBROIoI5dmgrxSo82sgzgAMIBt3A2FZ9vPRMY+GWT85JiqytDitGR3TqwnFUBhKUpRRAq4x7rA6A1arHrFp5Tp1p21O3SfjtvB3quiOKbqWk6ZaU1Np9HwqwAecddFcB0YyBEiRX3VwF2pgpAdiPbSMuvo2qIgyob0CUoC/h4Bz1be7Qa7B0Xw9/fMKkB1LpOm925lzqosyMQM62YpMGkjMsbZz0uPopu32fxzDWSPr+kekNNyLt9InGhTpxLmq1go/pXR2uw5dfpXc5yuta7DB0EGBwnQ8Vl5HPdDooqOTD9I1jE0mRyuBpWTTI3FRnu3JUh3rIyGBJhUmHqGZvw2CKdqHCIrQeQkkEYqOeJRJVdBjhv5KGJifqT3BFRwX/YFJIChAQpebNQKXe/0kPivWokHWwXlDB7S7mBZzhaAPidZvnuIhalE2qmTypDwHy22FyqV58T8MGGMchcASDi/QXI6kcdpJzPXSeU9o+NC68QDlOIrMVxKFeE7w7PvVmAaxEo0YwmuAzzKy9QpdlK0aab/xEi8V4iXj4hGepqAvHkXIQd+r3FNeiLfllkb61p6WTjr5urcmDQMR94/wYoilpG5OlybHdbhsYHvIzYoLrC7fzl630gcO6t4nM24vdB6Ymg9BVpEgKRAxSbE62Tqacxqnz9AcmgItb48NiR/He3n3ydGjPYuKk/ihZMgEwAEZvSlNxYONSbYrIGDtOY+8Nbt6KiH3l06wjZW8tcmFeVlWv+tWotnTY9IqlAfvNVTjtsobqtQnvsiDjdEVtNy/s2ci5TH+NdZluca2OVEr91Wayxh70kpM6ib4UGbfdmGgCo74gtKvKSJU0rTHakQ5L9JlaSDD5FamBRyI0qfL43Ad9qOUZ8DaffDCyuaVyuqk7cz9HwmEmvWU3VQ+5t06n/5kRDXttcw8w+3qClEEdGo1KeENcnXCB32dQe3tDTFpuAIMLqwXs6FhpawfZ5kPYvLPczGWaqftIs/RXJ/EltGc0ugw2dmTLpoQhCqrcKEBDoYVk0LDZKsnzitOGdi9mOWse7Se8798ib1UsHFUjGzISEt6upestxOeupSTOh0v4+AjXbDzRUyogHww3V+Bqg71bkcMxtB+WM+pn1XNbVTyl9NR040nhP7KEf6e9ruXAtmrBC2ah5cFEpLIot77VFZ9ilLuitSz+7T8n1yAh1IEG6xxXxninAZIzi2qGbH69O5RSpOJuJTv17zTLJQIIc781JwQ2TTwTGnx5wZLbffhCasowJKd2EVcyMJyhz6ru0PvXWJ4hUdkARJs3Xu8dus9a86N8Xk6aAPzBDqzYb1vyFIfBxP0oO8xFHgd30Cgmz8UrSE3qeWRrF8ftrI6xQnFjHBGWD/JWSvd6YMcQED0aVuQkuNW9ST/DzQThPzRfPUoiL10yAmV7Ytu4fR3x2sF0Yfi87YhHFuCMpV/DsqxmUizyiJuD938eRcH8hzR/VO53Qo3UIsqOLcyXtTv6THjSlTopQ+JOLOnHm1w8dzYbLN44OG44rRsbihMUQp+wUZ6bsI8rrOnm9WErzkbQFbrfAINdoCiNa6cimYIjvvnMTaFWNymqY1vZxGztQiMiHiHYwTfwHTXrb9j0uPM=|09J28iXv9oWzYtzK2LBT6Yht4IT4MijEkk0fwFdrVQ4=",
  publicKey:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Ww2chogqCpaAR7Uw448am4b7vDFXiM5kXjFlGfXBlrAdAqTTggEvTDlMNYqPlCo+mBM6iFmTTUY9rpZBvFskMnKvsvpJ47/fehAH2o2e3Ulv/5NFevaVCMCmpkBDtbMbO1A4a3btdRtCP8DsKWMefHauEpaoLxNTLWnOIZVfCMjsSgx2EvULHAZPTtbFwm4+UVKniM4ds4jvOsD85h4jn2aLs/jWJXFfxN8iVSqEqpC2TBvsPdyHb49xQoWWfF0Z6BiNqeNGKEU9Uos1pjL+kzhEzzSpH31PZT/ufJ/oo4+93wrUt57hb6f0jxiXhwd5yQ+9F6wVwpbfkq0IwhjOwIDAQAB",
};

const SDK_LEGACY_ACCOUNT = {
  email: "legacy@bitwarden.com",
  password: "asdfasdfasdf",
  iterations: 600_000,
  userKey:
    "0.8UClLa8IPE1iZT7chy5wzQ==|6PVfHnVk5S3XqEtQemnM5yb4JodxmPkkWzmDRdfyHtjORmvxqlLX40tBJZ+CKxQWmS8tpEB5w39rbgHg/gqs0haGdZG4cPbywsgGzxZ7uNI=",
  encKey: [
    12, 95, 151, 203, 37, 4, 236, 67, 137, 97, 90, 58, 6, 127, 242, 28, 209, 168, 125, 29, 118, 24, 213, 44, 117, 202,
    2, 115, 132, 165, 125, 148,
  ],
  macKey: [
    186, 215, 234, 137, 24, 169, 227, 29, 218, 57, 180, 237, 73, 91, 189, 51, 253, 26, 17, 52, 226, 4, 134, 75, 194,
    208, 178, 133, 128, 224, 140, 167,
  ],
};

const bytes = (list: number[]) => new Uint8Array(list);
const buffer = (data: Uint8Array) => new Uint8Array(data);

async function cryptoError(run: () => unknown): Promise<BitwardenCryptoError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof BitwardenCryptoError) return err;
    throw err;
  }
  throw new Error("expected a BitwardenCryptoError");
}

async function sourceError(run: () => Promise<unknown>): Promise<VaultSourceError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof VaultSourceError) return err;
    throw err;
  }
  throw new Error("expected a VaultSourceError");
}

describe("Bitwarden crypto: published vectors", () => {
  test("PBKDF2-SHA256 master key", async () => {
    const key = await deriveMasterKey(SDK_PASSWORD, SDK_SALT, { type: "pbkdf2", iterations: 10_000 });
    expect(Array.from(key)).toEqual(SDK_PBKDF2_KEY);
  });

  test("Argon2id master key (the salt is SHA-256 of the email)", async () => {
    const key = await deriveMasterKey(SDK_PASSWORD, SDK_SALT, {
      type: "argon2id",
      iterations: 4,
      memoryMiB: 32,
      parallelism: 2,
    });
    expect(Array.from(key)).toEqual(SDK_ARGON2_KEY);
  }, 30_000);

  test("the email is trimmed and lowercased before it salts the key", async () => {
    for (const email of ["test@bitwarden.com", "TEST@bitwarden.com", " test@bitwarden.com"]) {
      const key = await deriveMasterKey("asdfasdf", email, { type: "pbkdf2", iterations: 100_000 });
      const hash = pbkdf2(sha256, key, new TextEncoder().encode("asdfasdf"), { c: 1, dkLen: 32 });
      expect(toBase64(hash)).toBe(SDK_SERVER_HASH);
    }
  }, 20_000);

  test("HKDF stretch of the master key into an encryption key and a MAC key", () => {
    const stretched = stretchMasterKey(bytes(SDK_PBKDF2_KEY));
    expect(Array.from(stretched.encKey)).toEqual(SDK_STRETCHED_ENC);
    expect(Array.from(stretched.macKey)).toEqual(SDK_STRETCHED_MAC);
  });

  test("a published account opens: its user key verifies and decrypts the account's private key", async () => {
    const masterKey = await deriveMasterKey(SDK_ACCOUNT.password, SDK_ACCOUNT.email, {
      type: "pbkdf2",
      iterations: SDK_ACCOUNT.iterations,
    });
    const userKey = decryptUserKey(SDK_ACCOUNT.userKey, masterKey);
    expect(userKey.encKey.length).toBe(32);
    expect(userKey.macKey.length).toBe(32);

    // The private key is an EncString of type 2 under the user key: its MAC verifies and it is a PKCS#8 key whose
    // modulus is the published public key's.
    const der = decryptBytes(SDK_ACCOUNT.privateKey, userKey);
    expect(der[0]).toBe(0x30);
    const rsa = { name: "RSA-OAEP", hash: "SHA-1" };
    const privateKey = await crypto.subtle.importKey("pkcs8", buffer(der), rsa, true, ["decrypt"]);
    const publicDer = fromBase64(SDK_ACCOUNT.publicKey);
    if (!publicDer) throw new Error("bad public key vector");
    const publicKey = await crypto.subtle.importKey("spki", buffer(publicDer), rsa, true, ["encrypt"]);
    const [privateJwk, publicJwk] = await Promise.all([
      crypto.subtle.exportKey("jwk", privateKey),
      crypto.subtle.exportKey("jwk", publicKey),
    ]);
    expect(privateJwk.n).toBe(publicJwk.n);
  }, 20_000);

  test("the legacy user key (type 0, under the master key itself) opens as published", async () => {
    const masterKey = await deriveMasterKey(SDK_LEGACY_ACCOUNT.password, SDK_LEGACY_ACCOUNT.email, {
      type: "pbkdf2",
      iterations: SDK_LEGACY_ACCOUNT.iterations,
    });
    const userKey = decryptUserKey(SDK_LEGACY_ACCOUNT.userKey, masterKey);
    expect(Array.from(userKey.encKey)).toEqual(SDK_LEGACY_ACCOUNT.encKey);
    expect(Array.from(userKey.macKey)).toEqual(SDK_LEGACY_ACCOUNT.macKey);
  }, 20_000);
});

describe("Bitwarden crypto: our own fixtures (built with the same primitives)", () => {
  const key = symmetricKeyFrom(crypto.getRandomValues(new Uint8Array(64)));

  test("text round-trips through an EncString of type 2", () => {
    for (const text of ["", "ana@acme.example", "Olá, conta ✓ 🔐", "x".repeat(5000)]) {
      const enc = encryptString(text, key);
      expect(enc.startsWith("2.")).toBe(true);
      expect(decryptString(enc, key)).toBe(text);
    }
  });

  test("a wrong master password fails the user key's MAC", async () => {
    const kdf = { type: "pbkdf2", iterations: 5_000 } as const;
    const userKeyBytes = crypto.getRandomValues(new Uint8Array(64));
    const right = await deriveMasterKey("right password", "ana@acme.example", kdf);
    const protectedKey = encryptBytes(userKeyBytes, stretchMasterKey(right));
    expect(Array.from(decryptUserKey(protectedKey, right).encKey)).toEqual(Array.from(userKeyBytes.slice(0, 32)));
    const wrong = await deriveMasterKey("wrong password", "ana@acme.example", kdf);
    expect((await cryptoError(() => decryptUserKey(protectedKey, wrong))).reason).toBe("mac");
  });

  test("the MAC is checked before decrypting: any changed byte, or another key, fails with mac", async () => {
    const enc = encryptString("fake-password-1", key);
    const [head = "", data = "", mac = ""] = enc.split("|");
    const flipped = fromBase64(data);
    if (!flipped) throw new Error("bad fixture");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect((await cryptoError(() => decryptString(`${head}|${toBase64(flipped)}|${mac}`, key))).reason).toBe("mac");
    const iv = fromBase64(head.slice(2));
    if (!iv) throw new Error("bad fixture");
    iv[15] = (iv[15] ?? 0) ^ 1;
    expect((await cryptoError(() => decryptString(`2.${toBase64(iv)}|${data}|${mac}`, key))).reason).toBe("mac");
    const other = symmetricKeyFrom(crypto.getRandomValues(new Uint8Array(64)));
    expect((await cryptoError(() => decryptString(enc, other))).reason).toBe("mac");
  });

  test("malformed or unknown EncStrings are refused without decrypting", async () => {
    const enc = encryptString("value", key);
    const [head = "", data = ""] = enc.split("|");
    expect((await cryptoError(() => decryptString(`${head}|${data}|AAECAw==`, key))).reason).toBe("format");
    expect((await cryptoError(() => decryptString(`${head}|${data}`, key))).reason).toBe("format");
    expect((await cryptoError(() => decryptString("2.!!!!|Y3Q=|AAEC", key))).reason).toBe("format");
    expect((await cryptoError(() => decryptString("no dot here", key))).reason).toBe("format");
    expect((await cryptoError(() => decryptString(enc.replace(/^2\./, "1."), key))).reason).toBe("unsupported");
    expect((await cryptoError(() => decryptString(enc.replace(/^2\./, "7."), key))).reason).toBe("unsupported");
    // A type 0 EncString has no MAC: it is only ever accepted for a legacy user key.
    expect(
      (await cryptoError(() => decryptString(`0.${enc.slice(2).split("|").slice(0, 2).join("|")}`, key))).reason,
    ).toBe("unsupported");
  });

  test("a wrapped key must be 64 bytes", async () => {
    const short = encryptBytes(crypto.getRandomValues(new Uint8Array(32)), key);
    expect((await cryptoError(() => symmetricKeyFrom(decryptBytes(short, key)))).reason).toBe("unsupported");
  });

  test("KDF settings outside what Bitwarden (and this server) allow are refused", async () => {
    const tooFew = await cryptoError(() => deriveMasterKey("p", "e", { type: "pbkdf2", iterations: 4_999 }));
    expect(tooFew.reason).toBe("kdf");
    const tooLittle = await cryptoError(() =>
      deriveMasterKey("p", "e", { type: "argon2id", iterations: 3, memoryMiB: 15, parallelism: 4 }),
    );
    expect(tooLittle.reason).toBe("kdf");
    const tooMuch = await cryptoError(() =>
      deriveMasterKey("p", "e", { type: "argon2id", iterations: 3, memoryMiB: 1024, parallelism: 4 }),
    );
    expect(tooMuch.reason).toBe("kdf");
    // Memory times iterations is capped too (ADR 0144): each within its range, together too slow to run here.
    const tooLong = await cryptoError(() =>
      deriveMasterKey("p", "e", { type: "argon2id", iterations: 3, memoryMiB: 128, parallelism: 4 }),
    );
    expect(tooLong.reason).toBe("kdf");
    const argon2 = (iterations: number, memoryMiB: number) =>
      kdfSupported({ type: "argon2id", iterations, memoryMiB, parallelism: 4 });
    // Bitwarden's default, and the most at its memory.
    expect(argon2(3, 64)).toBe(true);
    expect(argon2(4, 64)).toBe(true);
    expect(argon2(5, 64)).toBe(false);
    expect(argon2(2, 128)).toBe(true);
    expect(argon2(10, 16)).toBe(true);
    expect(ARGON2_MAX_WORK_MIB_ITERATIONS).toBe(256);
  });

  test("constant-time comparison", () => {
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(bytes([1, 2, 3]), bytes([1, 2]))).toBe(false);
  });
});

// ---- The source, against a fake server ------------------------------------------------------------------------

const ID = {
  admin: "0b9b2a50-1c1e-4f0e-9a3c-000000000001",
  billing: "0b9b2a50-1c1e-4f0e-9a3c-000000000002",
  personal: "0b9b2a50-1c1e-4f0e-9a3c-000000000003",
  shared: "0b9b2a50-1c1e-4f0e-9a3c-000000000004",
  trashed: "0b9b2a50-1c1e-4f0e-9a3c-000000000005",
  card: "0b9b2a50-1c1e-4f0e-9a3c-000000000006",
  loose: "0b9b2a50-1c1e-4f0e-9a3c-000000000007",
  broken: "0b9b2a50-1c1e-4f0e-9a3c-000000000008",
  unknown: "0b9b2a50-1c1e-4f0e-9a3c-0000000000ff",
};

const PASSWORDS = {
  admin: "fake-pass-admin-1Qx",
  billing: "fake-pass-billing-2Wy",
  personal: "fake-pass-personal-3Ez",
  shared: "fake-pass-shared-4Rk",
  trashed: "fake-pass-trashed-5Tj",
};

const LOGINS: FakeLogin[] = [
  {
    id: ID.admin,
    name: "Acme admin",
    folder: "Agents",
    username: "ana@acme.example",
    password: PASSWORDS.admin,
    uris: [
      { uri: "https://admin.acme.example/login?next=/home", match: null },
      { uri: "acme.example", match: 0 },
      { uri: "https://admin.acme.example/other", match: null },
    ],
  },
  {
    id: ID.billing,
    name: "Billing",
    folder: "Agents",
    username: "billing",
    password: PASSWORDS.billing,
    ownKey: true,
    uris: [
      { uri: "https://billing.acme.example/start", match: 1 },
      { uri: "https://pay.acme.example/a", match: 2 },
      { uri: "https://exact.acme.example/x", match: 3 },
      { uri: "^https://.*\\.acme\\.example$", match: 4 },
      { uri: "https://never.acme.example", match: 5 },
      { uri: "http://old.acme.example", match: 3 },
    ],
  },
  { id: ID.personal, name: "Personal mail", folder: "Personal", username: "bruno", password: PASSWORDS.personal },
  {
    id: ID.shared,
    name: "Shared",
    folder: "Agents",
    password: PASSWORDS.shared,
    organizationId: "1bc9ac1e-0000-4000-8000-000000000001",
  },
  { id: ID.trashed, name: "Old", folder: "Agents", password: PASSWORDS.trashed, deletedDate: "2026-10-03T00:00:00Z" },
  { id: ID.card, name: "Company card", folder: "Agents", type: 3 },
  { id: ID.loose, name: "No folder", folder: null, password: "fake-pass-loose-6Yh" },
  { id: ID.broken, name: "Unreadable", folder: "Agents", password: "fake-pass-broken-7Ug", foreignKey: true },
];

const INPUT = {
  server: "bitwarden.com",
  clientId: FAKE_BW.clientId,
  clientSecret: FAKE_BW.clientSecret,
  masterPassword: FAKE_BW.masterPassword,
  folder: "agents",
};

/** A fake server, a source on it, and a connection made through `connect` (as the engine stores it). */
async function setup(options: FakeBitwardenOptions = {}, input: Record<string, string> = INPUT) {
  const fake = await createFakeBitwarden({ logins: LOGINS, ...options });
  let clock = Date.parse("2026-11-03T12:00:00Z");
  const source = createBitwardenSource({ fetch: fake.fetch, now: () => clock, timeoutMs: 2_000 });
  const result = await source.connect(input);
  const connection: VaultConnection = {
    id: "vault-connection-1",
    orgId: "org-1",
    config: result.config,
    secret: result.secret,
  };
  fake.calls.length = 0;
  const advance = (ms: number) => {
    clock += ms;
  };
  return { fake, source, result, connection, advance };
}

describe("Bitwarden source", () => {
  test("describes its connect card", () => {
    const d = createBitwardenSource().describe();
    expect(d.kind).toBe("bitwarden");
    expect(d.name).toBe("Bitwarden");
    expect(d.kinds).toEqual(["login"]);
    expect(d.steps).toHaveLength(3);
    expect(d.warning).toContain("master password");
    expect(d.fields.map((f) => [f.id, f.kind])).toEqual([
      ["server", "choice"],
      ["serverUrl", "url"],
      ["clientId", "text"],
      ["clientSecret", "secret"],
      ["masterPassword", "secret"],
      ["folder", "text"],
    ]);
    expect(d.fields.find((f) => f.id === "folder")?.initial).toBe("Agents");
  });

  test("connect signs in with the API key, opens the account and finds the folder (any casing)", async () => {
    const fake = await createFakeBitwarden({ logins: LOGINS });
    const source = createBitwardenSource({ fetch: fake.fetch });
    const result = await source.connect(INPUT);
    expect(result.label).toBe("Agents");
    expect(result.config).toEqual({
      server: "bitwarden.com",
      identityUrl: "https://identity.bitwarden.com",
      apiUrl: "https://api.bitwarden.com",
      folder: "Agents",
      email: FAKE_BW.email,
      deviceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(result.secret).toEqual({
      clientId: FAKE_BW.clientId,
      clientSecret: FAKE_BW.clientSecret,
      masterPassword: FAKE_BW.masterPassword,
    });
    const [token] = fake.callsTo("/connect/token");
    const form = new URLSearchParams(token?.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      scope: "api",
      client_id: FAKE_BW.clientId,
      client_secret: FAKE_BW.clientSecret,
      deviceType: "21",
      deviceIdentifier: result.config.deviceId ?? "",
      deviceName: "agentes.chat",
    });
    // The master password never leaves the server.
    expect(JSON.stringify(fake.calls)).not.toContain(FAKE_BW.masterPassword);
  });

  test("a self-hosted server (camelCase JSON) at the address a person pastes", async () => {
    const fake = await createFakeBitwarden({
      logins: LOGINS,
      casing: "camel",
      identityUrl: "https://vault.acme.example/identity",
      apiUrl: "https://vault.acme.example/api",
    });
    const source = createBitwardenSource({ fetch: fake.fetch });
    const result = await source.connect({ ...INPUT, server: "self", serverUrl: "https://vault.acme.example/#/vault" });
    expect(result.config.identityUrl).toBe("https://vault.acme.example/identity");
    expect(result.config.apiUrl).toBe("https://vault.acme.example/api");
    const connection = { id: "c2", orgId: "o", config: result.config, secret: result.secret };
    expect((await source.list(connection)).map((i) => i.title)).toEqual(["Acme admin", "Billing"]);
  });

  test("the EU cloud and a newer token answer (KDF only under the unlock options)", async () => {
    const fake = await createFakeBitwarden({
      logins: LOGINS,
      unlockOptionsOnly: true,
      identityUrl: "https://identity.bitwarden.eu",
      apiUrl: "https://api.bitwarden.eu",
    });
    const source = createBitwardenSource({ fetch: fake.fetch });
    const result = await source.connect({ ...INPUT, server: "bitwarden.eu" });
    expect(result.config.apiUrl).toBe("https://api.bitwarden.eu");
    expect(result.label).toBe("Agents");
  });

  test("an Argon2id account opens with the settings its server reports", async () => {
    const { source, connection } = await setup({
      kdf: { type: "argon2id", iterations: 2, memoryMiB: 16, parallelism: 1 },
    });
    expect(await source.reveal(connection, ID.admin, "password")).toBe(PASSWORDS.admin);
  }, 30_000);

  test("connect refuses what can't work before any request", async () => {
    const fake = await createFakeBitwarden({ logins: LOGINS });
    const source = createBitwardenSource({ fetch: fake.fetch });
    const cases: Record<string, string>[] = [
      { ...INPUT, server: "elsewhere.example" },
      { ...INPUT, server: "constructor" },
      { ...INPUT, server: "self", serverUrl: "http://vault.acme.example" },
      { ...INPUT, server: "self", serverUrl: "" },
      { ...INPUT, clientId: "organization.1234" },
      { ...INPUT, clientSecret: "  " },
      { ...INPUT, masterPassword: "" },
    ];
    for (const input of cases) expect((await sourceError(() => source.connect(input))).code).toBe("invalid_input");
    expect(fake.calls).toHaveLength(0);
  });

  test("connect failures: API key, master password, folder, network, rate limit, wrong server, timeout", async () => {
    const fake = await createFakeBitwarden({ logins: LOGINS });
    const clock = Date.parse("2026-11-03T12:00:00Z");
    const source = createBitwardenSource({ fetch: fake.fetch, now: () => clock, timeoutMs: 50 });

    expect((await sourceError(() => source.connect({ ...INPUT, clientSecret: "wrongSecret123" }))).code).toBe(
      "auth_failed",
    );
    expect((await sourceError(() => source.connect({ ...INPUT, masterPassword: "not it" }))).code).toBe("locked");
    expect((await sourceError(() => source.connect({ ...INPUT, folder: "Robots" }))).code).toBe("folder_missing");

    fake.state.rateLimitRetryAfter = "120";
    const limited = await sourceError(() => source.connect(INPUT));
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAt).toBe(new Date(clock + 120_000).toISOString());
    fake.state.rateLimitRetryAfter = null;

    fake.state.down = true;
    expect((await sourceError(() => source.connect(INPUT))).code).toBe("unreachable");
    fake.state.down = false;

    fake.state.html = true;
    expect((await sourceError(() => source.connect(INPUT))).code).toBe("unreachable");
    fake.state.html = false;

    fake.state.hang = true;
    expect((await sourceError(() => source.connect(INPUT))).message).toBe(
      "The Bitwarden server took too long to answer.",
    );
    fake.state.hang = false;

    const aborted = new AbortController();
    aborted.abort();
    expect((await sourceError(() => source.connect(INPUT, aborted.signal))).code).toBe("unreachable");
  });

  test("list: the folder's own logins, with usernames and websites, never a password", async () => {
    const { source, connection } = await setup();
    const items = await source.list(connection);
    expect(items).toEqual([
      {
        ref: ID.admin,
        kind: "login",
        title: "Acme admin",
        username: "ana@acme.example",
        websites: [
          { url: "https://admin.acme.example", match: "site" },
          { url: "https://acme.example", match: "site" },
        ],
        updatedAt: "2026-10-02T08:30:00.000Z",
      },
      {
        ref: ID.billing,
        kind: "login",
        title: "Billing",
        username: "billing",
        websites: [
          { url: "https://billing.acme.example", match: "exact" },
          { url: "https://pay.acme.example", match: "exact" },
          { url: "https://exact.acme.example", match: "exact" },
        ],
        updatedAt: "2026-10-02T08:30:00.000Z",
      },
    ]);
    const listed = JSON.stringify(items);
    for (const password of Object.values(PASSWORDS)) expect(listed).not.toContain(password);
  });

  test("the account stays open for 10 minutes at most, and never for changed credentials", async () => {
    const { fake, source, connection, advance } = await setup();
    await source.list(connection);
    await source.list(connection);
    await source.reveal(connection, ID.admin, "password");
    expect(fake.tokens()).toBe(2); // one for connect, one for the session
    expect(fake.callsTo("/accounts/profile")).toHaveLength(1);

    advance(10 * 60_000 + 1);
    await source.list(connection);
    expect(fake.tokens()).toBe(3);

    const changed = { ...connection, secret: { ...connection.secret, masterPassword: "not the password" } };
    expect((await sourceError(() => source.list(changed))).code).toBe("locked");
    expect(fake.tokens()).toBe(4);
  });

  test("reveal: one login's password, read from that login alone", async () => {
    const { fake, source, connection } = await setup();
    expect(await source.reveal(connection, ID.admin, "password")).toBe(PASSWORDS.admin);
    expect(await source.reveal(connection, ID.billing, "password")).toBe(PASSWORDS.billing);
    expect(fake.callsTo("/sync")).toHaveLength(0);
    expect(fake.callsTo("/folders")).toHaveLength(1);
    expect(fake.callsTo(`/ciphers/${ID.admin}`)).toHaveLength(1);
  });

  test("reveal finds nothing outside the folder's own logins", async () => {
    const { source, connection } = await setup();
    for (const ref of [ID.personal, ID.shared, ID.trashed, ID.card, ID.loose, ID.broken, ID.unknown, "../sync"]) {
      expect((await sourceError(() => source.reveal(connection, ref, "password"))).code).toBe("not_found");
    }
    expect((await sourceError(() => source.reveal(connection, ID.admin, "key"))).code).toBe("not_found");
  });

  test("a revoked access token signs in again once; a refused one is auth_failed", async () => {
    const { fake, source, connection } = await setup();
    await source.list(connection);
    fake.revokeTokens();
    expect(await source.reveal(connection, ID.admin, "password")).toBe(PASSWORDS.admin);
    expect(fake.tokens()).toBe(3);

    fake.state.rejectAll = true;
    expect((await sourceError(() => source.list(connection))).code).toBe("auth_failed");
    expect(fake.tokens()).toBe(4);
  });

  test("a folder renamed away is folder_missing on the next list", async () => {
    const { source, connection } = await setup();
    const renamed = { ...connection, config: { ...connection.config, folder: "Robots" } };
    expect((await sourceError(() => source.list(renamed))).code).toBe("folder_missing");
  });

  test("a server address the guarded fetch refuses (our own network) is invalid_input, in plain words", async () => {
    const asked: string[] = [];
    // What the server's `publicHttpsFetch` throws for a private, loopback, link-local or internal host.
    const guarded = (async (input: string | URL | Request): Promise<Response> => {
      asked.push(String(input));
      throw new OutboundAddressError();
    }) as typeof fetch;
    const source = createBitwardenSource({ fetch: guarded });
    const refused = await sourceError(() =>
      source.connect({ ...INPUT, server: "self", serverUrl: "https://10.0.0.5" }, undefined, { orgId: "org-1" }),
    );
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toContain("private or internal network");
    expect(asked).toEqual(["https://10.0.0.5/identity/connect/token"]);
    // A network failure stays one.
    const down = createBitwardenSource({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect((await sourceError(() => down.connect(INPUT))).code).toBe("unreachable");
  });
});

describe("Bitwarden source: a new login", () => {
  const NEW = {
    title: "shop.acme.example",
    username: "agent@acme.example",
    password: "fake-new-bw-password-77",
    website: "https://shop.acme.example",
    match: "site" as const,
    notes: "Made by an agent",
  };

  test("goes to the agents' folder, every text encrypted with the account's key, and is listed and revealed", async () => {
    const { fake, source, connection } = await setup();
    const created = await source.createLogin?.(connection, NEW);
    expect(created).toMatchObject({
      kind: "login",
      title: NEW.title,
      username: NEW.username,
      websites: [{ url: NEW.website, match: "site" }],
    });
    expect(JSON.stringify(created)).not.toContain(NEW.password);

    const [post] = fake.callsTo("/ciphers").filter((c) => c.method === "POST");
    expect(post?.url).toBe("https://api.bitwarden.com/ciphers");
    expect(post?.headers["content-type"]).toBe("application/json");
    // Nothing leaves in the clear: not the password, not the username, not the website.
    for (const plain of Object.values(NEW)) expect(post?.body).not.toContain(plain);
    const sent = JSON.parse(post?.body ?? "{}");
    const agents = fake.folders[0]?.Id;
    expect(sent).toMatchObject({ type: 1, folderId: agents, organizationId: null, favorite: false, reprompt: 0 });
    expect(sent.key).toBeUndefined();
    // What was sent opens with the same key and primitives the reads use.
    expect(decryptString(sent.name, fake.userKey)).toBe(NEW.title);
    expect(decryptString(sent.notes, fake.userKey)).toBe(NEW.notes);
    expect(decryptString(sent.login.username, fake.userKey)).toBe(NEW.username);
    expect(decryptString(sent.login.password, fake.userKey)).toBe(NEW.password);
    expect(sent.login.uris).toHaveLength(1);
    expect(sent.login.uris[0].match).toBe(0);
    expect(decryptString(sent.login.uris[0].uri, fake.userKey)).toBe(NEW.website);
    expect(decryptString(sent.login.uris[0].uriChecksum, fake.userKey)).toBe(
      toBase64(sha256(new TextEncoder().encode(NEW.website))),
    );

    const ref = created?.ref ?? "";
    expect((await source.list(connection)).map((i) => i.ref)).toContain(ref);
    expect(await source.reveal(connection, ref, "password")).toBe(NEW.password);
  });

  test("without a website or username, and for the exact origin", async () => {
    const { fake, source, connection } = await setup();
    await source.createLogin?.(connection, { title: "Bare", password: NEW.password });
    await source.createLogin?.(connection, { ...NEW, match: "exact" });
    const [bare, exact] = fake.callsTo("/ciphers").map((c) => JSON.parse(c.body ?? "{}"));
    expect(bare.login).toMatchObject({ username: null, uris: [] });
    expect(bare.notes).toBeNull();
    expect(exact.login.uris[0].match).toBe(1);
  });

  test("a login the server turns down is unsupported, the session kept, never the server's words", async () => {
    const { fake, source, connection } = await setup();
    await source.list(connection);
    fake.state.refuseNew = true;
    const refused = await sourceError(() => source.createLogin?.(connection, NEW) ?? Promise.resolve());
    expect(refused.code).toBe("unsupported");
    expect(refused.message).not.toContain(FAKE_BW.clientSecret);
    expect(fake.tokens()).toBe(2);
  });

  test("it never changes a login already there", () => {
    expect(createBitwardenSource().updateLogin).toBeUndefined();
  });
});

describe("Bitwarden key derivations", () => {
  test("one at a time per workspace, two at most across the process; a caller that gave up never starts", async () => {
    const queue = derivationQueue(2);
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const job = (name: string) => () => {
      started.push(name);
      return new Promise<string>((resolve) => finish.set(name, () => resolve(name)));
    };
    const a1 = queue("org-a", job("a1"));
    const a2 = queue("org-a", job("a2"));
    const b1 = queue("org-b", job("b1"));
    const c1 = queue("org-c", job("c1"));
    await Bun.sleep(5);
    // The workspace's second derivation waits on its first; another workspace's runs beside it; a third waits for
    // one of the two slots.
    expect(started).toEqual(["a1", "b1"]);
    finish.get("a1")?.();
    expect(await a1).toBe("a1");
    await Bun.sleep(5);
    expect(started).toEqual(["a1", "b1", "c1"]);
    finish.get("b1")?.();
    await b1;
    await Bun.sleep(5);
    expect(started).toEqual(["a1", "b1", "c1", "a2"]);

    // A caller that gives up before its turn comes: told at once, and its derivation never runs.
    const gone = new AbortController();
    const d1 = queue("org-d", job("d1"), gone.signal);
    gone.abort();
    expect((await sourceError(() => d1)).code).toBe("unreachable");
    finish.get("c1")?.();
    finish.get("a2")?.();
    expect(await Promise.all([c1, a2])).toEqual(["c1", "a2"]);
    await Bun.sleep(5);
    expect(started).not.toContain("d1");
    // The slots are free again.
    const e1 = queue("org-e", job("e1"));
    await Bun.sleep(5);
    finish.get("e1")?.();
    expect(await e1).toBe("e1");
  });
});
