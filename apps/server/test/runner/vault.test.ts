import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  SITE_SECRET_TTL_MS as PROTOCOL_SITE_SECRET_TTL_MS,
  parseServerFrame,
  VAULT_PASSWORD_PROTOCOL,
  VAULT_PROTOCOL,
  VAULT_TYPE_REFUSALS,
} from "@agenteschat/adapters/machine-protocol";
import {
  generateSecretKeyPair,
  madePasswordAad,
  openSecret,
  type SecretTarget,
  sealSecret,
  secretAad,
  vaultAad,
} from "@agenteschat/adapters/secret-box";
import { describeRequest, handleRequest, NEW_WORK_OPS, OP_ROUTES, type RequestScope } from "../../runner/handlers";
import { agentSecrets, dropStoredSiteSecrets, handleSecret, secretValue } from "../../runner/secrets";
import {
  ARMED_TTL_MS,
  FILL_MARK_ATTR,
  fieldRefusalOf,
  fillMarkSelector,
  fillUnmarkScript,
  makePassword,
  newFillMark,
  parseExecVault,
  parseTypeVault,
  RunnerVault,
  runnerVault,
  SITE_SECRET_TTL_MS,
  sealMadePassword,
  urlCarries,
  VAULT_KEY_TTL_MS,
  VAULT_KEYS_PER_AGENT,
  type VaultFieldFacts,
  type VaultFieldWant,
  VaultOpening,
  VaultRefusal,
  vaultFieldScript,
  vaultFieldVerdict,
} from "../../runner/vault";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });
/** Agents of these tests only: what they arm in this process's Vault never reaches another file's agents. */
const ana = { id: "7a7a7a7a-0135-7000-8000-000000000001", handle: "dev" };
const bia = { id: "7b7b7b7b-0135-7000-8000-000000000002", handle: "infra" };
const RULE = "exact:https://shop.example.com";

// ── Protocol ─────────────────────────────────────────────────────────────────

test("protocol 48 makes passwords: in the agent's process, sealed to the one call that asked", async () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(VAULT_PASSWORD_PROTOCOL);
  expect(VAULT_PASSWORD_PROTOCOL).toBe(48);
  expect(MACHINE_OPS).toContain("vault.password");
  expect(OP_ROUTES["vault.password"]).toBe("agent");
  const pair = await generateSecretKeyPair();
  const requestId = randomUUID();
  const rules = { length: 16, classes: ["lower", "digits"] };
  const box = await sealMadePassword({ requestId, publicKey: pair.publicKey, rules }, ana.id);
  const value = await openSecret(pair.privateKey, box, madePasswordAad({ requestId, agentId: ana.id }));
  expect(value).toMatch(/^[a-z0-9]{16}$/);
  // Bound to its request and its agent.
  await expect(openSecret(pair.privateKey, box, madePasswordAad({ requestId, agentId: bia.id }))).rejects.toThrow();
  const refused = (raw: unknown) => sealMadePassword({ requestId, publicKey: pair.publicKey, rules: raw }, ana.id);
  expect(await errorCode(() => refused({ length: 7, classes: ["lower"] }))).toBe("bad_request");
  expect(await errorCode(() => refused({ length: 20, classes: [] }))).toBe("bad_request");
  expect(await errorCode(() => refused({ length: 20, classes: ["emoji"] }))).toBe("bad_request");
});

test("a made password has its length, every class asked for, and no two alike", () => {
  const rules = { length: 12, classes: ["lower", "upper", "digits", "symbols"] as const };
  const made = Array.from({ length: 200 }, () => makePassword({ ...rules, classes: [...rules.classes] }));
  for (const p of made) {
    expect(p).toHaveLength(12);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/[2-9]/);
    expect(p).toMatch(/[!@#$%*\-_=+?]/);
  }
  expect(new Set(made).size).toBe(made.length);
  expect(makePassword({ length: 8, classes: ["digits"] })).toMatch(/^[2-9]{8}$/);
});

test("protocol 45 carries the Vault: vault.key is an op of the agent's own process and new work", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(VAULT_PROTOCOL);
  expect(VAULT_PROTOCOL).toBe(45);
  expect(MACHINE_OPS).toContain("vault.key");
  expect(OP_ROUTES["vault.key"]).toBe("agent");
  expect(NEW_WORK_OPS.has("vault.key")).toBe(true);
  expect(parseServerFrame(JSON.stringify({ type: "request", id: "1", op: "vault.key", agent: ana }))).toMatchObject({
    op: "vault.key",
  });
});

