/**
 * Where a Vault login may be typed (ADR 0144): one rule, read the same way by the server (before it releases a
 * value) and by the runner (at the moment it types, against the origin of the frame that owns the field).
 *
 * - `exact`: one origin, `https://host[:port]`. The default.
 * - `site`: every HTTPS page under one registrable domain (`github.com` also fills on `gist.github.com`). The
 *   public suffix list decides what a registrable domain is, private suffixes included, so a login saved for one
 *   `*.github.io` site never fills on another person's.
 *
 * Only HTTPS ever matches. An IP address or a name with no registrable domain (`localhost`) can only be `exact`.
 */
import { getDomain } from "tldts";

export type VaultMatch = "exact" | "site";

export type VaultOriginRule = { kind: "exact"; origin: string } | { kind: "site"; domain: string };

const PSL = { allowPrivateDomains: true } as const;

/** `https://host[:port]` for an address a person or a page gives (`github.com/login` is HTTPS), or null. */
export function vaultOrigin(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The rule for a saved website and its match, or null when the website isn't an HTTPS address. */
export function vaultRule(website: string, match: VaultMatch): VaultOriginRule | null {
  const origin = vaultOrigin(website);
  if (!origin) return null;
  if (match === "exact") return { kind: "exact", origin };
  const domain = getDomain(new URL(origin).hostname, PSL);
  // No registrable domain (an IP, `localhost`): only the exact origin is safe.
  return domain ? { kind: "site", domain } : { kind: "exact", origin };
}

/** The rule as it travels in a box's additional data and to the runner: `exact:https://a.com` / `site:a.com`. */
export function formatVaultRule(rule: VaultOriginRule): string {
  return rule.kind === "exact" ? `exact:${rule.origin}` : `site:${rule.domain}`;
}

export function parseVaultRule(text: string): VaultOriginRule | null {
  if (text.startsWith("exact:")) {
    const origin = vaultOrigin(text.slice(6));
    return origin && origin === text.slice(6) ? { kind: "exact", origin } : null;
  }
  if (text.startsWith("site:")) {
    const domain = text.slice(5);
    return domain && getDomain(domain, PSL) === domain ? { kind: "site", domain } : null;
  }
  return null;
}

/** Whether a page or frame at `origin` (as the browser reports it) is a place this rule allows. */
export function vaultRuleMatches(rule: VaultOriginRule, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (rule.kind === "exact") return url.origin === rule.origin;
  return getDomain(url.hostname, PSL) === rule.domain;
}

/** The host people know a login by (`github.com`), for titles and lines. */
export function vaultRuleLabel(rule: VaultOriginRule): string {
  return rule.kind === "exact" ? new URL(rule.origin).host : rule.domain;
}
