import {
  ApiError,
  useDeleteVaultItem,
  useUpdateVaultItem,
  useVaultItem,
  type VaultItemDetail,
  type VaultMatch,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { confirmAction, Gap, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import {
  accessSentence,
  agentsSummary,
  CONTACT_FIELDS,
  editProblem,
  formOf,
  hostOf,
  itemPatch,
  keyNameFrom,
  LIMITS,
  PROBLEM_KEY,
  patchEmpty,
  peopleSummary,
  usageFacts,
  usageWords,
  type VaultForm,
  vaultHref,
  websiteOrigin,
} from "./logic";
import { InputField, SavedValue, useVaultNames } from "./parts";

/**
 * An item's page (ADR 0144), the web's item dialog as a pushed screen: its fields by kind (a password or a key only
 * as dots, shown or copied by who may, each time recorded), "Change" for a new value, who has access in one sentence
 * with the rows that change it, its recent uses, and Delete. An item from a password manager changes there: here
 * only its access, description and a key's name.
 */
export function VaultItemScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const item = useVaultItem(orgId, id);
  if (!item.data) {
    const gone = item.error instanceof ApiError && item.error.status === 404;
    return (
      <SettingsPage title={t("settings.section.vault")}>
        {item.isError ? (
          <View style={styles.note}>
            <Note icon="x">{gone ? t("mobile.vault.item.gone") : t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )}
      </SettingsPage>
    );
  }
  return <ItemPage key={item.data.id} item={item.data} />;
}

function ItemPage({ item }: { item: VaultItemDetail }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const names = useVaultNames();
  const now = useNow(60_000);
  const update = useUpdateVaultItem(orgId);
  const remove = useDeleteVaultItem(orgId);
  const [form, setForm] = useState<VaultForm>(() => formOf(item));
  // "Change password": the field for a new value opens only when asked.
  const [changing, setChanging] = useState(false);
  const external = item.connectionId !== null;
  const editable = item.can.edit;
  const ownFields = editable && !external;
  const patch = itemPatch(item, form);
  const dirty = !patchEmpty(patch);
  // Someone else saved it meanwhile (the page refetched): untouched fields follow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a newer save resets the form
  useEffect(() => {
    if (!dirty) setForm(formOf(item));
  }, [item.updatedAt]);
  const set = (change: Partial<VaultForm>) => setForm((f) => ({ ...f, ...change }));
  const failed = (err: unknown) => toast({ title: errorText(t, err, i18n.language), icon: "x" });

  const save = () => {
    const problem = editProblem(item, form);
    if (problem) return toast({ title: t(PROBLEM_KEY[problem]), icon: "x" });
    update.mutate(
      { itemId: item.id, ...patch },
      {
        onSuccess: (saved) => {
          successHaptic();
          setForm(formOf(saved));
          setChanging(false);
          toast({ title: t("common.saved") });
        },
        onError: failed,
      },
    );
  };
  const followConnection = () =>
    update.mutate(
      { itemId: item.id, accessFromConnection: true },
      { onSuccess: () => toast({ title: t("mobile.vault.access.saved") }), onError: failed },
    );
  const askDelete = () =>
    confirmAction({
      title: t("mobile.vault.item.deleteTitle", { title: item.title }),
      text: external
        ? t("mobile.vault.item.deleteExternal", { name: item.sourceName ?? "" })
        : t("mobile.vault.item.deleteText"),
      action: t("mobile.vault.item.delete"),
      cancel: t("mobile.common.cancel"),
      onConfirm: () =>
        remove.mutate(item.id, {
          onSuccess: () => {
            successHaptic();
            toast({ title: t("mobile.vault.item.deleted"), icon: "trash" });
            goBack();
          },
          onError: failed,
        }),
    });

  const kindName = t(`mobile.vault.kind.${item.kind}`);
  const scopeName = item.scope === "personal" ? t("mobile.vault.tab.personal") : t("mobile.vault.tab.team");
  const valueLabel = item.kind === "key" ? t("mobile.vault.field.value") : t("mobile.vault.field.password");
  const hasValue = item.kind === "login" || item.kind === "key";

  return (
    <SettingsPage
      title={item.title}
      subtitle={`${kindName} · ${scopeName}`}
      {...(editable && dirty ? { action: { label: t("common.save"), onPress: save, disabled: update.isPending } } : {})}
      locked={update.isPending}
    >
      {item.missing ? (
        <View style={styles.note}>
          <Note icon="wait">{t("mobile.vault.item.missingText", { name: item.sourceName ?? "" })}</Note>
        </View>
      ) : null}
      {/* A contact whose saved fields don't open on the server (ADR 0144): who manages it types them again. */}
      {item.unreadable ? (
        <View style={styles.note}>
          <Note icon="x">{t("mobile.vault.item.unreadable")}</Note>
        </View>
      ) : null}
      <Gap />
      <GroupedList>
        <InputField
          label={t("mobile.vault.field.title")}
          value={form.title}
          onChange={(title) => set({ title })}
          editable={ownFields}
          maxLength={LIMITS.title}
          autoCapitalize="sentences"
        />
        {item.kind === "login" ? (
          <InputField
            label={t("mobile.vault.field.website")}
            value={form.website}
            onChange={(website) => set({ website })}
            editable={ownFields}
            maxLength={LIMITS.website}
            keyboardType="url"
            autoCapitalize="none"
            placeholder={t("mobile.vault.field.websitePlaceholder")}
          />
        ) : null}
        {item.kind === "login" ? (
          <InputField
            label={t("mobile.vault.field.username")}
            value={form.username}
            onChange={(username) => set({ username })}
            editable={ownFields}
            maxLength={LIMITS.username}
            autoCapitalize="none"
            textContentType="username"
          />
        ) : null}
        {item.kind === "key" ? (
          <InputField
            label={t("mobile.vault.field.keyName")}
            value={form.keyName}
            onChange={(keyName) => set({ keyName: keyNameFrom(keyName) })}
            editable={editable}
            mono
            maxLength={LIMITS.keyName}
            autoCapitalize="characters"
          />
        ) : null}
        {hasValue && item.hasSecret ? <SavedValue label={valueLabel} /> : null}
        {item.kind === "contact"
          ? CONTACT_FIELDS.map((field) => (
              <InputField
                key={field}
                label={t(`mobile.vault.contact.${field}`)}
                value={form.contact[field] ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, contact: { ...f.contact, [field]: v } }))}
                editable={ownFields}
                maxLength={LIMITS.contact}
                {...contactKeyboard(field)}
              />
            ))
          : null}
      </GroupedList>
      {external ? (
        <GroupedFooter>{t("mobile.vault.item.externalText", { name: item.sourceName ?? "" })}</GroupedFooter>
      ) : hasValue && !item.hasSecret ? (
        <GroupedFooter>{t("mobile.vault.item.noValue")}</GroupedFooter>
      ) : hasValue && ownFields ? (
        <GroupedFooter>{t("mobile.vault.item.sealedHelp")}</GroupedFooter>
      ) : null}

      {hasValue && ownFields ? (
        <>
          <Gap />
          <GroupedList>
            {changing ? (
              <InputField
                label={item.kind === "key" ? t("mobile.vault.field.newValue") : t("mobile.vault.field.newPassword")}
                value={form.secret}
                onChange={(secret) => set({ secret })}
                secureTextEntry
                textContentType="none"
                autoComplete="off"
                autoCapitalize="none"
                autoFocus
              />
            ) : (
              <GroupedRow
                icon="pen"
                label={item.kind === "key" ? t("mobile.vault.item.changeValue") : t("mobile.vault.item.changePassword")}
                onPress={() => setChanging(true)}
              />
            )}
          </GroupedList>
          {changing ? <GroupedFooter>{t("mobile.vault.item.changeHelp")}</GroupedFooter> : null}
        </>
      ) : null}

      {item.kind === "login" ? (
        <MatchRows
          match={form.match}
          website={form.website}
          editable={ownFields}
          onChange={(match) => set({ match })}
        />
      ) : null}

      {item.kind !== "contact" ? (
        <>
          <Gap />
          <GroupedList>
            <InputField
              label={t("mobile.vault.field.description")}
              hint={{
                name: t("common.about", { label: t("mobile.vault.field.description") }),
                text: t("mobile.vault.field.descriptionHelp"),
              }}
              value={form.description}
              onChange={(description) => set({ description })}
              editable={editable}
              maxLength={LIMITS.description}
              autoCapitalize="sentences"
              placeholder={t("mobile.vault.field.descriptionPlaceholder")}
            />
          </GroupedList>
        </>
      ) : null}

      <GroupedHeader>{t("mobile.vault.access.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon={item.scope === "personal" ? "lock" : "members"}
          label={scopeName}
          sub={item.scope === "personal" ? t("mobile.vault.scope.personalText") : t("mobile.vault.scope.teamText")}
          subLines={3}
        />
        {item.scope === "team" ? (
          <GroupedRow
            icon="person"
            label={t("mobile.vault.access.people")}
            value={peopleSummary(t, item.scope, item.access, names)}
            chevron={editable}
            {...(editable ? { onPress: () => router.push(vaultHref.itemAccess(item.id) as never) } : {})}
          />
        ) : null}
        <GroupedRow
          icon="agent"
          label={t("mobile.vault.access.agents")}
          value={agentsSummary(t, item.access, names)}
          chevron={editable}
          {...(editable ? { onPress: () => router.push(vaultHref.itemAccess(item.id) as never) } : {})}
        />
        {external && editable && !item.accessFromConnection ? (
          <GroupedRow
            icon="undo"
            label={t("mobile.vault.access.useConnection")}
            disabled={update.isPending}
            onPress={followConnection}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>
        {[
          accessSentence(t, item.scope, item.access, names),
          external && item.accessFromConnection ? t("mobile.vault.access.followsConnection") : null,
        ]
          .filter(Boolean)
          .join(" ")}
      </GroupedFooter>

      <GroupedHeader>{t("mobile.vault.uses.title")}</GroupedHeader>
      {item.uses.length === 0 ? (
        <GroupedFooter>{t("mobile.vault.uses.none")}</GroupedFooter>
      ) : (
        <GroupedList>
          {item.uses.map((use) => (
            <GroupedRow
              key={use.id}
              leading={
                <Face
                  who={use.agentId ? { type: "agent", id: use.agentId } : { type: "person", id: use.userId }}
                  size={32}
                  live={false}
                />
              }
              label={usageWords(t, use, names)}
              labelLines={2}
              sub={usageFacts(t, i18n.language, use, names, new Date(now))}
            />
          ))}
        </GroupedList>
      )}

      {item.can.delete ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="trash"
              label={t("mobile.vault.item.delete")}
              danger
              disabled={remove.isPending}
              onPress={askDelete}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** Where agents may type a login: only its exact address (the default), or anywhere on the same site. */
export function MatchRows({
  match,
  website,
  editable,
  onChange,
}: {
  match: VaultMatch;
  website: string;
  editable: boolean;
  onChange: (match: VaultMatch) => void;
}) {
  const { t } = useTranslation();
  const origin = websiteOrigin(website);
  const host = hostOf(origin);
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("mobile.vault.match.title") }), text: t("mobile.vault.match.help") }}
      >
        {t("mobile.vault.match.title")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("mobile.vault.match.exact")}
          sub={origin ?? t("mobile.vault.match.exactText")}
          checked={match === "exact"}
          disabled={!editable}
          onPress={() => onChange("exact")}
        />
        <GroupedRow
          label={t("mobile.vault.match.site")}
          sub={host ? t("mobile.vault.match.siteOn", { host }) : t("mobile.vault.match.siteText")}
          subLines={2}
          checked={match === "site"}
          disabled={!editable}
          onPress={() => onChange("site")}
        />
      </GroupedList>
    </>
  );
}

/** The keyboard a contact's field wants. */
export function contactKeyboard(field: (typeof CONTACT_FIELDS)[number]) {
  if (field === "email") return { keyboardType: "email-address" as const, autoCapitalize: "none" as const };
  if (field === "phone") return { keyboardType: "phone-pad" as const, autoCapitalize: "none" as const };
  if (field === "postalCode" || field === "document")
    return { keyboardType: "default" as const, autoCapitalize: "characters" as const };
  return { keyboardType: "default" as const, autoCapitalize: "words" as const };
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
});
