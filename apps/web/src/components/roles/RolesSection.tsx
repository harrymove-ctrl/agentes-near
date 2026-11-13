import type { OrgRole, OrgRoles, PermissionArea, Person } from "@agenteschat/client";
import {
  useChangeRole,
  useCreateRole,
  useDeleteRole,
  usePeople,
  useReorderRoles,
  useRoles,
  useSetMemberRoles,
  useUpdateRole,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { can, type RolePermission } from "@agenteschat/client/lib/permissions";
import {
  type AreaLevel,
  areaLine,
  COMPUTER_KEYS,
  type ComputerLevel,
  computerChoice,
  everyoneOf,
  giveRole,
  holdsAll,
  isBelow,
  isEveryone,
  keyState,
  levelLabel,
  levelOf,
  levelOptions,
  newRoleInput,
  PEOPLE_SEARCH_FROM,
  type PermissionAreaId,
  peopleWith,
  ROLE_TEMPLATES,
  roleLock,
  roleName,
  roleSummary,
  sortRoles,
  withComputerLevel,
  withKey,
  withLevel,
} from "@agenteschat/client/lib/roles";
import {
  Avatar,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  ditherUrl,
  Icon,
  type IconName,
  InfoHint,
  Input,
  Locked,
  Menu,
  MenuItem,
  PageHeader,
  RoleMark,
  Segmented,
  Switch,
  ToolLevelSwatch,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import "./roles.css";

/**
 * Settings › Papéis e permissões (ADR 0085): the roles as rows that each sum themselves up in a sentence; a role
 * opens on its own page, with one level per area (Como Todos · Usar · Gerenciar) and item by item behind
 * "Ajustar", the people who hold it, and its name, color and icon. The owner is shown as a role on top.
 */

const AREA_ICONS: Record<string, IconName> = {
  chat: "message",
  agents: "agent",
  tools: "plug",
  knowledge: "book",
  org: "settings",
};

/** The owner, drawn as a role on top (it isn't one on the server: `organization_members.role`). */
const OWNER_ID = "owner";

export function RolesSection() {
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const people = usePeople(org.id);
  const [open, setOpen] = useState<string | null>(null);
  if (roles.isLoading || people.isLoading || !roles.data) return <LoadingList count={4} trailing />;
  const list = sortRoles(roles.data.roles);
  const role = open === OWNER_ID ? OWNER_ID : list.find((r) => r.id === open);
  if (role === OWNER_ID) return <OwnerPage people={people.data ?? []} onBack={() => setOpen(null)} />;
  if (role)
    return (
      <RolePage
        key={role.id}
        role={role}
        data={roles.data}
        people={people.data ?? []}
        onBack={() => setOpen(null)}
        onOpen={setOpen}
      />
    );
  return <RoleList roles={list} people={people.data ?? []} onOpen={setOpen} />;
}

function PeopleStack({ people }: { people: Person[] }) {
  return (
    <span className="roles-row__people">
      <span className="roles-stack" aria-hidden="true">
        {people.slice(0, 3).map((p) => (
          <Avatar key={p.userId} size="xs" name={p.name} imageUrl={p.avatarUrl ?? p.image} />
        ))}
      </span>
      <span className="tabular">{people.length}</span>
    </span>
  );
}

function RoleList({ roles, people, onOpen }: { roles: OrgRole[]; people: Person[]; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const reorder = useReorderRoles(org.id);
  const [ordering, setOrdering] = useState(false);
  const [creating, setCreating] = useState(false);
  const everyone = everyoneOf(roles);
  const custom = roles.filter((r) => !isEveryone(r));
  const owners = people.filter((p) => p.role === "owner");
  const manages = can(org, "manage_roles");

  const move = (role: OrgRole, by: -1 | 1) => {
    const ids = custom.map((r) => r.id);
    const i = ids.indexOf(role.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
    reorder.mutate(ids, { onError: (e) => toast.show(errorText(t, e), "error") });
  };

  const row = (role: OrgRole) => {
    const i = custom.indexOf(role);
    const above = custom[i - 1];
    return (
      <div key={role.id} className="roles-line">
        {ordering && !isEveryone(role) && (
          <span className="roles-move">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronUp"
              aria-label={t("rolesPage.moveUp", { name: role.name })}
              disabled={!role.editable || !above?.editable}
              onClick={() => move(role, -1)}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronDown"
              aria-label={t("rolesPage.moveDown", { name: role.name })}
              disabled={!role.editable || i === custom.length - 1}
              onClick={() => move(role, 1)}
            />
          </span>
        )}
        <button type="button" className="roles-row ac-mediarow ac-mediarow--row" onClick={() => onOpen(role.id)}>
          <span className="ac-mediarow__face">
            <RoleMark color={role.color} icon={role.icon} size={24} />
          </span>
          <span className="ac-mediarow__head">
            <b>{roleName(t, role)}</b>
            {isEveryone(role) && <Chip className="roles-base-chip">{t("rolesPage.base")}</Chip>}
          </span>
          <span className="ac-mediarow__end">
            <PeopleStack people={peopleWith(role, people)} />
            <Icon name="chevronRight" size={18} />
          </span>
          <span className="ac-mediarow__body roles-row__sum">{roleSummary(t, i18n.language, role, everyone)}</span>
        </button>
      </div>
    );
  };

  return (
    <div className="roles">
      <PageHeader
        level={2}
        title={t("settings.section.roles")}
        meta={t("settings.sectionText.roles")}
        actions={
          manages && (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t("rolesPage.create")}
            </Button>
          )
        }
      />
      <Card className="roles-list" aria-label={t("settings.section.roles")}>
        <div className="roles-line">
          <button type="button" className="roles-row ac-mediarow ac-mediarow--row" onClick={() => onOpen(OWNER_ID)}>
            <span className="ac-mediarow__face">
              <RoleMark color="violet" icon="audienceOwner" size={24} />
            </span>
            <span className="ac-mediarow__head">
              <b>{t("roles.owner")}</b>
            </span>
            <span className="ac-mediarow__end">
              <PeopleStack people={owners} />
              <Icon name="chevronRight" size={18} />
            </span>
            <span className="ac-mediarow__body roles-row__sum">{t("rolesPage.summary.owner")}</span>
          </button>
        </div>
        {custom.map(row)}
        {everyone && row(everyone)}
        <CardFooter>
          <span className="roles-foot ac-actline">
            <span>{t("rolesPage.orderHint")}</span>
            {manages && custom.length > 1 && (
              <span className="ac-acts">
                <Button size="sm" variant="ghost" onClick={() => setOrdering((v) => !v)}>
                  {ordering ? t("rolesPage.reorderDone") : t("rolesPage.reorder")}
                </Button>
              </span>
            )}
          </span>
        </CardFooter>
      </Card>
      <NewRoleDialog
        open={creating}
        onOpenChange={setCreating}
        roles={custom}
        onCreated={(id) => {
          setCreating(false);
          onOpen(id);
        }}
      />
    </div>
  );
}

const SWATCH: Record<AreaLevel, "read" | "write" | "approval" | "off"> = {
  none: "read",
  use: "read",
  manage: "write",
  custom: "approval",
};

function LevelMark({ role, level }: { role: OrgRole; level: AreaLevel }) {
  if (level === "none" && isEveryone(role)) return <ToolLevelSwatch level="off" />;
  // "Como Todos" in Todos' own tones; the rest in the role's.
  return <ToolLevelSwatch level={SWATCH[level]} color={(level === "none" ? "graphite" : role.color) as "graphite"} />;
}

function RolePage({
  role,
  data,
  people,
  onBack,
  onOpen,
}: {
  role: OrgRole;
  data: OrgRoles;
  people: Person[];
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateRole(org.id);
  const remove = useDeleteRole(org.id);
  const create = useCreateRole(org.id);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const everyone = everyoneOf(data.roles);
  const base = isEveryone(role);
  const locked = roleLock(org, role);
  const lock = locked && t(`rolesPage.locked.${locked}`);
  const admin = !base && role.permissions.includes("administrator");
  const holders = peopleWith(role, people);
  const name = roleName(t, role);
  const fail = (e: unknown) => toast.show(errorText(t, e), "error");
  const save = (permissions: string[]) => update.mutate({ roleId: role.id, patch: { permissions } }, { onError: fail });

  const area = (a: PermissionArea) => {
    const level = levelOf(role, a, everyone);
    const options = levelOptions(role, a, everyone);
    const keys = a.keys.filter((k) => !COMPUTER_KEYS.includes(k));
    const expanded = open.has(a.id);
    const line = areaLine(t, i18n.language, role, a, everyone);
    const label = t(`permissions.areas.${a.id as PermissionAreaId}`);
    return (
      <div key={a.id} className="roles-area" data-off={admin || undefined}>
        <div className="roles-area__top">
          <span className="roles-area__icon" aria-hidden="true">
            <Icon name={AREA_ICONS[a.id] ?? "settings"} size={20} />
          </span>
          <span className="roles-area__text">
            <b>{label}</b>
            <span className="roles-area__line">{line}</span>
          </span>
          {!admin &&
            (lock ? (
              <Chip lead={<LevelMark role={role} level={level} />}>{levelLabel(t, role, level)}</Chip>
            ) : (
              <Segmented<AreaLevel>
                size="sm"
                label={t("rolesPage.levelsOf", { area: label })}
                value={level}
                onValueChange={(v) => v !== "custom" && save(withLevel(role, a, v))}
                options={[...options, ...(level === "custom" ? (["custom"] as const) : [])].map((v) => ({
                  value: v,
                  label: levelLabel(t, role, v),
                  mark: <LevelMark role={role} level={v} />,
                }))}
              />
            ))}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronDown"
            className="roles-area__more"
            aria-expanded={expanded}
            aria-label={t("rolesPage.adjust", { area: label })}
            onClick={() =>
              setOpen((s) => {
                const next = new Set(s);
                if (next.has(a.id)) next.delete(a.id);
                else next.add(a.id);
                return next;
              })
            }
          />
        </div>
        {a.id === "tools" && <ComputerChoice role={role} everyone={everyone} lock={!!lock || admin} onSave={save} />}
        {expanded && (
          <div className="roles-area__items">
            {keys.map((k) => (
              <KeyRow key={k} role={role} everyone={everyone} k={k as RolePermission} lock={!!lock} onSave={save} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="roles">
      <button type="button" className="roles-back" onClick={onBack}>
        <Icon name="chevronLeft" size={16} />
        {t("rolesPage.back")}
      </button>
      <header className="roles-id">
        <RoleMark color={role.color} icon={role.icon} size={64} />
        <div className="roles-id__text">
          <h2 className="roles-id__name">{name}</h2>
          <span className="roles-id__handle">{t("rolesPage.people", { count: holders.length })}</span>
        </div>
        {!base && role.editable && holdsAll(org, role.permissions) && (
          <Menu
            align="end"
            label={t("rolesPage.more")}
            trigger={<Button size="sm" iconOnly icon="more" aria-label={t("rolesPage.more")} />}
          >
            <MenuItem
              icon="copy"
              onSelect={() =>
                create.mutate(
                  {
                    name: t("rolesPage.copyName", { name: role.name }).slice(0, 40),
                    icon: role.icon,
                    color: role.color,
                    permissions: role.permissions,
                  },
                  { onSuccess: (r) => onOpen(r.id), onError: fail },
                )
              }
            >
              {t("rolesPage.duplicate")}
            </MenuItem>
            <MenuItem icon="trash" danger onSelect={() => setDeleting(true)}>
              {t("rolesPage.delete")}
            </MenuItem>
          </Menu>
        )}
      </header>
      {lock && (
        <p className="roles-note ac-iconline">
          <Icon name="lock" size={16} />
          <span>{lock}</span>
        </p>
      )}
      <Card aria-labelledby="role-can">
        <CardHeader
          id="role-can"
          icon="shield"
          title={t("rolesPage.canDo", { name })}
          subtitle={roleSummary(t, i18n.language, role, everyone)}
        />
        {base && <p className="roles-base">{t("rolesPage.everyoneNote")}</p>}
        {!base && (
          <div className="roles-area roles-area--admin">
            <div className="roles-area__top">
              <span className="roles-area__icon" aria-hidden="true">
                <Icon name="shield" size={20} />
              </span>
              <label className="roles-area__text" htmlFor="role-admin">
                <b>{t("rolesPage.administrator")}</b>
                <span>{t("rolesPage.administratorDesc")}</span>
              </label>
              <Switch
                id="role-admin"
                checked={admin}
                disabled={!!lock}
                onCheckedChange={(on) => save(withKey(role, "administrator", on))}
              />
            </div>
          </div>
        )}
        {data.areas.map(area)}
        <CardFooter>{base ? t("rolesPage.areaFootBase") : t("rolesPage.areaFoot")}</CardFooter>
      </Card>
      <RolePeople role={role} roles={data.roles} people={people} />
      <RoleLook role={role} data={data} lock={!!lock} />
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("rolesPage.deleteTitle", { name })}
        description={t("common.joinSentences", { a: t("rolesPage.deleteText"), b: t("common.cantUndo") })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(role.id, {
                onSuccess: () => {
                  toast.show(t("rolesPage.deleted", { name }));
                  setDeleting(false);
                  onBack();
                },
                onError: fail,
              })
            }
          >
            {t("rolesPage.delete")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/**
 * The agents' computers as one choice (`computerLevelOf`): nothing, the browser, the whole computer, on every agent
 * (`everyone`: on what is the person's own). Below what `everyone` already gives isn't offered.
 */
function ComputerChoice({
  role,
  everyone,
  lock,
  onSave,
}: {
  role: OrgRole;
  everyone: OrgRole | undefined;
  lock: boolean;
  onSave: (permissions: string[]) => void;
}) {
  const { t } = useTranslation();
  const { options, shown, reach } = computerChoice(role, everyone);
  return (
    <div className="roles-computer">
      <span className="roles-key__text">
        <b>{t("rolesPage.computer.title")}</b>
        <span>{t(`rolesPage.computer.${reach}.${shown}`)}</span>
      </span>
      <Segmented<ComputerLevel>
        size="sm"
        label={t("rolesPage.computer.title")}
        value={shown}
        disabled={lock}
        onValueChange={(v) => v !== shown && onSave(withComputerLevel(role, v))}
        options={options.map((v) => ({ value: v, label: t(`rolesPage.computer.levels.${v}`) }))}
      />
    </div>
  );
}

function KeyRow({
  role,
  everyone,
  k,
  lock,
  onSave,
}: {
  role: OrgRole;
  everyone: OrgRole | undefined;
  k: RolePermission;
  lock: boolean;
  onSave: (permissions: string[]) => void;
}) {
  const { t } = useTranslation();
  const { on, from } = keyState(role, everyone, k);
  const viaAdmin = from === "admin";
  const viaAll = from === "everyone";
  const id = `role-key-${k}`;
  return (
    <div className="roles-key ac-actrow">
      <label className="roles-key__text ac-actrow__text" htmlFor={id}>
        <b>{t(`permissions.${k}.title`)}</b>
        <span>{t(`permissions.${k}.desc`)}</span>
      </label>
      {(viaAdmin || viaAll) && (
        <span className="roles-key__from">
          <Icon name={viaAdmin ? "shield" : "audienceEveryone"} size={14} />
          {viaAdmin ? t("rolesPage.fromAdmin") : t("rolesPage.fromEveryone")}
        </span>
      )}
      <Switch
        id={id}
        checked={on}
        disabled={lock || viaAdmin || viaAll}
        onCheckedChange={(next) => onSave(withKey(role, k, next))}
      />
    </div>
  );
}

function RolePeople({ role, roles, people }: { role: OrgRole; roles: OrgRole[]; people: Person[] }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const set = useSetMemberRoles(org.id);
  const [adding, setAdding] = useState(false);
  const holders = peopleWith(role, people);
  const name = roleName(t, role);
  const gives = !isEveryone(role) && role.givable && can(org, "manage_members");
  const viewer = { role: org.role, rank: org.rank, userId: me.user.id };
  const below = (p: Person) => isBelow(viewer, p, roles);
  const others = (p: Person) =>
    sortRoles(roles.filter((r) => r.id !== role.id && !isEveryone(r) && (p.roleIds ?? []).includes(r.id)));
  return (
    <Card aria-labelledby="role-people">
      <CardHeader
        id="role-people"
        icon="members"
        title={t("rolesPage.peopleTitle")}
        subtitle={t("rolesPage.peopleSub", { count: holders.length, name })}
        action={
          gives ? (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              {t("rolesPage.addPeople")}
            </Button>
          ) : undefined
        }
      />
      {isEveryone(role) && <p className="roles-base">{t("rolesPage.everyonePeople")}</p>}
      {holders.length === 0 ? (
        <p className="roles-empty">{t("rolesPage.nobody", { name })}</p>
      ) : (
        <ul className="roles-people">
          {holders.map((p) => (
            <li key={p.userId} className="roles-person ac-mediarow ac-mediarow--row">
              <span className="ac-mediarow__face">
                <Avatar size="sm" name={p.name} imageUrl={p.avatarUrl ?? p.image} />
              </span>
              <span className="ac-mediarow__head">
                <b>
                  {p.name}
                  {p.userId === me.user.id ? t("common.youSuffix") : ""}
                </b>
                <span className="ac-mediarow__meta">{p.email}</span>
              </span>
              {others(p).length > 0 && (
                <span className="ac-mediarow__body roles-chips">
                  {others(p).map((r) => (
                    <RoleChip key={r.id} role={r} />
                  ))}
                </span>
              )}
              {gives && below(p) && (
                <span className="ac-mediarow__end">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("rolesPage.removeOf", { person: p.name, name })}
                    onClick={() =>
                      set.mutate(
                        { userId: p.userId, roleIds: (p.roleIds ?? []).filter((id) => id !== role.id) },
                        { onError: (e) => toast.show(errorText(t, e), "error") },
                      )
                    }
                  >
                    {t("rolesPage.remove")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <AddPeopleDialog
        open={adding}
        onOpenChange={setAdding}
        title={t("rolesPage.addTitle", { name })}
        candidates={people.filter((p) => !(p.roleIds ?? []).includes(role.id) && below(p))}
        roles={roles}
        emptyText={t("rolesPage.noOneLeft", { name })}
        onAdd={async (ids) => {
          const { added, failed } = await giveRole(people, ids, role.id, set.mutateAsync);
          if (added > 0) toast.show(t("rolesPage.added", { count: added, name }));
          if (failed) toast.show(errorText(t, failed), "error");
        }}
      />
    </Card>
  );
}

/** A role's small chip: its mark and name. */
export function RoleChip({ role }: { role: OrgRole }) {
  const { t } = useTranslation();
  return (
    <Chip className="roles-chip" lead={<RoleMark color={role.color} icon={role.icon} size={18} />}>
      {roleName(t, role)}
    </Chip>
  );
}

function RoleLook({ role, data, lock }: { role: OrgRole; data: OrgRoles; lock: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateRole(org.id);
  const base = isEveryone(role);
  const [draft, setDraft] = useState(role.name);
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) =>
    update.mutate({ roleId: role.id, patch: p }, { onError: (e) => toast.show(errorText(t, e), "error") });
  return (
    <Card aria-labelledby="role-look">
      <CardHeader id="role-look" icon="edit" title={t("rolesPage.lookTitle")} />
      <div className="roles-look">
        <div className="roles-look__row">
          <span className="roles-look__text">
            <span className="ac-hintline">
              <label htmlFor="role-name">
                <b>{t("rolesPage.name")}</b>
              </label>
              {!base && (
                <InfoHint name={t("common.about", { label: t("rolesPage.name") })}>{t("rolesPage.nameDesc")}</InfoHint>
              )}
            </span>
            {base && <span className="roles-look__status">{t("rolesPage.locked.everyone")}</span>}
          </span>
          <Input
            id="role-name"
            className="roles-look__name"
            value={base ? t("rolesPage.everyoneName") : draft}
            maxLength={40}
            readOnly={lock || base}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const next = draft.trim();
              if (next && next !== role.name) patch({ name: next });
              else setDraft(role.name);
            }}
          />
        </div>
        <div className="roles-look__row">
          <span className="roles-look__text">
            <span className="ac-hintline">
              <b>{t("rolesPage.color")}</b>
              <InfoHint name={t("common.about", { label: t("rolesPage.color") })}>{t("rolesPage.colorDesc")}</InfoHint>
            </span>
          </span>
          <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
            {data.colors.map((c) => (
              // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={role.color === c}
                aria-label={t("rolesPage.colorOf", { color: c })}
                disabled={lock}
                className="roles-color"
                style={{ backgroundImage: `url("${ditherUrl(c as "graphite", 8)}")` }}
                onClick={() => patch({ color: c })}
              />
            ))}
          </div>
        </div>
        {!base && (
          <div className="roles-look__row">
            <span className="roles-look__text">
              <span className="ac-hintline">
                <b>{t("rolesPage.icon")}</b>
                <InfoHint name={t("common.about", { label: t("rolesPage.icon") })}>{t("rolesPage.iconDesc")}</InfoHint>
              </span>
            </span>
            <div className="roles-icons" role="radiogroup" aria-label={t("rolesPage.icon")}>
              {data.icons.map((n) => (
                // biome-ignore lint/a11y/useSemanticElements: an icon button in a radio group
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={role.icon === n}
                  aria-label={n}
                  disabled={lock}
                  className="roles-iconpick"
                  onClick={() => patch({ icon: n })}
                >
                  <Icon name={n as IconName} size={18} />
                </button>
              ))}
            </div>
          </div>
        )}
        {!base && (
          <div className="roles-look__row roles-look__row--switch">
            <span className="roles-look__text">
              <span className="ac-hintline">
                <label htmlFor="role-hoist">
                  <b>{t("rolesPage.hoist")}</b>
                </label>
                <InfoHint name={t("common.about", { label: t("rolesPage.hoist") })}>
                  {t("rolesPage.hoistDesc")}
                </InfoHint>
              </span>
            </span>
            <Switch
              id="role-hoist"
              checked={role.hoist}
              disabled={lock}
              onCheckedChange={(hoist) => patch({ hoist })}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

/** The owners as a role: what only they do, and who they are (owners make more owners). */
function OwnerPage({ people, onBack }: { people: Person[]; onBack: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const change = useChangeRole(org.id);
  const [adding, setAdding] = useState(false);
  const owners = people.filter((p) => p.role === "owner");
  const mine = can(org, "manage_owners");
  const fail = (e: unknown) => toast.show(errorText(t, e), "error");
  const items: { icon: IconName; title: string; desc: string }[] = [
    { icon: "audienceOwner", title: t("rolesPage.owner.transfer"), desc: t("rolesPage.owner.transferDesc") },
    { icon: "members", title: t("rolesPage.owner.owners"), desc: t("rolesPage.owner.ownersDesc") },
    { icon: "trash", title: t("rolesPage.owner.delete"), desc: t("rolesPage.owner.deleteDesc") },
  ];
  return (
    <div className="roles">
      <button type="button" className="roles-back" onClick={onBack}>
        <Icon name="chevronLeft" size={16} />
        {t("rolesPage.back")}
      </button>
      <header className="roles-id">
        <RoleMark color="violet" icon="audienceOwner" size={64} />
        <div className="roles-id__text">
          <h2 className="roles-id__name">{t("roles.owner")}</h2>
          <span className="roles-id__handle">{t("rolesPage.people", { count: owners.length })}</span>
        </div>
      </header>
      <Card aria-labelledby="owner-only">
        <CardHeader
          id="owner-only"
          icon="lock"
          title={t("rolesPage.owner.title")}
          subtitle={t("rolesPage.owner.sub")}
        />
        {items.map((i) => (
          <div key={i.title} className="roles-area">
            <div className="roles-area__top">
              <span className="roles-area__icon" aria-hidden="true">
                <Icon name={i.icon} size={20} />
              </span>
              <span className="roles-area__text">
                <b>{i.title}</b>
                <span>{i.desc}</span>
              </span>
            </div>
          </div>
        ))}
        <CardFooter>{t("rolesPage.owner.foot")}</CardFooter>
      </Card>
      <Card aria-labelledby="owner-people">
        <CardHeader
          id="owner-people"
          icon="members"
          title={t("rolesPage.peopleTitle")}
          subtitle={t("rolesPage.peopleSub", { count: owners.length, name: t("roles.owner") })}
          action={
            mine ? (
              <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
                {t("rolesPage.addPeople")}
              </Button>
            ) : undefined
          }
        />
        {owners.length === 1 && <p className="roles-base">{t("rolesPage.soleOwner")}</p>}
        <ul className="roles-people">
          {owners.map((p) => (
            <li key={p.userId} className="roles-person ac-mediarow ac-mediarow--row">
              <span className="ac-mediarow__face">
                <Avatar size="sm" name={p.name} imageUrl={p.avatarUrl ?? p.image} />
              </span>
              <span className="ac-mediarow__head">
                <b>
                  {p.name}
                  {p.userId === me.user.id ? t("common.youSuffix") : ""}
                </b>
                <span className="ac-mediarow__meta">{p.email}</span>
              </span>
              {mine && owners.length > 1 && (
                <span className="ac-mediarow__end">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("rolesPage.removeOf", { person: p.name, name: t("roles.owner") })}
                    onClick={() => change.mutate({ userId: p.userId, role: "member" }, { onError: fail })}
                  >
                    {t("rolesPage.remove")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <AddPeopleDialog
        open={adding}
        onOpenChange={setAdding}
        title={t("rolesPage.addTitle", { name: t("roles.owner") })}
        candidates={people.filter((p) => p.role !== "owner")}
        roles={[]}
        emptyText={t("rolesPage.noOneLeft", { name: t("roles.owner") })}
        onAdd={async (ids) => {
          for (const id of ids) await change.mutateAsync({ userId: id, role: "owner" });
          toast.show(t("rolesPage.added", { count: ids.length, name: t("roles.owner") }));
        }}
      />
    </div>
  );
}

function AddPeopleDialog({
  open,
  onOpenChange,
  title,
  candidates,
  roles,
  emptyText,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  candidates: Person[];
  roles: OrgRole[];
  emptyText: string;
  onAdd: (userIds: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // Who could get it before Adicionar, also while it closes: the ones being added keep their rows.
  const listed = useHeldWhile(candidates, busy || !open);
  const q = query.trim().toLowerCase();
  const shown = listed.filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q));
  const close = (next: boolean) => {
    if (!next) {
      setPicked(new Set());
      setQuery("");
    }
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={t("rolesPage.addSub")}
      closeLabel={t("common.close")}
      width={440}
    >
      <Locked when={busy}>
        <DialogBody>
          {listed.length > PEOPLE_SEARCH_FROM && (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("rolesPage.searchPeople")}
              aria-label={t("rolesPage.searchPeople")}
            />
          )}
          {shown.length === 0 ? (
            <p className="roles-empty">{emptyText}</p>
          ) : (
            <ul className="roles-pick">
              {shown.map((p) => {
                const on = picked.has(p.userId);
                const held = sortRoles(roles.filter((r) => !isEveryone(r) && (p.roleIds ?? []).includes(r.id)));
                return (
                  <li key={p.userId}>
                    <button
                      type="button"
                      className="roles-pick__row"
                      aria-pressed={on}
                      onClick={() =>
                        setPicked((s) => {
                          const next = new Set(s);
                          if (next.has(p.userId)) next.delete(p.userId);
                          else next.add(p.userId);
                          return next;
                        })
                      }
                    >
                      <span className="ac-check" data-state={on ? "checked" : "unchecked"} aria-hidden="true">
                        {on && <Icon name="check" size={14} />}
                      </span>
                      <span className="roles-pick__who ac-mediarow ac-mediarow--row">
                        <span className="ac-mediarow__face">
                          <Avatar size="sm" name={p.name} imageUrl={p.avatarUrl ?? p.image} />
                        </span>
                        <span className="ac-mediarow__head">
                          <b>{p.name}</b>
                          <span className="ac-mediarow__meta">{p.email}</span>
                        </span>
                        {held.length > 0 && (
                          <span className="ac-mediarow__body roles-chips">
                            {held.map((r) => (
                              <RoleChip key={r.id} role={r} />
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button onClick={() => close(false)}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={picked.size === 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd([...picked]);
              close(false);
            } catch (e) {
              toast.show(errorText(t, e), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          {picked.size ? t("rolesPage.addCount", { count: picked.size }) : t("rolesPage.add")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function NewRoleDialog({
  open,
  onOpenChange,
  roles,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: OrgRole[];
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const create = useCreateRole(org.id);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("blank");
  const copies = roles.filter((r) => holdsAll(org, r.permissions));
  const choices = [
    ...ROLE_TEMPLATES.map((x) => ({
      id: x.id,
      title: t(`rolesPage.templates.${x.id}`),
      desc: t(`rolesPage.templates.${x.id}Desc`),
    })),
    ...copies.map((r) => ({ id: `copy:${r.id}`, title: t("rolesPage.templates.copyOf", { name: r.name }), desc: "" })),
  ];
  const submit = () => {
    const typed = name.trim();
    if (!typed) return;
    create.mutate(newRoleInput(typed, from, copies), {
      onSuccess: (r) => {
        toast.show(t("rolesPage.created", { name: typed }));
        setName("");
        setFrom("blank");
        onCreated(r.id);
      },
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("rolesPage.newTitle")}
      description={t("rolesPage.newSub")}
      closeLabel={t("common.close")}
      width={440}
    >
      <Locked when={create.isPending}>
        <DialogBody>
          <label className="roles-field" htmlFor="new-role-name">
            {t("rolesPage.name")}
            <Input
              id="new-role-name"
              value={name}
              maxLength={40}
              autoFocus
              placeholder={t("rolesPage.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <div className="roles-field">
            {t("rolesPage.startFrom")}
            <div className="roles-templates" role="radiogroup" aria-label={t("rolesPage.startFrom")}>
              {choices.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a choice button in a radio group
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={from === c.id}
                  className="roles-template"
                  onClick={() => setFrom(c.id)}
                >
                  <span className="ac-radio" data-state={from === c.id ? "checked" : "unchecked"} aria-hidden="true">
                    {from === c.id && <span className="ac-radio__dot" />}
                  </span>
                  <span>
                    <b>{c.title}</b>
                    {c.desc && <span>{c.desc}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={submit}>
          {t("rolesPage.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