// ── Keys ─────────────────────────────────────────────────────────────────────

test("a key opens for two minutes, once, for its own agent only; an agent holds 16 at most", async () => {
  let now = 1_000_000;
  const vault = new RunnerVault(() => now);
  const a = await vault.issueKey(ana.id);
  expect(a.keyId).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.publicKey.length).toBeGreaterThan(40);
  expect(Date.parse(a.expiresAt)).toBe(now + VAULT_KEY_TTL_MS);
  // Another agent can't take it, and doesn't use it up either.
  expect(vault.takeKey(bia.id, a.keyId)).toBeNull();
  const priv = vault.takeKey(ana.id, a.keyId);
  expect(typeof priv).toBe("string");
  // Single use: gone at the first take.
  expect(vault.takeKey(ana.id, a.keyId)).toBeNull();
  // Expired: gone.
  const b = await vault.issueKey(ana.id);
  now += VAULT_KEY_TTL_MS;
  expect(vault.takeKey(ana.id, b.keyId)).toBeNull();
  // The 17th pushes the oldest out.
  const keys: string[] = [];
  for (let i = 0; i < VAULT_KEYS_PER_AGENT + 1; i++) keys.push((await vault.issueKey(ana.id)).keyId);
  expect(vault.keyCount(ana.id)).toBe(VAULT_KEYS_PER_AGENT);
  expect(vault.takeKey(ana.id, keys[0] as string)).toBeNull();
  expect(vault.takeKey(ana.id, keys[1] as string)).not.toBeNull();
  expect(await errorCode(() => vault.issueKey(""))).toBe("bad_request");
});

test("a box opens only with its key, agent and use; the key goes at the first try, whatever comes of it", async () => {
  const vault = new RunnerVault();
  const seal = async (agentId: string, rule: string, value: string) => {
    const k = await vault.issueKey(ana.id);
    const aad = vaultAad({ keyId: k.keyId, agentId, use: { kind: "fill", rule } });
    return { keyId: k.keyId, box: await sealSecret(k.publicKey, value, aad) };
  };
  const fill = { kind: "fill" as const, rule: RULE };
  // Sealed for another rule: doesn't open, and the key is gone after, for this request too.
  const other = await seal(ana.id, "exact:https://bank.example", "hunter2-other-site");
  const opening = new VaultOpening(vault, ana.id);
  expect(await errorCode(() => opening.open(other.keyId, other.box, fill, "X"))).toBe("bad_request");
  const again = await opening.open(other.keyId, other.box, fill, "X").catch((e) => e);
  expect(again).toBeInstanceOf(VaultRefusal);
  expect((again as VaultRefusal).code).toBe("key_expired");
  // Sealed for another agent: doesn't open either.
  const theirs = await seal(bia.id, RULE, "hunter2-their-agent");
  expect(await errorCode(() => new VaultOpening(vault, ana.id).open(theirs.keyId, theirs.box, fill, "X"))).toBe(
    "bad_request",
  );
  // The right one opens; within one request the same box opens again without the key (a confirmation field).
  const mine = await seal(ana.id, RULE, "hunter2-just-right");
  const one = new VaultOpening(vault, ana.id);
  expect(await one.open(mine.keyId, mine.box, fill, "VAULT_PASSWORD")).toBe("hunter2-just-right");
  expect(await one.open(mine.keyId, mine.box, fill, "VAULT_PASSWORD")).toBe("hunter2-just-right");
  one.close();
  // Opened is armed: redacted from the agent's output for a while.
  expect(vault.redactor(ana.id)?.("pw=hunter2-just-right")).toBe("pw=[secret:VAULT_PASSWORD]");
  // A new request has no key left.
  const two = await new VaultOpening(vault, ana.id).open(mine.keyId, mine.box, fill, "X").catch((e) => e);
  expect((two as VaultRefusal).code).toBe("key_expired");
});

