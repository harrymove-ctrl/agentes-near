import type { VaultAccess, VaultItem, VaultItemKind, VaultScope } from "@agenteschat/client";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  DetailsDialog,
  DetailsSection,
  Field,
  Icon,
  Input,
  Locked,
  Segmented,
  Select,
  SettingNote,
} from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useVaultItemActions } from "./data";
import { DEFAULT_MATCH, defaultAccess, hostOf, KIND_ICON, vaultOrigin } from "./lib";
import { AccessBlock } from "./VaultAccess";
import { cleanContact, draftErrors, type ItemDraft, ItemFields, VaultTile } from "./VaultItemDialog";
import "@/pages/issues.css";
import "./vault.css";

/*
 * "New item" (ADR 0144): an item's own page, empty. What to save (a login, a key, contact details) and its fields on
 * the left; who may use it beside them, where an item's page shows who has access. A personal item starts usable by
 * any of its owner's agents when the owner asks; a team one starts seen by everyone and used by no agent until someone
 * picks them.
 */

const EMPTY: ItemDraft = {
  title: "",
  description: "",
  website: "",
  match: DEFAULT_MATCH,
  username: "",
  keyName: "",
  contact: {},
};

export function VaultNewDialog({
  canManageTeam,
  scope: startScope,
  onClose,
  onCreated,
}: {
  canManageTeam: boolean;
  /** The tab it was opened from. */
  scope: VaultScope;
  onClose: () => void;
  onCreated: (item: VaultItem) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useVaultItemActions(org.id);
  const [kind, setKind] = useState<VaultItemKind>("login");
  const [draft, setDraft] = useState<ItemDraft>(EMPTY);
  const [secret, setSecret] = useState("");
  const [scope, setScope] = useState<VaultScope>(canManageTeam ? startScope : "personal");
  const [access, setAccess] = useState<VaultAccess>(() => defaultAccess(canManageTeam ? startScope : "personal"));
  const [tried, setTried] = useState(false);
  const formId = useId();
  const check = () => draftErrors(t, kind, draft, secret, kind !== "contact");
  const errors = tried ? check() : {};

  const pickScope = (next: VaultScope) => {
    setScope(next);
    // Each scope's own starting access: what a team item means differs from a personal one.
    setAccess(defaultAccess(next));
  };
  const save = async () => {
    setTried(true);
    if (Object.keys(check()).length > 0) return;
    const title =
      draft.title.trim() ||
      (kind === "login" ? (hostOf(vaultOrigin(draft.website)) ?? "") : kind === "key" ? draft.keyName.trim() : "");
    const item = await actions.create({
      kind,
      scope,
      title,
      description: draft.description.trim() || undefined,
      ...(kind === "login"
        ? {
            website: vaultOrigin(draft.website) ?? draft.website.trim(),
            match: draft.match,
            username: draft.username.trim() || undefined,
            secret,
          }
        : kind === "key"
          ? { keyName: draft.keyName.trim(), secret }
          : { contact: cleanContact(draft.contact) }),
      access,
    });
    if (!item) return;
    toast.show(t("vault.new.saved"));
    onCreated(item);
  };

  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("common.close")}
      className="vlt-details"
      size="lg"
      title={t("vault.new.title")}
      icon={<VaultTile kind={kind} size="lg" />}
      subtitle={t("vault.new.text")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {/* The form's own button, from the footer: Enter in a field saves too. */}
          <Button type="submit" form={formId} variant="primary" loading={actions.creating} disabled={actions.creating}>
            {t("vault.new.save")}
          </Button>
        </>
      }
    >
      <div className="vlt-layout">
        <Locked when={actions.creating}>
          <form
            id={formId}
            className="vlt-details__main"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {/* One line to choose what to save: the list says what each kind is (ADR 0144). */}
            <Field label={t("vault.new.what")}>
              <Select<VaultItemKind>
                value={kind}
                onValueChange={(k) => {
                  setKind(k);
                  setTried(false);
                }}
                options={(["login", "key", "contact"] as const).map((k) => ({
                  value: k,
                  label: t(`vault.kind.${k}`),
                  description: t(`vault.kind.${k}Text`),
                  leading: <Icon name={KIND_ICON[k]} size={16} />,
                }))}
                renderValue={(o) => (
                  <span className="ac-iconline">
                    <Icon name={KIND_ICON[o.value]} size={16} />
                    <span>{o.label}</span>
                  </span>
                )}
              />
            </Field>
            <ItemFields
              kind={kind}
              draft={draft}
              onDraft={(p) => setDraft((d) => ({ ...d, ...p }))}
              readOnly={false}
              errors={errors}
              secret={
                kind === "contact" ? null : (
                  <Field
                    label={t(kind === "login" ? "vault.field.password" : "vault.field.value")}
                    error={errors.secret}
                  >
                    <Input
                      type="password"
                      value={secret}
                      autoComplete="new-password"
                      spellCheck={false}
                      onChange={(e) => setSecret(e.target.value)}
                      data-1p-ignore
                    />
                  </Field>
                )
              }
            />
          </form>
          {/* Who may use it, where an item's page shows who has access (ADR 0144 §7): Personal or Team first. */}
          <aside className="vlt-aside">
            <DetailsSection title={t("vault.access.title")}>
              <Segmented<VaultScope>
                block
                label={t("vault.new.who")}
                value={scope}
                disabled={!canManageTeam}
                onValueChange={pickScope}
                options={[
                  { value: "personal", label: t("vault.scope.personal") },
                  { value: "team", label: t(modeKey(org, "vault.scope.team")) },
                ]}
              />
              {!canManageTeam && <SettingNote icon="lock">{t(modeKey(org, "vault.new.teamLocked"))}</SettingNote>}
              <AccessBlock
                scope={scope}
                access={access}
                editable
                onChange={(next) => {
                  setAccess(next);
                  return true;
                }}
              />
            </DetailsSection>
          </aside>
        </Locked>
      </div>
    </DetailsDialog>
  );
}
