import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  type ExecVault,
  PASSWORD_CLASSES,
  PASSWORD_LENGTH,
  type PasswordClass,
  type PasswordRules,
  SITE_SECRET_TTL_MS,
  VAULT_EXEC_KEYS,
  type VaultTypeRefusal,
} from "@agenteschat/adapters/machine-protocol";
import {
  generateSecretKeyPair,
  isReservedSecretName,
  madePasswordAad,
  openSecret,
  parseSecretBox,
  redactSecrets,
  SECRET_NAME,
  type SecretBox,
  sealSecret,
  type VaultUse,
  vaultAad,
} from "@agenteschat/adapters/secret-box";
import { parseVaultRule, type VaultOriginRule } from "@agenteschat/adapters/vault/site";
import { RunnerError } from "./errors";

/**
 * What the Vault leaves on a computer (ADR 0144), all of it in this process's memory, never on disk, never in a
 * log, an argument list or an error:
 *
 * - One-use keys (`vault.key`): the server seals a login's password or a key's value to one, for one agent and one
 *   use (`vaultAad`). A key opens for two minutes and goes at its first use, whether the box opens or not; an agent
 *   holds 16 at most (the oldest goes first).
 * - Site secrets: a password or code a person gave through `request_secret` for one site, kept for its browser for
 *   15 minutes after it was activated (`SITE_SECRET_TTL_MS`, which the server counts too; before, they stayed in
 *   `store.json`; `secrets.ts` removes those).
 * - Armed values: every value opened here, redacted from what leaves the computer (command output, browser
 *   answers, errors) for 10 minutes after its last use.
 *
 * In system mode all of it lives in the agent's worker, as the agent's own user: root relays sealed boxes only.
 */

export const VAULT_KEY_TTL_MS = 2 * 60_000;
export const VAULT_KEYS_PER_AGENT = 16;
/** The protocol's, so the server counts a site's password gone when this process drops it (ADR 0144 §6). */
export { SITE_SECRET_TTL_MS };
export const ARMED_TTL_MS = 10 * 60_000;
/** After a password is typed, how long its browser stops any request that carries it in its address. */
export const GET_GUARD_MS = 2 * 60_000;

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const KEY_EXPIRED =
  "The key this Vault value was sealed to is gone from the computer (it expired or was already used). Try again.";
const BOX_MISMATCH =
  "This Vault value doesn't open on this computer: it was sealed for another agent, use or key. Nothing was used.";

/** A refusal the agent reads (`VAULT_TYPE_REFUSALS`); never the value. */
export class VaultRefusal extends Error {
  constructor(
    readonly code: VaultTypeRefusal,
    message: string,
  ) {
    super(message);
    this.name = "VaultRefusal";
  }
}

interface HeldKey {
  agentId: string;
  privateKey: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** A site's password or code from `request_secret`, for the browser only. `value: null`: root handed it on. */
export interface SiteSecret {
  name: string;
  /** Its origin (`https://host`). */
  site: string;
  value: string | null;
  size: number;
  requestId: string;
  order: string;
  expiresAt: number;
}

interface Armed {
  name: string;
  value: string;
  until: number;
}

const unref = (t: ReturnType<typeof setTimeout>) => {
  (t as { unref?: () => void }).unref?.();
  return t;
};

export class RunnerVault {
  private readonly keys = new Map<string, HeldKey>();
  /** By the agent's secrets folder (`secrets.ts`): the same agent under two homes never mixes. */
  private readonly sites = new Map<string, SiteSecret[]>();
  /** By agent id (or a browser profile's session key). */
  private readonly armed = new Map<string, Armed[]>();

  constructor(private readonly now: () => number = Date.now) {}

  // ── Keys ───────────────────────────────────────────────────────────────────

