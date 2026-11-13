import type { OrgRole } from "@agenteschat/client";
import { Checkbox, RoleMark } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/** Roles to tick, each with its mark and how many hold it: an agent's audience and a channel's (ADR 0125). */
export function RoleChecklist({
  roles,
  picked,
  onToggle,
  idPrefix,
}: {
  roles: readonly OrgRole[];
  picked: ReadonlySet<string>;
  onToggle: (roleId: string, on: boolean) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  return roles.map((r) => {
    const id = `${idPrefix}-r-${r.id}`;
    return (
      <label key={r.id} htmlFor={id} className="scope-row">
        <Checkbox id={id} checked={picked.has(r.id)} onCheckedChange={(on) => onToggle(r.id, on)} />
        <RoleMark color={r.color} icon={r.icon} size={26} />
        <span className="scope-row__text">
          <span>{r.name}</span>
          <span className="small muted">{t("audience.roleMembers", { count: r.people })}</span>
        </span>
      </label>
    );
  });
}
