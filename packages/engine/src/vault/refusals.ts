import { SECRET_NAME, vaultRule, vaultRuleLabel } from "@agenteschat/adapters";
import { cutText } from "../format";
import type { ToolOutput } from "../tools/types";
import { neutralizeUntrusted } from "../untrusted";
import type { VaultPlace } from "./service";

/**
 * Why the Vault refused an agent (ADR 0144). The message is English, for the model, and says what to do next. It
 * never says that an item the run may not see exists: an item hidden from the person behind the run (or from a run
 * nobody is behind) is `not_found`, the same as one that never existed.
 */
export type VaultRefusalCode =
  | "not_found"
  | "not_shared"
  | "wrong_site"
  | "missing"
  | "no_value"
  | "source_error"
  | "no_person"
  | "not_allowed"
  | "read_only";

export class VaultRefusal extends Error {
  constructor(
    readonly code: VaultRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultRefusal";
  }
}

/** What `vaultItemName` reads of an item: only what the engine checked when it was saved. */
export interface VaultItemNaming {
  id: string;
  kind: string;
  website: string | null;
  match: string;
  keyName: string | null;
}

/**
 * How the agent's tool text names an item outside `vault_list`'s blocks (ADR 0144 §4, ADR 0117): its kind and id, a
 * login's site (the host of its rule, parsed from the saved HTTPS origin) and a key's variable name (checked against
 * `SECRET_NAME`). Never its title, description or username, which people, agents, password managers and CSV files
 * write: those reach the model only in an `untrustedBlock`. Lowercase, for the middle of a sentence (`named`
 * capitalizes it).
 */
export function vaultItemName(item: VaultItemNaming): string {
  if (item.kind === "login") {
    const rule = item.website ? vaultRule(item.website, item.match === "site" ? "site" : "exact") : null;
    return rule ? `the login ${item.id} for ${vaultRuleLabel(rule)}` : `the login ${item.id}`;
  }
  if (item.kind === "key") {
    return item.keyName && SECRET_NAME.test(item.keyName)
      ? `the key ${item.keyName} (${item.id})`
      : `the key ${item.id}`;
  }
  return `the contact ${item.id}`;
}

/** `vaultItemName` at the start of a sentence. */
export const named = (item: VaultItemNaming) => {
  const name = vaultItemName(item);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

/**
 * A place in plain words, for the agent's tool text: `the Vault`, or `1Password · "Agents"`. The label is what the
 * people who run the workspace's password manager called their vault or folder, so it is shown, but as one short
 * quoted line with every envelope marker neutralised (ADR 0117).
 */
export function vaultPlaceName(place: VaultPlace): string {
  if (!place.connectionId) return place.name;
  const label = cutText(
    neutralizeUntrusted(place.label ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    60,
  );
  return label ? `${place.name} · ${JSON.stringify(label)}` : place.name;
}

const NOT_FOUND =
  "No Vault item like that is shared with you. Look with vault_list, or ask the person to save it in Settings, Vault.";

export const refuse = {
  notFound: (message = NOT_FOUND) => new VaultRefusal("not_found", message),
  notShared: (item: VaultItemNaming) =>
    new VaultRefusal(
      "not_shared",
      `${named(item)} is in the Vault but not shared with you. Someone who manages it can add you in Settings, Vault.`,
    ),
  wrongSite: (label: string, host: string) =>
    new VaultRefusal("wrong_site", `This login is for ${label}. The page is on ${host}, so it isn't typed there.`),
  noWebsite: () =>
    new VaultRefusal("wrong_site", "This login has no HTTPS website saved, so it can't be typed anywhere."),
  missing: (item: VaultItemNaming, source: string) =>
    new VaultRefusal(
      "missing",
      `${named(item)} is gone from ${source} since the last sync. Ask the person to put it back, or use another one.`,
    ),
  noValue: (item: VaultItemNaming) =>
    new VaultRefusal(
      "no_value",
      `${named(item)} has nothing saved to use. Ask the person to add it in Settings, Vault.`,
    ),
  sourceError: (source: string, reason: string) =>
    new VaultRefusal("source_error", `Couldn't read it from ${source}: ${reason}`),
  sourceWrite: (place: VaultPlace, reason: string) =>
    new VaultRefusal("source_error", `Couldn't save it in ${vaultPlaceName(place)}: ${reason} Nothing was saved.`),
  readOnly: (place: VaultPlace) =>
    new VaultRefusal(
      "read_only",
      `This ${place.name} token can only read, so nothing was saved or changed in ${vaultPlaceName(place)}. Tell the person: someone who manages that connection creates a token that can also write there and reconnects it in Settings, Vault, Connections. Until then, new logins go in the Vault (\`save_in\`: "vault").`,
    ),
  noPerson: () =>
    new VaultRefusal(
      "no_person",
      "Nobody is behind this run, so there is no one to save it for. Do it when a person asks.",
    ),
  notAllowed: (why: string) => new VaultRefusal("not_allowed", why),
};

/**
 * A Vault refusal as a tool's answer, in its own words (which never say an item hidden from the run exists) with its
 * code (`vault.<code>`); null for any other error, which the tool answers its own way.
 */
export function vaultRefusalOutput(error: unknown): ToolOutput | null {
  if (!(error instanceof VaultRefusal)) return null;
  return { content: error.message, isError: true, data: { code: `vault.${error.code}` } };
}
