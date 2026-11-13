import { ApiError, useApi, useMe, useSettings } from "@agenteschat/client";
import { browserTimezone, zoneDisplayName } from "@agenteschat/client/lib/routines";
import { filterZones, type ZoneOption, zoneOptions } from "@agenteschat/ui/timezones";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { authClient } from "@/lib/auth";
import { useOrg, useOrgMaybe } from "@/providers/org";
import {
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PersonAvatar,
  SearchField,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { SheetHeader } from "../new/parts";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { goBack, PushedHeader } from "../shared/parts";
import { usePersonPhoto } from "../shared/photo";
import { type AccountDraft, accountChanges, accountProblem, handleErrorKey } from "./logic";
import { Page, refreshProfile, setAccountDraft, useAccountDraft, useChangePhoto } from "./parts";

/** A zone as the list says it: "Horário de Brasília" (a friendly name) or the city. */
const zoneName = (zone: string, locale: string) =>
  zoneDisplayName(zone, locale) ?? (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/**
 * Conta: the photo and "Alterar foto", Nome (editable), E-mail (read only),
 * then in this workspace your @ and the time zone (Fuso, pushed over it), as the web's Perfil. "OK" in the bar
 * saves and goes back; Apagar conta at the end.
 */
export function AccountPage() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const dir = useDirectory();
  const mine = meId ? dir.memberById.get(meId) : undefined;
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  // The form starts from the profile when Conta opens (Fuso, over it, changes its zone) and is dropped when it closes.
  // Taken once both the account and this workspace's profile are in, so an @ still loading never reads as empty.
  const loaded = Boolean(me.data && mine);
  const [initial, setInitial] = useState<AccountDraft>(() => ({
    name: me.data?.user.name ?? "",
    handle: mine?.handle ?? "",
    zone: mine?.timezone ?? null,
  }));
  const [seeded, setSeeded] = useState(loaded);
  useEffect(() => {
    if (seeded || !loaded) return;
    setSeeded(true);
    setInitial({ name: me.data?.user.name ?? "", handle: mine?.handle ?? "", zone: mine?.timezone ?? null });
  }, [seeded, loaded, me.data, mine]);
  useEffect(() => {
    setAccountDraft(initial);
    return () => setAccountDraft(null);
  }, [initial]);
  const draft = useAccountDraft() ?? initial;
  const setDraft = setAccountDraft;
  const [saving, setSaving] = useState(false);
  const { changePhoto, uploading } = useChangePhoto();
  const [error, setError] = useState<string | null>(null);

  // A message from the last OK goes away once the form changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared on every edit of the form
  useEffect(() => setError(null), [draft]);

  const problem = accountProblem(draft);
  const changes = accountChanges(initial, draft);
  const changed = Boolean(changes.name || changes.profile);
  // Show what's wrong once the person changed something (not on a fresh, untouched form).
  const shownProblem = changed && problem ? t(`mobile.me.account.${problem}`) : null;

  const save = async () => {
    if (saving) return;
    // Nothing to save (a new photo saves on its own): OK just closes, as it says.
    if (!changed) return goBack();
    if (problem) return setError(t(`mobile.me.account.${problem}`));
    setSaving(true);
    setError(null);
    try {
      if (changes.name) {
        const res = await authClient().updateUser({ name: changes.name });
        if (res.error) throw new Error(res.error.message ?? "");
      }
      if (changes.profile) await api.orgs.updateMe(org.orgId, changes.profile);
      refreshProfile(qc, org.orgId);
      toast({ title: t("mobile.me.account.saved") });
      goBack();
    } catch (e) {
      const key = e instanceof ApiError ? handleErrorKey(e.code) : null;
      setError(key ? t(`mobile.me.account.${key}`) : t("mobile.app.failed"));
    } finally {
      setSaving(false);
    }
  };

  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  const zoneLabel = draft.zone ? zoneName(draft.zone, i18n.language) : t("mobile.me.account.orgZone");
  return (
    <Page
      title={t("mobile.me.account.title")}
      action={{
        label: t("mobile.me.account.save"),
        disabled: saving,
        onPress: () => void save(),
      }}
      locked={saving}
    >
      <View style={styles.photo}>
        <PersonAvatar name={draft.name || "?"} size={92} photo={photo} />
        <Pressable
          onPress={changePhoto}
          disabled={uploading}
          accessibilityRole="button"
          hitSlop={12}
          style={({ pressed }) => (pressed ? styles.pressed : null)}
        >
          <Text variant="subhead" tone={uploading ? "faint" : "ink2"} style={styles.semibold}>
            {t("mobile.me.account.changePhoto")}
          </Text>
        </Pressable>
      </View>
      <GroupedList>
        <GroupedField label={t("mobile.me.account.name")}>
          <TextInput
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            placeholder={t("mobile.me.account.namePlaceholder")}
            placeholderTextColor={c.faint}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="done"
            accessibilityLabel={t("mobile.me.account.name")}
            style={input}
          />
        </GroupedField>
        <GroupedField label={t("mobile.me.account.email")}>
          <Text variant="callout" tone="faint" numberOfLines={1}>
            {me.data?.user.email ?? ""}
          </Text>
        </GroupedField>
      </GroupedList>
      <GroupedHeader>{t("mobile.me.account.inWorkspace", { org: org.org?.name ?? "" })}</GroupedHeader>
      <GroupedList>
        <GroupedField label={t("mobile.me.account.handle")}>
          <View style={styles.handle}>
            <Text variant="callout" tone="faint">
              @
            </Text>
            <TextInput
              value={draft.handle}
              onChangeText={(handle) => setDraft({ ...draft, handle })}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="done"
              accessibilityLabel={t("mobile.me.account.handle")}
              style={input}
            />
          </View>
        </GroupedField>
        <GroupedField
          label={t("mobile.me.account.timezone")}
          hint={{
            name: t("common.about", { label: t("mobile.me.account.timezone") }),
            text: t("mobile.me.account.timezoneHint"),
          }}
          onPress={() => router.push("/me/zone")}
        >
          <Text variant="callout" numberOfLines={1}>
            {zoneLabel}
          </Text>
        </GroupedField>
      </GroupedList>
      {shownProblem || error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {shownProblem ?? error}
        </Text>
      ) : null}
      <View style={styles.gapBig} />
      <GroupedList>
        <GroupedRow
          icon="x"
          label={t("mobile.me.deleteAccount")}
          danger
          chevron
          onPress={() => router.push("/account-delete")}
        />
      </GroupedList>
      <GroupedFooter>{t("deleteAccount.card.text")}</GroupedFooter>
      <GroupedList>
        <GroupedRow
          icon="home"
          label={t(org.org?.role === "owner" ? "deleteAccount.card.oneWorkspace" : "deleteAccount.card.leaveWorkspace")}
          labelLines={2}
          chevron
          onPress={() => router.push(org.org?.role === "owner" ? "/settings/general" : "/me/members")}
        />
      </GroupedList>
    </Page>
  );
}

