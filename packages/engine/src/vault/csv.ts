/**
 * Importing a password manager's export (ADR 0144): a CSV from Chrome, 1Password, Bitwarden, or any file with a
 * website and a password column. Only HTTPS logins come in, as built-in items of the scope the person chose. The
 * file is read once and kept nowhere: its rows live only in this call, notes included (they never become a
 * description, which agents read, since notes often hold recovery codes).
 *
 * The same login twice (same scope, website and username): the same password is skipped as a duplicate, another one
 * replaces the saved password. Within one file the first row wins.
 */
import { MAX_SECRET_BYTES, vaultOrigin } from "@agenteschat/adapters";
import { and, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ConflictError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import { cleanAccess, type ItemRow } from "./access";
import { assertRoom, cleanScope, teamNeedsPermission, vaultViewer } from "./items";
import { openItemValue, type SealedItemColumns, sealItemValue } from "./seal";
import {
  VAULT_LIMITS,
  type VaultCsvFormat,
  type VaultDeps,
  type VaultImportResult,
  type VaultImportSkip,
  type VaultScope,
  vaultNow,
} from "./service";

const { vaultItems, vaultUses } = schema;

const unrecognized = () =>
  new ValidationError(
    "This file isn't a passwords export we can read. Export a CSV from your password manager.",
    "vault.csv_unrecognized",
  );

/**
 * RFC 4180: fields split by commas, quoted fields with commas, line breaks and doubled quotes inside, CRLF or LF
 * between rows, a byte order mark at the start. Blank lines are left out. It stops once it holds `maxRows` rows (the
 * header counts), so a file over the import's cap is never parsed whole (ADR 0144): the caller sees one row too many.
 */
export function parseVaultCsv(text: string, maxRows = Number.POSITIVE_INFINITY): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    field = "";
    started = false;
  };
  for (let i = 0; i < src.length && rows.length < maxRows; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"' && !started) {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = false;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (rows.length >= maxRows) return rows.slice(0, maxRows);
  if (quoted) throw unrecognized();
  if (started || field !== "" || row.length > 0) endRow();
  return rows;
}

/** Where each column a login needs is, in one recognized format. */
export interface VaultCsvLayout {
  format: VaultCsvFormat;
  title: number;
  url: number;
  username: number;
  password: number;
  /** Bitwarden: only rows whose `type` is `login` are logins. */
  type: number;
}

const firstOf = (headers: string[], names: string[]) => {
  for (const name of names) {
    const at = headers.indexOf(name);
    if (at >= 0) return at;
  }
  return -1;
};

/** Which export a header row is, or null. */
export function csvLayout(header: string[]): VaultCsvLayout | null {
  const h = header.map((cell) => cell.trim().toLowerCase());
  const at = (name: string) => h.indexOf(name);
  if (at("login_uri") >= 0 && at("login_password") >= 0) {
    return {
      format: "bitwarden",
      title: at("name"),
      url: at("login_uri"),
      username: at("login_username"),
      password: at("login_password"),
      type: at("type"),
    };
  }
  if (at("name") >= 0 && at("url") >= 0 && at("username") >= 0 && at("password") >= 0 && at("title") < 0) {
    const [title, url, username, password] = [at("name"), at("url"), at("username"), at("password")] as const;
    return { format: "chrome", title, url, username, password, type: -1 };
  }
  if (at("title") >= 0 && at("url") >= 0 && at("username") >= 0 && at("password") >= 0) {
    const [title, url, username, password] = [at("title"), at("url"), at("username"), at("password")] as const;
    return { format: "1password", title, url, username, password, type: -1 };
  }
  const url = firstOf(h, ["url", "website", "login_uri", "uri", "site", "web site", "login url", "address"]);
  const password = firstOf(h, ["password", "login_password", "pass", "passwd"]);
  if (url < 0 || password < 0) return null;
  return {
    format: "generic",
    title: firstOf(h, ["name", "title", "account", "service"]),
    url,
    username: firstOf(h, ["username", "login_username", "user name", "user", "login", "email", "e-mail"]),
    password,
    type: -1,
  };
}

/** One login read from a row, or why it was skipped. */
export type CsvLogin =
  | { ok: true; title: string; website: string; username: string | null; password: string }
  | { ok: false; reason: Exclude<VaultImportSkip, "duplicate"> };

/** A Bitwarden cell may hold several addresses: the first HTTPS one. */
function websiteOf(cell: string, format: VaultCsvFormat): string | null | "not_https" {
  const candidates = (format === "bitwarden" ? cell.split(/[,\n]/) : [cell]).map((u) => u.trim()).filter(Boolean);
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    // An address with no scheme is read as HTTPS (`vaultOrigin`); `http://` and app links never are.
    const origin = candidate.length <= VAULT_LIMITS.website ? vaultOrigin(candidate) : null;
    if (origin) return origin;
  }
  return "not_https";
}

export function csvLogin(row: string[], layout: VaultCsvLayout): CsvLogin | null {
  const cell = (index: number) => (index >= 0 ? (row[index] ?? "") : "");
  if (layout.type >= 0 && cell(layout.type).trim().toLowerCase() !== "login") return null;
  const website = websiteOf(cell(layout.url), layout.format);
  if (website === null) return { ok: false, reason: "invalid" };
  if (website === "not_https") return { ok: false, reason: "not_https" };
  const password = cell(layout.password);
  if (!password) return { ok: false, reason: "no_password" };
  if (new TextEncoder().encode(password).byteLength > MAX_SECRET_BYTES) return { ok: false, reason: "invalid" };
  const username = cell(layout.username).trim();
  if (username.length > VAULT_LIMITS.username) return { ok: false, reason: "invalid" };
  const title = cell(layout.title).trim().slice(0, VAULT_LIMITS.title) || new URL(website).host;
  return { ok: true, title, website, username: username || null, password };
}

