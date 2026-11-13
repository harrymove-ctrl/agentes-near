import type { Agent, AgentAudience, AudienceMode } from "@agenteschat/client";
import { useAgents, useAiStatus, useRoles } from "@agenteschat/client";
import {
  agentsReach,
  audienceChip,
  audienceModeKey,
  audienceModeTextKey,
  offersConsultable,
} from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, onlyOwnerReplies } from "@agenteschat/client/lib/no-ai";
import { rolePicksInSight } from "@agenteschat/client/lib/personal-view";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Avatar,
  Checkbox,
  Chip,
  fold,
  Icon,
  type IconName,
  InfoHint,
  OptionList,
  PickerHeading,
  RadioCard,
  RadioGroup,
  RoleMark,
  SearchField,
  SettingRow,
  Switch,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { RoleChecklist } from "./roles/RoleChecklist";

/** A picture per choice: the whole workspace, the people you pick, only the person responsible. */
const AUDIENCE_ICON: Record<AudienceMode, IconName> = {
  everyone: "audienceEveryone",
  people: "audiencePeople",
  owner: "audienceOwner",
};

const MODES: AudienceMode[] = ["everyone", "people", "owner"];

/**
 * "Seus agentes só atendem você.", before inviting anyone (setup's Team step, Members' invite card): every agent
 * with an AI is the viewer's and answers only them, so whoever joins now gets no answer. Nothing otherwise.
 */
export function OnlyYouNote({ orgId, viewerId }: { orgId: string; viewerId: string }) {
  const { t } = useTranslation();
  const agents = useAgents(orgId);
  const status = useAiStatus(orgId);
  const thinks = (id: string) => (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  if (!onlyOwnerReplies(agents.data ?? [], thinks, viewerId)) return null;
  return (
    <p className="setup-line ac-iconline">
      <Icon name="audienceOwner" size={14} />
      <span>
        {t("members.agentsOnlyYou")}{" "}
        <InfoHint name={t("common.about", { label: t("members.agentsOnlyYou") })}>
          {t("members.agentsOnlyYouHint")}
        </InfoHint>
      </span>
    </p>
  );
}

/**
 * Chip "Pessoal" / "Restrito" next to the agent's name (nothing when everyone can talk to it). Alone in a personal
 * workspace, nothing either: there is nobody else it could answer (ADR 0159).
 */
export function AudienceChip({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const { solo } = usePersonalView();
  const label = audienceChip(t, agent, { org, meId: me.user.id });
  if (!label || solo) return null;
  return (
    <Chip icon="lock" className="audience-chip">
      {label}
    </Chip>
  );
}

/**
 * The three choices (Todos do workspace / Só algumas pessoas ou papéis / Só o
 * responsável), with the roles and people picker under the second, and whether other agents may consult it for
 * the rest (ADR 0085 addendum).
 * `compact`: a segmented control and one line about the choice ("Criar agente").
 * A personal workspace says them plainly, people before roles, and offers roles only when one is worth picking
 * (`rolePicksInSight`) unless `everyRole` (ADR 0159); the choices themselves are the same.
 */
export function AudienceChoice({
  value,
  onChange,
  ownerUserId,
  agentName,
  idPrefix,
  compact,
  layout = "cards",
  onPlan = false,
  everyRole = false,
}: {
  value: AgentAudience;
  onChange: (next: AgentAudience) => void;
  ownerUserId: string | null;
  agentName: string;
  idPrefix: string;
  compact?: boolean;
  /** Compact's choices as cards (default) or as rows. */
  layout?: "cards" | "rows";
  /** It thinks with a person's plan (ADR 0059 §5). */
  onPlan?: boolean;
  /** Every role to pick, in a personal workspace too (the agent page's own "Who can talk"). */
  everyRole?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const g = agentGrammar(agentName);
  const owner = ownerUserId ? dir.memberById.get(ownerUserId) : undefined;
  const reach = agentsReach(value, onPlan, ownerUserId);
  const modeText = (mode: AudienceMode) =>
    mode === "owner"
      ? owner
        ? t("audience.modeText.owner", { ...g, owner: owner.name })
        : t("audience.modeText.noOwner")
      : t(audienceModeTextKey(org, mode), g);
  return (
    <div className="stack-4" style={{ gap: 12 }}>
      {compact ? (
        <OptionList
          aria-label={t("audience.title", g)}
          layout={layout}
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode })}
          options={MODES.map((mode) => ({
            value: mode,
            leading: (
              <span className="audience-card__icon">
                <Icon name={AUDIENCE_ICON[mode]} size={20} />
              </span>
            ),
            title: t(audienceModeKey(org, mode)),
            description: modeText(mode),
          }))}
        />
      ) : (
        <RadioGroup
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode: mode as AudienceMode })}
          aria-label={t("audience.title", g)}
          className="stack-4"
          style={{ gap: 8 }}
        >
          {MODES.map((mode) => (
            <RadioCard
              key={mode}
              value={mode}
              id={`${idPrefix}-${mode}`}
              checked={value.mode === mode}
              disabled={mode === "owner" && !ownerUserId}
              title={t(audienceModeKey(org, mode))}
              description={modeText(mode)}
            />
          ))}
        </RadioGroup>
      )}
      {value.mode === "people" && (
        <AudiencePeoplePicker
          value={value}
          onChange={(next) => onChange({ ...value, ...next })}
          ownerUserId={ownerUserId}
          idPrefix={idPrefix}
          everyRole={everyRole}
        />
      )}
      {reach && (
        <span className="small muted">
          {t("audience.notListed")} {t(`audience.agents.${reach}`, g)}
        </span>
      )}
      {offersConsultable(value, onPlan) && (
        <SettingRow
          title={t("audience.consultable", g)}
          hint={{
            name: t("common.about", { label: t("audience.consultable", g) }),
            text: t("audience.consultableHint", g),
          }}
          htmlFor={`${idPrefix}-consultable`}
        >
          <Switch
            id={`${idPrefix}-consultable`}
            checked={value.consultable ?? true}
            onCheckedChange={(consultable) => onChange({ ...value, consultable })}
          />
        </SettingRow>
      )}
    </div>
  );
}