test("armed values and site secrets live their time in memory, then go", () => {
  let now = 5_000_000;
  const vault = new RunnerVault(() => now);
  vault.arm(ana.id, "VAULT_PASSWORD", "hunter2-armed");
  expect(vault.armedOf(ana.id)).toEqual([{ name: "VAULT_PASSWORD", value: "hunter2-armed" }]);
  expect(vault.armedOf(bia.id)).toEqual([]);
  now += ARMED_TTL_MS;
  expect(vault.armedOf(ana.id)).toEqual([]);
  expect(vault.redactor(ana.id)).toBeNull();
  const shop = { name: "SHOP_PASSWORD", site: "https://shop.example.com" };
  vault.putSite("/store/a", { ...shop, value: "pw-1234", requestId: "r-00000001", order: "o1" });
  expect(vault.site("/store/a", "SHOP_PASSWORD")?.value).toBe("pw-1234");
  expect(vault.site("/store/b", "SHOP_PASSWORD")).toBeNull();
  // Root handed it on: only that it did stays.
  vault.handOff("/store/a", "r-00000001");
  expect(vault.site("/store/a", "SHOP_PASSWORD")).toBeNull();
  expect(vault.siteByRequest("/store/a", "r-00000001")).toMatchObject({ value: null, size: 7 });
  vault.putSite("/store/a", { ...shop, value: "pw-5678", requestId: "r-00000002", order: "o2" });
  now += SITE_SECRET_TTL_MS - 1;
  expect(vault.site("/store/a", "SHOP_PASSWORD")?.value).toBe("pw-5678");
  now += 1;
  expect(vault.sitesOf("/store/a")).toEqual([]);
  // The protocol's own minutes: the server counts a site's password gone when this drops it (ADR 0144 §6).
  expect(SITE_SECRET_TTL_MS).toBe(PROTOCOL_SITE_SECRET_TTL_MS);
  expect(SITE_SECRET_TTL_MS).toBe(15 * 60_000);
});

// ── Input ─────────────────────────────────────────────────────────────────────

test("malformed Vault input is refused with the reason, before anything opens", async () => {
  const k = await new RunnerVault().issueKey(ana.id);
  const box = await sealSecret(k.publicKey, "v4lue-here", "aad");
  const json = JSON.stringify({ keyId: k.keyId, box });
  expect(parseTypeVault(["e4", RULE, json])).toMatchObject({ ref: "@e4", ruleText: RULE, keyId: k.keyId });
  for (const args of [
    ["e4", RULE],
    ["#password", RULE, json],
    ["e4", "exact:http://shop.example.com", json],
    ["e4", "site:github.io", json],
    ["e4", RULE, "not json"],
    ["e4", RULE, JSON.stringify({ keyId: "k1", box })],
    ["e4", RULE, JSON.stringify({ keyId: k.keyId, box: { v: 9 } })],
  ]) {
    const err = await errorCode(() => parseTypeVault(args));
    expect(err).toBe("bad_request");
  }
  const ok = { keyId: k.keyId, keys: [{ name: "OPENAI_KEY_FOR_TESTS", box }] };
  // A name that steers an AI CLI is refused.
  expect(await errorCode(() => parseExecVault(ok))).toBe("bad_request");
  expect(parseExecVault({ keyId: k.keyId, keys: [{ name: "STRIPE_KEY", box }] }).keys[0]?.name).toBe("STRIPE_KEY");
  for (const raw of [
    null,
    { keyId: k.keyId, keys: [] },
    { keyId: k.keyId, keys: [{ name: "lower", box }] },
    {
      keyId: k.keyId,
      keys: [
        { name: "A_KEY", box },
        { name: "A_KEY", box },
      ],
    },
    { keyId: k.keyId, keys: [{ name: "A_KEY", box: {} }] },
    { keyId: k.keyId, keys: Array.from({ length: 11 }, (_, i) => ({ name: `K${i}`, box })) },
  ]) {
    expect(await errorCode(() => parseExecVault(raw))).toBe("bad_request");
  }
});

// ── The check in the page ─────────────────────────────────────────────────────

