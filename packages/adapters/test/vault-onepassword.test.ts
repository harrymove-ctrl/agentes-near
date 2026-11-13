import { describe, expect, test } from "bun:test";
import {
  createOnePasswordSource,
  keyNameFromTitle,
  type OnePasswordSdk,
  type OnePasswordSourceOptions,
} from "../src/vault/onepassword";
import { type VaultConnection, VaultSourceError } from "../src/vault/source";
import { createFakeOnePassword, FAKE_OP_TOKEN, type FakeOpItem } from "./fixtures/vault-fakes";

const SECRETS = {
  admin: "fake-op-pass-admin-1Qx",
  mail: "fake-op-pass-mail-2Wy",
  archived: "fake-op-pass-archived-3Ez",
  openai: "fake-op-key-openai-4Rk",
  stripe: "fake-op-key-stripe-5Tj",
};

const ID = {
  admin: "loginadmin00000000000000001",
  mail: "loginmail000000000000000002",
  openai: "keyopenai000000000000000003",
  stripe: "keystripe000000000000000004",
  note: "securenote00000000000000005",
  archived: "loginold0000000000000000006",
};

const ITEMS: FakeOpItem[] = [
  {
    id: ID.admin,
    title: "Acme admin",
    category: "Login",
    username: "ana@acme.example",
    password: SECRETS.admin,
    websites: [
      { url: "https://admin.acme.example/login?next=/home", autofillBehavior: "AnywhereOnWebsite" },
      { url: "billing.acme.example", autofillBehavior: "ExactDomain" },
      { url: "https://never.acme.example", autofillBehavior: "Never" },
      { url: "http://old.acme.example", autofillBehavior: "ExactDomain" },
      { url: "https://admin.acme.example/other", autofillBehavior: "AnywhereOnWebsite" },
    ],
  },
  { id: ID.mail, title: "Mail", category: "Login", username: "agents@acme.example", password: SECRETS.mail },
  { id: ID.openai, title: "OPENAI_API_KEY", category: "ApiCredentials", credential: SECRETS.openai },
  { id: ID.stripe, title: "Stripe secret key", category: "ApiCredentials", credential: SECRETS.stripe },
  { id: ID.note, title: "Recovery codes", category: "SecureNote" },
  { id: ID.archived, title: "Old login", category: "Login", password: SECRETS.archived, state: "archived" },
];

const NOW = Date.parse("2026-11-03T12:00:00Z");

async function sourceError(run: () => Promise<unknown>): Promise<VaultSourceError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof VaultSourceError) return err;
    throw err;
  }
  throw new Error("expected a VaultSourceError");
}