/** Fuso, pushed over Conta: a pick goes into Conta's form and back to it ("Usar o fuso do workspace" is null). */
export function ZonePage() {
  const { t } = useTranslation();
  const draft = useAccountDraft();
  return (
    <ZoneList
      title={t("mobile.me.zone.title")}
      value={draft?.zone ?? null}
      withWorkspace
      onPick={(zone) => {
        if (draft) setAccountDraft({ ...draft, zone });
        goBack();
      }}
    />
  );
}

interface ZoneListProps {
  title: string;
  value: string | null;
  withWorkspace?: boolean;
  onPick: (zone: string | null) => void;
  /**
   * Shown in a sheet of its own (the first run, which sits outside the navigator): its own bar with × instead of the
   * pushed screen's native bar, which would retitle the screen under the sheet.
   */
  onClose?: () => void;
}

/**
 * A time zone chosen on a screen of its own (Conta's Fuso, a routine's "Fuso horário", the first run's "Fuso"): the
 * search, "Usar o fuso do workspace" (`withWorkspace`: a pick of null), then the suggested zones and every other.
 * Inside a workspace its zone and its people's are suggested too; before there is one (the first run), the phone's.
 */
export function ZoneList(props: ZoneListProps) {
  const org = useOrgMaybe();
  return org ? <WorkspaceZoneList {...props} orgId={org.orgId} /> : <ZonePicker {...props} orgZone={null} people="" />;
}

/** In a workspace: its own zone and its people's suggested first. */
function WorkspaceZoneList({ orgId, ...props }: ZoneListProps & { orgId: string }) {
  const settings = useSettings(orgId);
  const dir = useDirectory();
  const people = [...dir.memberById.values()].map((m) => m.timezone).join(",");
  return <ZonePicker {...props} orgZone={settings.data?.timezone ?? null} people={people} />;
}