const facts = (over: Partial<VaultFieldFacts> = {}): VaultFieldFacts => ({
  tag: "INPUT",
  type: "password",
  autocomplete: "",
  formMethod: "post",
  origin: "https://shop.example.com",
  ancestors: [],
  top: true,
  ...over,
});
const SHOP = "https://shop.example.com";
const exact: VaultFieldWant = { exact: SHOP, domain: null, top: SHOP, field: "password" };
const site: VaultFieldWant = { exact: null, domain: "example.com", top: SHOP, field: "password" };

test("the field's verdict: its frame and every frame around it on the rule's sites, a password field, no GET form", () => {
  expect(vaultFieldVerdict(facts(), exact)).toBeNull();
  expect(vaultFieldVerdict(facts({ origin: "https://shop.example.com:8443" }), exact)).toBe("wrong_site");
  expect(vaultFieldVerdict(facts({ origin: "http://shop.example.com" }), exact)).toBe("wrong_site");
  // A site rule: the domain and its subdomains, never a look-alike.
  expect(vaultFieldVerdict(facts(), site)).toBeNull();
  for (const origin of ["https://evilexample.com", "https://example.com.evil.test", "http://example.com", "null", ""]) {
    expect(vaultFieldVerdict(facts({ origin, top: false, ancestors: ["https://shop.example.com"] }), site)).toBe(
      "wrong_site",
    );
  }
  // The top of the page must be the page the runner checked.
  expect(vaultFieldVerdict(facts({ origin: "https://example.com" }), site)).toBe("wrong_site");
  // In a frame: its origin, and each one around it, on the rule's sites, the outermost the page itself.
  const framed = { origin: "https://login.example.com", top: false };
  expect(vaultFieldVerdict(facts({ ...framed, ancestors: ["https://shop.example.com"] }), site)).toBeNull();
  expect(vaultFieldVerdict(facts({ ...framed, ancestors: ["https://ads.test", SHOP] }), site)).toBe("wrong_site");
  expect(vaultFieldVerdict(facts({ ...framed, ancestors: ["https://other.example.com"] }), site)).toBe("wrong_site");
  expect(vaultFieldVerdict(facts({ ...framed, ancestors: [] }), site)).toBe("wrong_site");
  // The field.
  expect(vaultFieldVerdict(facts({ tag: "IFRAME" }), exact)).toBe("in_frame");
  // Its own code on the wire, so the server tells the agent to hand the sign-in to a person.
  expect(VAULT_TYPE_REFUSALS).toContain("in_frame");
  expect(vaultFieldVerdict(facts({ tag: "TEXTAREA" }), exact)).toBe("not_password_field");
  expect(vaultFieldVerdict(facts({ tag: null }), exact)).toBe("not_password_field");
  expect(vaultFieldVerdict(facts({ type: "text" }), exact)).toBe("not_password_field");
  expect(vaultFieldVerdict(facts({ type: "text", autocomplete: "section-login current-password" }), exact)).toBeNull();
  expect(vaultFieldVerdict(facts({ type: "text", autocomplete: "new-password" }), exact)).toBeNull();
  expect(vaultFieldVerdict(facts({ type: "text", autocomplete: "current-passwords" }), exact)).toBe(
    "not_password_field",
  );
  expect(vaultFieldVerdict(facts({ formMethod: "get" }), exact)).toBe("get_form");
  expect(vaultFieldVerdict(facts({ formMethod: "" }), exact)).toBeNull();
  // A submit button of the form can send it by GET on its own (formmethod).
  expect(vaultFieldVerdict(facts({ formMethod: "post", submitGet: true }), exact)).toBe("get_form");
  expect(vaultFieldVerdict(facts({ formMethod: "", submitGet: false }), exact)).toBeNull();
  // A code's field: text, tel, number or one-time-code.
  const code: VaultFieldWant = { ...exact, field: "code" };
  for (const type of ["text", "tel", "number"]) expect(vaultFieldVerdict(facts({ type }), code)).toBeNull();
  expect(vaultFieldVerdict(facts({ type: "password" }), code)).toBe("not_code_field");
  expect(vaultFieldVerdict(facts({ type: "password", autocomplete: "one-time-code" }), code)).toBeNull();
  expect(vaultFieldVerdict(facts({ type: "email" }), code)).toBe("not_code_field");
});

