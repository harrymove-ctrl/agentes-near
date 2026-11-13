import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { importVaultCsv, listVault } from "../src";
import { csvLayout, parseVaultCsv } from "../src/vault/csv";
import { everythingStored, storedValue, type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * Importing a passwords export (ADR 0144): Chrome, 1Password, Bitwarden or any CSV with a website and a password;
 * HTTPS logins only; the same login again is a duplicate or an update; nothing of the file is kept but the sealed
 * logins.
 */

describe("reading CSV", () => {
  test("quotes, doubled quotes, commas and line breaks inside, CRLF, a byte order mark, blank lines", () => {
    const text = '﻿name,url,note\r\n"Acme, Inc","https://acme.example","said ""hi""\nthen left"\r\n\r\nplain,x,\n';
    expect(parseVaultCsv(text)).toEqual([
      ["name", "url", "note"],
      ["Acme, Inc", "https://acme.example", 'said "hi"\nthen left'],
      ["plain", "x", ""],
    ]);
    expect(parseVaultCsv("a,b")).toEqual([["a", "b"]]);
    expect(parseVaultCsv('"",x\n')).toEqual([["", "x"]]);
    expect(() => parseVaultCsv('a,"open\n')).toThrow();
  });

  test("with a cap, it stops at that many rows and never reads the rest", () => {
    expect(parseVaultCsv("h\n1\n2\n3\n4", 3)).toEqual([["h"], ["1"], ["2"]]);
    // What comes after the cap isn't parsed: an unclosed quote there fails nothing.
    expect(parseVaultCsv('h\n1\n2\n"open', 3)).toEqual([["h"], ["1"], ["2"]]);
    // Blank lines don't count; a file under the cap reads whole.
    expect(parseVaultCsv("h\n\n1\n\n", 3)).toEqual([["h"], ["1"]]);
  });

  test("which export a header is", () => {
    expect(csvLayout(["name", "url", "username", "password", "note"])?.format).toBe("chrome");
    expect(
      csvLayout(["Title", "Url", "Username", "Password", "OTPAuth", "Favorite", "Archived", "Tags", "Notes"])?.format,
    ).toBe("1password");
    expect(
      csvLayout([
        "folder",
        "favorite",
        "type",
        "name",
        "notes",
        "fields",
        "reprompt",
        "login_uri",
        "login_username",
        "login_password",
        "login_totp",
      ])?.format,
    ).toBe("bitwarden");
    expect(csvLayout(["Account", "Website", "Email", "Password"])).toMatchObject({
      format: "generic",
      title: 0,
      url: 1,
      username: 2,
      password: 3,
    });
    expect(csvLayout(["first", "last", "phone"])).toBeNull();
  });
});

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const CHROME = [
  "name,url,username,password,note",
  "GitHub,https://github.com/login,ana-acme,gh-Secret-111,recovery codes: 1111-2222",
  "Old site,http://legacy.example.com,ana,legacy-pw-222,",
  "App,android://com.example.app,ana,app-pw-333,",
  "No password,https://nopass.example.com,ana,,",
  "Broken,,ana,broken-pw-444,",
  "GitHub again,https://github.com/,ana-acme,gh-Other-555,",
  "Shop,https://shop.example.com,,shop-pw-666,",
].join("\n");

const logins = async (userId: string) =>
  (await listVault(v.deps, userId, v.f.org.id)).items.filter((i) => i.kind === "login");

describe("importing", () => {
  test("a dry run counts and writes nothing; the import writes only HTTPS logins with a password", async () => {
    v = await vaultSetup();
    const dry = await importVaultCsv(v.deps, v.ana.id, v.f.org.id, { csv: CHROME, scope: "personal", dryRun: true });
    expect(dry).toEqual({
      added: 2,
      updated: 0,
      skipped: [
        { reason: "duplicate", count: 1 },
        { reason: "not_https", count: 2 },
        { reason: "no_password", count: 1 },
        { reason: "invalid", count: 1 },
      ],
      format: "chrome",
    });
    expect(await v.f.db.select().from(schema.vaultItems)).toEqual([]);

    expect(
      await importVaultCsv(v.deps, v.ana.id, v.f.org.id, { csv: CHROME, scope: "personal", dryRun: false }),
    ).toEqual(dry);
    const saved = await logins(v.ana.id);
    expect(saved.map((i) => [i.title, i.website, i.username, i.scope]).sort()).toEqual([
      ["GitHub", "https://github.com", "ana-acme", "personal"],
      ["Shop", "https://shop.example.com", null, "personal"],
    ]);
    // Notes never come in: agents read descriptions.
    expect(saved.every((i) => i.description === "")).toBe(true);
    const github = saved.find((i) => i.title === "GitHub");
    expect(await storedValue(v, github?.id ?? "")).toBe("gh-Secret-111");
    const stored = await everythingStored(v);
    for (const secret of ["gh-Secret-111", "shop-pw-666", "1111-2222"]) expect(stored).not.toContain(secret);
    const [audit] = await v.f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "vault.imported"));
    expect(audit?.details).toMatchObject({ format: "chrome", scope: "personal", added: 2, updated: 0 });
  });

  test("again: the same password is a duplicate, another one replaces it; other people's logins are another scope", async () => {
    v = await vaultSetup();
    await importVaultCsv(v.deps, v.ana.id, v.f.org.id, { csv: CHROME, scope: "personal", dryRun: false });
    const again = [
      "name,url,username,password",
      "GitHub,https://github.com,ana-acme,gh-Secret-111",
      "Shop,https://shop.example.com,,shop-NEW-777",
    ].join("\r\n");
    expect(
      await importVaultCsv(v.deps, v.ana.id, v.f.org.id, { csv: again, scope: "personal", dryRun: false }),
    ).toMatchObject({
      added: 0,
      updated: 1,
      skipped: [{ reason: "duplicate", count: 1 }],
    });
    const shop = (await logins(v.ana.id)).find((i) => i.title === "Shop");
    expect(await storedValue(v, shop?.id ?? "")).toBe("shop-NEW-777");
    const [row] = await v.f.db
      .select()
      .from(schema.vaultItems)
      .where(eq(schema.vaultItems.id, shop?.id ?? ""));
    expect(row?.secretVersion).toBe(2);
    // Bruno's import of the same file is his own.
    expect(
      await importVaultCsv(v.deps, v.bruno.id, v.f.org.id, { csv: again, scope: "personal", dryRun: true }),
    ).toMatchObject({
      added: 2,
      updated: 0,
    });
  });

  test("1Password, Bitwarden (logins only) and a generic file into the team, by who manages credentials", async () => {
    v = await vaultSetup();
    const onePassword = [
      "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
      'Deploy,https://deploy.acme.example,ops,"op,pw""1",,false,false,,',
    ].join("\n");
    const bitwarden = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      'Agents,,login,Registry,,,0,"androidapp://x,https://registry.acme.example",bot,bw-pw-1,',
      "Agents,,note,A note,secret note text,,0,,,,",
      "Agents,,card,Card,,,0,,,,",
    ].join("\n");
    const generic = ["Account,Website,Email,Password", "Mail,mail.acme.example,ops@acme.example,mail-pw-1"].join("\n");

    await expect(
      importVaultCsv(v.deps, v.bruno.id, v.f.org.id, { csv: onePassword, scope: "team", dryRun: true }),
    ).rejects.toMatchObject({ code: "vault.team_needs_permission" });
    expect(
      await importVaultCsv(v.deps, v.carla.id, v.f.org.id, { csv: onePassword, scope: "team", dryRun: false }),
    ).toMatchObject({
      format: "1password",
      added: 1,
    });
    expect(
      await importVaultCsv(v.deps, v.carla.id, v.f.org.id, { csv: bitwarden, scope: "team", dryRun: false }),
    ).toMatchObject({
      format: "bitwarden",
      added: 1,
      skipped: [],
    });
    expect(
      await importVaultCsv(v.deps, v.carla.id, v.f.org.id, { csv: generic, scope: "team", dryRun: false }),
    ).toMatchObject({
      format: "generic",
      added: 1,
    });
    const team = await logins(v.dora.id);
    expect(team.map((i) => [i.title, i.website, i.username]).sort()).toEqual([
      ["Deploy", "https://deploy.acme.example", "ops"],
      ["Mail", "https://mail.acme.example", "ops@acme.example"],
      ["Registry", "https://registry.acme.example", "bot"],
    ]);
    // Team imports get the default team access: everyone, no agent yet.
    expect(team.every((i) => i.access.everyone && !i.access.allAgents && i.access.agentIds.length === 0)).toBe(true);
    const deploy = team.find((i) => i.title === "Deploy");
    expect(await storedValue(v, deploy?.id ?? "")).toBe('op,pw"1');
  });

  test("files it refuses: no website and password columns, too many rows, too large", async () => {
    v = await vaultSetup();
    const run = (csv: string) => importVaultCsv(v.deps, v.ana.id, v.f.org.id, { csv, scope: "personal", dryRun: true });
    await expect(run("first,last,phone\nAna,Silva,123")).rejects.toMatchObject({ code: "vault.csv_unrecognized" });
    await expect(run("")).rejects.toMatchObject({ code: "vault.csv_unrecognized" });
    const many = ["url,password", ...Array.from({ length: 5001 }, (_, i) => `https://s${i}.example.com,p${i}`)].join(
      "\n",
    );
    await expect(run(many)).rejects.toMatchObject({ code: "vault.csv_too_many_rows" });
    await expect(run(`url,password\n${"x".repeat(2 * 1024 * 1024)}`)).rejects.toMatchObject({
      code: "vault.csv_too_large",
    });
    expect(
      await v.f.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, v.f.org.id), eq(schema.auditLog.action, "vault.imported"))),
    ).toEqual([]);
  });
});
