import { type AgentStyle, keys, useAiAccounts, useSetAgentStyle, useSetShowActivity } from "@agenteschat/client";
import { authErrorText, errorText } from "@agenteschat/client/lib/errors";
import { browserTimezone, isTimeZone, timezoneName, zoneDisplayName } from "@agenteschat/client/lib/routines";
import {
  AffixInput,
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
  PlanMeter,
  ProviderLogo,
  Segmented,
  Switch,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import type { AuthResult } from "@/auth/client";
import { useAuth } from "@/auth/context";
import { ChangeAvatarDialog } from "@/components/AvatarBuilder";
import { ChatLookSettings } from "@/components/ChatLookSettings";
import { PrefRow } from "@/components/NoticePrefs";
import { OpenOnPhoneDialog } from "@/components/OpenOnPhone";
import { useOrg } from "@/components/org-context";
import { MyFace } from "@/components/ProfilePhoto";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useDirectory } from "@/hooks/useDirectory";
import { localePatch, rememberLocale } from "@/i18n";
import { type MenuLook, menuLook, onMenuLookChange, setMenuLook } from "@/lib/context-menu";
import { inDesktopApp } from "@/lib/desktop";
import { useOpenParam } from "@/lib/open-param";
import { ownPlanLines, planMeterText } from "@/lib/plan-usage";
import { onSoundChoiceChange, type SoundChoice, setSoundChoice, soundChoice } from "@/lib/sounds";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { LanguageSelect } from "./LanguageSelect";

/**
 * Configurações › Sua conta: your profile in this workspace, your time zone, whether agents' work shows under their replies,
 * how agents talk to you (ADR 0147), opening the phone app and a password
 * for an account without one, your plans' limits (ADR 0063 §5), how conversations look to you, then what this device keeps for itself (theme,
 * language, sounds, the desktop app's menus), and last, deleting the account.
 */