/** A fake SDK, a source on it, and a connection made through `connect` (as the engine stores it). */
async function setup(options: Partial<OnePasswordSourceOptions> = {}, items: FakeOpItem[] = ITEMS) {
  const fake = createFakeOnePassword({ items });
  let loads = 0;
  let clock = NOW;
  const source = createOnePasswordSource({
    loadSdk: async () => {
      loads += 1;
      return fake.sdk;
    },
    now: () => clock,
    timeoutMs: 500,
    ...options,
  });
  const result = await source.connect({ token: FAKE_OP_TOKEN });
  const connection: VaultConnection = {
    id: "op-connection-1",
    orgId: "org-1",
    config: result.config,
    secret: result.secret,
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { fake, source, result, connection, loads: () => loads, advance };
}

describe("1Password source: connect", () => {
  test("describes its connect card", () => {
    const d = createOnePasswordSource().describe();
    expect(d.kind).toBe("onepassword");
    expect(d.name).toBe("1Password");
    expect(d.kinds).toEqual(["login", "key"]);
    expect(d.steps).toEqual([
      "Create a vault in 1Password only for your agents and move into it the logins they may use",
      "Create a service account with access to that vault only (read and write, if your agents should save new logins there)",
      "Paste the service account token here",
    ]);
    expect(d.fields).toHaveLength(1);
    expect(d.fields[0]).toMatchObject({ id: "token", kind: "secret", required: true });
    expect(d.helpUrl).toBe("https://developer.1password.com/docs/service-accounts/get-started/");
  });

  test("a service account that sees one vault connects to it", async () => {
    const { fake, result } = await setup();
    expect(result).toEqual({
      label: "Agents",
      config: { vaultId: "vaultagents0000000000000001", vaultName: "Agents" },
      secret: { token: FAKE_OP_TOKEN },
    });
    expect(fake.calls.createClient).toEqual([{ integrationName: "agentes.chat", integrationVersion: "v1.0.0" }]);
    expect(fake.calls.vaultsList).toEqual([{ decryptDetails: true }]);
  });

  test("no vault, or more than one, is refused", async () => {
    const fake = createFakeOnePassword({ vaults: [] });
    const source = createOnePasswordSource({ loadSdk: async () => fake.sdk });
    expect((await sourceError(() => source.connect({ token: FAKE_OP_TOKEN }))).code).toBe("no_vault");
    fake.state.vaults = [
      { id: "vaultone000000000000000001", title: "Agents" },
      { id: "vaulttwo000000000000000002", title: "Private" },
    ];
    expect((await sourceError(() => source.connect({ token: FAKE_OP_TOKEN }))).code).toBe("many_vaults");
  });

  test("a token that isn't one is refused before the SDK loads", async () => {
    let loads = 0;
    const fake = createFakeOnePassword();
    const source = createOnePasswordSource({
      loadSdk: async () => {
        loads += 1;
        return fake.sdk;
      },
    });
    for (const token of ["", "not a token", "ops_short", `sk-${"a".repeat(40)}`]) {
      expect((await sourceError(() => source.connect({ token }))).code).toBe("invalid_input");
    }
    expect(loads).toBe(0);
  });

  test("a token 1Password refuses is auth_failed, and the error never carries it", async () => {
    const fake = createFakeOnePassword();
    const source = createOnePasswordSource({ loadSdk: async () => fake.sdk });
    const other = `ops_${"Z".repeat(40)}`;
    const err = await sourceError(() => source.connect({ token: other }));
    expect(err.code).toBe("auth_failed");
    expect(`${err.message} ${err.stack ?? ""}`).not.toContain(other);
  });

  test("a token the SDK can't use, in its own words, is auth_failed, never unreachable", async () => {
    // The SDK's messages (0.5.0) for a revoked, mangled or orphaned token: trying again with it can't work.
    for (const said of [
      "bad service account token, please rotate it: ",
      "service account token base64 decoding failed, please create another token",
      "service account deserialization failed, please create another token",
      "secret key was the wrong length",
      "account couldn't be found",
    ]) {
      const sdk: OnePasswordSdk = {
        createClient: async () => {
          throw new Error(`${said} (${FAKE_OP_TOKEN})`);
        },
      };
      const source = createOnePasswordSource({ loadSdk: async () => sdk });
      const err = await sourceError(() => source.connect({ token: FAKE_OP_TOKEN }));
      expect({ said, code: err.code }).toEqual({ said, code: "auth_failed" });
      expect(err.message).not.toContain(FAKE_OP_TOKEN);
    }
  });

  test("a token as 1Password issues it (ops_, then ~900 base64url characters), pasted with spaces", async () => {
    const details = { signInAddress: "my.1password.example", srpX: "0".repeat(64), padding: "fake ".repeat(120) };
    const token = `ops_${Buffer.from(JSON.stringify(details)).toString("base64url")}`;
    expect(token.length).toBeGreaterThan(800);
    const fake = createFakeOnePassword({ token });
    const source = createOnePasswordSource({ loadSdk: async () => fake.sdk });
    expect((await source.connect({ token: ` ${token}\n` })).secret).toEqual({ token });
  });

  test("an SDK that can't load is unsupported, and is tried again next time", async () => {
    let loads = 0;
    const fake = createFakeOnePassword();
    const source = createOnePasswordSource({
      loadSdk: async () => {
        loads += 1;
        if (loads === 1) throw new Error("wasm failed to load");
        return fake.sdk;
      },
    });
    expect((await sourceError(() => source.connect({ token: FAKE_OP_TOKEN }))).code).toBe("unsupported");
    expect((await source.connect({ token: FAKE_OP_TOKEN })).label).toBe("Agents");
    expect(loads).toBe(2);
  });

  test("an SDK call that throws at once is mapped like one that rejects", async () => {
    const sdk: OnePasswordSdk = {
      createClient() {
        throw new Error(`boom with ${FAKE_OP_TOKEN}`);
      },
    };
    const source = createOnePasswordSource({ loadSdk: async () => sdk });
    const err = await sourceError(() => source.connect({ token: FAKE_OP_TOKEN }));
    expect(err.code).toBe("unreachable");
    expect(err.message).not.toContain(FAKE_OP_TOKEN);
  });
});

describe("1Password source: list", () => {
  test("logins and API credentials, metadata only", async () => {
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
          { url: "https://billing.acme.example", match: "exact" },
        ],
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
      {
        ref: ID.mail,
        kind: "login",
        title: "Mail",
        username: "agents@acme.example",
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
      {
        ref: ID.openai,
        kind: "key",
        title: "OPENAI_API_KEY",
        keyName: "OPENAI_API_KEY",
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
      {
        ref: ID.stripe,
        kind: "key",
        title: "Stripe secret key",
        keyName: "STRIPE_SECRET_KEY",
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    ]);
    const listed = JSON.stringify(items);
    for (const secret of [...Object.values(SECRETS), FAKE_OP_TOKEN]) expect(listed).not.toContain(secret);
  });

  test("full items are read only when new or changed, with one client per connection", async () => {
    const { fake, source, connection, advance } = await setup();
    await source.list(connection);
    // Only logins need a full read (for the username); keys and notes don't.
    expect(fake.calls.getAll).toEqual([[ID.admin, ID.mail]]);
    expect(fake.calls.get).toEqual([]);

    await source.list(connection);
    expect(fake.calls.getAll).toHaveLength(1);

    const mail = fake.state.items.find((i) => i.id === ID.mail);
    if (!mail) throw new Error("fixture");
    mail.updatedAt = "2026-11-02T09:00:00.000Z";
    mail.username = "robots@acme.example";
    const items = await source.list(connection);
    expect(fake.calls.getAll).toEqual([[ID.admin, ID.mail], [ID.mail]]);
    expect(items.find((i) => i.ref === ID.mail)?.username).toBe("robots@acme.example");

    // connect made one client; the lists share another until it is 10 minutes old.
    expect(fake.calls.createClient).toHaveLength(2);
    advance(10 * 60_000 + 1);
    await source.list(connection);
    expect(fake.calls.createClient).toHaveLength(3);
    expect(fake.calls.getAll).toHaveLength(2);
  });

  test("an item deleted between the overview and the read is left out", async () => {
    const { fake, source, connection } = await setup();
    const realCreate = fake.sdk.createClient;
    fake.sdk.createClient = async (config) => {
      const client = await realCreate(config);
      return {
        ...client,
        items: {
          ...client.items,
          getAll: async (vaultId, ids) => {
            const answer = await client.items.getAll(vaultId, ids);
            return {
              individualResponses: answer.individualResponses.map((r) =>
                r.content?.id === ID.mail ? { error: { type: "itemNotFound" } } : r,
              ),
            };
          },
        },
      };
    };
    const refs = (await source.list(connection)).map((i) => i.ref);
    expect(refs).toEqual([ID.admin, ID.openai, ID.stripe]);
  });

  test("rate limits, expired sessions and other SDK failures map to codes, never to the SDK's text", async () => {
    const { fake, source, connection } = await setup();
    const { RateLimitExceededError, AuthExpiredError } = fake;
    await source.list(connection);

    fake.state.failOn = "items.list";
    fake.state.failWith = () => new RateLimitExceededError(`limit for ${FAKE_OP_TOKEN}`);
    const limited = await sourceError(() => source.list(connection));
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAt).toBe(new Date(NOW + 10 * 60_000).toISOString());

    // A kept client that stops working is replaced once, then the failure stands.
    const clientsBefore = fake.calls.createClient.length;
    fake.state.failWith = () => new AuthExpiredError(`expired ${FAKE_OP_TOKEN}`);
    expect((await sourceError(() => source.list(connection))).code).toBe("auth_failed");
    expect(fake.calls.createClient.length).toBe(clientsBefore + 1);

    const said: [string, string][] = [
      [`request failed: 429 Too Many Requests (${FAKE_OP_TOKEN})`, "rate_limited"],
      [`Unauthorized: service account ${FAKE_OP_TOKEN} was deleted`, "auth_failed"],
      [`vault not found for ${FAKE_OP_TOKEN}`, "no_vault"],
      [`error sending request for ${FAKE_OP_TOKEN}`, "unreachable"],
      // The SDK's own words (0.5.0).
      ["vault couldn't be found", "no_vault"],
      ["bad service account token, please rotate it: ", "auth_failed"],
    ];
    for (const [text, code] of said) {
      fake.state.failWith = () => new Error(text);
      const err = await sourceError(() => source.list(connection));
      expect(err.code).toBe(code as VaultSourceError["code"]);
      expect(`${err.message} ${err.retryAt ?? ""} ${err.stack ?? ""}`).not.toContain(FAKE_OP_TOKEN);
    }

    fake.state.failOn = null;
    expect(await source.list(connection)).toHaveLength(4);
  });

  test("a call that never answers times out", async () => {
    const { fake, source, connection } = await setup({ timeoutMs: 20 });
    fake.state.hang = true;
    const err = await sourceError(() => source.list(connection));
    expect(err.code).toBe("unreachable");
    expect(err.message).toBe("1Password took too long to answer.");
  });
});

