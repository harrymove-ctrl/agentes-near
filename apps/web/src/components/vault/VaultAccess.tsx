import type { VaultAccess, VaultScope } from "@agenteschat/client";
import { useRoles } from "@agenteschat/client";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  AccessDialog,
  type AccessSubject,
  Avatar,
  AvatarStack,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  Locked,
  RoleMark,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentSwitches } from "@/components/AgentSwitches";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/*
 * Who has access to a Vault item, or to a connection's items by default (ADR 0144): the people who see it and on
 * whose behalf agents may use it (team only: a personal item is its owner's), the agents that may use it, and the
 * whole of it said in one sentence.
 */

type Directory = ReturnType<typeof useDirectory>;
type Level = "use" | "none";

const list = (locale: string, items: string[], type: "conjunction" | "disjunction") =>
  new Intl.ListFormat(locale, { style: "long", type }).format(items);

/** The first two names and "2 more", as one list. */
function shortList(t: TFunction, locale: string, names: string[]): string {
  if (names.length <= 3) return list(locale, names, "conjunction");
  return list(locale, [...names.slice(0, 2), t("vault.access.more", { count: names.length - 2 })], "conjunction");
}

function agentNames(dir: Directory, access: VaultAccess): string[] {
  return access.agentIds.map((id) => dir.agentById.get(id)?.name).filter((n): n is string => Boolean(n));
}

/** The people side in a few words: everyone, nobody but who manages the Vault, or the roles and people. */
export function peopleSummary(t: TFunction, locale: string, dir: Directory, access: VaultAccess): string {
  if (access.everyone) return t("vault.access.everyone");
  const names = [
    ...access.roleIds.map((id) => dir.roleName(id)),
    ...access.userIds.map((id) => dir.memberById.get(id)?.name),
  ].filter((n): n is string => Boolean(n));
  return names.length > 0 ? shortList(t, locale, names) : t("vault.access.managersOnly");
}

/** The agents side in a few words. */
export function agentsSummary(t: TFunction, locale: string, dir: Directory, access: VaultAccess): string {
  if (access.allAgents) return t("vault.access.allAgents");
  const names = agentNames(dir, access);
  return names.length > 0 ? shortList(t, locale, names) : t("vault.access.noAgents");
}

/**
 * The whole of it in one sentence, as the server decides it (ADR 0144 §3): which agents, and when someone asks.
 * "Dev and Infra can use it when someone in Support or Ana asks."
 */
export function accessSentence(
  t: TFunction,
  locale: string,
  dir: Directory,
  scope: VaultScope,
  access: VaultAccess,
): string {
  const names = agentNames(dir, access);
  if (!access.allAgents && names.length === 0) return t("vault.summary.noAgents");
  const agents = access.allAgents ? t("vault.summary.allAgents") : list(locale, names, "conjunction");
  const count = access.allAgents ? 1 : names.length;
  if (scope === "personal") return t("vault.summary.personal", { agents, count });
  if (access.everyone) return t("vault.summary.everyone", { agents, count });
  const people = [
    ...access.roleIds
      .map((id) => dir.roleName(id))
      .filter((n): n is string => Boolean(n))
      .map((role) => t("vault.summary.inRole", { role })),
    ...access.userIds.map((id) => dir.memberById.get(id)?.name).filter((n): n is string => Boolean(n)),
  ];
  if (people.length === 0) return t("vault.summary.nobody");
  return t("vault.summary.people", { agents, count, people: list(locale, people, "disjunction") });
}

/** "Who can see it" (team): everyone, or roles and people, in the shared access dialog. */
export function PeopleAccessDialog({
  access,
  saving,
  onSave,
  onClose,
}: {
  access: VaultAccess;
  saving?: boolean;
  onSave: (access: VaultAccess) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const dir = useDirectory(org.id);
  const [everyone, setEveryone] = useState<Level>(access.everyone ? "use" : "none");
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set([...access.roleIds.map((id) => `r:${id}`), ...access.userIds.map((id) => `u:${id}`)]),
  );
  const use = { value: "use" as const, label: t("vault.access.level.use") };
  const subjects: AccessSubject[] = [
    ...sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).map((r) => ({
      id: `r:${r.id}`,
      name: r.name,
      detail: t("vault.access.roleDetail"),
      group: t("vault.access.roles"),
      lead: <RoleMark color={r.color} icon={r.icon} size={24} />,
    })),
    ...dir.members.map((m) => ({
      id: `u:${m.userId}`,
      name: m.name,
      detail: m.email,
      group: t("vault.access.peopleGroup"),
      lead: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
    })),
  ];
  return (
    <AccessDialog<Level>
      title={t("vault.access.peopleTitle")}
      description={t("vault.access.peopleText")}
      base={[
        {
          id: "everyone",
          name: t("vault.access.everyone"),
          detail: t("vault.access.everyoneText"),
          lead: <Icon name="audienceEveryone" size={20} />,
          level: everyone,
          levels: [use, { value: "none", label: t("vault.access.level.none") }],
          onChange: setEveryone,
        },
      ]}
      subjects={subjects}
      // While everyone may, a row would say nothing: the rows come back when "everyone" is lowered.
      levelOf={(s) => (everyone === "use" || !picked.has(s.id) ? undefined : "use")}
      levelsFor={() => [use]}
      onLevelChange={(s, level) => {
        setPicked((p) => {
          const next = new Set(p);
          if (level) next.add(s.id);
          else next.delete(s.id);
          return next;
        });
        // Adding someone while everyone may means limiting it: "everyone" drops, in plain sight, until Save.
        if (level) setEveryone("none");
      }}
      labels={{
        add: t("vault.access.add"),
        addList: t("vault.access.add"),
        addSearch: t("vault.access.addSearch"),
        noResults: t("vault.access.noMatch"),
        removeOf: (name) => t("common.removeName", { name }),
        levelOf: (name) => t("vault.access.levelOf", { name }),
        close: t("common.close"),
        cancel: t("common.cancel"),
        save: t("common.save"),
      }}
      saving={saving}
      onSave={() => {
        const ids = [...picked];
        const of = (prefix: string) => ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(2));
        onSave(
          everyone === "use"
            ? { ...access, everyone: true, roleIds: [], userIds: [] }
            : { ...access, everyone: false, roleIds: of("r:"), userIds: of("u:") },
        );
      }}
      onClose={onClose}
    />
  );
}