const loginKey = (website: string, username: string | null) => `${website}\n${username ?? ""}`;
const SKIP_ORDER: VaultImportSkip[] = ["duplicate", "not_https", "no_password", "invalid"];

/**
 * Imports a CSV export into the chosen scope (personal for anyone, team for who manages credentials), or with
 * `dryRun` only counts what it would do. Team items get the default team access.
 */
export async function importVaultCsv(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  input: { csv: string; scope: VaultScope; dryRun: boolean },
): Promise<VaultImportResult> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const scope = cleanScope(input.scope);
  if (scope === "team" && !viewer.manages) throw teamNeedsPermission();
  const ownerUserId = scope === "personal" ? userId : null;
  if (typeof input.csv !== "string" || new TextEncoder().encode(input.csv).byteLength > VAULT_LIMITS.csvBytes)
    throw new ValidationError("The file is too large (max 2 MB)", "vault.csv_too_large", { maxMb: 2 });
  // The header, the most rows an import takes, and one more to tell a file over the cap.
  const rows = parseVaultCsv(input.csv, VAULT_LIMITS.csvRows + 2);
  const [header, ...body] = rows;
  const layout = header ? csvLayout(header) : null;
  if (!layout) throw unrecognized();
  if (body.length > VAULT_LIMITS.csvRows)
    throw new ValidationError(`At most ${VAULT_LIMITS.csvRows} rows`, "vault.csv_too_many_rows", {
      max: VAULT_LIMITS.csvRows,
    });

  const existing = new Map<string, ItemRow>();
  for (const row of await db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, orgId),
        eq(vaultItems.kind, "login"),
        ownerUserId ? eq(vaultItems.ownerUserId, ownerUserId) : isNull(vaultItems.ownerUserId),
        isNull(vaultItems.connectionId),
      ),
    ))
    if (row.website) existing.set(loginKey(row.website, row.username), row);

  const skipped = new Map<VaultImportSkip, number>();
  const skip = (reason: VaultImportSkip) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const seen = new Set<string>();
  const adds: { title: string; website: string; username: string | null; password: string }[] = [];
  const updates: { item: ItemRow; password: string }[] = [];
  for (const row of body) {
    const login = csvLogin(row, layout);
    if (!login) continue;
    if (!login.ok) {
      skip(login.reason);
      continue;
    }
    const key = loginKey(login.website, login.username);
    if (seen.has(key)) {
      skip("duplicate");
      continue;
    }
    seen.add(key);
    const saved = existing.get(key);
    if (!saved) {
      adds.push(login);
      continue;
    }
    let current: string | null = null;
    try {
      current = await openItemValue(deps, saved);
    } catch {
      // A saved password that no longer opens here is replaced by the file's.
    }
    if (current === login.password) skip("duplicate");
    else updates.push({ item: saved, password: login.password });
  }

  const result: VaultImportResult = {
    added: adds.length,
    updated: updates.length,
    skipped: SKIP_ORDER.filter((r) => skipped.has(r)).map((reason) => ({ reason, count: skipped.get(reason) ?? 0 })),
    format: layout.format,
  };
  if (input.dryRun || (adds.length === 0 && updates.length === 0)) return result;

  await assertRoom(db, orgId, adds.length);
  const access = await cleanAccess(db, orgId, scope, undefined);
  const now = vaultNow(deps);
  const newRows: (typeof vaultItems.$inferInsert)[] = [];
  for (const add of adds) {
    const id = Bun.randomUUIDv7();
    const sealed = await sealItemValue(deps, { orgId, id, ownerUserId }, 1, add.password);
    newRows.push({
      id,
      orgId,
      kind: "login",
      ownerUserId,
      title: add.title,
      website: add.website,
      match: "exact",
      username: add.username,
      ...sealed,
      ...access,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
  }
  const replaced: { item: ItemRow; sealed: SealedItemColumns }[] = [];
  for (const update of updates) {
    const sealed = await sealItemValue(deps, update.item, update.item.secretVersion + 1, update.password);
    replaced.push({ item: update.item, sealed });
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < newRows.length; i += 500) await tx.insert(vaultItems).values(newRows.slice(i, i + 500));
    for (const { item, sealed } of replaced) {
      const [done] = await tx
        .update(vaultItems)
        .set({ ...sealed, previousSecrets: [], updatedAt: now })
        .where(and(eq(vaultItems.id, item.id), eq(vaultItems.secretVersion, item.secretVersion)))
        .returning({ id: vaultItems.id });
      if (!done) throw new ConflictError("Some logins changed meanwhile. Import again.", "vault.changed_meanwhile");
    }
    const uses = [
      ...newRows.map((row) => ({ orgId, itemId: row.id as string, action: "create", userId, createdAt: now })),
      ...replaced.map(({ item }) => ({ orgId, itemId: item.id, action: "edit", userId, createdAt: now })),
    ];
    for (let i = 0; i < uses.length; i += 500) await tx.insert(vaultUses).values(uses.slice(i, i + 500));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "vault.imported",
      target: { type: "vault", id: null },
      details: {
        format: layout.format,
        scope,
        added: result.added,
        updated: result.updated,
        skipped: Object.fromEntries(result.skipped.map((s) => [s.reason, s.count])),
      },
    });
  });
  await publishVaultChanged(deps.pubsub, orgId);
  return result;
}