describe("1Password source: reveal", () => {
  test("a login's password and a key's credential, read now", async () => {
    const { fake, source, connection } = await setup();
    expect(await source.reveal(connection, ID.admin, "password")).toBe(SECRETS.admin);
    expect(await source.reveal(connection, ID.openai, "key")).toBe(SECRETS.openai);
    expect(fake.calls.get).toEqual([ID.admin, ID.openai]);
  });

  test("a missing item or field is not_found, never with the SDK's text", async () => {
    const { fake, source, connection } = await setup();
    expect((await sourceError(() => source.reveal(connection, ID.admin, "key"))).code).toBe("not_found");
    expect((await sourceError(() => source.reveal(connection, ID.openai, "password"))).code).toBe("not_found");
    expect((await sourceError(() => source.reveal(connection, ID.note, "password"))).code).toBe("not_found");
    const gone = await sourceError(() => source.reveal(connection, "doesnotexist00000000000099", "password"));
    expect(gone.code).toBe("not_found");
    expect(gone.message).not.toContain(FAKE_OP_TOKEN);
    const calls = fake.calls.get.length;
    expect((await sourceError(() => source.reveal(connection, "../items", "password"))).code).toBe("not_found");
    expect(fake.calls.get.length).toBe(calls);
    // Deleted in 1Password since the last sync, in the SDK's own words (0.5.0).
    fake.state.failOn = "items.get";
    fake.state.failWith = () => new Error("item couldn't be found");
    expect((await sourceError(() => source.reveal(connection, ID.admin, "password"))).code).toBe("not_found");
  });
});