  /** `vault.key`: a fresh pair for `agentId`; only the public half leaves. */
  async issueKey(agentId: string): Promise<{ keyId: string; publicKey: string; expiresAt: string }> {
    if (!agentId) throw new RunnerError("bad_request", "A Vault key belongs to an agent");
    const pair = await generateSecretKeyPair();
    this.sweepKeys();
    // Oldest first (insertion order): the 17th key pushes the first out.
    const mine = [...this.keys.entries()].filter(([, k]) => k.agentId === agentId);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - (VAULT_KEYS_PER_AGENT - 1)))) this.dropKey(id);
    const keyId = randomUUID();
    const expiresAt = this.now() + VAULT_KEY_TTL_MS;
    const held: HeldKey = { agentId, privateKey: pair.privateKey, expiresAt };
    held.timer = unref(setTimeout(() => this.keys.get(keyId) === held && this.keys.delete(keyId), VAULT_KEY_TTL_MS));
    this.keys.set(keyId, held);
    return { keyId, publicKey: pair.publicKey, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * The key's private half, taken: whatever comes of the opening, it never opens anything again. Null when it is
   * gone or expired. Another agent's key stays where it is (that agent may still use it) and opens nothing here.
   */
  takeKey(agentId: string, keyId: string): string | null {
    const held = this.keys.get(keyId);
    if (!held || held.agentId !== agentId) return null;
    this.dropKey(keyId);
    return held.expiresAt > this.now() ? held.privateKey : null;
  }

  /** Live keys of an agent (tests and the 16 cap). */
  keyCount(agentId: string): number {
    this.sweepKeys();
    return [...this.keys.values()].filter((k) => k.agentId === agentId).length;
  }

  private dropKey(keyId: string) {
    const held = this.keys.get(keyId);
    if (held?.timer) clearTimeout(held.timer);
    this.keys.delete(keyId);
  }

  private sweepKeys() {
    const now = this.now();
    for (const [id, k] of this.keys) if (k.expiresAt <= now) this.dropKey(id);
  }

  // ── Site secrets ───────────────────────────────────────────────────────────

  /** Keeps a site secret for 15 minutes, in place of one of the same name. */
  putSite(store: string, entry: Omit<SiteSecret, "expiresAt" | "size"> & { value: string }) {
    const kept = this.sitesOf(store).filter((s) => s.name !== entry.name);
    kept.push({ ...entry, size: Buffer.byteLength(entry.value), expiresAt: this.now() + SITE_SECRET_TTL_MS });
    this.sites.set(store, kept);
  }

  /** The live site secrets of one agent's folder (values included, `null` once handed on). */
  sitesOf(store: string): SiteSecret[] {
    const now = this.now();
    const live = (this.sites.get(store) ?? []).filter((s) => s.expiresAt > now);
    if (live.length === 0) this.sites.delete(store);
    else this.sites.set(store, live);
    return live;
  }

  site(store: string, name: string): SiteSecret | null {
    return this.sitesOf(store).find((s) => s.name === name && s.value !== null) ?? null;
  }

  siteByRequest(store: string, requestId: string): SiteSecret | null {
    return this.sitesOf(store).find((s) => s.requestId === requestId) ?? null;
  }

  dropSites(store: string, pick: (s: SiteSecret) => boolean) {
    const kept = this.sitesOf(store).filter((s) => !pick(s));
    if (kept.length === 0) this.sites.delete(store);
    else this.sites.set(store, kept);
  }

  /** Root handed it to the agent's worker: root keeps only that it did (a lost reply's retry). */
  handOff(store: string, requestId: string) {
    for (const s of this.sitesOf(store)) if (s.requestId === requestId) s.value = null;
  }

  // ── Redaction ──────────────────────────────────────────────────────────────

  /** `value` is redacted from what this agent's work sends out for 10 minutes from now. */
  arm(agentId: string, name: string, value: string) {
    if (!agentId || value.length === 0) return;
    const kept = this.liveArmed(agentId).filter((a) => a.value !== value);
    this.armed.set(agentId, [...kept, { name, value, until: this.now() + ARMED_TTL_MS }]);
  }

  armedOf(agentId: string): { name: string; value: string }[] {
    return this.liveArmed(agentId).map(({ name, value }) => ({ name, value }));
  }

  private liveArmed(agentId: string): Armed[] {
    const now = this.now();
    const live = (this.armed.get(agentId) ?? []).filter((a) => a.until > now);
    if (live.length === 0) this.armed.delete(agentId);
    else this.armed.set(agentId, live);
    return live;
  }

  /** Redacts what `agentIds` armed (none: the text as it is). */
  redactor(...agentIds: string[]): ((text: string) => string) | null {
    const values = agentIds.flatMap((id) => (id ? this.armedOf(id) : []));
    return values.length > 0 ? (text: string) => redactSecrets(text, values) : null;
  }
}

