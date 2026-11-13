import type { OrgRole, Person } from "@agenteschat/client";
import {
  useChangeRole,
  useCreateRole,
  useDeleteRole,
  usePeople,
  useRoles,
  useSetMemberRoles,
  useUpdateRole,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { can, type RolePermission } from "@agenteschat/client/lib/permissions";
import {
  COMPUTER_KEYS,
  computerChoice,
  everyoneOf,
  giveRole,
  holdsAll,
  isBelow,
  isEveryone,
  keyState,
  levelLabel,
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
import { matchesWords } from "@agenteschat/ui/search";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  SearchField,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { RoleMark } from "../dashboards/parts";
import { Face } from "../shared/Face";
import { useColors, useMeId } from "../shared/hooks";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import {
  areaChoices,
  COMPUTER_AREA,
  givesRole,
  OWNER_ROLE,
  ROLE_AREA_ICON,
  roleAreaRows,
  roleCandidates,
} from "./logic";
import { chooseAction, confirmAction, SettingsPage } from "./parts";

/*
 * Configurações › Papéis e permissões (ADR 0085), as the web's (`apps/web/src/components/roles/RolesSection.tsx`) on
 * the phone's settings screens: the roles, each opening its screen (what it can do per area, its people, its name and
 * color); an area opens its levels and its items one by one. Same routes and checks as the web: the server says what
 * this person may change (`editable`, `givable`), and a role above them reads only. A role's icon and the roles' order
 * change on the web: most role icons aren't in the phone's icon set, and the order is a drag list there.
 */

const OWNER_COLOR = "violet";

const rolePath = (roleId: string) => `/settings/roles/${roleId}` as const;

function useRolesData() {
  const { orgId, org } = useOrg();
  const roles = useRoles(orgId);
  const people = usePeople(orgId);
  const meId = useMeId();
  const viewer = { role: org?.role ?? "member", rank: org?.rank, userId: meId ?? "" };
  return { orgId, org, data: roles.data, people: people.data, failed: roles.isError || people.isError, viewer };
}

function useFail() {
  const { t } = useTranslation();
  const toast = useToast();
  return (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
}

/** The page while the roles load, or what failed. */
function Waiting({ title, failed }: { title: string; failed: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <SettingsPage title={title}>
      {failed ? (
        <View style={styles.note}>
          <Note icon="x">{t("common.loadFailed")}</Note>
        </View>
      ) : (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      )}
    </SettingsPage>
  );
}

/** The roles: Criar papel, the owners on top, the roles in order, then Todos under Base. */
export function RolesScreen() {
  const { t, i18n } = useTranslation();
  const { org, data, people, failed } = useRolesData();
  const title = t("settings.section.roles");
  if (!data || !people) return <Waiting title={title} failed={failed} />;
  const list = sortRoles(data.roles);
  const everyone = everyoneOf(list);
  const owners = people.filter((p) => p.role === "owner");
  const row = (role: OrgRole) => (
    <GroupedRow
      key={role.id}
      leading={<RoleMark color={role.color} size={30} />}
      label={roleName(t, role)}
      sub={roleSummary(t, i18n.language, role, everyone)}
      subLines={2}
      media
      value={String(peopleWith(role, people).length)}
      chevron
      onPress={() => router.push(rolePath(role.id))}
    />
  );
  return (
    <SettingsPage title={title}>
      <GroupedFooter>{t("settings.sectionText.roles")}</GroupedFooter>
      {can(org, "manage_roles") ? (
        <GroupedList>
          <GroupedRow icon="plus" label={t("rolesPage.create")} onPress={() => router.push("/settings/roles/new")} />
        </GroupedList>
      ) : null}
      <GroupedHeader>{t("settings.section.roles")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<RoleMark color={OWNER_COLOR} size={30} />}
          label={t("roles.owner")}
          sub={t("rolesPage.summary.owner")}
          subLines={2}
          media
          value={String(owners.length)}
          chevron
          onPress={() => router.push(rolePath(OWNER_ROLE))}
        />
        {list.filter((r) => !isEveryone(r)).map(row)}
      </GroupedList>
      <GroupedFooter>{t("rolesPage.orderHint")}</GroupedFooter>
      <GroupedHeader>{t("rolesPage.base")}</GroupedHeader>
      <GroupedList>{everyone ? row(everyone) : null}</GroupedList>
      <GroupedFooter>{t("mobile.settings.roles.onComputer")}</GroupedFooter>
    </SettingsPage>
  );
}

/** A role's screen (`roleId`; `owner`: the owners' page). */
export function RoleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const { data, people, failed } = useRolesData();
  const role = data?.roles.find((r) => r.id === roleId);
  if (roleId === OWNER_ROLE && people) return <OwnerScreen people={people} />;
  if (!data || !people || !role) return <Waiting title={t("rolesPage.back")} failed={failed} />;
  return <RolePage role={role} people={people} />;
}

function RolePage({ role, people }: { role: OrgRole; people: Person[] }) {
  const { t, i18n } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, org, data, viewer } = useRolesData();
  const update = useUpdateRole(orgId);
  const create = useCreateRole(orgId);
  const remove = useDeleteRole(orgId);
  const set = useSetMemberRoles(orgId);
  if (!data) return null;
  const everyone = everyoneOf(data.roles);
  const base = isEveryone(role);
  const name = roleName(t, role);
  const locked = roleLock(org ?? { role: "member" }, role);
  const admin = !base && role.permissions.includes("administrator");
  const holders = peopleWith(role, people);
  const gives = givesRole(org, role);
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) =>
    update.mutate({ roleId: role.id, patch: p }, { onError: fail });
  const openArea = (area: string) =>
    router.push({ pathname: "/settings/roles/area", params: { roleId: role.id, area } });
  const takeFrom = (p: Person) =>
    chooseAction(
      p.name,
      [
        {
          label: t("rolesPage.removeOf", { person: p.name, name }),
          destructive: true,
          onPress: () =>
            set.mutate(
              { userId: p.userId, roleIds: (p.roleIds ?? []).filter((id) => id !== role.id) },
              { onError: fail },
            ),
        },
      ],
      t("common.cancel"),
    );
  const actions = !base && role.editable && holdsAll(org ?? { role: "member" }, role.permissions);
  return (
    <SettingsPage title={name} subtitle={t("rolesPage.people", { count: holders.length })}>
      {locked ? (
        <View style={styles.note}>
          <Note icon="lock">{t(`rolesPage.locked.${locked}`)}</Note>
        </View>
      ) : null}
      <GroupedHeader>{t("rolesPage.canDo", { name })}</GroupedHeader>
      <GroupedList>
        {!base ? (
          <GroupedRow
            icon="shield"
            label={t("rolesPage.administrator")}
            sub={t("rolesPage.administratorDesc")}
            subLines={2}
            media
            toggle={admin}
            disabled={Boolean(locked)}
            onPress={() => patch({ permissions: withKey(role, "administrator", !admin) })}
          />
        ) : null}
        {roleAreaRows(t, i18n.language, role, data).map((r) => (
          <GroupedRow
            key={r.id}
            icon={ROLE_AREA_ICON[r.id] ?? "bolt"}
            label={r.label}
            sub={r.line}
            subLines={2}
            media
            value={r.value}
            chevron
            onPress={() => openArea(r.id)}
          />
        ))}
      </GroupedList>
      <GroupedFooter>
        {base ? t("rolesPage.everyoneNote") : roleSummary(t, i18n.language, role, everyone)}
      </GroupedFooter>

      <GroupedHeader>{t("rolesPage.peopleTitle")}</GroupedHeader>
      <GroupedList>
        {gives ? (
          <GroupedRow
            icon="plus"
            label={t("rolesPage.addPeople")}
            onPress={() => router.push({ pathname: "/settings/roles/add", params: { roleId: role.id } })}
          />
        ) : null}
        {holders.map((p) => (
          <PersonRow
            key={p.userId}
            person={p}
            mine={p.userId === viewer.userId}
            {...(gives && isBelow(viewer, p, data.roles) ? { onPress: () => takeFrom(p) } : {})}
          />
        ))}
      </GroupedList>
      <GroupedFooter>
        {base
          ? t("rolesPage.everyonePeople")
          : holders.length === 0
            ? t("rolesPage.nobody", { name })
            : t("rolesPage.peopleSub", { count: holders.length, name })}
      </GroupedFooter>

      <GroupedHeader>{t("rolesPage.lookTitle")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("rolesPage.name")}
          value={name}
          chevron={!base && !locked}
          disabled={base || Boolean(locked)}
          onPress={() => router.push({ pathname: "/settings/roles/rename", params: { roleId: role.id } })}
        />
        <ColorPick
          colors={data.colors}
          value={role.color}
          disabled={Boolean(locked)}
          onPick={(color) => patch({ color })}
        />
        {!base ? (
          <GroupedRow
            label={t("rolesPage.hoist")}
            labelLines={2}
            hint={{ name: t("common.about", { label: t("rolesPage.hoist") }), text: t("rolesPage.hoistDesc") }}
            toggle={role.hoist}
            disabled={Boolean(locked)}
            onPress={() => patch({ hoist: !role.hoist })}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{base ? t("rolesPage.locked.everyone") : t("mobile.settings.roles.onComputer")}</GroupedFooter>

      {actions ? (
        <>
          <GroupedHeader>{t("rolesPage.more")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon="copy"
              label={t("rolesPage.duplicate")}
              onPress={() =>
                create.mutate(
                  {
                    name: t("rolesPage.copyName", { name: role.name }).slice(0, 40),
                    icon: role.icon,
                    color: role.color,
                    permissions: role.permissions,
                  },
                  { onSuccess: (r) => router.replace(rolePath(r.id)), onError: fail },
                )
              }
            />
            <GroupedRow
              icon="trash"
              danger
              label={t("rolesPage.delete")}
              onPress={() =>
                confirmAction({
                  title: t("rolesPage.deleteTitle", { name }),
                  text: t("common.joinSentences", { a: t("rolesPage.deleteText"), b: t("common.cantUndo") }),
                  action: t("rolesPage.delete"),
                  cancel: t("common.cancel"),
                  onConfirm: () =>
                    remove.mutate(role.id, {
                      onSuccess: () => {
                        toast({ title: t("rolesPage.deleted", { name }), icon: "trash" });
                        goBack();
                      },
                      onError: fail,
                    }),
                })
              }
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

function PersonRow({ person, mine, onPress }: { person: Person; mine: boolean; onPress?: () => void }) {
  const { t } = useTranslation();
  return (
    <GroupedRow
      leading={<Face who={{ type: "person", id: person.userId }} size={30} live={false} />}
      label={mine ? `${person.name}${t("common.youSuffix")}` : person.name}
      sub={person.email}
      subLines={2}
      media
      {...(onPress ? { more: true, onPress } : {})}
    />
  );
}

/** The role's color: its swatches in one row, the chosen one ringed. */
function ColorPick({
  colors,
  value,
  disabled,
  onPick,
}: {
  colors: string[];
  value: string;
  disabled: boolean;
  onPick: (color: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.colors} accessibilityRole="radiogroup" accessibilityLabel={t("rolesPage.color")}>
      <Text variant="body">{t("rolesPage.color")}</Text>
      <View style={styles.swatches}>
        {colors.map((color) => {
          const on = color === value;
          return (
            <Pressable
              key={color}
              accessibilityRole="radio"
              accessibilityLabel={t(`look.colors.${color}`, { defaultValue: color })}
              accessibilityState={{ checked: on, disabled }}
              disabled={disabled}
              // 44 pt tall to the finger; side by side, as far as half the gap between swatches.
              hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
              onPress={() => {
                if (on) return;
                tapHaptic();
                onPick(color);
              }}
              style={({ pressed }) => [
                styles.swatch,
                { borderColor: on ? c.ink : "transparent", opacity: disabled ? 0.5 : pressed && !on ? 0.6 : 1 },
              ]}
            >
              <RoleMark color={color} size={22} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const OWNER_ITEMS: { icon: IconName; key: "transfer" | "owners" | "delete" }[] = [
  { icon: "swap", key: "transfer" },
  { icon: "members", key: "owners" },
  { icon: "trash", key: "delete" },
];

/** The owners as a role: what only they do, and who they are (owners make more owners). */
function OwnerScreen({ people }: { people: Person[] }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { orgId, org, viewer } = useRolesData();
  const change = useChangeRole(orgId);
  const owners = people.filter((p) => p.role === "owner");
  const mine = can(org, "manage_owners");
  const owner = t("roles.owner");
  return (
    <SettingsPage title={owner} subtitle={t("rolesPage.people", { count: owners.length })}>
      <GroupedHeader>{t("rolesPage.owner.title")}</GroupedHeader>
      <GroupedList>
        {OWNER_ITEMS.map((i) => (
          <GroupedRow
            key={i.key}
            icon={i.icon}
            label={t(`rolesPage.owner.${i.key}`)}
            labelLines={2}
            sub={t(`rolesPage.owner.${i.key}Desc`)}
            subLines={2}
            media
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("rolesPage.owner.sub")}</GroupedFooter>
      <GroupedHeader>{t("rolesPage.peopleTitle")}</GroupedHeader>
      <GroupedList>
        {mine ? (
          <GroupedRow
            icon="plus"
            label={t("rolesPage.addPeople")}
            onPress={() => router.push({ pathname: "/settings/roles/add", params: { roleId: OWNER_ROLE } })}
          />
        ) : null}
        {owners.map((p) => (
          <PersonRow
            key={p.userId}
            person={p}
            mine={p.userId === viewer.userId}
            {...(mine && owners.length > 1
              ? {
                  onPress: () =>
                    chooseAction(
                      p.name,
                      [
                        {
                          label: t("rolesPage.removeOf", { person: p.name, name: owner }),
                          destructive: true,
                          onPress: () => change.mutate({ userId: p.userId, role: "member" }, { onError: fail }),
                        },
                      ],
                      t("common.cancel"),
                    ),
                }
              : {})}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{owners.length === 1 ? t("rolesPage.soleOwner") : t("rolesPage.owner.foot")}</GroupedFooter>
    </SettingsPage>
  );
}

/** An area of a role (`area`; `computer`: the agents' computers' choice): its levels, then its items one by one. */
export function RoleAreaScreen({ roleId, area }: { roleId: string; area: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { orgId, org, data, failed } = useRolesData();
  const update = useUpdateRole(orgId);
  const role = data?.roles.find((r) => r.id === roleId);
  const found = data?.areas.find((a) => a.id === area);
  const computer = area === COMPUTER_AREA;
  const title = computer ? t("rolesPage.computer.title") : t(`permissions.areas.${area as PermissionAreaId}`);
  if (!data || !role || (!computer && !found)) return <Waiting title={title} failed={failed} />;
  const everyone = everyoneOf(data.roles);
  const admin = !isEveryone(role) && role.permissions.includes("administrator");
  const off = Boolean(roleLock(org ?? { role: "member" }, role)) || admin;
  const save = (permissions: string[]) => update.mutate({ roleId: role.id, patch: { permissions } }, { onError: fail });
  if (computer) {
    const choice = computerChoice(role, everyone);
    return (
      <SettingsPage title={title} subtitle={roleName(t, role)}>
        <GroupedHeader>{title}</GroupedHeader>
        <GroupedList>
          {choice.options.map((level) => (
            <GroupedRow
              key={level}
              label={t(`rolesPage.computer.levels.${level}`)}
              sub={t(`rolesPage.computer.${choice.reach}.${level}`)}
              subLines={3}
              checked={choice.shown === level}
              disabled={off}
              onPress={() => level !== choice.shown && save(withComputerLevel(role, level))}
            />
          ))}
        </GroupedList>
        {admin ? <GroupedFooter>{t("rolesPage.viaAdmin")}</GroupedFooter> : null}
      </SettingsPage>
    );
  }
  if (!found) return null;
  const { level, options } = areaChoices(role, found, everyone);
  const keys = found.keys.filter((k) => !COMPUTER_KEYS.includes(k)) as RolePermission[];
  return (
    <SettingsPage title={title} subtitle={roleName(t, role)}>
      <GroupedHeader>{t("rolesPage.levelsOf", { area: title })}</GroupedHeader>
      <GroupedList>
        {options.map((v) => (
          <GroupedRow
            key={v}
            label={levelLabel(t, role, v)}
            checked={!admin && level === v}
            disabled={off || v === "custom"}
            onPress={() => v !== level && save(withLevel(role, found, v))}
          />
        ))}
      </GroupedList>
      {admin ? <GroupedFooter>{t("rolesPage.viaAdmin")}</GroupedFooter> : null}
      <GroupedHeader>{t("mobile.settings.roles.items")}</GroupedHeader>
      <GroupedList>
        {keys.map((k) => {
          const { on, from } = keyState(role, everyone, k);
          return (
            <GroupedRow
              key={k}
              label={t(`permissions.${k}.title`)}
              labelLines={2}
              sub={t(`permissions.${k}.desc`)}
              subLines={3}
              {...(from
                ? { belowText: from === "admin" ? t("rolesPage.fromAdmin") : t("rolesPage.fromEveryone") }
                : {})}
              toggle={on}
              disabled={off || from !== null}
              onPress={() => save(withKey(role, k, !on))}
            />
          );
        })}
      </GroupedList>
    </SettingsPage>
  );
}

/** Adicionar pessoas to a role (`owner`: make owners): who may get it, checked, then Adicionar. */
export function AddToRoleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, data, people: live, failed, viewer } = useRolesData();
  const set = useSetMemberRoles(orgId);
  const change = useChangeRole(orgId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Everyone as before Adicionar: the ones being added keep their rows while it adds and the screen goes back.
  const people = useHeldWhile(live, busy);
  const [query, setQuery] = useState("");
  const owner = roleId === OWNER_ROLE;
  const role = data?.roles.find((r) => r.id === roleId);
  const name = owner ? t("roles.owner") : role ? roleName(t, role) : "";
  const title = t("rolesPage.addTitle", { name });
  if (!data || !people || (!owner && !role)) return <Waiting title={title} failed={failed} />;
  const candidates = owner
    ? people.filter((p) => p.role !== "owner")
    : role
      ? roleCandidates(viewer, role, people, data.roles)
      : [];
  const add = async () => {
    setBusy(true);
    let stays = true;
    try {
      const ids = [...picked];
      // Owners as the web makes them: one by one, stopping at a refusal.
      const makeOwners = async () => {
        let added = 0;
        try {
          for (const userId of ids) {
            await change.mutateAsync({ userId, role: "owner" });
            added++;
          }
          return { added, failed: null };
        } catch (e) {
          return { added, failed: e };
        }
      };
      const { added, failed: refused } = owner
        ? await makeOwners()
        : await giveRole(people, ids, roleId, set.mutateAsync);
      if (added > 0) {
        successHaptic();
        toast({ title: t("rolesPage.added", { count: added, name }), icon: "check" });
      }
      if (refused) fail(refused);
      else {
        stays = false;
        goBack();
      }
    } finally {
      if (stays) setBusy(false);
    }
  };
  return (
    <SettingsPage
      title={title}
      action={{
        label: picked.size ? t("rolesPage.addCount", { count: picked.size }) : t("rolesPage.add"),
        disabled: picked.size === 0 || busy,
        onPress: () => void add(),
      }}
      locked={busy}
    >
      <GroupedFooter>{t("rolesPage.addSub")}</GroupedFooter>
      {candidates.length > PEOPLE_SEARCH_FROM ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("rolesPage.searchPeople")}
            accessibilityLabel={t("rolesPage.searchPeople")}
          />
        </View>
      ) : null}
      <GroupedList>
        {candidates
          .filter((p) => matchesWords(`${p.name} ${p.email}`, query))
          .map((p) => (
            <GroupedRow
              key={p.userId}
              leading={<Face who={{ type: "person", id: p.userId }} size={30} live={false} />}
              label={p.name}
              sub={p.email}
              subLines={2}
              media
              checked={picked.has(p.userId)}
              onPress={() =>
                setPicked((now) => {
                  const next = new Set(now);
                  if (!next.delete(p.userId)) next.add(p.userId);
                  return next;
                })
              }
            />
          ))}
      </GroupedList>
      {candidates.length === 0 ? <GroupedFooter>{t("rolesPage.noOneLeft", { name })}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/** Criar papel: its name and what it starts from (a template, or the same keys as a role this person holds all of). */
export function NewRoleScreen() {
  const { t } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, org, data } = useRolesData();
  const create = useCreateRole(orgId);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("blank");
  const typed = name.trim();
  const copies = (data?.roles ?? []).filter(
    (r) => !isEveryone(r) && holdsAll(org ?? { role: "member" }, r.permissions),
  );
  const choices = [
    ...ROLE_TEMPLATES.map((x) => ({
      id: x.id,
      title: t(`rolesPage.templates.${x.id}`),
      desc: t(`rolesPage.templates.${x.id}Desc`),
    })),
    ...sortRoles(copies).map((r) => ({
      id: `copy:${r.id}`,
      title: t("rolesPage.templates.copyOf", { name: r.name }),
      desc: "",
    })),
  ];
  const submit = () => {
    if (!typed || create.isPending) return;
    create.mutate(newRoleInput(typed, from, copies), {
      onSuccess: (r) => {
        successHaptic();
        toast({ title: t("rolesPage.created", { name: typed }), icon: "check" });
        router.replace(rolePath(r.id));
      },
      onError: fail,
    });
  };
  return (
    <SettingsPage
      title={t("rolesPage.newTitle")}
      action={{ label: t("mobile.settings.roles.create"), disabled: !typed || create.isPending, onPress: submit }}
      locked={create.isPending}
    >
      <GroupedHeader>{t("rolesPage.name")}</GroupedHeader>
      <TextArea
        value={name}
        onChangeText={setName}
        multiline={false}
        minHeight={50}
        maxLength={40}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={submit}
        placeholder={t("rolesPage.namePlaceholder")}
        accessibilityLabel={t("rolesPage.name")}
      />
      <GroupedHeader>{t("rolesPage.startFrom")}</GroupedHeader>
      <GroupedList>
        {choices.map((c) => (
          <GroupedRow
            key={c.id}
            label={c.title}
            {...(c.desc ? { sub: c.desc, subLines: 2 } : {})}
            checked={from === c.id}
            onPress={() => setFrom(c.id)}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("rolesPage.newSub")}</GroupedFooter>
    </SettingsPage>
  );
}

/** A role's name, pushed over its screen. */
export function RenameRoleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { orgId, data } = useRolesData();
  const update = useUpdateRole(orgId);
  const role = data?.roles.find((r) => r.id === roleId);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? role?.name ?? "";
  const next = value.trim();
  const ready = Boolean(role?.editable) && next.length > 0 && next !== role?.name && !update.isPending;
  const save = () => {
    if (!role || !ready) return;
    update.mutate({ roleId: role.id, patch: { name: next } }, { onSuccess: () => goBack(), onError: fail });
  };
  return (
    <SettingsPage
      title={t("rolesPage.name")}
      action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      locked={update.isPending}
    >
      <GroupedHeader hint={{ name: t("common.about", { label: t("rolesPage.name") }), text: t("rolesPage.nameDesc") }}>
        {t("rolesPage.name")}
      </GroupedHeader>
      <TextArea
        value={value}
        onChangeText={setDraft}
        multiline={false}
        minHeight={50}
        maxLength={40}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel={t("rolesPage.name")}
      />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
  colors: { paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  // The ring's corner is the mark's (30% of 22) plus the 2 pt gap and the 2 pt ring: concentric at 10.
  swatch: { padding: 2, borderRadius: 10, borderWidth: 2 },
  search: { paddingTop: 10 },
});
