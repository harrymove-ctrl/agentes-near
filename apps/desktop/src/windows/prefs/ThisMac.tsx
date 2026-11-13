import type { ComputerDevice, DeviceAudience, DevicesList, Member, OrgRole, PhoneDevice } from "@agenteschat/client";
import {
  audienceWords,
  iosOf,
  iphoneOverWifi,
  portraitOf,
  reasonText,
  sameAudience,
  statusDetail,
  statusLook,
  statusPill,
} from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  Input,
  Menu,
  MenuItem,
  PixelSpinner,
  Select,
  Switch,
} from "@agenteschat/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useStore } from "../../app";
import {
  androidStepsUrl,
  deviceServer,
  IPHONE_SETUP_PREF,
  isSignedOut,
  siteApi,
  thisComputer,
} from "../../control/devices";
import { serverPlace } from "../../control/local-server";
import { type PairTarget, pairWithSession, targetKey } from "../../control/pair";
import { homeServer, serverName } from "../../control/server";
import { type Home, orgName } from "../../control/store";
import { agentOf, useLocalServer, usePending, useWifiIphones, writePref } from "../../hooks";
import type { Host } from "../../host/types";
import { AgentFace, ConnectionChip, OrgTile } from "../../ui/bits";
import { MacPermissionCard, useMacGrants } from "../../ui/permissions";
import { CardTitle, hintFor, PrefCard, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";

/** How often the devices are asked while Preferences is open (the runner's own phone changes ask at once). */
const POLL_MS = 5000;

/** The iPhone setup, in the welcome window (it reads the pref once it shows). */
export function openIphoneSetup(host: Host) {
  writePref(IPHONE_SETUP_PREF, true);
  void host.showWindow("welcome").catch(() => {});
}

interface Target {
  homeId: string;
  server: string | null;
  orgId: string | null;
}
type Answer = { list?: DevicesList; error?: unknown };

/** Each home's devices on its server, asked together, again every `POLL_MS` and right after its phones changed. */
function useDevices(homes: readonly Home[]) {
  const host = useHost();
  const local = useLocalServer();
  const targets: Target[] = homes.map((h) => ({
    homeId: h.homeId,
    server: deviceServer(h, local),
    orgId: h.status?.org?.id ?? null,
  }));
  const key = JSON.stringify(targets);
  const phones = JSON.stringify(homes.map((h) => h.status?.phones ?? []));
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const load = useCallback(async () => {
    const asked = JSON.parse(key) as Target[];
    const got = await Promise.all(
      asked.map(async (a): Promise<[string, Answer]> => {
        if (!a.server || !a.orgId) return [a.homeId, {}];
        try {
          return [a.homeId, { list: await siteApi(host, a.server).devices.list(a.orgId) }];
        } catch (error) {
          return [a.homeId, { error }];
        }
      }),
    );
    setAnswers(Object.fromEntries(got));
  }, [host, key]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  // The runner saw a phone come, go or change state: its server heard it at the same moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `phones` is the trigger itself
  useEffect(() => {
    const timer = setTimeout(() => void load(), 800);
    return () => clearTimeout(timer);
  }, [phones, load]);
  return { answers, load, targets };
}

const AUDIENCE_ICON: Record<DeviceAudience["mode"], IconName> = {
  owner: "audienceOwner",
  everyone: "audienceEveryone",
  people: "audiencePeople",
};

/**
 * General's This Mac card: the name (`top`), one row per workspace the person is signed in to (a paired one pauses
 * and resumes with its switch, one this computer doesn't work for yet shows Allow, which pairs it after the system's
 * dialog), Add a workspace, and Open at login (`bottom`). Under it the phones plugged in, with their state and one
 * way out each (Stop, Show me how). Who can use it and the phones are the server's, as the web sets
 * them. On a Mac, its permissions (`Permissions`).
 */
export function ThisMacCards({
  homes,
  offers,
  top,
  bottom,
  onLeave,
}: {
  homes: Home[];
  offers: PairTarget[];
  top?: ReactNode;
  bottom?: ReactNode;
  onLeave?: (home: Home) => void;
}) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const local = useLocalServer();
  const { answers, load, targets } = useDevices(homes);
  const [pending, run] = usePending<string>();
  const [who, setWho] = useState<string | null>(null);
  const user = homes.find((h) => h.status?.user)?.status?.user;
  const multi = homes.length > 1;

  const setAgents = (home: Home, on: boolean) =>
    run(home.homeId, async () => {
      try {
        await store.request(home.homeId, on ? { type: "resume" } : { type: "pause", until: null });
      } catch {
        toast(t("desktop.common.error"), "alert");
      }
    });
  const pair = (target: PairTarget) =>
    run(targetKey(target), async () => {
      try {
        if (!(await host.askToPair(target.server, target.name))) return;
        await pairWithSession(host, store, target);
        // Its agents work while the app runs.
        await host.setAutostart(true).catch(() => {});
        toast(t("desktop.pair.done", { org: target.name }));
      } catch (err) {
        toast(errorText(t, err, i18n.language), "alert");
      }
    });
  const place = (server: string | null) => {
    const where = serverPlace(local, server);
    if (where === "here") return t("desktop.prefs.thisMac.placeHere");
    if (where === "cloud") return t("desktop.prefs.thisMac.placeCloud");
    return server ? serverName(server) : "";
  };
  const hint = (org: string) => hintFor(t, org, t("desktop.prefs.thisMac.letAgentsDesc"));

  const whoHome = homes.find((h) => h.homeId === who);
  const whoTarget = whoHome ? targets[homes.indexOf(whoHome)] : undefined;
  const phoneHomes = homes.flatMap((h, i) => {
    const target = targets[i];
    const computer = thisComputer(answers[h.homeId]?.list, h);
    return target?.server && target.orgId && computer && !answers[h.homeId]?.error
      ? [{ home: h, server: target.server, orgId: target.orgId, computer }]
      : [];
  });
  // One line for the phones, with the first workspace's Android steps: the phone plugs into this computer either way.
  const stepsAt = phoneHomes[0];
  const phonesShown = homes.some((h, i) => targets[i]?.server && targets[i]?.orgId && !answers[h.homeId]?.error);

  return (
    <>
      <CardTitle>{t("desktop.prefs.general.thisMac")}</CardTitle>
      <PrefCard>
        {top}
        {homes.map((h, i) => {
          const org = orgName(h);
          const id = `mac-agents-${h.homeId}`;
          const agents = h.status?.agents ?? [];
          const server = homeServer(h);
          const orgId = h.status?.org?.id;
          const here = serverPlace(local, server) === "here";
          return (
            <PrefRow
              key={h.homeId}
              lead={<OrgTile logo={h.logo} size="lg" />}
              htmlFor={id}
              title={org}
              hint={hint(org)}
              chip={<ConnectionChip status={h.status} running={h.running} />}
              desc={
                <>
                  {agents.length > 0 && (
                    <span className="dk-avs">
                      {agents.slice(0, 5).map((a) => (
                        <AgentFace key={a.id} agent={a} size="xs" />
                      ))}
                    </span>
                  )}
                  {[
                    place(server),
                    agents.length
                      ? t("desktop.prefs.general.agents", { count: agents.length })
                      : t("desktop.prefs.general.noAgents"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </>
              }
              end={
                <>
                  <Switch
                    id={id}
                    aria-describedby={`${id}-hint`}
                    checked={h.status?.paused?.paused !== true}
                    disabled={pending !== null}
                    onCheckedChange={(on) => void setAgents(h, on)}
                  />
                  <Menu
                    align="end"
                    label={t("desktop.prefs.thisMac.more", { org })}
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="more"
                        aria-label={t("desktop.prefs.thisMac.more", { org })}
                      />
                    }
                  >
                    {server && orgId && (
                      <MenuItem
                        icon="external"
                        onSelect={() => void host.openExternal(`${server}/org/${encodeURIComponent(orgId)}`)}
                      >
                        {t("desktop.common.open")}
                      </MenuItem>
                    )}
                    {targets[i]?.server && targets[i]?.orgId && (
                      <MenuItem icon="audienceEveryone" onSelect={() => setWho(h.homeId)}>
                        {t("desktop.prefs.thisMac.who")}
                      </MenuItem>
                    )}
                    {/* The server here's own organizations work here by its rule (its computer, ADR 0060). */}
                    {!here && onLeave && (
                      <MenuItem icon="arrowRight" danger onSelect={() => onLeave(h)}>
                        {t("desktop.prefs.general.leave")}
                      </MenuItem>
                    )}
                  </Menu>
                </>
              }
            />
          );
        })}
        {offers.map((o) => {
          const key = targetKey(o);
          return (
            <PrefRow
              key={key}
              lead={<OrgTile logo={o.logo} size="lg" />}
              title={o.name}
              hint={hint(o.name)}
              desc={[place(o.server), t("desktop.pair.notUsing")].filter(Boolean).join(" · ")}
              end={
                <Button
                  size="sm"
                  variant="primary"
                  loading={pending === key}
                  disabled={pending !== null && pending !== key}
                  onClick={() => void pair(o)}
                >
                  {t("desktop.pair.allow")}
                </Button>
              }
            />
          );
        })}
        {bottom}
        <PrefRow
          lead={
            <span className="dk-logo">
              <Icon name="plus" size={16} />
            </span>
          }
          title={t("desktop.prefs.thisMac.otherWorkspace")}
          hint={hintFor(t, t("desktop.prefs.thisMac.otherWorkspace"), t("desktop.prefs.thisMac.otherWorkspaceDesc"))}
          end={
            <Button size="sm" onClick={() => void host.addWorkspace().catch(() => {})}>
              {t("desktop.prefs.thisMac.addWorkspace")}
            </Button>
          }
        />
      </PrefCard>

      {host.platform === "mac" && homes.length > 0 && <Permissions />}

      {phonesShown && (
        <>
          <CardTitle>{t("desktop.prefs.thisMac.phones")}</CardTitle>
          <PrefCard>
            {phoneHomes.flatMap(({ home, server, orgId, computer }) =>
              computer.phones.map((p) => (
                <PhoneRow
                  key={`${home.homeId} ${p.id}`}
                  phone={p}
                  computer={computer}
                  home={home}
                  server={server}
                  orgId={orgId}
                  org={multi ? orgName(home) : undefined}
                  onChanged={load}
                />
              )),
            )}
            {host.platform === "mac" &&
              phoneHomes.map(({ home, server, orgId, computer }) => (
                <WifiIphones
                  key={home.homeId}
                  computer={computer}
                  server={server}
                  orgId={orgId}
                  org={multi ? orgName(home) : undefined}
                  onChanged={load}
                />
              ))}
            <PrefRow
              desc={
                <span>
                  {t("desktop.prefs.thisMac.plug")}{" "}
                  {stepsAt && (
                    <button
                      type="button"
                      className="ac-link dk-link"
                      onClick={() =>
                        void host.openExternal(androidStepsUrl(stepsAt.server, stepsAt.orgId, stepsAt.computer.id))
                      }
                    >
                      {t("desktop.prefs.thisMac.androidSteps")}
                    </button>
                  )}
                  {host.platform === "mac" && (
                    <>
                      {stepsAt && " · "}
                      <button type="button" className="ac-link dk-link" onClick={() => openIphoneSetup(host)}>
                        {t("desktop.prefs.thisMac.iphoneSteps")}
                      </button>
                    </>
                  )}
                </span>
              }
            />
          </PrefCard>
        </>
      )}

      {whoHome && whoTarget?.server && whoTarget.orgId && (
        <Dialog
          open
          onOpenChange={(open) => !open && setWho(null)}
          title={t("desktop.prefs.thisMac.pickTitle")}
          closeLabel={t("desktop.common.close")}
          width={440}
        >
          <DialogBody>
            <PrefCard>
              <WhoRow
                home={whoHome}
                server={whoTarget.server}
                orgId={whoTarget.orgId}
                computer={thisComputer(answers[whoHome.homeId]?.list, whoHome)}
                error={answers[whoHome.homeId]?.error}
                user={user}
                onChanged={load}
              />
            </PrefCard>
          </DialogBody>
        </Dialog>
      )}
    </>
  );
}

/**
 * This Mac's permissions, as Prepare this Mac asks them, and where people turn them on again: an ad-hoc signed app
 * loses them with each update. Asking for Screen Recording or Full Disk Access keeps Preferences to open again when
 * macOS reopens the app.
 */
function Permissions() {
  const { t } = useTranslation();
  const host = useHost();
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    host
      .setupState()
      .then((s) => {
        if (s?.step !== "prefs" || !s.resumed) return;
        setResumed(true);
        return host.setSetupState(null);
      })
      .catch(() => {});
  }, [host]);
  const mac = useMacGrants(() => host.setSetupState({ step: "prefs" }).catch(() => {}));
  const title = t("desktop.prepare.prefsTitle");
  return (
    <>
      <CardTitle hint={hintFor(t, title, t("desktop.prepare.prefsHint"))}>{title}</CardTitle>
      <MacPermissionCard mac={mac} resumed={resumed} hinted />
    </>
  );
}

/** Who in `home` may point their agents at this computer, the web's three choices; people and roles in a dialog. */
function WhoRow({
  home,
  server,
  orgId,
  computer,
  error,
  user,
  onChanged,
}: {
  home: Home;
  server: string;
  orgId: string;
  computer: ComputerDevice | null;
  error: unknown;
  user: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const org = orgName(home);
  const title = org;
  const lead = <OrgTile logo={home.logo} size="lg" />;
  const id = `who-${home.homeId}`;

  if (error) {
    const signedOut = isSignedOut(error);
    return (
      <PrefRow
        lead={lead}
        title={title}
        desc={
          signedOut
            ? t("desktop.prefs.thisMac.signedOut", { server: serverName(server) })
            : t("desktop.prefs.thisMac.unreachable", { server: serverName(server) })
        }
        end={
          signedOut ? (
            <Button size="sm" onClick={() => void host.openExternal(`${server}/org/${encodeURIComponent(orgId)}`)}>
              {t("desktop.common.open")}
            </Button>
          ) : (
            <Button size="sm" icon="refresh" onClick={() => void onChanged()}>
              {t("desktop.common.retry")}
            </Button>
          )
        }
      />
    );
  }
  if (!computer) {
    return <PrefRow lead={lead} title={title} end={<PixelSpinner size={16} />} />;
  }

  const audience = computer.audience;
  const save = async (next: DeviceAudience) => {
    if (sameAudience(next, audience)) return true;
    setSaving(true);
    try {
      await siteApi(host, server).devices.updateComputer(orgId, computer.id, { audience: next });
      await onChanged();
      toast(t("desktop.prefs.thisMac.saved"));
      return true;
    } catch (err) {
      toast(errorText(t, err, i18n.language), "alert");
      return false;
    } finally {
      setSaving(false);
    }
  };
  // Someone else's agents on a computer where every agent is this OS user: what they can reach, said once.
  const wider = audience.mode !== "owner" && !computer.systemMode && user;

  return (
    <>
      <PrefRow
        lead={lead}
        htmlFor={id}
        title={title}
        hint={hintFor(
          t,
          title,
          wider ? t("desktop.prefs.thisMac.wider", { user }) : t("desktop.prefs.thisMac.whoDesc"),
        )}
        desc={
          audience.mode === "people" ? (
            <>
              {audienceWords(t, { audience, ownerName: null }).text}
              {computer.mayManage && (
                <>
                  {" · "}
                  <button type="button" className="ac-link dk-link" onClick={() => setPicking(true)}>
                    {t("desktop.prefs.thisMac.edit")}
                  </button>
                </>
              )}
            </>
          ) : undefined
        }
        end={
          <Select
            id={id}
            size="sm"
            align="end"
            aria-describedby={`${id}-hint`}
            value={audience.mode}
            disabled={!computer.mayManage || saving}
            onValueChange={(mode) => {
              if (mode === "people") setPicking(true);
              else void save({ mode, userIds: [], roleIds: [] });
            }}
            options={(["owner", "everyone", "people"] as const).map((mode) => ({
              value: mode,
              label:
                mode === "everyone" ? t("desktop.prefs.thisMac.everyone", { org }) : t(`desktop.prefs.thisMac.${mode}`),
              leading: <Icon name={AUDIENCE_ICON[mode]} size={16} />,
            }))}
          />
        }
      />
      {picking && (
        <PeoplePicker
          server={server}
          orgId={orgId}
          ownerUserId={computer.ownerUserId}
          value={audience.mode === "people" ? audience : { mode: "people", userIds: [], roleIds: [] }}
          saving={saving}
          onCancel={() => setPicking(false)}
          onSave={async (next) => {
            if (await save(next)) setPicking(false);
          }}
        />
      )}
    </>
  );
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** "Specific people or roles": the workspace's people (the owner always can) and roles, ticked. */
export function PeoplePicker({
  server,
  orgId,
  ownerUserId,
  value,
  saving,
  onCancel,
  onSave,
}: {
  server: string;
  orgId: string;
  ownerUserId: string | null;
  value: DeviceAudience;
  saving: boolean;
  onCancel: () => void;
  onSave: (next: DeviceAudience) => void;
}) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const [people, setPeople] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [userIds, setUserIds] = useState(() => new Set(value.userIds));
  const [roleIds, setRoleIds] = useState(() => new Set(value.roleIds));
  const api = useMemo(() => siteApi(host, server), [host, server]);
  useEffect(() => {
    let live = true;
    Promise.all([api.orgs.members(orgId), api.roles.list(orgId)])
      .then(([members, list]) => {
        if (!live) return;
        setPeople(members.filter((m) => m.userId !== ownerUserId));
        setRoles(list.roles.filter((r) => r.kind === "custom"));
      })
      .catch((err) => live && setFailed(errorText(t, err, i18n.language)));
    return () => {
      live = false;
    };
  }, [api, orgId, ownerUserId, t, i18n.language]);
  const q = fold(query.trim());
  const shown = (people ?? []).filter((m) => !q || fold(m.name).includes(q) || fold(m.email).includes(q));
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !saving && onCancel()}
      title={t("desktop.prefs.thisMac.pickTitle")}
      description={t("desktop.prefs.thisMac.ownerAlways")}
      closeLabel={t("desktop.common.close")}
      width={440}
    >
      <DialogBody className="dk-pick">
        {failed ? (
          <p className="dk-honest">{failed}</p>
        ) : !people ? (
          <PixelSpinner size={16} />
        ) : (
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("desktop.prefs.thisMac.search")}
              aria-label={t("desktop.prefs.thisMac.search")}
            />
            <h4 className="dk-ctitle">{t("audience.people")}</h4>
            <div className="dk-pick__list">
              {shown.length === 0 && <p className="dk-help">{t("desktop.prefs.thisMac.noMatch")}</p>}
              {shown.map((m) => (
                <div key={m.userId} className="dk-pick__row ac-iconline">
                  <Checkbox
                    id={`pick-person-${m.userId}`}
                    checked={userIds.has(m.userId)}
                    onCheckedChange={(on) => setUserIds((s) => toggle(s, m.userId, on))}
                  />
                  <label htmlFor={`pick-person-${m.userId}`} className="ac-iconline">
                    <Avatar kind="person" size="xs" name={m.name} imageUrl={m.avatarUrl ?? m.image} />
                    <span>{m.name}</span>
                  </label>
                </div>
              ))}
            </div>
            {roles.length > 0 && (
              <>
                <h4 className="dk-ctitle">{t("audience.roles")}</h4>
                <div className="dk-pick__list">
                  {roles.map((r) => (
                    <div key={r.id} className="dk-pick__row ac-iconline">
                      <Checkbox
                        id={`pick-role-${r.id}`}
                        checked={roleIds.has(r.id)}
                        onCheckedChange={(on) => setRoleIds((s) => toggle(s, r.id, on))}
                      />
                      <label htmlFor={`pick-role-${r.id}`}>{r.name}</label>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter bar>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t("desktop.common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={!people}
          onClick={() => onSave({ mode: "people", userIds: [...userIds], roleIds: [...roleIds] })}
        >
          {t("desktop.prefs.thisMac.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** On a Mac, the iPhones on its Wi-Fi that trust it, each with Use over Wi-Fi (for who may manage it). */
function WifiIphones({
  computer,
  server,
  orgId,
  org,
  onChanged,
}: {
  computer: ComputerDevice;
  server: string;
  orgId: string;
  org?: string;
  onChanged: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const near = useWifiIphones({ server, orgId, machineId: computer.id }, computer.mayManage);
  const pickIt = async (serial: string) => {
    try {
      await near.pick(serial);
      await onChanged();
    } catch (err) {
      toast(errorText(t, err, i18n.language), "alert");
    }
  };
  return near.available.map((p) => (
    <PrefRow
      key={p.serial}
      lead={<ComputerPortrait kind="iphone" state="paused" size={48} />}
      title={t("devices.iphone.wifi.also", { name: p.name ?? p.model })}
      desc={org}
      hint={hintFor(t, t("devices.iphone.wifi.use"), t("devices.iphone.wifi.hint"))}
      end={
        <Button
          size="sm"
          loading={near.using === p.serial}
          disabled={near.using !== null}
          onClick={() => void pickIt(p.serial)}
        >
          {t("devices.iphone.wifi.use")}
        </Button>
      }
    />
  ));
}

/** One phone on this computer: its state, who can use it, and its one way out (Stop, Show me how). */
function PhoneRow({
  phone,
  computer,
  home,
  server,
  orgId,
  org,
  onChanged,
}: {
  phone: PhoneDevice;
  computer: ComputerDevice;
  home: Home;
  server: string;
  orgId: string;
  /** With more than one workspace here: whose list the phone is in. */
  org?: string;
  onChanged: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const { kind, state } = portraitOf(phone);
  const s = phone.status;
  const look = statusLook(s);
  const holder = s.kind === "in_use" && s.agentId ? agentOf(home, { id: s.agentId, name: s.agentName ?? "" }) : null;
  const who =
    phone.audience === null
      ? audienceWords(t, { audience: null, ownerName: null, short: true }).text
      : t("desktop.prefs.thisMac.phoneWho", {
          who:
            phone.audience.mode === "owner"
              ? t("desktop.prefs.thisMac.owner")
              : audienceWords(t, { audience: phone.audience, ownerName: null }).text,
        });
  const line =
    s.kind === "needs_you"
      ? reasonText(t, s.reason)
      : [org, statusDetail(t, i18n.language, s, { host: computer.name, ios: iosOf(phone) }), who]
          .filter(Boolean)
          .join(" · ");
  const icon: IconName | undefined =
    look === "ready"
      ? "check"
      : look === "needs"
        ? "alert"
        : look === "offline"
          ? "dash"
          : look === "paused"
            ? "pause"
            : undefined;
  const lead = holder ? (
    <AgentFace agent={holder} size="xs" />
  ) : look === "preparing" || look === "busy" ? (
    <PixelSpinner size={14} />
  ) : undefined;
  const howTo = phone.platform === "ios" ? look === "needs" || look === "preparing" : look === "needs";

  // An iPhone over Wi-Fi is let go here, and comes back only if picked again.
  const letGo = async () => {
    setStopping(true);
    try {
      await siteApi(host, server).devices.forgetPhone(orgId, phone.id);
      toast(t("devices.iphone.wifi.stopped", { name: phone.name }));
      await onChanged();
    } catch (err) {
      toast(errorText(t, err, i18n.language), "alert");
    } finally {
      setStopping(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await siteApi(host, server).devices.stopPhone(orgId, phone.id);
      toast(t("devices.stopped", { name: phone.name }));
      await onChanged();
    } catch (err) {
      toast(errorText(t, err, i18n.language), "alert");
    } finally {
      setStopping(false);
    }
  };

  return (
    <PrefRow
      lead={<ComputerPortrait kind={kind} state={state} size={48} />}
      title={phone.name}
      chip={
        <Chip tone={look === "needs" ? "waiting" : "neutral"} icon={lead ? undefined : icon} lead={lead}>
          {statusPill(t, s)}
        </Chip>
      }
      hint={
        phone.platform === "android"
          ? hintFor(t, t("devices.who.title"), t("devices.who.phoneHint", { host: computer.name }))
          : undefined
      }
      desc={line}
      end={
        s.kind === "in_use" ? (
          <Button size="sm" icon="stop" loading={stopping} onClick={() => void stop()}>
            {t("devices.stop")}
          </Button>
        ) : howTo ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              phone.platform === "ios"
                ? openIphoneSetup(host)
                : void host.openExternal(androidStepsUrl(server, orgId, computer.id))
            }
          >
            {t("devices.showMe")}
          </Button>
        ) : iphoneOverWifi(phone) && computer.mayManage ? (
          <Button size="sm" loading={stopping} onClick={() => void letGo()}>
            {t("devices.iphone.wifi.stop")}
          </Button>
        ) : undefined
      }
    />
  );
}
