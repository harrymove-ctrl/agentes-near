import type {
  DashboardAudience,
  DashboardEditPolicy,
  DashboardOwner,
  DashboardSummary,
  Member,
  OrgRole,
} from "@agenteschat/client";
import {
  editorsSummary,
  editorsText,
  fitEditRoles,
  roleSeesBoard,
  toggleEditRole,
  useMembers,
  useRoles,
} from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  Icon,
  type IconName,
  Menu,
  MenuCheckboxItem,
  MenuHeading,
  MenuSeparator,
  Radio,
  RadioGroup,
  RoleMark,
} from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";

/** Who sees and who edits a board, as the New dashboard and Share dialogs edit it (ADR 0135 §8). */
export interface BoardAudience {
  audience: DashboardAudience;
  roleIds: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`. */
  editRoleIds: string[];
}

/** A `roles` audience needs at least one role (the server's `dashboard.roles_required`). */
export const audienceReady = (a: BoardAudience) => a.audience !== "roles" || a.roleIds.length > 0;

/** The workspace's own roles (not `everyone`), in their order. */
export function useCustomRoles(orgId: string): OrgRole[] {
  const roles = useRoles(orgId);
  return sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
}

/** Whether a member is an admin: the workspace's owner, or holding a role with `administrator` (ADR 0085). */
export function adminOf(member: Pick<Member, "role" | "roleIds">, roles: readonly OrgRole[]): boolean {
  if (member.role === "owner") return true;
  const held = new Set(member.roleIds ?? []);
  return roles.some((r) => held.has(r.id) && r.permissions.includes("administrator"));
}

/** The roles' names, in the workspace's order, joined for a sentence ("Sales, Support"). */
export function roleNames(roles: readonly OrgRole[], ids: readonly string[]): string {
  return roles
    .filter((r) => ids.includes(r.id))
    .map((r) => r.name)
    .join(", ");
}

/** "Whole workspace", "Only you" or the roles (each with its mark): a board's audience in its meta line. */
export function VisibilityChip({ board }: { board: Pick<DashboardSummary, "audience" | "roleIds"> }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useCustomRoles(org.id).filter((r) => board.roleIds.includes(r.id));
  if (board.audience === "workspace")
    return (
      <span className="db-vis">
        <Icon name="globe" size={14} />
        {t("dashboards.audience.workspace")}
      </span>
    );
  // A `roles` board whose roles are all gone is its owner's alone until shared again (ADR 0135 §8).
  if (board.audience === "private" || roles.length === 0)
    return (
      <span className="db-vis">
        <Icon name="lock" size={14} />
        {t("dashboards.audience.private")}
      </span>
    );
  return (
    <span className="db-vis">
      <Icon name="lock" size={14} />
      {roles.map((r) => (
        <span key={r.id} className="db-vis__role">
          <RoleMark color={r.color} icon={r.icon} size={14} />
          {r.name}
        </span>
      ))}
    </span>
  );
}

/** Who made a board: the agent's or the person's face, then "Created by Theo" (or "Created by you"). */
export function OwnerLine({ owner, mine }: { owner: DashboardOwner | null; mine: boolean }) {
  const { t } = useTranslation();
  if (!owner) return null;
  const you = mine && owner.kind === "person";
  return (
    <span className="db-by">
      {owner.kind === "agent" ? (
        <AgentAvatar agentId={owner.id} name={owner.name} size="xs" />
      ) : (
        <PersonAvatar id={owner.id} name={owner.name} size="xs" />
      )}
      <span>{you ? t("dashboards.meta.byYou") : t("dashboards.meta.by", { name: owner.name })}</span>
    </span>
  );
}

const AUDIENCE_ICON: Record<DashboardAudience, IconName> = {
  workspace: "globe",
  roles: "audiencePeople",
  private: "lock",
};

/**
 * "Who sees" (the whole workspace, roles with their chips and how many hold each, or only you), "Who edits" and the
 * note on what whoever sees a board sees (ADR 0135 §8, §12). Showing a board to others needs `post`: without it the
 * wider choices are shown but can't be picked, unless the board already has one. Narrowing who sees drops the edit
 * roles that no longer see the board (`fitEditRoles`).
 */
export function AudienceFields({
  value,
  onChange,
  saved,
}: {
  value: BoardAudience;
  onChange: (next: BoardAudience) => void;
  /** The audience the board has now (Share): kept selectable even without `post`. */
  saved?: DashboardAudience;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useCustomRoles(org.id);
  const members = useMembers(org.id);
  const id = useId();
  const mayPublish = can(org, "post");
  const memberCount = members.data?.length ?? 0;
  const hint: Record<DashboardAudience, string> = {
    workspace: t("dashboards.audience.workspaceHint", { count: memberCount }),
    roles: t("dashboards.audience.rolesHint"),
    private: t("dashboards.audience.privateHint"),
  };
  const option = (audience: DashboardAudience) => {
    const optionId = `${id}-${audience}`;
    const disabled = audience !== "private" && !mayPublish && saved !== audience;
    return (
      <label
        key={audience}
        htmlFor={optionId}
        className="db-opt ac-mediarow"
        data-state={value.audience === audience ? "checked" : "unchecked"}
        data-disabled={disabled ? "" : undefined}
      >
        <span className="ac-mediarow__face">
          <span className="db-opt__icon">
            <Icon name={AUDIENCE_ICON[audience]} size={18} />
          </span>
        </span>
        <span className="ac-mediarow__head">
          <b className="db-opt__title">{t(`dashboards.audience.${audience}`)}</b>
        </span>
        <span className="ac-mediarow__end">
          <Radio value={audience} id={optionId} disabled={disabled} />
        </span>
        <small className="ac-mediarow__body db-opt__hint">{hint[audience]}</small>
      </label>
    );
  };
  const toggleRole = (roleId: string) =>
    onChange(
      fitEditRoles({
        ...value,
        roleIds: value.roleIds.includes(roleId)
          ? value.roleIds.filter((r) => r !== roleId)
          : [...value.roleIds, roleId],
      }),
    );
  return (
    <>
      <div className="db-f">
        <span className="db-lbl" id={`${id}-sees`}>
          {t("dashboards.audience.label")}
        </span>
        <RadioGroup
          className="db-opts"
          aria-labelledby={`${id}-sees`}
          value={value.audience}
          onValueChange={(audience: DashboardAudience) => onChange(fitEditRoles({ ...value, audience }))}
        >
          {option("workspace")}
          {option("roles")}
          {value.audience === "roles" && (
            // biome-ignore lint/a11y/useSemanticElements: toggle buttons under a field's label, not a fieldset
            <div className="db-roles" role="group" aria-label={t("dashboards.audience.roles")}>
              {roles.length === 0 && <span className="small muted">{t("dashboards.audience.noRoles")}</span>}
              {roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="db-role"
                  aria-pressed={value.roleIds.includes(r.id)}
                  onClick={() => toggleRole(r.id)}
                >
                  <RoleMark color={r.color} icon={r.icon} size={16} />
                  <span>{r.name}</span>
                  <small>{t("dashboards.audience.people", { count: r.people })}</small>
                </button>
              ))}
            </div>
          )}
          {option("private")}
        </RadioGroup>
      </div>
      <EditorsField value={value} onChange={onChange} roles={roles} />
      <p className="db-note ac-iconline">
        <Icon name="shield" size={16} />
        <span>{t("widgets.exposure")}</span>
      </p>
    </>
  );
}

/**
 * "Who edits" (ADR 0135 §8): a dropdown with "Whoever sees it", "Only you and admins", then the workspace's roles to
 * check (with `roles`, people holding one of them who see the board edit it). A role whose people don't see the board
 * is shown but can't be checked, with why: editing isn't seeing, so it would give them nothing. The trigger says what
 * is picked ("Sales and Board", "3 roles").
 */
function EditorsField({
  value,
  onChange,
  roles,
}: {
  value: BoardAudience;
  onChange: (next: BoardAudience) => void;
  roles: readonly OrgRole[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const label = t("dashboards.edit.label");
  const picked = value.editPolicy === "roles" ? value.editRoleIds : [];
  return (
    <div className="db-f">
      <span className="db-lbl" id={`${id}-edits`}>
        {label}
      </span>
      <div className="ac-select">
        <Menu
          label={label}
          trigger={
            <button type="button" className="ac-select__trigger" aria-labelledby={`${id}-edits ${id}-value`}>
              <span className="ac-select__value" id={`${id}-value`}>
                {editorsText(t, editorsSummary(value, roles))}
              </span>
              <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
                <path d="m6 8 4 4 4-4" />
              </svg>
            </button>
          }
        >
          <MenuCheckboxItem
            icon="eye"
            closes
            checked={value.editPolicy === "viewers"}
            onCheckedChange={() => onChange({ ...value, editPolicy: "viewers", editRoleIds: [] })}
          >
            {t("dashboards.edit.viewers")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            icon="lock"
            closes
            checked={value.editPolicy === "owner"}
            onCheckedChange={() => onChange({ ...value, editPolicy: "owner", editRoleIds: [] })}
          >
            {t("dashboards.edit.owner")}
          </MenuCheckboxItem>
          {roles.length > 0 && (
            <>
              <MenuSeparator />
              <MenuHeading>{t("dashboards.edit.roles")}</MenuHeading>
              {roles.map((r) => {
                const sees = roleSeesBoard(value, r.id);
                return (
                  <MenuCheckboxItem
                    key={r.id}
                    leading={<RoleMark color={r.color} icon={r.icon} size={16} />}
                    checked={picked.includes(r.id)}
                    disabled={!sees}
                    description={sees ? undefined : t("dashboards.edit.cantSee")}
                    onCheckedChange={() => onChange(toggleEditRole(value, r.id))}
                  >
                    {r.name}
                  </MenuCheckboxItem>
                );
              })}
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}
