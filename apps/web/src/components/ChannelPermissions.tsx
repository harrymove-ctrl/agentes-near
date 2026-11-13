import {
  CHANNEL_KEYS,
  type ChannelKey,
  type ChannelOverride,
  type OrgRole,
  useChannelPermissions,
  useRoles,
  useSetChannelPermission,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { grants, isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { Avatar, Button, Icon, RoleMark, SearchSelect, Segmented } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

type State = "deny" | "inherit" | "allow";
type Target = ChannelOverride["target"];

const STATE_ICON = { deny: "close", inherit: "dash", allow: "check" } as const;
const KEY_I18N = { post: "post", talk_to_agents: "callAgents", manage_channels: "manage" } as const;

const sameTarget = (a: Target, b: Target) => a.type === b.type && a.id === b.id;
const stateOf = (o: ChannelOverride | undefined, key: ChannelKey): State =>
  o?.allow.includes(key) ? "allow" : o?.deny.includes(key) ? "deny" : "inherit";

/**
 * "Permissões avançadas" of a channel (ADR 0134), Discord's way in our words: the roles and people with an exception
 * on the left (`Todos` always first), and for the one picked, each key as Negar / Padrão / Permitir. Each change saves
 * at once; the server refuses what the person can't hand out.
 */
export function ChannelPermissions({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const roles = sortRoles(useRoles(org.id).data?.roles ?? []);
  const everyone = roles.find(isEveryone);
  const saved = useChannelPermissions(org.id, channelId).data ?? [];
  const save = useSetChannelPermission(org.id, channelId);
  // Added from "+" but with nothing set yet: listed until it gets a key, never saved empty.
  const [added, setAdded] = useState<Target[]>([]);
  const [picked, setPicked] = useState<Target | null>(null);
  const everyoneTarget: Target | null = everyone ? { type: "role", id: everyone.id } : null;
  const targets: Target[] = [
    ...(everyoneTarget ? [everyoneTarget] : []),
    ...roles
      .filter((r) => !isEveryone(r) && saved.some((o) => sameTarget(o.target, { type: "role", id: r.id })))
      .map((r) => ({ type: "role" as const, id: r.id })),
    ...saved.filter((o) => o.target.type === "person").map((o) => o.target),
    ...added.filter(
      (a) => !saved.some((o) => sameTarget(o.target, a)) && !(everyoneTarget && sameTarget(a, everyoneTarget)),
    ),
  ];
  const current = (picked && targets.find((x) => sameTarget(x, picked))) ?? targets[0] ?? null;
  const roleById = (id: string) => roles.find((r) => r.id === id);
  const nameOf = (x: Target) => {
    if (x.type === "person") return dir.memberById.get(x.id)?.name ?? t("channel.unknownPerson");
    const role = roleById(x.id);
    return !role || isEveryone(role) ? t("rolesPage.everyoneName") : role.name;
  };
  const markOf = (x: Target) => {
    if (x.type === "person") {
      const m = dir.memberById.get(x.id);
      return <Avatar kind="person" size="xs" name={m?.name ?? ""} imageUrl={m?.image} />;
    }
    const role = roleById(x.id);
    return <RoleMark color={role?.color ?? "graphite"} icon={role?.icon ?? "person"} size={18} />;
  };
  const overrideOf = (x: Target) => saved.find((o) => sameTarget(o.target, x));
  const change = (x: Target, key: ChannelKey, state: State) => {
    const was = overrideOf(x) ?? { target: x, allow: [], deny: [] };
    const allow = was.allow.filter((k) => k !== key);
    const deny = was.deny.filter((k) => k !== key);
    if (state === "allow") allow.push(key);
    if (state === "deny") deny.push(key);
    // Kept listed and picked when its last key goes back to Padrão, so the focus stays on the control.
    setAdded((list) => (list.some((a) => sameTarget(a, x)) ? list : [...list, x]));
    save.mutate({ target: x, allow, deny }, { onError: (e) => toast.show(errorText(t, e), "error") });
  };
  const clear = (x: Target) => {
    setAdded((list) => list.filter((a) => !sameTarget(a, x)));
    if (overrideOf(x)) {
      save.mutate({ target: x, allow: [], deny: [] }, { onError: (e) => toast.show(errorText(t, e), "error") });
    }
    setPicked(null);
  };
  // What Padrão means for the one picked, in one line.
  const defaultLine = (x: Target, key: ChannelKey) => {
    const everyoneName = t("rolesPage.everyoneName");
    if (x.type === "person") return t("channel.perms.default.person");
    const role = roleById(x.id);
    if (!role) return "";
    const holds = grants(role.permissions).has(key);
    if (isEveryone(role)) {
      return holds
        ? t("channel.perms.default.allowedBy", { role: everyoneName })
        : t("channel.perms.default.notHeld", { role: everyoneName });
    }
    return holds
      ? t("channel.perms.default.allowedBy", { role: role.name })
      : t("channel.perms.default.followsEveryone", { role: everyoneName });
  };
  const options = [
    ...roles
      .filter((r: OrgRole) => !isEveryone(r) && !targets.some((x) => sameTarget(x, { type: "role", id: r.id })))
      .map((r) => ({
        value: `role:${r.id}`,
        label: r.name,
        group: t("channel.perms.groupRoles"),
        leading: <RoleMark color={r.color} icon={r.icon} size={24} />,
        disabled: !r.givable,
      })),
    ...dir.members
      .filter((m) => !targets.some((x) => sameTarget(x, { type: "person", id: m.userId })))
      .map((m) => ({
        value: `person:${m.userId}`,
        label: m.name,
        description: m.email,
        group: t("channel.perms.groupPeople"),
        leading: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
      })),
  ];
  return (
    <section className="channel-perms" aria-labelledby="channel-perms-title">
      <div className="channel-perms__intro">
        <h3 id="channel-perms-title" className="ac-eyebrow">
          {t("channel.perms.advanced")}
        </h3>
        <p className="small muted">{t("channel.perms.intro")}</p>
      </div>
      <div className="channel-perms__grid">
        <div className="channel-perms__targets">
          <ul aria-label={t("channel.perms.targets")}>
            {targets.map((x) => (
              <li key={`${x.type}:${x.id}`}>
                <button
                  type="button"
                  className="channel-perms__target"
                  aria-current={current && sameTarget(x, current) ? "true" : undefined}
                  onClick={() => setPicked(x)}
                >
                  {markOf(x)}
                  <span className="channel-perms__target-name">{nameOf(x)}</span>
                </button>
              </li>
            ))}
          </ul>
          <SearchSelect
            value={undefined}
            onValueChange={(v) => {
              const [type, id = ""] = v.split(/:(.*)/s) as ["role" | "person", string];
              const next = { type, id };
              setAdded((list) => [...list, next]);
              setPicked(next);
            }}
            options={options}
            labels={{
              search: t("channel.perms.addSearch"),
              searchPlaceholder: t("channel.perms.addSearch"),
              noResults: t("channel.perms.addNone"),
              list: t("channel.perms.targets"),
            }}
            renderValue={() => (
              <span className="ac-iconline">
                <Icon name="plus" size={16} />
                <span>{t("channel.perms.add")}</span>
              </span>
            )}
            aria-label={t("channel.perms.add")}
            className="channel-perms__add"
          />
        </div>
        {current && (
          <div className="channel-perms__keys">
            <div className="channel-perms__keys-head">
              <span className="ac-iconline">
                {markOf(current)}
                <strong>{nameOf(current)}</strong>
              </span>
              {(overrideOf(current) || !everyoneTarget || !sameTarget(current, everyoneTarget)) && (
                <Button size="sm" variant="ghost" icon="close" onClick={() => clear(current)}>
                  {t("channel.perms.clear")}
                </Button>
              )}
            </div>
            {CHANNEL_KEYS.map((key) => {
              const name = t(`channel.perms.keys.${KEY_I18N[key]}.title`);
              const state = stateOf(overrideOf(current), key);
              return (
                <div key={key} className="channel-perms__key">
                  <span className="channel-perms__key-text">
                    <span className="channel-perms__key-name">{name}</span>
                    <span className="small muted">{t(`channel.perms.keys.${KEY_I18N[key]}.line`)}</span>
                    {state === "inherit" && <span className="channel-perms__default">{defaultLine(current, key)}</span>}
                  </span>
                  <Segmented
                    size="sm"
                    label={t("channel.perms.stateLabel", { key: name, target: nameOf(current) })}
                    value={state}
                    onValueChange={(next) => change(current, key, next)}
                    options={(["deny", "inherit", "allow"] as const).map((s) => ({
                      value: s,
                      title: t(`channel.perms.state.${s}`),
                      label: (
                        <span className={`channel-perms__state channel-perms__state--${s}`}>
                          <Icon name={STATE_ICON[s]} size={16} />
                          <span className="ac-visually-hidden">{t(`channel.perms.state.${s}`)}</span>
                        </span>
                      ),
                    }))}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