/** This process's Vault (the daemon's, or a worker's in system mode). */
export const runnerVault = new RunnerVault();

/**
 * What one request opened (ADR 0144): each key taken once, at its first use; each value kept until the request
 * ends (`close`), so a second field typed with the same box (a password and its confirmation) doesn't need the key
 * again. Every value opened is armed for redaction.
 */
export class VaultOpening {
  private readonly keys = new Map<string, string | null>();
  private readonly values = new Map<string, string>();

  constructor(
    private readonly vault: RunnerVault,
    private readonly agentId: string,
    /** Where else what it opens is redacted (a browser profile's session). */
    private readonly alsoArm: string[] = [],
  ) {}

  async open(keyId: string, box: SecretBox, use: VaultUse, label: string): Promise<string> {
    const purpose = use.kind === "fill" ? `fill:${use.rule}` : `env:${use.name}`;
    const id = `${keyId}|${purpose}|${box.epk}|${box.iv}|${box.ct}`;
    const known = this.values.get(id);
    if (known !== undefined) return known;
    if (!this.keys.has(keyId)) this.keys.set(keyId, this.vault.takeKey(this.agentId, keyId));
    const privateKey = this.keys.get(keyId);
    if (!privateKey) throw new VaultRefusal("key_expired", KEY_EXPIRED);
    let value: string;
    try {
      value = await openSecret(privateKey, box, vaultAad({ keyId, agentId: this.agentId, use }));
    } catch {
      // A box that doesn't open spends its key for this request too.
      this.keys.set(keyId, null);
      throw new RunnerError("bad_request", BOX_MISMATCH);
    }
    this.values.set(id, value);
    for (const agent of [this.agentId, ...this.alsoArm]) this.vault.arm(agent, label, value);
    return value;
  }

  /** The request ended: nothing it opened is reachable from here anymore (a string can't be wiped in place). */
  close() {
    this.keys.clear();
    this.values.clear();
  }
}

// ── Passwords the agent makes ──────────────────────────────────────────────

/** No look-alikes (l, 1, O, 0), and only symbols sites commonly take. */
const PASSWORD_CHARS: Record<PasswordClass, string> = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%*-_=+?",
};

const pick = (chars: string) => chars[randomInt(chars.length)] as string;

/** `length` characters from the OS's random source: at least one of each class, in no order of class. */
export function makePassword({ length, classes }: PasswordRules): string {
  const sets = classes.map((c) => PASSWORD_CHARS[c]);
  const all = sets.join("");
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}

/** The request's rules, checked whole: the server's are the agent's own words. */
function passwordRulesOf(raw: unknown): PasswordRules {
  const bad = (why: string) => new RunnerError("bad_request", `A password's rules: ${why}`);
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PasswordRules>;
  const { length, classes } = r;
  if (
    !Number.isInteger(length) ||
    (length as number) < PASSWORD_LENGTH.min ||
    (length as number) > PASSWORD_LENGTH.max
  ) {
    throw bad(`length goes from ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max}`);
  }
  if (!Array.isArray(classes) || classes.length === 0 || !classes.every((c) => PASSWORD_CLASSES.includes(c))) {
    throw bad(`classes are some of ${PASSWORD_CLASSES.join(", ")}`);
  }
  return { length: length as number, classes: [...new Set(classes)] };
}

