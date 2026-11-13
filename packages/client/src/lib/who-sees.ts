import type { TFunction } from "i18next";
import type { OrgSummary } from "../api/types";
import { joinNames } from "./format";
import { modeKey } from "./workspace-mode";

/** Who something is for (ADR 0151): "only me" is a list of one, and administrators always see it. */
export type AudienceChoice = { mode: "everyone" } | { mode: "people"; userIds: string[] };
export type AudienceKind = "everyone" | "me" | "people";

export const EVERYONE: AudienceChoice = { mode: "everyone" };

/** Which of the three options `a` is, for `myId`. */
export function audienceKind(a: { mode: "everyone" | "people"; userIds?: readonly string[] }, myId: string) {
  if (a.mode === "everyone") return "everyone" satisfies AudienceKind;
  const ids = a.userIds ?? [];
  return ids.length === 1 && ids[0] === myId ? ("me" satisfies AudienceKind) : ("people" satisfies AudienceKind);
}

/** What the option `kind` saves; "only me" and a list always hold me, unless I'm an administrator and left myself out. */
export function audienceOfKind(kind: AudienceKind, userIds: readonly string[], myId: string): AudienceChoice {
  if (kind === "everyone") return EVERYONE;
  return { mode: "people", userIds: kind === "me" ? [myId] : [...userIds] };
}

/** Who the list starts with: the people it names, as they are, or me when it names nobody yet. */
export const pickedOf = (a: { mode: "everyone" | "people"; userIds?: readonly string[] }, myId: string) =>
  new Set(a.mode === "people" ? (a.userIds ?? []) : [myId]);

/**
 * A wiki page's list, roles included: the page's roles stay on a list of people, and "only me" means it. `roleIds`:
 * the ones on the page now. `kind`: the option picked, as a list may hold me alone and keep its roles.
 */
export function wikiAudienceOf(next: AudienceChoice, roleIds: string[], kind: AudienceKind) {
  if (next.mode === "everyone") return null;
  return { roleIds: kind === "me" ? [] : roleIds, userIds: next.userIds };
}

/**
 * The setting in a few words: "Todos no workspace", "Só eu", "Só Ana", "Ana e Bia", "Ana, Bia e mais 2". `org`: a
 * personal workspace says "everyone" its way (ADR 0159).
 */
export function whoSeesLabel(
  t: TFunction,
  a: { mode: "everyone" | "people"; userIds?: readonly string[] },
  myId: string,
  nameOf: (id: string) => string | undefined,
  org?: Pick<OrgSummary, "mode"> | null,
) {
  const kind = audienceKind(a, myId);
  if (kind === "everyone") return t(modeKey(org, "whoSees.everyone"));
  if (kind === "me") return t("whoSees.me");
  const names = (a.userIds ?? []).flatMap((id) => {
    const name = nameOf(id);
    return name ? [name] : [];
  });
  const [first] = names;
  if (first === undefined) return t("whoSees.people");
  if (names.length === 1) return t("whoSees.only", { name: first });
  if (names.length <= 3) return joinNames(names, t);
  return t("whoSees.more", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
}
