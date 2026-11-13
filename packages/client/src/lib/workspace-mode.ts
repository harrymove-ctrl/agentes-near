import { type OrgSummary, WORKSPACE_MODES, type WorkspaceMode } from "../api/types";

/**
 * Who a workspace is for (ADR 0159). Personal mode changes defaults, words and what is in sight, never what exists or
 * who may do what: read it only to pick a default, a word or a place, never to refuse something.
 */
export const isWorkspaceMode = (v: unknown): v is WorkspaceMode => WORKSPACE_MODES.includes(v as WorkspaceMode);

/** The workspace's mode; an older server sends none, which is a team's. */
export const workspaceModeOf = (org: Pick<OrgSummary, "mode"> | null | undefined): WorkspaceMode =>
  isWorkspaceMode(org?.mode) ? org.mode : "team";

/** Whether the workspace is personal: one person (and maybe their family) with their agents. */
export const isPersonal = (org: Pick<OrgSummary, "mode"> | null | undefined) => workspaceModeOf(org) === "personal";

/**
 * The key of a string that has a personal variant: `<key>Personal` next to `<key>` (a sibling key, not an i18next
 * context, so `_female` and plural forms still work on it). A team's workspace reads the plain key.
 */
export const modeKey = <K extends string>(org: Pick<OrgSummary, "mode"> | null | undefined, key: K) =>
  isPersonal(org) ? (`${key}Personal` as const) : key;