/** `vault.password`: a new password, out of this process only as a box for the key the request brought. */
export async function sealMadePassword(
  req: { requestId: string; publicKey: string; rules: unknown },
  agentId: unknown,
): Promise<SecretBox> {
  if (typeof agentId !== "string" || !agentId) throw new RunnerError("bad_request", "A password belongs to an agent");
  if (!KEY_ID.test(req.requestId)) throw new RunnerError("bad_request", "A password needs its request's id");
  const value = makePassword(passwordRulesOf(req.rules));
  return sealSecret(req.publicKey, value, madePasswordAad({ requestId: req.requestId, agentId }));
}

// ── Commands: keys for one `exec` ──────────────────────────────────────────

/** `exec`'s `vault`, checked whole before anything opens: the key, and each name once, none reserved. */
export function parseExecVault(raw: unknown): { keyId: string; keys: { name: string; box: SecretBox }[] } {
  const bad = (why: string) => new RunnerError("bad_request", `Vault keys for this command: ${why}`);
  if (typeof raw !== "object" || raw === null) throw bad("expected { keyId, keys }");
  const v = raw as Partial<ExecVault>;
  if (typeof v.keyId !== "string" || !KEY_ID.test(v.keyId)) throw bad("keyId must be the id vault.key answered");
  if (!Array.isArray(v.keys) || v.keys.length === 0 || v.keys.length > VAULT_EXEC_KEYS) {
    throw bad(`between 1 and ${VAULT_EXEC_KEYS} keys`);
  }
  const seen = new Set<string>();
  const keys = v.keys.map((k) => {
    const name = typeof k?.name === "string" ? k.name : "";
    if (!SECRET_NAME.test(name)) throw bad(`${name.slice(0, 64) || "a key"} isn't a variable name (UPPER_SNAKE)`);
    if (isReservedSecretName(name)) throw bad(`${name} is a name a key can't have`);
    if (seen.has(name)) throw bad(`${name} is there twice`);
    seen.add(name);
    const box = parseSecretBox(k?.box);
    if (!box) throw bad(`${name}'s sealed value is malformed`);
    return { name, box };
  });
  return { keyId: v.keyId, keys };
}

/** Opens a command's keys with its agent's one-use key; each value goes into that command's environment only. */
export async function openExecKeys(
  vault: RunnerVault,
  agentId: string,
  parsed: ReturnType<typeof parseExecVault>,
): Promise<{ name: string; value: string }[]> {
  const opening = new VaultOpening(vault, agentId);
  try {
    const out: { name: string; value: string }[] = [];
    for (const k of parsed.keys) {
      const value = await opening.open(parsed.keyId, k.box, { kind: "env", name: k.name }, k.name);
      out.push({ name: k.name, value });
    }
    return out;
  } catch (err) {
    if (err instanceof VaultRefusal) throw new RunnerError("not_found", err.message);
    throw err;
  } finally {
    opening.close();
  }
}

// ── The browser: typing a login ──────────────────────────────────────────────

/** `agentes:type_vault [ref, rule, boxJson]`, checked whole: malformed input is `bad_request` with the reason. */
export function parseTypeVault(args: unknown[]): {
  ref: string;
  rule: VaultOriginRule;
  ruleText: string;
  keyId: string;
  box: SecretBox;
} {
  const bad = (why: string) => new RunnerError("bad_request", `agentes:type_vault ${why}`);
  const [rawRef, rawRule, rawBox] = args;
  if (args.length !== 3) throw bad("takes a ref (@e3), the login's rule and its sealed box");
  const ref = typeof rawRef === "string" && /^@?e\d{1,6}$/.test(rawRef) ? `@${rawRef.replace(/^@/, "")}` : null;
  if (!ref) throw bad("needs a ref from the page's snapshot (@e3)");
  const ruleText = typeof rawRule === "string" ? rawRule : "";
  const rule = parseVaultRule(ruleText);
  if (!rule) throw bad("needs the login's rule (exact:https://host or site:domain)");
  let sealed: unknown;
  try {
    sealed = JSON.parse(typeof rawBox === "string" ? rawBox : "");
  } catch {
    throw bad("needs its sealed box as JSON ({ keyId, box })");
  }
  const s = typeof sealed === "object" && sealed !== null ? (sealed as Record<string, unknown>) : {};
  if (typeof s.keyId !== "string" || !KEY_ID.test(s.keyId)) throw bad("needs the id vault.key answered");
  const box = parseSecretBox(s.box);
  if (!box) throw bad("got a malformed sealed box");
  return { ref, rule, ruleText, keyId: s.keyId, box };
}

