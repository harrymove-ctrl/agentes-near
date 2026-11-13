import {
  useCreateVaultItem,
  useVault,
  type VaultAccess,
  type VaultItemKind,
  type VaultScope,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import {
  CONTACT_FIELDS,
  defaultAccess,
  emptyForm,
  formProblem,
  hostOf,
  itemInput,
  KIND_ICON,
  keyNameFrom,
  LIMITS,
  PROBLEM_KEY,
  reservedKeyName,
  SECRET_NAME,
  VAULT_KINDS,
  type VaultForm,
  vaultHref,
  websiteOrigin,
} from "./logic";
import { AgentRows, InputField, ScopeRows } from "./parts";
import { contactKeyboard, MatchRows } from "./VaultItemScreen";

/**
 * A new Vault item (ADR 0144), the web's dialog as a pushed screen: what it is (a login, a key or contact details),
 * its fields, personal or the team's (the team's only for who manages the workspace's keys), and the agents that may
 * use it. Saved, it opens its own page, where who sees it can be narrowed.
 */
export function VaultNewScreen({ scope: asked }: { scope: VaultScope }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const vault = useVault(orgId);
  const create = useCreateVaultItem(orgId);
  const canTeam = vault.data?.canManageTeam ?? false;
  const [form, setForm] = useState<VaultForm>(() => emptyForm("login"));
  const [chosen, setChosen] = useState<VaultScope>(asked);
  // The team's only for who may: until the Vault says so, and for anyone else, a new item is personal.
  const scope: VaultScope = chosen === "team" && canTeam ? "team" : "personal";
  // The scope's default access until the person changes an agent (a new scope starts from its own default).
  const [touched, setTouched] = useState<VaultAccess | null>(null);
  const access = touched ?? defaultAccess(scope);
  const set = (change: Partial<VaultForm>) => setForm((f) => ({ ...f, ...change }));
  const pickKind = (kind: VaultItemKind) => setForm((f) => ({ ...emptyForm(kind), title: f.title }));
  const pickScope = (next: VaultScope) => {
    setChosen(next);
    setTouched(null);
  };
  const problem = formProblem(form, true);
  const save = () => {
    if (problem) return;
    create.mutate(itemInput(form, scope, access), {
      onSuccess: (item) => {
        successHaptic();
        toast({ title: t("mobile.vault.savedToVault"), icon: "lock" });
        router.replace(vaultHref.item(item.id) as never);
      },
      onError: (err) => toast({ title: errorText(t, err, i18n.language), icon: "x" }),
    });
  };

  const typedWebsite = form.website.trim() !== "";
  const keyName = form.keyName.trim();
  const keyHint =
    keyName && !SECRET_NAME.test(keyName)
      ? t(PROBLEM_KEY.keyName)
      : keyName && reservedKeyName(keyName)
        ? t(PROBLEM_KEY.keyReserved)
        : t("mobile.vault.field.keyNameHelp");

  return (
    <SettingsPage
      title={t("mobile.vault.newItem")}
      action={{ label: t("common.save"), onPress: save, disabled: problem !== null || create.isPending }}
      locked={create.isPending}
    >
      <GroupedHeader>{t("mobile.vault.kindTitle")}</GroupedHeader>
      <GroupedList>
        {VAULT_KINDS.map((kind) => (
          <GroupedRow
            key={kind}
            icon={KIND_ICON[kind]}
            label={t(`mobile.vault.kind.${kind}`)}
            sub={t(`mobile.vault.kindText.${kind}`)}
            subLines={2}
            checked={form.kind === kind}
            onPress={() => pickKind(kind)}
          />
        ))}
      </GroupedList>

      <Gap />
      {form.kind === "login" ? (
        <>
          <GroupedList>
            <InputField
              label={t("mobile.vault.field.website")}
              hint={{
                name: t("common.about", { label: t("mobile.vault.field.website") }),
                text: t("mobile.vault.field.loginHelp"),
              }}
              value={form.website}
              onChange={(website) => set({ website })}
              maxLength={LIMITS.website}
              keyboardType="url"
              autoCapitalize="none"
              placeholder={t("mobile.vault.field.websitePlaceholder")}
            />
            <InputField
              label={t("mobile.vault.field.username")}
              value={form.username}
              onChange={(username) => set({ username })}
              maxLength={LIMITS.username}
              autoCapitalize="none"
              textContentType="username"
            />
            <InputField
              label={t("mobile.vault.field.password")}
              value={form.secret}
              onChange={(secret) => set({ secret })}
              secureTextEntry
              textContentType="none"
              autoComplete="off"
              autoCapitalize="none"
            />
            <InputField
              label={t("mobile.vault.field.title")}
              value={form.title}
              onChange={(title) => set({ title })}
              maxLength={LIMITS.title}
              autoCapitalize="sentences"
              placeholder={hostOf(websiteOrigin(form.website)) || t("mobile.vault.field.titleOptional")}
            />
          </GroupedList>
          {typedWebsite && !websiteOrigin(form.website) ? (
            <GroupedFooter>{t(PROBLEM_KEY.website)}</GroupedFooter>
          ) : null}
          <MatchRows match={form.match} website={form.website} editable onChange={(match) => set({ match })} />
        </>
      ) : null}

      {form.kind === "key" ? (
        <>
          <GroupedList>
            <InputField
              label={t("mobile.vault.field.keyName")}
              value={form.keyName}
              onChange={(v) => set({ keyName: keyNameFrom(v) })}
              mono
              maxLength={LIMITS.keyName}
              autoCapitalize="characters"
              placeholder={t("mobile.vault.field.keyNamePlaceholder")}
            />
            <InputField
              label={t("mobile.vault.field.value")}
              value={form.secret}
              onChange={(secret) => set({ secret })}
              secureTextEntry
              textContentType="none"
              autoComplete="off"
              autoCapitalize="none"
            />
            <InputField
              label={t("mobile.vault.field.description")}
              value={form.description}
              onChange={(description) => set({ description })}
              maxLength={LIMITS.description}
              autoCapitalize="sentences"
              placeholder={t("mobile.vault.field.descriptionPlaceholder")}
            />
          </GroupedList>
          <GroupedFooter>{keyHint}</GroupedFooter>
        </>
      ) : null}

      {form.kind === "contact" ? (
        <>
          <GroupedList>
            {CONTACT_FIELDS.map((field) => (
              <InputField
                key={field}
                label={t(`mobile.vault.contact.${field}`)}
                value={form.contact[field] ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, contact: { ...f.contact, [field]: v } }))}
                maxLength={LIMITS.contact}
                {...contactKeyboard(field)}
              />
            ))}
          </GroupedList>
          <GroupedFooter>{t("mobile.vault.field.contactHelp")}</GroupedFooter>
        </>
      ) : null}

      <ScopeRows scope={scope} onChange={pickScope} canTeam={canTeam} />
      {scope === "team" ? <GroupedFooter>{t("mobile.vault.teamAudience")}</GroupedFooter> : null}
      <AgentRows scope={scope} access={access} onChange={setTouched} />
    </SettingsPage>
  );
}
