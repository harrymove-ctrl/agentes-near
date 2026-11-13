import type { SecretRequest, VaultScope } from "@agenteschat/client";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, Checkbox, Field, Icon, Input, Segmented, Token, TokenList } from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { LIMITS } from "./lib";
import { AgentsAccessDialog } from "./VaultAccess";
import "./vault.css";

/*
 * "Save to the Vault" on a secret request's card (ADR 0144): a site's password becomes a login, a variable a key, after
 * the value went to the computer. Checked by default; Personal or Team; the agents that may use it (the one asking
 * first); and, for a site, the username to keep with it. Never for a file or a verification code.
 */

export interface VaultSaveChoice {
  on: boolean;
  scope: VaultScope;
  allAgents: boolean;
  agentIds: string[];
  username: string;
}

/** Whether a request's value can go to the Vault: a site's password or a variable, never a file or a code. */
export const savesToVault = (r: Pick<SecretRequest, "target" | "codeDigits">) =>
  !r.codeDigits && (r.target.kind === "site" || r.target.kind === "env");

export const vaultSaveDefaults = (r: Pick<SecretRequest, "agentId" | "username">): VaultSaveChoice => ({
  on: true,
  scope: "personal",
  allAgents: false,
  agentIds: [r.agentId],
  username: r.username ?? "",
});

export function VaultSaveBlock({
  request,
  value,
  onChange,
  canManageTeam,
  disabled,
}: {
  request: Pick<SecretRequest, "target">;
  value: VaultSaveChoice;
  onChange: (value: VaultSaveChoice) => void;
  canManageTeam: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const id = useId();
  const [choosing, setChoosing] = useState(false);
  const site = request.target.kind === "site";
  const set = (patch: Partial<VaultSaveChoice>) => onChange({ ...value, ...patch });
  return (
    <div className="vlt-save">
      <div className="vlt-save__check">
        <Checkbox
          id={`${id}-on`}
          checked={value.on}
          disabled={disabled}
          aria-describedby={`${id}-why`}
          onCheckedChange={(on) => set({ on })}
        />
        {/* The label names the box; why it helps is its description, under it. */}
        <span className="vlt-save__text">
          <label htmlFor={`${id}-on`}>{t("vault.card.save")}</label>
          <small id={`${id}-why`}>{t("vault.card.saveText")}</small>
        </span>
      </div>
      {value.on && (
        <div className="vlt-save__more">
          {site && (
            <Field label={t("vault.field.username")}>
              <Input
                value={value.username}
                maxLength={LIMITS.username}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                placeholder={t("vault.field.usernamePlaceholder")}
                onChange={(e) => set({ username: e.target.value })}
                data-1p-ignore
              />
            </Field>
          )}
          <div className="vlt-save__line">
            <Segmented<VaultScope>
              size="sm"
              label={t("vault.card.scope")}
              value={value.scope}
              disabled={disabled || !canManageTeam}
              onValueChange={(scope) => set({ scope })}
              options={[
                { value: "personal", label: t("vault.scope.personal") },
                { value: "team", label: t(modeKey(org, "vault.scope.team")) },
              ]}
            />
            <span className="vlt-save__hint">
              {canManageTeam
                ? t(value.scope === "team" ? modeKey(org, "vault.card.teamText") : "vault.card.personalText")
                : t(modeKey(org, "vault.card.teamLocked"))}
            </span>
          </div>
          <div className="vlt-save__line">
            <span className="vlt-save__label">{t("vault.card.agents")}</span>
            <TokenList label={t("vault.card.agents")}>
              {value.allAgents ? (
                <li>
                  <Token leading={<Icon name="members" size={14} />}>{t("vault.access.allAgents")}</Token>
                </li>
              ) : value.agentIds.length === 0 ? (
                <li>
                  <Token>{t("vault.access.noAgents")}</Token>
                </li>
              ) : (
                value.agentIds.map((agentId) => {
                  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
                  return (
                    <li key={agentId}>
                      <Token leading={<AgentAvatar agentId={agentId} name={name} size="xs" />}>{name}</Token>
                    </li>
                  );
                })
              )}
            </TokenList>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setChoosing(true)}>
              {t("vault.card.choose")}
            </Button>
          </div>
        </div>
      )}
      {choosing && (
        <AgentsAccessDialog
          scope={value.scope}
          access={{ everyone: false, roleIds: [], userIds: [], allAgents: value.allAgents, agentIds: value.agentIds }}
          onSave={(access) => {
            set({ allAgents: access.allAgents, agentIds: access.agentIds });
            setChoosing(false);
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