/** `agentes:type_secret`'s fields: one ref, or one per character of a code (protocol 45). */
export const MAX_CODE_FIELDS = 16;

export function parseSecretRefs(args: unknown[]): string[] | null {
  const refs = [args[0], ...args.slice(3)];
  if (refs.length > MAX_CODE_FIELDS) return null;
  const out: string[] = [];
  for (const r of refs) {
    if (typeof r !== "string" || !/^@?e\d{1,6}$/.test(r)) return null;
    out.push(`@${r.replace(/^@/, "")}`);
  }
  return new Set(out).size === out.length ? out : null;
}

/** What the page says about the focused field and the frame it is in (gathered by `vaultFieldScript`). */
export interface VaultFieldFacts {
  /** The focused element's tag (`INPUT`, `IFRAME`), null when nothing has focus. */
  tag: string | null;
  /** Its `type` (lowercase). */
  type: string;
  /** Its `autocomplete` attribute (lowercase). */
  autocomplete: string;
  /** Its form's `method` attribute (lowercase), "" without one. */
  formMethod: string;
  /** A submit control of its form (inside it or naming it) says `formmethod="get"`: that button sends by GET. */
  submitGet?: boolean;
  /** `location.origin` of the frame the field is in. */
  origin: string;
  /** `location.ancestorOrigins`, the parent's first. */
  ancestors: string[];
  /** `window === top`. */
  top: boolean;
}

/** Where a field may be (from the rule and the page's origin the runner read from the browser itself). */
export interface VaultFieldWant {
  /** `exact` rule: the one origin. */
  exact: string | null;
  /** `site` rule: the registrable domain. */
  domain: string | null;
  /** The page's own origin (`get url`): the top of the frame tree. */
  top: string;
  field: "password" | "code";
}

export type VaultFieldVerdict = "wrong_site" | "in_frame" | "not_password_field" | "not_code_field" | "get_form";

/**
 * Whether a field may get the value (null) or why not (ADR 0144). It runs in the page (`vaultFieldScript` sends its
 * source), where the page's own scripts run too and can patch any DOM method or accessor the script reads
 * (`activeElement`, a field's `type` and `form`, `getAttribute`). What they can't fake is `location` (its `origin`
 * and `ancestorOrigins`), `window` and `top`, which the platform makes unforgeable. So what this guarantees is where
 * the value goes: into a frame whose origin, and every origin around it, the rule allows, the outermost being the
 * page the runner checked. The field checks (a password field, no form or submit button that sends by GET) catch a
 * wrong field or a GET form on an honest page; a script of the rule's own site that lies about them could read the
 * field anyway. The verdict uses only operators, index reads and loops, so no patched built-in changes its answer.
 * The runner already matched the page's origin against the rule with the public suffix list; a frame is matched here
 * by its host under the rule's domain.
 */