/** The script as a page runs it: its globals, nothing else. */
function runInPage(
  script: string,
  page: { active: Record<string, unknown> | null; origin: string; ancestors?: string[] },
): unknown {
  const win = {};
  const ancestors = page.ancestors ?? [];
  const run = new Function("document", "location", "window", "top", `return ${script}`);
  const location = { origin: page.origin, ancestorOrigins: ancestors };
  return run({ activeElement: page.active }, location, win, ancestors.length ? {} : win);
}

const input = (type: string, attrs: Record<string, string> = {}, method?: string) => ({
  tagName: "INPUT",
  type,
  getAttribute: (n: string) => attrs[n] ?? null,
  form: method === undefined ? null : { getAttribute: (n: string) => (n === "method" ? method : null) },
});

test("the script the page runs answers the frame's origin, or throws the verdict before the fill", () => {
  const script = vaultFieldScript(exact);
  // Nothing of the value in it: the rule and the page's origin only.
  expect(script).toContain('"exact":"https://shop.example.com"');
  expect(runInPage(script, { active: input("password"), origin: "https://shop.example.com" })).toBe(
    "https://shop.example.com",
  );
  const thrown = (page: Parameters<typeof runInPage>[1]) => {
    try {
      runInPage(script, page);
      return null;
    } catch (err) {
      return fieldRefusalOf(err instanceof Error ? err.message : String(err));
    }
  };
  expect(thrown({ active: input("password"), origin: "https://bank.example" })).toBe("wrong_site");
  expect(thrown({ active: input("text", { autocomplete: "Username" }), origin: "https://shop.example.com" })).toBe(
    "not_password_field",
  );
  expect(thrown({ active: input("text", { autocomplete: "  Current-Password " }), origin: SHOP })).toBeNull();
  expect(thrown({ active: input("password", {}, " GET "), origin: "https://shop.example.com" })).toBe("get_form");
  expect(thrown({ active: { tagName: "iframe" }, origin: "https://shop.example.com" })).toBe("in_frame");
  expect(thrown({ active: null, origin: "https://shop.example.com" })).toBe("not_password_field");
  expect(
    thrown({ active: input("password"), origin: "https://shop.example.com", ancestors: ["https://ads.test"] }),
  ).toBe("wrong_site");
  expect(fieldRefusalOf("Evaluation failed: Error: agentes-vault:get_form")).toBe("get_form");
  expect(fieldRefusalOf("Element not found")).toBeNull();
});

test("a form a submit button sends by GET is refused; one with no method (a script signs in) isn't", () => {
  const script = vaultFieldScript(exact);
  const button = (formmethod: string | null, type: string | null = null, tagName = "BUTTON") => ({
    tagName,
    getAttribute: (n: string) => (n === "formmethod" ? formmethod : n === "type" ? type : null),
  });
  const field = (controls: unknown[], method: string | null = null) => ({
    ...input("password"),
    form: { getAttribute: (n: string) => (n === "method" ? method : null), elements: controls },
  });
  const verdict = (active: unknown) => {
    try {
      runInPage(script, { active: active as Record<string, unknown>, origin: SHOP });
      return null;
    } catch (err) {
      return fieldRefusalOf(err instanceof Error ? err.message : String(err));
    }
  };
  expect(verdict(field([]))).toBeNull();
  expect(verdict(field([button(null)]))).toBeNull();
  expect(verdict(field([button(" GET ")]))).toBe("get_form");
  expect(verdict(field([button("get", "submit")]))).toBe("get_form");
  expect(verdict(field([button("get", "image", "INPUT")]))).toBe("get_form");
  expect(verdict(field([button("post", "submit"), button("get", "submit", "INPUT")], "post"))).toBe("get_form");
  // Not a submit control: its formmethod does nothing.
  expect(verdict(field([button("get", "button")]))).toBeNull();
  expect(verdict(field([button("get", "text", "INPUT")]))).toBeNull();
});