export function AccountSection() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const api = useApi();
  const plans = ownPlanLines(t, useAiAccounts(org.id).data, dir.agents, me.user.id);
  const showActivity = useSetShowActivity(org.id);
  const agentStyle = useSetAgentStyle(org.id);
  const toast = useToast();
  // Looking at your plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  const theme = useTheme();
  const look = useSyncExternalStore(onMenuLookChange, menuLook, () => "ours" as const);
  const sounds = useSyncExternalStore(onSoundChoiceChange, soundChoice, soundChoice);
  const [profile, setProfile] = useState<"name" | "timezone" | null>(null);
  const [phone, setPhone] = useState(false);
  // Adding a password and deleting the account: their dialogs are the account button's, kept in the address so a
  // sign-in again comes back to them.
  const [, setAccount] = useOpenParam("account");
  const mine = dir.memberById.get(me.user.id);
  const zone = mine?.timezone || browserTimezone() || "UTC";
  return (
    <>
      <Card aria-label={t("shell.profile")}>
        <div className="settings-rows">
          <PrefRow
            id="account-profile"
            lead={<MyFace className="settings-row__face" />}
            label={t("shell.profile")}
            status={t("shell.profileHint")}
            onOpen={() => setProfile("name")}
          />
          <PrefRow
            id="account-zone"
            icon="clock"
            label={t("shell.timezone")}
            status={zoneDisplayName(zone, i18n.language) ?? timezoneName(zone, i18n.language)}
            onOpen={() => setProfile("timezone")}
          />
          <PrefRow
            id="account-activity"
            icon="layers"
            label={t("settings.account.activity")}
            hint={t("settings.account.activityHelp")}
            control={
              <Switch
                checked={org.showActivity === true}
                onCheckedChange={(on) =>
                  showActivity.mutate(on, { onError: () => toast.show(t("settings.account.activityFailed")) })
                }
                aria-label={t("settings.account.activity")}
              />
            }
          />
          {/* A server from before the choice sends no `agentStyle` and can't keep one. */}
          {org.agentStyle !== undefined && (
            <PrefRow
              id="account-agent-style"
              icon="message"
              label={t("settings.account.agentStyle")}
              hint={t("settings.account.agentStyleHelp")}
              control={
                <Segmented
                  size="sm"
                  label={t("settings.account.agentStyle")}
                  value={org.agentStyle ?? "simple"}
                  onValueChange={(v) =>
                    agentStyle.mutate(v as AgentStyle, {
                      onError: () => toast.show(t("settings.account.activityFailed")),
                    })
                  }
                  options={[
                    { value: "simple", label: t("settings.account.agentStyleSimple") },
                    { value: "technical", label: t("settings.account.agentStyleTechnical") },
                  ]}
                />
              }
            />
          )}
          <PrefRow
            id="account-phone"
            icon="phone"
            label={t("shell.openOnPhone")}
            status={t("shell.openOnPhoneHint")}
            onOpen={() => setPhone(true)}
          />
          <PrefRow
            id="account-password"
            icon="key"
            label={t(me.user.hasPassword === false ? "shell.addPassword" : "shell.newPassword")}
            status={t(me.user.hasPassword === false ? "shell.addPasswordHint" : "shell.newPasswordRow")}
            onOpen={() => setAccount("password")}
          />
        </div>
      </Card>
      {plans.length > 0 && (
        <Card aria-labelledby="account-plans">
          <CardHeader id="account-plans" title={t("settings.account.plans")} />
          <div className="settings-rows">
            {plans.map((p) => (
              <PrefRow
                key={p.key}
                id={`account-plan-${p.key}`}
                lead={<ProviderLogo id={p.logo} size="sm" />}
                label={p.name}
                status={<PlanMeter compact usage={p.usage} text={planMeterText(t, i18n.language)} />}
                onOpen={() =>
                  void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } })
                }
              />
            ))}
          </div>
        </Card>
      )}
      {/* A server from before the choice sends no `chatPrefs` and can't keep one. */}
      {org.chatPrefs !== undefined && <ChatLookSettings />}
      <Card aria-labelledby="account-device">
        <CardHeader id="account-device" title={t("settings.account.device")} />
        <div className="settings-rows">
          <PrefRow
            id="account-theme"
            icon="bulb"
            label={t("shell.theme")}
            control={
              <Segmented
                size="sm"
                label={t("shell.theme")}
                value={theme.preference}
                onValueChange={(v) => theme.setPreference(v as ThemePreference)}
                options={[
                  { value: "system", label: t("shell.themeSystem") },
                  { value: "light", label: t("shell.themeLight") },
                  { value: "dark", label: t("shell.themeDark") },
                ]}
              />
            }
          />
          <PrefRow
            id="account-language"
            icon="globe"
            label={t("shell.language")}
            control={
              <LanguageSelect
                signedIn
                align="end"
                onPick={(choice) =>
                  void api.account.updateMe(localePatch(choice)).catch(() => rememberLocale(choice, true))
                }
              />
            }
          />
          <PrefRow
            id="account-sounds"
            icon="sound"
            label={t("shell.sounds")}
            control={
              <Segmented
                size="sm"
                label={t("shell.sounds")}
                value={sounds}
                onValueChange={(v) => setSoundChoice(v as SoundChoice)}
                options={[
                  { value: "tactile", label: t("shell.soundTactile") },
                  { value: "sky", label: t("shell.soundSky") },
                  { value: "pixel", label: t("shell.soundPixel") },
                  { value: "off", label: t("shell.soundOff") },
                ]}
              />
            }
          />
          {inDesktopApp() && (
            <PrefRow
              id="account-look"
              icon="pointer"
              label={t("contextMenu.look")}
              control={
                <Segmented
                  size="sm"
                  label={t("contextMenu.look")}
                  value={look}
                  onValueChange={(v) => setMenuLook(v as MenuLook)}
                  options={[
                    { value: "ours", label: t("contextMenu.lookOurs") },
                    { value: "system", label: t("contextMenu.lookSystem") },
                  ]}
                />
              }
            />
          )}
        </div>
      </Card>
      <Card aria-labelledby="account-delete" className="settings-danger">
        <CardHeader
          id="account-delete"
          icon="trash"
          title={t("deleteAccount.menu")}
          subtitle={
            <>
              {t("deleteAccount.card.text")}{" "}
              <Link
                className="ac-link"
                to="/org/$orgId/settings/$section"
                params={{ orgId: org.id, section: org.role === "owner" ? "general" : "members" }}
              >
                {t(org.role === "owner" ? "deleteAccount.card.oneWorkspace" : "deleteAccount.card.leaveWorkspace")}
              </Link>
            </>
          }
          action={
            <Button size="sm" variant="danger" onClick={() => setAccount("delete")}>
              {t("deleteAccount.card.button")}
            </Button>
          }
        />
      </Card>
      <ProfileDialog focus={profile} onClose={() => setProfile(null)} />
      <OpenOnPhoneDialog open={phone} onClose={() => setPhone(false)} />
    </>
  );
}