export function vaultFieldVerdict(facts: VaultFieldFacts, want: VaultFieldWant): VaultFieldVerdict | null {
  const scheme = "https://";
  const hostOf = (origin: unknown): string | null => {
    if (typeof origin !== "string" || origin.length <= scheme.length) return null;
    for (let i = 0; i < scheme.length; i++) if (origin[i] !== scheme[i]) return null;
    let host = "";
    for (let j = scheme.length; j < origin.length; j++) {
      if (origin[j] === ":" || origin[j] === "/") break;
      host += origin[j];
    }
    return host.length > 0 ? host : null;
  };
  const allowed = (origin: unknown): boolean => {
    if (want.exact !== null) return origin === want.exact;
    const host = hostOf(origin);
    const domain = want.domain;
    if (host === null || domain === null) return false;
    if (host === domain) return true;
    const offset = host.length - domain.length;
    if (offset < 2 || host[offset - 1] !== ".") return false;
    for (let k = 0; k < domain.length; k++) if (host[offset + k] !== domain[k]) return false;
    return true;
  };
  if (!allowed(facts.origin)) return "wrong_site";
  if (facts.top === true) {
    if (facts.origin !== want.top) return "wrong_site";
  } else {
    const list = facts.ancestors;
    if (list.length === 0) return "wrong_site";
    for (let a = 0; a < list.length; a++) if (!allowed(list[a])) return "wrong_site";
    if (list[list.length - 1] !== want.top) return "wrong_site";
  }
  const tag = facts.tag;
  if (tag === "IFRAME" || tag === "FRAME") return "in_frame";
  const kind = want.field;
  if (tag !== "INPUT") return kind === "code" ? "not_code_field" : "not_password_field";
  const hasToken = (list: string, token: string): boolean => {
    let start = 0;
    for (let i = 0; i <= list.length; i++) {
      const c = i < list.length ? list[i] : " ";
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "\f") continue;
      if (i - start === token.length) {
        let same = true;
        for (let k = 0; k < token.length; k++) {
          if (list[start + k] !== token[k]) {
            same = false;
            break;
          }
        }
        if (same) return true;
      }
      start = i + 1;
    }
    return false;
  };
  const type = facts.type;
  const auto = facts.autocomplete;
  if (kind === "code") {
    const text = type === "text" || type === "tel" || type === "number";
    return text || hasToken(auto, "one-time-code") ? null : "not_code_field";
  }
  if (type !== "password" && !hasToken(auto, "current-password") && !hasToken(auto, "new-password")) {
    return "not_password_field";
  }
  return facts.formMethod === "get" || facts.submitGet === true ? "get_form" : null;
}

/** The marker a refusal is thrown with in the page, as `agent-browser` reports it back. */
export const FIELD_REFUSAL_MARK = "agentes-vault:";

/** The attribute the check puts on the field it let through, with a one-time value the fill then finds it by. */
export const FILL_MARK_ATTR = "data-agentes-fill";

/** A one-time mark for one field's fill: random, so no page can have an element that carries it beforehand. */
export const newFillMark = () => randomBytes(16).toString("hex");

/** The selector of the field the check marked (`fill` takes it instead of the ref, which it would look up again). */
export const fillMarkSelector = (mark: string) => `[${FILL_MARK_ATTR}="${mark}"]`;

/**
 * The check `agentes:type_vault` (and a code typed into several fields) runs between focusing the field and filling
 * it, in the same `agent-browser` invocation: it throws unless `vaultFieldVerdict` lets the focused field have the
 * value, so `--bail` stops before the fill. It answers the frame's origin. With `mark`, the field it let through
 * gets that one-time mark (`FILL_MARK_ATTR`) and the fill goes to that element only (`fillMarkSelector`): a page
 * that navigated, or a ref that now points elsewhere, has no element with it, and nothing is typed.
 */