/**
 * The people and roles under "Only some people or roles": who always can (the owner), what's picked as tokens, and a
 * search over the workspace's roles and people with a check each. `within`: only these may be picked (an admin
 * narrowing someone's device takes people away, never adds them); `rolesHint` says what a role grants here.
 */
export function AudiencePeoplePicker({
  value,
  onChange,
  ownerUserId,
  idPrefix,
  within,
  rolesHint,
  everyRole = false,
}: {
  value: { userIds: string[]; roleIds?: string[] };
  onChange: (next: { userIds: string[]; roleIds: string[] }) => void;
  ownerUserId: string | null;
  idPrefix: string;
  within?: { userIds: string[]; roleIds: string[] };
  rolesHint?: string;
  /** Every role to pick, in a personal workspace too (the agent page's own "Who can talk"). */
  everyRole?: boolean;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const owner = ownerUserId ? dir.memberById.get(ownerUserId) : undefined;
  const roles = useRoles(org.id);
  const [query, setQuery] = useState("");
  const picked = new Set(value.userIds);
  const pickedRoles = new Set(value.roleIds ?? []);
  const candidates = dir.members.filter(
    (m) => m.userId !== ownerUserId && (!within || within.userIds.includes(m.userId)),
  );
  // `everyone` ("Todos") is the first choice, not a role to pick. A personal workspace's family picks people, unless a
  // role is worth it or already picked (ADR 0159).
  const personal = isPersonal(org);
  const allRoles = roles.data?.roles ?? [];
  const roleCandidates =
    everyRole || rolePicksInSight(org, allRoles, value.roleIds ?? [])
      ? sortRoles(allRoles.filter((r) => !isEveryone(r) && (!within || within.roleIds.includes(r.id))))
      : [];
  const q = fold(query.trim());
  const rows = candidates.filter((m) => !q || fold(`${m.name} ${m.email} ${m.handle}`).includes(q));
  const roleRows = roleCandidates.filter((r) => !q || fold(r.name).includes(q));
  const toggle = (key: "userIds" | "roleIds", id: string, on: boolean) => {
    const next = new Set(value[key] ?? []);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ userIds: value.userIds, roleIds: value.roleIds ?? [], [key]: [...next] });
  };
  // Without a role to pick (a personal workspace's family), the search is for people only.
  const peopleOnly = personal && roleCandidates.length === 0;
  const searchLabel = t(peopleOnly ? "audience.searchPeople" : "audience.search");
  const roleGroup = (
    <>
      <PickerHeading label={t("audience.roles")} description={rolesHint ?? t("audience.rolesHint")} />
      <RoleChecklist
        roles={roleRows}
        picked={pickedRoles}
        onToggle={(id, on) => toggle("roleIds", id, on)}
        idPrefix={idPrefix}
      />
    </>
  );
  return (
    <div className="people-picker">
      {owner && (
        <span className="small muted">
          {picked.size > 0 || pickedRoles.size > 0
            ? t("audience.ownerAlways", { name: owner.name })
            : ownerUserId === me.user.id
              ? t("audience.onlyYouForNow")
              : t("audience.onlyOwnerForNow", { name: owner.name })}
        </span>
      )}
      {(picked.size > 0 || pickedRoles.size > 0) && (
        <TokenList label={t("audience.picked")}>
          {roleCandidates
            .filter((r) => pickedRoles.has(r.id))
            .map((r) => (
              <li key={r.id}>
                <Token
                  leading={<RoleMark color={r.color} icon={r.icon} size={18} />}
                  removeLabel={t("common.removeName", { name: r.name })}
                  onRemove={() => toggle("roleIds", r.id, false)}
                >
                  {r.name}
                </Token>
              </li>
            ))}
          {candidates
            .filter((m) => picked.has(m.userId))
            .map((m) => (
              <li key={m.userId}>
                <Token
                  leading={<Avatar kind="person" size="xs" name={m.name} imageUrl={m.image} />}
                  removeLabel={t("common.removeName", { name: m.name })}
                  onRemove={() => toggle("userIds", m.userId, false)}
                >
                  {m.name}
                </Token>
              </li>
            ))}
        </TokenList>
      )}
      <SearchField
        size="sm"
        aria-label={searchLabel}
        placeholder={searchLabel}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery("")}
        clearLabel={t("filters.clearSearch")}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="people-picker__results" role="region" aria-label={searchLabel}>
        {rows.length === 0 && roleRows.length === 0 ? (
          <p className="small muted">{t(peopleOnly ? "audience.noMatchPeople" : "audience.noMatch")}</p>
        ) : (
          <>
            {roleRows.length > 0 && !personal && roleGroup}
            {rows.length > 0 && (
              <>
                {roleRows.length > 0 && <PickerHeading label={t("audience.people")} />}
                {rows.map((m) => {
                  const id = `${idPrefix}-p-${m.userId.replace(/[^a-zA-Z0-9]/g, "-")}`;
                  return (
                    <label key={m.userId} htmlFor={id} className="scope-row">
                      <Checkbox
                        id={id}
                        checked={picked.has(m.userId)}
                        onCheckedChange={(on) => toggle("userIds", m.userId, on)}
                      />
                      <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                      <span className="scope-row__text">
                        <span>{m.name}</span>
                        <span className="small muted">{m.email}</span>
                      </span>
                    </label>
                  );
                })}
              </>
            )}
            {/* A personal workspace's family picks people first (ADR 0159). */}
            {roleRows.length > 0 && personal && roleGroup}
          </>
        )}
      </div>
    </div>
  );
}

/** A "people" audience needs someone (a person or a role) besides an absent owner. */
export const audienceValid = (a: AgentAudience, ownerUserId: string | null) =>
  a.mode === "everyone" ||
  (a.mode === "owner"
    ? Boolean(ownerUserId)
    : a.userIds.length > 0 || (a.roleIds?.length ?? 0) > 0 || Boolean(ownerUserId));
