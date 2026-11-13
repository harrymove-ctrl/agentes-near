import type { DeviceAudience } from "@agenteschat/client";
import { narrowsAudience } from "@agenteschat/client/lib/devices";
import { Icon, Select } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AudiencePeoplePicker } from "@/components/AgentAudience";
import { PrefRow } from "@/components/NoticePrefs";
import { AUDIENCE_ICON } from "./parts";

const MODES = ["owner", "everyone", "people"] as const;

/**
 * Who may point their agents at a device: one select (Only the owner, Everyone in the workspace, Only some people or
 * roles) and, for the third, the people and roles picker the agent page uses. `narrowOnly`: an admin on someone's
 * personal device, who may only take people away (the others stay shown, disabled).
 */
export function WhoSelect({
  value,
  onChange,
  narrowOnly = false,
  disabled = false,
  id,
  size = "md",
}: {
  value: DeviceAudience;
  onChange: (next: DeviceAudience) => void;
  narrowOnly?: boolean;
  disabled?: boolean;
  id?: string;
  /** A form's field (`md`, as tall as the fields beside it) or a settings row's control (`sm`). */
  size?: "md" | "sm";
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      size={size}
      align="end"
      aria-label={id ? undefined : t("devices.who.title")}
      value={value.mode}
      disabled={disabled}
      onValueChange={(mode) => onChange({ ...value, mode })}
      options={MODES.map((mode) => ({
        value: mode,
        label: t(`audience.mode.${mode}`),
        leading: <Icon name={AUDIENCE_ICON[mode]} size={16} />,
        disabled: narrowOnly && !narrowsAudience(value, { ...value, mode }),
      }))}
    />
  );
}

/** The people and roles under "Only some people or roles", for a device. */
export function WhoPicker({
  value,
  onChange,
  ownerUserId,
  narrowFrom,
  idPrefix,
}: {
  value: DeviceAudience;
  onChange: (next: DeviceAudience) => void;
  ownerUserId: string | null;
  /** An admin narrowing: only those already in this rule can stay. */
  narrowFrom?: DeviceAudience;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  if (value.mode !== "people") return null;
  return (
    <div className="dv-picker">
      <AudiencePeoplePicker
        value={value}
        onChange={(next) => onChange({ mode: "people", ...next })}
        ownerUserId={ownerUserId}
        idPrefix={idPrefix}
        within={narrowFrom?.mode === "people" ? narrowFrom : undefined}
        rolesHint={t("devices.who.rolesHint")}
      />
    </div>
  );
}

/**
 * A device page's "Who can use it" line: the select at its end and the picker under it. Read-only (the value alone)
 * for someone who may not change it; `hint` behind the ⓘ ("Sharing a phone never shares Sam's MacBook Pro.").
 */
export function WhoCanUseRow({
  value,
  onChange,
  ownerUserId,
  narrowOnly,
  editable,
  hint,
  saving,
  idPrefix,
}: {
  value: DeviceAudience;
  onChange: (next: DeviceAudience) => void;
  ownerUserId: string | null;
  narrowOnly: boolean;
  editable: boolean;
  hint?: string;
  saving?: boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PrefRow
        id={`${idPrefix}-who`}
        icon="audiencePeople"
        label={t("devices.who.title")}
        hint={hint}
        control={
          <WhoSelect
            size="sm"
            value={value}
            onChange={onChange}
            narrowOnly={narrowOnly}
            disabled={!editable || saving}
          />
        }
      />
      {editable && (
        <WhoPicker
          value={value}
          onChange={onChange}
          ownerUserId={ownerUserId}
          narrowFrom={narrowOnly ? value : undefined}
          idPrefix={idPrefix}
        />
      )}
    </>
  );
}
