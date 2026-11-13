import type { OrgRole } from "@agenteschat/client";
import { personalHelperRole } from "@agenteschat/client/lib/personal-view";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Button, Icon, Menu, MenuCheckboxItem, MenuHeading, MenuNote, RoleMark } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import "./roles.css";

/**
 * Picks roles (ADR 0085) from a menu that stays open: only the ones the person may give (below their own). The
 * trigger is a field-like button that names what's picked ("Membro" with none: everyone's base alone, ADR 0090),
 * or `trigger` (a "+" on a person's row).
 */
export function RolesPicker({
  roles,
  value,
  onChange,
  label,
  trigger,
  size,
  side,
  align = "end",
}: {
  roles: readonly OrgRole[];
  value: readonly string[];
  onChange: (roleIds: string[]) => void;
  /** What the menu is for (its accessible name). */
  label: string;
  trigger?: ReactNode;
  size?: "sm";
  /** Beside the trigger instead of under it (a profile card opens it to its right). */
  side?: "bottom" | "right";
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const givable = sortRoles(roles.filter((r) => !isEveryone(r) && r.givable));
  // A personal workspace says it in the invitation's plain words (ADR 0159), naming its helper role as it's called.
  const helper = isPersonal(org) ? personalHelperRole(roles) : null;
  const picked = sortRoles(roles.filter((r) => value.includes(r.id)));
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...value, id])] : value.filter((v) => v !== id));
  return (
    <Menu
      label={label}
      side={side}
      align={align}
      trigger={
        trigger ?? (
          <Button size={size} className="roles-picker" aria-label={label}>
            <span className="roles-picker__value">
              {picked.length ? picked.map((r) => r.name).join(", ") : t("roles.member")}
            </span>
            <Icon name="chevronDown" size={16} />
          </Button>
        )
      }
    >
      <MenuHeading>{label}</MenuHeading>
      {givable.map((r) => (
        <MenuCheckboxItem key={r.id} checked={value.includes(r.id)} onCheckedChange={(on) => toggle(r.id, on)}>
          <span className="roles-picker__item">
            <RoleMark color={r.color} icon={r.icon} size={18} />
            {r.name}
          </span>
        </MenuCheckboxItem>
      ))}
      <MenuNote>
        {!givable.length
          ? t("members.noRolesToGive")
          : helper
            ? t("members.everyoneNotePersonal", { role: helper.name })
            : t("members.everyoneNote")}
      </MenuNote>
    </Menu>
  );
}