test("the field the check lets through gets a one-time mark the fill finds it by, taken off after", () => {
  const mark = newFillMark();
  expect(mark).toMatch(/^[0-9a-f]{32}$/);
  expect(newFillMark()).not.toBe(mark);
  expect(fillMarkSelector(mark)).toBe(`[${FILL_MARK_ATTR}="${mark}"]`);
  const attrs: Record<string, string> = {};
  const field = {
    ...input("password"),
    setAttribute: (n: string, v: string) => {
      attrs[n] = v;
    },
  };
  expect(runInPage(vaultFieldScript(exact, mark), { active: field, origin: SHOP })).toBe(SHOP);
  expect(attrs).toEqual({ [FILL_MARK_ATTR]: mark });
  // A refused field is never marked.
  const other: Record<string, string> = {};
  const text = {
    ...input("text"),
    setAttribute: (n: string, v: string) => {
      other[n] = v;
    },
  };
  expect(() => runInPage(vaultFieldScript(exact, newFillMark()), { active: text, origin: SHOP })).toThrow();
  expect(other).toEqual({});
  // Taking it off never throws, whether the field is there or the page moved on.
  const removed: string[] = [];
  const unmark = (found: unknown) =>
    new Function("document", `return ${fillUnmarkScript(mark)}`)({ querySelector: () => found });
  expect(unmark({ removeAttribute: (n: string) => removed.push(n) })).toBe(true);
  expect(removed).toEqual([FILL_MARK_ATTR]);
  expect(unmark(null)).toBe(true);
  expect(
    new Function("document", `return ${fillUnmarkScript(mark)}`)({
      querySelector: () => {
        throw new Error("Execution context was destroyed");
      },
    }),
  ).toBe(true);
});

// ── The GET guard ─────────────────────────────────────────────────────────────

test("an address carries a value raw, encoded or form-encoded; short values are left alone", () => {
  const value = "p@ss word/+1&x";
  expect(urlCarries(`https://a.example/?p=${value}`, value)).toBe(true);
  expect(urlCarries(`https://a.example/?p=${encodeURIComponent(value)}`, value)).toBe(true);
  expect(urlCarries(`https://a.example/?${new URLSearchParams({ p: value })}`, value)).toBe(true);
  expect(urlCarries(`https://a.example/?p=${encodeURIComponent(value).toLowerCase()}`, value)).toBe(true);
  expect(urlCarries("https://a.example/login?next=/home", value)).toBe(false);
  expect(urlCarries("https://a.example/?pin=123", "123")).toBe(false);
  expect(urlCarries("https://a.example/%E0%A4%A", "hunter2")).toBe(false);
});

// ── Site secrets in memory ───────────────────────────────────────────────────

/** A site's password delivered as the server does: keypair, sealed to the site, staged, activated. */
async function giveSite(secretsDir: string, ws: string, agent: typeof ana, requestId: string, value: string) {
  const target: SecretTarget = { kind: "site", site: "https://shop.example.com" };
  const { publicKey } = await handleSecret(secretsDir, agent, ws, { action: "keypair", requestId });
  const aad = secretAad({ requestId, orgId: "org-1", name: "SHOP_PASSWORD", target });
  const box = await sealSecret(publicKey ?? "", value, aad);
  await handleSecret(secretsDir, agent, ws, { action: "deliver", requestId, name: "SHOP_PASSWORD", target, aad, box });
  const order = `2026-11-03T12:00:00.000Z|${requestId}`;
  return handleSecret(secretsDir, agent, ws, { action: "activate", requestId, order });
}