describe("1Password source: writing", () => {
  const NEW = {
    title: "shop.acme.example",
    username: "agent@acme.example",
    password: "fake-op-new-password-6Uv",
    website: "https://shop.acme.example",
    match: "site" as const,
    notes: "Made by an agent",
  };

  test("a new login is created as the SDK's Login item, and comes back without its password", async () => {
    const { fake, source, connection } = await setup();
    const created = await source.createLogin?.(connection, NEW);
    expect(fake.calls.create).toEqual([
      {
        category: "Login",
        vaultId: connection.config.vaultId ?? "",
        title: NEW.title,
        fields: [
          { id: "username", title: "username", fieldType: "Text", value: NEW.username },
          { id: "password", title: "password", fieldType: "Concealed", value: NEW.password },
        ],
        websites: [{ url: NEW.website, label: "website", autofillBehavior: "AnywhereOnWebsite" }],
        notes: NEW.notes,
      },
    ]);
    expect(created).toMatchObject({
      kind: "login",
      title: NEW.title,
      username: NEW.username,
      websites: [{ url: NEW.website, match: "site" }],
    });
    expect(JSON.stringify(created)).not.toContain(NEW.password);
    const ref = created?.ref ?? "";
    expect((await source.list(connection)).map((i) => i.ref)).toContain(ref);
    expect(await source.reveal(connection, ref, "password")).toBe(NEW.password);
  });

  test("the exact origin, and a login with no username or website", async () => {
    const { fake, source, connection } = await setup();
    await source.createLogin?.(connection, { ...NEW, match: "exact" });
    await source.createLogin?.(connection, { title: "Bare", password: NEW.password });
    expect(fake.calls.create[0]?.websites?.[0]?.autofillBehavior).toBe("ExactDomain");
    expect(fake.calls.create[1]).toEqual({
      category: "Login",
      vaultId: connection.config.vaultId ?? "",
      title: "Bare",
      fields: [{ id: "password", title: "password", fieldType: "Concealed", value: NEW.password }],
    });
  });

  test("a change puts the item back as it was read, with only that field changed", async () => {
    const { fake, source, connection } = await setup();
    const changed = await source.updateLogin?.(connection, ID.admin, { password: NEW.password });
    expect(changed).toMatchObject({ ref: ID.admin, kind: "login", username: "ana@acme.example" });
    expect(JSON.stringify(changed)).not.toContain(NEW.password);
    const [put] = fake.calls.put;
    const before = await fake.sdk.createClient({ auth: FAKE_OP_TOKEN, integrationName: "t", integrationVersion: "t" });
    const now = await before.items.get(connection.config.vaultId ?? "", ID.admin);
    expect(put?.id).toBe(ID.admin);
    expect(put?.title).toBe("Acme admin");
    expect(put?.websites).toEqual(now.websites);
    // Every field it had is still there (the notes too), in place.
    expect(put?.fields.map((f) => [f.id, f.id === "password" ? NEW.password : f.value])).toEqual(
      now.fields.map((f) => [f.id, f.value]),
    );
    expect(await source.reveal(connection, ID.admin, "password")).toBe(NEW.password);

    await source.updateLogin?.(connection, ID.admin, { username: "bruno@acme.example" });
    expect(fake.calls.put[1]?.fields.find((f) => f.id === "username")?.value).toBe("bruno@acme.example");
    expect(fake.calls.put[1]?.fields.find((f) => f.id === "password")?.value).toBe(NEW.password);
    // Nothing to change: nothing is sent.
    await source.updateLogin?.(connection, ID.admin, {});
    expect(fake.calls.put).toHaveLength(2);
  });

  test("only a login of this vault changes", async () => {
    const { fake, source, connection } = await setup();
    const change = { password: NEW.password };
    expect(
      (await sourceError(() => source.updateLogin?.(connection, ID.openai, change) ?? Promise.resolve())).code,
    ).toBe("invalid_input");
    const missing = await sourceError(
      () => source.updateLogin?.(connection, "doesnotexist00000000000099", change) ?? Promise.resolve(),
    );
    expect(missing.code).toBe("not_found");
    expect((await sourceError(() => source.updateLogin?.(connection, "../x", change) ?? Promise.resolve())).code).toBe(
      "not_found",
    );
    expect(fake.calls.put).toHaveLength(0);
  });

  test("a service account that only reads is read_only at the write, in our words, and still reads", async () => {
    const { fake, source, connection } = await setup();
    fake.state.readOnly = true;
    const create = await sourceError(() => source.createLogin?.(connection, NEW) ?? Promise.resolve());
    const update = await sourceError(
      () => source.updateLogin?.(connection, ID.admin, { password: NEW.password }) ?? Promise.resolve(),
    );
    for (const refused of [create, update]) {
      expect(refused.code).toBe("read_only");
      expect(refused.message).not.toContain(FAKE_OP_TOKEN);
      expect(refused.message).not.toContain(NEW.password);
    }
    // 1Password's documented words for it, and a bare status.
    fake.state.readOnly = false;
    fake.state.failOn = "items.create";
    for (const said of ["You don't have the right permissions to execute this argument", "403 Forbidden"]) {
      fake.state.failWith = () => new Error(said);
      expect((await sourceError(() => source.createLogin?.(connection, NEW) ?? Promise.resolve())).code).toBe(
        "read_only",
      );
    }
    fake.state.failOn = null;
    expect(await source.reveal(connection, ID.admin, "password")).toBe(SECRETS.admin);
  });
});

describe("key names from titles", () => {
  test("a variable name stays; anything else is upper-snaked", () => {
    expect(keyNameFromTitle("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
    expect(keyNameFromTitle("Stripe secret key")).toBe("STRIPE_SECRET_KEY");
    expect(keyNameFromTitle("OpenAI API key")).toBe("OPENAI_API_KEY");
    expect(keyNameFromTitle("  chave de produção  ")).toBe("CHAVE_DE_PRODUCAO");
    expect(keyNameFromTitle("2fa backup")).toBe("KEY_2FA_BACKUP");
    expect(keyNameFromTitle("🔑")).toBeUndefined();
    expect(keyNameFromTitle("x".repeat(100))).toHaveLength(64);
  });
});