class NameRefused extends Error {
  constructor(readonly result: Extract<AuthResult, { ok: false }>) {
    super(result.code);
  }
}

/** "Perfil" and "Fuso horário": my name (the account's, the same in every workspace), photo, handle and time zone here. */
export function ProfileDialog({ focus, onClose }: { focus: "name" | "timezone" | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const mine = dir.memberById.get(me.user.id);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [zone, setZone] = useState("");
  const [useOrgZone, setUseOrgZone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (!focus) return;
    setName(me.user.name);
    setHandle(mine?.handle ?? "");
    setZone(mine?.timezone || browserTimezone() || "UTC");
    setUseOrgZone(false);
    setError(null);
  }, [focus, mine, me.user.name]);
  const zoneOk = useOrgZone || isTimeZone(zone.trim());
  const nameOk = name.trim() !== "";
  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() !== me.user.name) {
        const result = await auth.updateName(name.trim());
        if (!result.ok) throw new NameRefused(result);
      }
      await api.orgs.updateMe(org.id, {
        handle: handle.trim() || undefined,
        timezone: useOrgZone ? null : zone.trim(),
      });
    },
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.members(org.id) });
      void qc.invalidateQueries({ queryKey: keys.people(org.id) });
      toast.show(t("shell.profileSaved"));
      onClose();
    },
    onError: (e) => setError(e instanceof NameRefused ? authErrorText(t, e.result) : errorText(t, e)),
  });
  return (
    <Dialog
      open={focus !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("shell.profileTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (zoneOk && nameOk && !save.isPending) save.mutate();
        }}
      >
        <Locked when={save.isPending}>
          <DialogBody>
            <div className="row" style={{ gap: 12, alignItems: "center" }}>
              <Avatar name={me.user.name} size="lg" imageUrl={mine?.image ?? me.user.image} />
              <span style={{ fontWeight: 600, flex: 1 }}>{t("photo.label")}</span>
              <Button size="sm" type="button" onClick={() => setAsk(true)}>
                {t("photo.change")}
              </Button>
            </div>
            <Field label={t("auth.yourName")} id="me-name" error={nameOk ? undefined : t("shell.nameEmpty")}>
              <Input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus={focus === "name"}
              />
            </Field>
            <Field label={t("shell.handle")} id="me-handle">
              <AffixInput prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </Field>
            <Field
              label={t("shell.timezone")}
              id="me-zone"
              hint={{ name: t("common.about", { label: t("shell.timezone") }), text: t("shell.timezoneHelp") }}
              error={!zoneOk ? t("shell.timezoneInvalid") : undefined}
            >
              <ZoneSelect value={zone || "UTC"} disabled={useOrgZone} onChange={setZone} />
            </Field>
            <span className="row" style={{ gap: 8, alignItems: "center" }}>
              <Checkbox id="me-zone-org" checked={useOrgZone} onCheckedChange={setUseOrgZone} />
              <label htmlFor="me-zone-org">{t("shell.useOrgZone")}</label>
            </span>
            {error && <Alert>{error}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!zoneOk || !nameOk || save.isPending}
            loading={save.isPending}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
      <ChangeAvatarDialog open={ask} onClose={() => setAsk(false)} />
    </Dialog>
  );
}