/** "Which agents can use it": every agent (now and later), or the ones switched on. */
export function AgentsAccessDialog({
  scope,
  access,
  saving,
  onSave,
  onClose,
}: {
  scope: VaultScope;
  access: VaultAccess;
  saving?: boolean;
  onSave: (access: VaultAccess) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(access.allAgents);
  const [ids, setIds] = useState(access.agentIds);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.agents.title")}
      description={scope === "personal" ? t("vault.agents.textPersonal") : t("vault.agents.textTeam")}
      closeLabel={t("common.close")}
      width={480}
    >
      <Locked when={Boolean(saving)}>
        <DialogBody>
          <AgentSwitches
            value={ids}
            onChange={setIds}
            all={{
              checked: all,
              onChange: setAll,
              label: t("vault.agents.all"),
              detail: t("vault.agents.allDetail"),
            }}
          />
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={saving}
          onClick={() => onSave({ ...access, allAgents: all, agentIds: all ? [] : ids })}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The agents' faces, at most four, or the icon for all of them. */
export function AgentFaces({ access }: { access: VaultAccess }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (access.allAgents)
    return (
      <span className="vlt-faces__all" aria-hidden="true">
        <Icon name="members" size={14} />
      </span>
    );
  const agents = access.agentIds
    .map((id) => dir.agentById.get(id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  if (agents.length === 0) return null;
  return (
    <AvatarStack>
      {agents.slice(0, 4).map((a) => (
        <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
      ))}
    </AvatarStack>
  );
}

/**
 * One line of the access block: its icon on the top row with what it is (Edit at its end), then who under it (after
 * the agents' faces, for the agents). Every line's icon, the scope's too, keeps one width, so the words line up.
 */
function AccessLine({
  icon,
  faces,
  label,
  value,
  editLabel,
  onEdit,
}: {
  icon: IconName;
  faces?: ReactNode;
  label: string;
  value: string;
  editLabel?: string;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="vlt-access__line">
      <span className="vlt-access__lead" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <b className="vlt-access__label">{label}</b>
      {onEdit && (
        <Button size="sm" variant="ghost" className="vlt-access__edit" aria-label={editLabel} onClick={onEdit}>
          {t("vault.access.edit")}
        </Button>
      )}
      <span className="vlt-access__value">
        {faces}
        <span title={value}>{value}</span>
      </span>
    </div>
  );
}

/**
 * The access block of an item (the dialog's aside) or a connection: Personal or Team, the people (team), the agents,
 * and the sentence. `onChange` saves (an item, a connection) or changes a draft (a new item).
 */
export function AccessBlock({
  scope,
  access,
  editable,
  saving,
  onChange,
  children,
}: {
  scope: VaultScope;
  access: VaultAccess;
  /** Who may change it: false shows it, without Edit. */
  editable: boolean;
  saving?: boolean;
  /** Saves (or changes the draft): `false` when it failed, and the dialog stays open with the person's choice. */
  onChange: (access: VaultAccess) => Promise<boolean> | boolean;
  /** Under the sentence: a note on where the access comes from. */
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [editing, setEditing] = useState<null | "people" | "agents">(null);
  const save = async (next: VaultAccess) => {
    if (await onChange(next)) setEditing(null);
  };
  const peopleLabel = t("vault.access.people");
  const agentsLabel = t("vault.access.agents");
  return (
    <div className="vlt-access">
      {scope === "team" && (
        <AccessLine
          icon={access.everyone ? "audienceEveryone" : "audiencePeople"}
          label={peopleLabel}
          value={peopleSummary(t, i18n.language, dir, access)}
          editLabel={t("vault.access.editOf", { what: peopleLabel })}
          onEdit={editable ? () => setEditing("people") : undefined}
        />
      )}
      <AccessLine
        icon="agent"
        // The line's own icon says agents: faces only for the agents chosen, no second icon for all of them.
        faces={access.allAgents ? undefined : <AgentFaces access={access} />}
        label={agentsLabel}
        value={agentsSummary(t, i18n.language, dir, access)}
        editLabel={t("vault.access.editOf", { what: agentsLabel })}
        onEdit={editable ? () => setEditing("agents") : undefined}
      />
      <p className="vlt-access__sentence">{accessSentence(t, i18n.language, dir, scope, access)}</p>
      {children}
      {editing === "people" && (
        <PeopleAccessDialog access={access} saving={saving} onSave={save} onClose={() => setEditing(null)} />
      )}
      {editing === "agents" && (
        <AgentsAccessDialog
          scope={scope}
          access={access}
          saving={saving}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