test("a site's password from request_secret stays in memory, never in store.json, and is typed and redacted from there", async () => {
  const home = tempDir("vault-home-");
  const ws = tempDir("vault-ws-");
  dirs.push(home, ws);
  const secretsDir = path.join(home, "secrets");
  const value = "hunter2-in-memory-only";
  expect(await giveSite(secretsDir, ws, ana, "req-mem-0001", value)).toEqual({ size: value.length });
  const folder = path.join(secretsDir, "7a7a7a7a");
  const store = path.join(folder, "store.json");
  expect(existsSync(store) ? readFileSync(store, "utf8") : "").not.toContain(value);
  // Nothing on disk holds it: the key and the staged box are gone, the order is only an order.
  expect(existsSync(path.join(folder, "keys", "req-mem-0001"))).toBe(false);
  expect(existsSync(path.join(folder, "staged", "req-mem-0001"))).toBe(false);
  expect(await secretValue(secretsDir, ana, "SHOP_PASSWORD")).toEqual({ value, site: "https://shop.example.com" });
  const s = await agentSecrets(secretsDir, ana);
  expect(s?.env.SHOP_PASSWORD).toBeUndefined();
  expect(s?.redact(`pw=${value}`)).toBe("pw=[secret:SHOP_PASSWORD]");
  // A lost activation reply asked again: answered from memory.
  expect(
    await handleSecret(secretsDir, ana, ws, {
      action: "activate",
      requestId: "req-mem-0001",
      order: "2026-11-03T12:00:00.000Z|req-mem-0001",
    }),
  ).toEqual({ size: value.length });
  // Removing it forgets it in memory too.
  const throughOrder = "2026-11-03T12:00:00.000Z|req-mem-0001";
  await handleSecret(secretsDir, ana, ws, { action: "remove", name: "SHOP_PASSWORD", throughOrder });
  expect(await secretValue(secretsDir, ana, "SHOP_PASSWORD")).toBeNull();
});

test("a site's password an older runner left in store.json is never used and is removed at load", async () => {
  const home = tempDir("vault-home-");
  dirs.push(home);
  const secretsDir = path.join(home, "secrets");
  const folder = path.join(secretsDir, "7b7b7b7b");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const store = path.join(folder, "store.json");
  const old = {
    secrets: [
      { name: "OLD_SITE_PW", target: { kind: "site", site: SHOP }, value: "left-on-disk-1", deliveredAt: "x" },
      { name: "GITHUB_TOKEN", target: { kind: "env" }, value: "ghp_kept_on_disk_123", deliveredAt: "x" },
    ],
  };
  writeFileSync(store, JSON.stringify(old), { mode: 0o600 });
  // Read before the rewrite: skipped already.
  expect(await secretValue(secretsDir, bia, "OLD_SITE_PW")).toBeNull();
  await dropStoredSiteSecrets(secretsDir);
  // The rewrite waits its turn in the folder's queue: an action through it runs after.
  await handleSecret(secretsDir, bia, home, { action: "discard", requestId: "req-none-0001" });
  const kept = readFileSync(store, "utf8");
  expect(kept).not.toContain("left-on-disk-1");
  expect(kept).not.toContain("OLD_SITE_PW");
  expect(JSON.parse(kept).secrets).toEqual([old.secrets[1]]);
  expect((await agentSecrets(secretsDir, bia))?.env.GITHUB_TOKEN).toBe("ghp_kept_on_disk_123");
});

// ── Keys for one command ─────────────────────────────────────────────────────

const posix = process.platform !== "win32";

async function sealKeys(agent: typeof ana, keys: Record<string, string>, as: Record<string, string> = {}) {
  const ctx = { workspaceReal: tempDir("vault-ws-"), exec: true, token: "agm_x" };
  dirs.push(ctx.workspaceReal);
  const { vaultKey } = (await handleRequest(ctx, { agent, op: "vault.key" }, scope())) as {
    vaultKey: { keyId: string; publicKey: string; expiresAt: string };
  };
  const sealed = await Promise.all(
    Object.entries(keys).map(async ([name, value]) => ({
      name,
      box: await sealSecret(
        vaultKey.publicKey,
        value,
        vaultAad({ keyId: vaultKey.keyId, agentId: agent.id, use: { kind: "env", name: as[name] ?? name } }),
      ),
    })),
  );
  return { ctx, vault: { keyId: vaultKey.keyId, keys: sealed } };
}