export function vaultFieldScript(want: VaultFieldWant, mark?: string): string {
  return `(() => {
  const el = document.activeElement;
  const form = el && el.form ? el.form : null;
  const attr = (node, name) =>
    node && typeof node.getAttribute === "function" ? String(node.getAttribute(name) || "").trim().toLowerCase() : "";
  const list = location.ancestorOrigins;
  const ancestors = [];
  for (let i = 0; list && i < 32; i++) {
    const a = list[i];
    if (a === undefined || a === null) break;
    ancestors[ancestors.length] = String(a);
  }
  // A submit button of the form (inside it, or naming it with form=) can send it by GET on its own: formmethod.
  let submitGet = false;
  const controls = form ? form.elements : null;
  for (let i = 0; controls && i < 1024; i++) {
    const c = controls[i];
    if (c === undefined || c === null) break;
    const tag = String(c.tagName || "").toUpperCase();
    const kind = attr(c, "type");
    const submits = (tag === "BUTTON" && (kind === "" || kind === "submit")) || (tag === "INPUT" && (kind === "submit" || kind === "image"));
    if (submits && attr(c, "formmethod") === "get") {
      submitGet = true;
      break;
    }
  }
  const facts = {
    tag: el ? String(el.tagName || "").toUpperCase() : null,
    type: el && typeof el.type === "string" ? el.type.toLowerCase() : "",
    autocomplete: attr(el, "autocomplete"),
    formMethod: attr(form, "method"),
    submitGet: submitGet,
    origin: location.origin,
    ancestors: ancestors,
    top: window === top,
  };
  const refusal = (${vaultFieldVerdict.toString()})(facts, ${JSON.stringify(want)});
  if (refusal !== null) throw new Error(${JSON.stringify(FIELD_REFUSAL_MARK)} + refusal);
  const mark = ${JSON.stringify(mark ?? null)};
  if (mark !== null) el.setAttribute(${JSON.stringify(FILL_MARK_ATTR)}, mark);
  return facts.origin;
})()`;
}

/** Takes a fill's one-time mark off its field after the fill; it never fails (the field may be gone by then). */
export function fillUnmarkScript(mark: string): string {
  return `(() => {
  try {
    const el = document.querySelector(${JSON.stringify(fillMarkSelector(mark))});
    if (el) el.removeAttribute(${JSON.stringify(FILL_MARK_ATTR)});
  } catch (e) {}
  return true;
})()`;
}

/** The want for a rule, on a page whose origin the browser reported (`get url`). */
export function fieldWant(rule: VaultOriginRule, top: string, field: VaultFieldWant["field"]): VaultFieldWant {
  return {
    exact: rule.kind === "exact" ? rule.origin : null,
    domain: rule.kind === "site" ? rule.domain : null,
    top,
    field,
  };
}

/** The verdict a failed check reported (`agentes-vault:wrong_site`), or null for any other failure. */
export function fieldRefusalOf(error: string | undefined): VaultFieldVerdict | null {
  const m = /agentes-vault:(wrong_site|in_frame|not_password_field|not_code_field|get_form)\b/.exec(error ?? "");
  return m ? (m[1] as VaultFieldVerdict) : null;
}

// ── The GET guard ───────────────────────────────────────────────────────────

const formEncoded = (value: string) => new URLSearchParams([["v", value]]).toString().slice(2);

const decoded = (url: string): string | null => {
  try {
    return decodeURIComponent(url);
  } catch {
    return null;
  }
};

/**
 * Whether an address carries `value`: as it is, as `encodeURIComponent` writes it, form-encoded (`+` for spaces),
 * or escaped some other way (the address decoded). Values under 4 characters are left alone, as redaction leaves
 * them: they would stop ordinary pages.
 */
export function urlCarries(url: string, value: string): boolean {
  if (value.length < 4 || !url) return false;
  for (const form of [value, encodeURIComponent(value), formEncoded(value)]) if (url.includes(form)) return true;
  for (const text of [decoded(url), decoded(url.replace(/\+/g, " "))]) if (text?.includes(value)) return true;
  return false;
}

export const GET_BLOCKED = "The page tried to send the password in its address; I stopped it.";
/** The guard against that couldn't be armed (Chrome didn't confirm it in time): nothing is typed without it. */
export const UNGUARDED =
  "The browser couldn't confirm it would stop the password leaving in an address, so it wasn't typed. Try again.";