function ZonePicker({
  title,
  value,
  withWorkspace = false,
  onPick,
  onClose,
  orgZone,
  people,
}: ZoneListProps & {
  orgZone: string | null;
  /** The people's zones, comma-separated (a stable dependency). */
  people: string;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const suggested = [value ?? "", browserTimezone() ?? "", orgZone ?? "", ...people.split(","), "UTC"].filter(
      Boolean,
    );
    return zoneOptions(suggested, (z) => zoneDisplayName(z, i18n.language));
  }, [value, orgZone, people, i18n.language]);
  const q = query.trim();
  const rows: (ZoneOption | { header: string })[] = q
    ? filterZones([...options.suggested, ...options.rest], q)
    : [
        { header: t("mobile.me.zone.suggested") },
        ...options.suggested,
        { header: t("mobile.me.zone.all") },
        ...options.rest,
      ];
  // A group starts after a header (or the top) and ends before the next one (or the end).
  const edge = (i: number) => {
    const row = rows[i];
    return row === undefined || "header" in row;
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      {onClose ? (
        <View style={styles.sheetBar}>
          <SheetHeader title={title} onPress={onClose} />
        </View>
      ) : (
        <PushedHeader title={title} solid={false} grouped />
      )}
      <FlatList
        data={rows}
        keyExtractor={(r) => ("header" in r ? `h:${r.header}` : r.zone)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        initialNumToRender={20}
        contentContainerStyle={[styles.zoneList, { paddingBottom: 24 + insets.bottom }]}
        ListHeaderComponent={
          <>
            <View style={styles.search}>
              <SearchField value={query} onChangeText={setQuery} placeholder={t("mobile.me.zone.search")} />
            </View>
            {q || !withWorkspace ? null : (
              <GroupedList>
                <GroupedRow
                  label={t("mobile.me.zone.useOrg")}
                  {...(orgZone ? { sub: zoneName(orgZone, i18n.language) } : {})}
                  checked={value === null}
                  onPress={() => onPick(null)}
                />
              </GroupedList>
            )}
          </>
        }
        ListEmptyComponent={<GroupedFooter>{t("mobile.me.zone.none")}</GroupedFooter>}
        renderItem={({ item, index }) =>
          "header" in item ? (
            <GroupedHeader>{item.header}</GroupedHeader>
          ) : (
            <ZoneRow
              option={item}
              checked={item.zone === value}
              first={edge(index - 1)}
              last={edge(index + 1)}
              onPress={() => onPick(item.zone)}
            />
          )
        }
      />
    </View>
  );
}

/**
 * One zone, a row of a GroupedList drawn piece by piece so the long list stays virtualized: the group's corners on its
 * first and last row, the hairline from the text on, and the group's shadow kept to its sides where two rows meet.
 */
function ZoneRow({
  option,
  checked,
  first,
  last,
  onPress,
}: {
  option: ZoneOption;
  checked: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <View style={[styles.zoneClip, first && styles.zoneClipFirst, last && styles.zoneClipLast]}>
      <View
        style={[
          styles.zoneRow,
          first && styles.zoneFirst,
          last && styles.zoneLast,
          { backgroundColor: c.raised, boxShadow: first ? `${shadows.e1}, ${shadows.top}` : shadows.e1 },
        ]}
      >
        {first ? null : <View style={[styles.zoneDivider, { backgroundColor: c.line2 }]} />}
        <GroupedRow label={option.name} value={option.offsetLabel} checked={checked} onPress={onPress} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The sheet's own bar (the first run): on the 16 margin, clear of the grabber.
  sheetBar: { paddingHorizontal: 16, paddingTop: 14 },
  fill: { flex: 1 },
  photo: { alignItems: "center", gap: 8, paddingTop: 6, paddingBottom: 14 },
  semibold: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  handle: { flexDirection: "row", alignItems: "center", gap: 1 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
  gapBig: { height: 24 },
  search: { paddingTop: 4, paddingBottom: 8 },
  zoneList: { paddingHorizontal: 16 },
  // Room for the shadow beside the rows (and above and below the group), cut where two rows meet: no line across.
  zoneClip: { overflow: "hidden", marginHorizontal: -6, paddingHorizontal: 6 },
  zoneClipFirst: { marginTop: -6, paddingTop: 6 },
  zoneClipLast: { marginBottom: -6, paddingBottom: 6 },
  // GroupedList's numbers: radius 14, the hairline inset 14 to the text.
  zoneRow: { overflow: "hidden" },
  zoneFirst: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  zoneLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  zoneDivider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
});