test.if(posix)("keys reach one command's environment, never its output, and the key opens once", async () => {
  const stripe = "sk_test_vault_0123456789";
  const db = "postgres://u:vaultpw@db.example/x";
  const { ctx, vault } = await sealKeys(ana, { STRIPE_KEY: stripe, DATABASE_URL: db });
  const exec = (command: string, v: unknown = vault): MachineRequest =>
    ({ agent: ana, op: "exec", command, timeoutSeconds: 10, stream: false, vault: v }) as MachineRequest;
  expect(describeRequest(exec("echo hi"))).toBe("[dev] exec echo hi (2 Vault keys)");
  const ran = (await handleRequest(
    ctx,
    exec(`test "$STRIPE_KEY" = "${stripe}" && echo matches; echo "key=$STRIPE_KEY"; echo "$DATABASE_URL" >&2`),
    scope(),
  )) as { stdout: string; stderr: string };
  expect(ran.stdout).toBe("matches\nkey=[secret:STRIPE_KEY]\n");
  expect(ran.stderr).toBe("[secret:DATABASE_URL]\n");
  // The same key again: gone.
  expect(await errorCode(() => handleRequest(ctx, exec("true"), scope()))).toBe("not_found");
  // The next command without keys doesn't have them, and what it prints of them is still redacted (armed).
  const after = (await handleRequest(
    ctx,
    { agent: ana, op: "exec", command: `echo "[$STRIPE_KEY]"; echo ${stripe}`, timeoutSeconds: 10, stream: false },
    scope(),
  )) as { stdout: string };
  expect(after.stdout).toBe("[]\n[secret:STRIPE_KEY]\n");
});

test.if(posix)("a key sealed for another name or agent doesn't open; tasks never take keys", async () => {
  const other = await sealKeys(ana, { STRIPE_KEY: "sk_test_vault_wrong_name" }, { STRIPE_KEY: "OTHER_KEY" });
  const exec = (agent: typeof ana, vault: unknown): MachineRequest =>
    ({ agent, op: "exec", command: "true", timeoutSeconds: 10, stream: false, vault }) as MachineRequest;
  expect(await errorCode(() => handleRequest(other.ctx, exec(ana, other.vault), scope()))).toBe("bad_request");
  const forAna = await sealKeys(ana, { STRIPE_KEY: "sk_test_vault_for_ana" });
  expect(await errorCode(() => handleRequest(forAna.ctx, exec(bia, forAna.vault), scope()))).toBe("not_found");
  const task = {
    agent: ana,
    op: "task.start",
    taskId: "0d0d0d0d-0000-7000-8000-000000000001",
    executor: "shell",
    command: "true",
    vault: forAna.vault,
  } as unknown as MachineRequest;
  const tasks = { start: () => Promise.resolve({}) };
  expect(await errorCode(() => handleRequest({ ...forAna.ctx, tasks: tasks as never }, task, scope()))).toBe(
    "bad_request",
  );
});

test.if(posix)("output is redacted before a long output is cut, so no half of a value survives the cut", async () => {
  const value = "sk_test_long_output_value_42";
  const { ctx, vault } = await sealKeys(ana, { LONG_KEY: value });
  // Cut raw, the kept head (1 MiB) would end 14 characters into the value and the kept tail start 6 before its end.
  const command = [
    "head -c 1048562 /dev/zero | tr '\\0' a",
    'printf "$LONG_KEY"',
    "head -c 1048570 /dev/zero | tr '\\0' b",
  ].join("; ");
  const ran = (await handleRequest(
    ctx,
    { agent: ana, op: "exec", command, timeoutSeconds: 30, stream: false, vault } as MachineRequest,
    scope(),
  )) as { stdout: string };
  expect(ran.stdout).not.toContain(value.slice(0, 14));
  expect(ran.stdout).not.toContain(value.slice(22));
  expect(ran.stdout).toContain("[secret:LONG_KEY]");
});

test("an error's text leaves redacted like an answer", async () => {
  const value = "hunter2-in-an-error";
  runnerVault.arm(bia.id, "VAULT_PASSWORD", value);
  const ws = tempDir("vault-ws-");
  dirs.push(ws);
  const ctx = { workspaceReal: ws, exec: true, token: "agm_x" };
  const err = await handleRequest(
    ctx,
    { agent: bia, op: "exec", command: "true", cwd: value, timeoutSeconds: 5, stream: false },
    scope(),
  ).catch((e: Error & { code?: string }) => e);
  expect((err as { code?: string }).code).toBe("not_found");
  expect((err as Error).message).toContain("[secret:VAULT_PASSWORD]");
  expect((err as Error).message).not.toContain(value);
});
