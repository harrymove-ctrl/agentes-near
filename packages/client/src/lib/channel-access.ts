import type { ChannelInput } from "../api/types";

/** Who may join a channel (ADR 0125): anyone in the workspace, only who is added, or the people of some roles. */
export type ChannelAccessMode = "public" | "private" | "roles";
export interface ChannelAccess {
  mode: ChannelAccessMode;
  roleIds: string[];
}

type Visible = { visibility: string; audienceRoleIds?: readonly string[]; seenAsAdmin?: boolean };

const limited = (c: Visible) => c.visibility === "private" && (c.audienceRoleIds?.length ?? 0) > 0;

export const accessOf = (c: Visible): ChannelAccess => ({
  mode: c.visibility === "public" ? "public" : limited(c) ? "roles" : "private",
  roleIds: limited(c) ? [...(c.audienceRoleIds ?? [])] : [],
});

/** "Departamentos ou papéis" needs a role picked before it means anything. */
export const accessValid = (a: ChannelAccess) => a.mode !== "roles" || a.roleIds.length > 0;

/** What the server takes for it; a public channel drops its roles on its own. */
export const accessInput = (a: ChannelAccess): Pick<ChannelInput, "visibility" | "audienceRoleIds"> =>
  a.mode === "public"
    ? { visibility: "public" }
    : { visibility: "private", audienceRoleIds: a.mode === "roles" ? a.roleIds : [] };

/**
 * Whether I may join a channel I see and am not in: public, limited to roles, which the server shows only to their
 * people, or any for an administrator (ADR 0151).
 */
export const joinable = (c: Visible & { isMember: boolean }) =>
  !c.isMember && (c.visibility === "public" || limited(c) || c.seenAsAdmin === true);
