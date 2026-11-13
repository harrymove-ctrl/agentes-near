import type {
  VaultConnection,
  VaultContactFields,
  VaultItem,
  VaultItemKind,
  VaultItemPatch,
  VaultMatch,
  VaultOverview,
  VaultScope,
  VaultUse,
} from "@agenteschat/client";
import { useVaultItem } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { MAX_SECRET_BYTES } from "@agenteschat/client/lib/secret-box";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Chip,
  DetailsDialog,
  DetailsSection,
  Dialog,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  Input,
  Locked,
  Segmented,
  SettingNote,
  Textarea,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useVaultItemActions } from "./data";
import { CONTACT_FIELDS, type ContactField, hostOf, KEY_NAME, KIND_ICON, LIMITS, vaultOrigin } from "./lib";
import { AccessBlock } from "./VaultAccess";
import "@/pages/issues.css";
import "./vault.css";

/*
 * A Vault item, opened (ADR 0144): its fields by kind, the value always behind its dots (Change, for who may), who
 * has access in the aside (people, agents, the sentence) and its recent uses. An item from a password manager keeps
 * that manager's fields read-only here: only its note, a key's variable name and its access change in the app.
 */

/** The kind's tile (or a connection's, by `icon`): the icon in a neutral square, the same in lists and dialogs. */
export function VaultTile({ kind, icon, size = "md" }: { kind?: VaultItemKind; icon?: IconName; size?: "md" | "lg" }) {
  return (
    <span className="vlt-tile" data-size={size} aria-hidden="true">
      <Icon name={icon ?? KIND_ICON[kind ?? "login"]} size={size === "lg" ? 20 : 18} />
    </span>
  );
}

/** Where it comes from (a password manager) and whether it's gone from there. */
export function ItemChips({ item }: { item: VaultItem }) {
  const { t } = useTranslation();
  return (
    <>
      {item.sourceName && <Chip icon="plug">{item.sourceName}</Chip>}
      {item.missing && (
        <Chip icon="alert" tone="waiting">
          {t("vault.item.missing")}
        </Chip>
      )}
    </>
  );
}

/** Personal or Team, with what it means, as a line: its icon in the access lines' column, so the words line up. */
export function ScopeLine({ scope }: { scope: VaultScope }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // Team reads Shared in a personal workspace (ADR 0159).
  const team = scope === "team";
  return (
    <span className="vlt-scope">
      <span className="vlt-access__lead" aria-hidden="true">
        <Icon name={team ? "members" : "person"} size={18} />
      </span>
      <span className="vlt-scope__text">
        <b>{team ? t(modeKey(org, "vault.scope.team")) : t("vault.scope.personal")}</b>
        <small>{team ? t(modeKey(org, "vault.scope.teamText")) : t("vault.scope.personalText")}</small>
      </span>
    </span>
  );
}

/** What a form edits. Strings throughout: an empty one is "none". */
export interface ItemDraft {
  title: string;
  description: string;
  website: string;
  match: VaultMatch;
  username: string;
  keyName: string;
  contact: VaultContactFields;
}

export const draftOf = (i: VaultItem): ItemDraft => ({
  title: i.title,
  description: i.description,
  website: i.website ?? "",
  match: i.match,
  username: i.username ?? "",
  keyName: i.keyName ?? "",
  contact: { ...(i.contact ?? {}) },
});

/** The contact's fields with a value, trimmed. */
export function cleanContact(c: VaultContactFields): VaultContactFields {
  const out: VaultContactFields = {};
  for (const f of CONTACT_FIELDS) {
    const v = c[f]?.trim();
    if (v) out[f] = v;
  }
  return out;
}

export type DraftErrors = Partial<Record<"title" | "website" | "keyName" | "secret" | "contact", string>>;

/**
 * What is wrong with a draft before the server says so, in the person's words. `secret`: the value typed (undefined
 * when the saved one stays).
 */
export function draftErrors(
  t: TFunction,
  kind: VaultItemKind,
  d: ItemDraft,
  secret: string | undefined,
  needsSecret: boolean,
): DraftErrors {
  const e: DraftErrors = {};
  // A login goes by its site's name and a key by its variable's when they have none: only a contact needs one.
  if (!d.title.trim() && kind === "contact") e.title = t("vault.error.title");
  if (kind === "login" && !vaultOrigin(d.website)) e.website = t("vault.error.website");
  if (kind === "key" && !KEY_NAME.test(d.keyName.trim())) e.keyName = t("vault.error.keyName");
  if (kind === "contact" && Object.keys(cleanContact(d.contact)).length === 0) e.contact = t("vault.error.contact");
  if (kind !== "contact") {
    if (secret !== undefined && new TextEncoder().encode(secret).byteLength > MAX_SECRET_BYTES)
      e.secret = t("secret.tooLarge");
    else if (needsSecret && !secret) e.secret = t(kind === "login" ? "vault.error.password" : "vault.error.value");
  }
  return e;
}

/**
 * The fields of an item by kind, in the order a person fills them. `secret` is the value's own block (a field in a
 * new item, Show / Copy / Change in a saved one); `locked` are the fields a password manager keeps.
 */
export function ItemFields({
  kind,
  draft,
  onDraft,
  readOnly,
  locked = false,
  errors,
  secret,
}: {
  kind: VaultItemKind;
  draft: ItemDraft;
  onDraft: (patch: Partial<ItemDraft>) => void;
  readOnly: boolean;
  locked?: boolean;
  errors: DraftErrors;
  secret: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const fixed = readOnly || locked;
  const origin = vaultOrigin(draft.website);
  const example =
    kind === "login" ? t(modeKey(org, "vault.field.loginPlaceholder")) : t(`vault.field.${kind}Placeholder`);
  // Read only, an empty field says nothing: only what has a value shows.
  const filled = (value: string | undefined, fixedHere = readOnly) => !fixedHere || Boolean(value?.trim());
  const title = (
    <Field label={t(kind === "contact" ? "vault.field.contactTitle" : "vault.field.title")} error={errors.title}>
      <Input
        value={draft.title}
        maxLength={LIMITS.title}
        readOnly={fixed}
        placeholder={fixed ? undefined : (kind === "login" && hostOf(origin)) || example}
        onChange={(e) => onDraft({ title: e.target.value })}
      />
    </Field>
  );
  const description = filled(draft.description) && (
    <Field
      label={t("vault.field.description")}
      hint={{
        name: t("common.about", { label: t("vault.field.description") }),
        text: readOnly ? undefined : t("vault.field.descriptionHelp"),
      }}
    >
      <Textarea
        rows={2}
        autoGrow
        value={draft.description}
        maxLength={LIMITS.description}
        readOnly={readOnly}
        placeholder={readOnly ? undefined : t(`vault.field.descriptionPlaceholder.${kind}`)}
        onChange={(e) => onDraft({ description: e.target.value })}
      />
    </Field>
  );
  if (kind === "login")
    return (
      <div className="vlt-fields">
        <Field label={t("vault.field.website")} error={errors.website}>
          <Input
            value={draft.website}
            maxLength={LIMITS.website}
            readOnly={fixed}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("vault.field.websitePlaceholder")}
            onChange={(e) => onDraft({ website: e.target.value })}
          />
        </Field>
        <div className="ac-field">
          <span className="ac-field__label">{t("vault.field.match")}</span>
          <Segmented<VaultMatch>
            label={t("vault.field.match")}
            value={draft.match}
            disabled={fixed}
            onValueChange={(match) => onDraft({ match })}
            options={[
              { value: "exact", label: t("vault.match.exact") },
              { value: "site", label: t("vault.match.site") },
            ]}
          />
          <span className="ac-field__example">
            {draft.match === "exact"
              ? origin
                ? t("vault.match.exactHelp", { origin })
                : t("vault.match.exactHelpNone")
              : t("vault.match.siteHelp")}
          </span>
        </div>
        {filled(draft.username, fixed) && (
          <Field label={t("vault.field.username")}>
            <Input
              value={draft.username}
              maxLength={LIMITS.username}
              readOnly={fixed}
              autoComplete="off"
              spellCheck={false}
              placeholder={fixed ? undefined : t("vault.field.usernamePlaceholder")}
              onChange={(e) => onDraft({ username: e.target.value })}
              data-1p-ignore
            />
          </Field>
        )}
        {secret}
        {title}
        {description}
      </div>
    );
  if (kind === "key")
    return (
      <div className="vlt-fields">
        <Field
          label={t("vault.field.keyName")}
          error={errors.keyName}
          hint={{
            name: t("common.about", { label: t("vault.field.keyName") }),
            text: errors.keyName || readOnly ? undefined : t("vault.field.keyNameHelp"),
          }}
        >
          <Input
            className="vlt-mono"
            value={draft.keyName}
            maxLength={64}
            readOnly={readOnly}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            placeholder={readOnly ? undefined : t("vault.field.keyNamePlaceholder")}
            onChange={(e) => onDraft({ keyName: e.target.value.toUpperCase().replace(/[\s-]+/g, "_") })}
          />
        </Field>
        {secret}
        {title}
        {description}
      </div>
    );
  return (
    <div className="vlt-fields">
      {title}
      <fieldset className="vlt-contact" aria-label={t("vault.contact.group")}>
        {CONTACT_FIELDS.filter((f: ContactField) => filled(draft.contact[f])).map((f: ContactField) => (
          <Field key={f} label={t(`vault.contact.${f}`)} className={f.startsWith("address") ? "vlt-wide" : undefined}>
            <Input
              value={draft.contact[f] ?? ""}
              maxLength={LIMITS.contact}
              readOnly={readOnly}
              type={f === "email" ? "email" : f === "phone" ? "tel" : "text"}
              autoComplete="off"
              onChange={(e) => onDraft({ contact: { ...draft.contact, [f]: e.target.value } })}
            />
          </Field>
        ))}
      </fieldset>
      {errors.contact && <span className="ac-field__error">{errors.contact}</span>}
      {description}
    </div>
  );
}

/**
 * A saved value, always behind its dots: once saved it never comes back to a screen (ADR 0144 §2). Whoever manages it
 * types a new one in its place (Change); `value` non-null is that new value being typed.
 */
function SecretValue({
  item,
  canChange,
  value,
  onValue,
  error,
}: {
  item: VaultItem;
  canChange: boolean;
  value: string | null;
  onValue: (value: string | null) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const label = t(item.kind === "login" ? "vault.field.password" : "vault.field.value");
  if (value !== null)
    return (
      <Field
        label={label}
        error={error}
        hint={{ name: t("common.about", { label: label }), text: error ? undefined : t("vault.item.newValueHelp") }}
      >
        <span className="vlt-secret__change">
          <Input
            type="password"
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={t(item.kind === "login" ? "vault.item.newPassword" : "vault.item.newValue")}
            onChange={(e) => onValue(e.target.value)}
            data-1p-ignore
          />
          <Button variant="ghost" onClick={() => onValue(null)}>
            {t("vault.item.keepValue")}
          </Button>
        </span>
      </Field>
    );
  return (
    <div className="ac-field">
      <span className="ac-field__label">{label}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: the value and what acts on it, named as one */}
      <div className="vlt-secret" role="group" aria-label={label}>
        {item.hasSecret ? (
          <span className="vlt-secret__value">
            <span className="vlt-secret__dots" aria-hidden="true">
              ••••••••••
            </span>
            <span className="ac-visually-hidden">{t("vault.item.hidden")}</span>
            {item.keyHint && <span className="vlt-secret__hint">{t("vault.item.endsIn", { hint: item.keyHint })}</span>}
          </span>
        ) : (
          <span className="vlt-secret__value vlt-secret__value--none">{t("vault.item.noValue")}</span>
        )}
        <span className="vlt-secret__acts">
          {canChange && (
            <Button size="sm" variant="ghost" icon="edit" onClick={() => onValue("")}>
              {item.hasSecret ? t("vault.item.change") : t("vault.item.add")}
            </Button>
          )}
        </span>
      </div>
      {error ? (
        <span className="ac-field__error">{error}</span>
      ) : (
        canChange && item.hasSecret && <span className="ac-field__example">{t("vault.item.sealedHelp")}</span>
      )}
    </div>
  );
}

/** One use: who, where, for whom and when. */
function UseRow({ use }: { use: VaultUse }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = use.agentId ? (dir.anyAgent(use.agentId)?.name ?? t("channel.unknownAgent")) : null;
  const person = use.userId ? (dir.memberById.get(use.userId)?.name ?? t("channel.unknownPerson")) : null;
  const who = agent ?? person ?? t("channel.unknownPerson");
  const host = hostOf(use.origin);
  const line =
    use.action === "fill"
      ? host
        ? t("vault.use.fill", { agent: who, host })
        : t("vault.use.fillSomewhere", { agent: who })
      : use.action === "key"
        ? t("vault.use.key", { agent: who })
        : t(`vault.use.${use.action}`, { who });
  const behalf = use.onBehalfOfUserId ? dir.memberById.get(use.onBehalfOfUserId)?.name : undefined;
  const whom = behalf
    ? t("vault.use.for", { name: behalf })
    : use.routineName
      ? t("vault.use.routine", { name: use.routineName })
      : null;
  const meta = [whom, relativeTime(t, i18n.language, use.at)].filter(Boolean);
  return (
    <li className="vlt-use">
      <ActorAvatar
        actor={use.agentId ? { type: "agent", id: use.agentId } : { type: "person", id: use.userId ?? "" }}
        name={who}
        size="sm"
      />
      <span className="vlt-use__text">
        <b>{line}</b>
        <small>{meta.join(" · ")}</small>
      </span>
    </li>
  );
}

/**
 * Opens an item from the list: its details as the server has them now, the list's copy while they load. A contact's
 * fields come only with its details (the list has none, ADR 0144 §7): its form waits for them, and starts from them.
 */
export function VaultItemDialog({
  itemId,
  overview,
  onClose,
}: {
  itemId: string;
  overview: VaultOverview;
  onClose: () => void;
}) {
  const { org } = useOrg();
  const detail = useVaultItem(org.id, itemId);
  const item = detail.data ?? overview.items.find((i) => i.id === itemId);
  if (!item) return null;
  const connection = item.connectionId ? overview.connections.find((c) => c.id === item.connectionId) : undefined;
  const fieldsPending = item.kind === "contact" && !detail.data;
  return (
    <ItemDialog
      // A contact's form starts again from its details once they arrive.
      key={fieldsPending ? "listed" : "detail"}
      item={item}
      uses={detail.data?.uses}
      usesLoading={detail.isPending}
      usesFailed={detail.isError}
      fieldsPending={fieldsPending}
      unreadable={detail.data?.unreadable === true}
      connection={connection}
      onClose={onClose}
    />
  );
}

function ItemDialog({
  item,
  uses,
  usesLoading,
  usesFailed,
  fieldsPending,
  unreadable,
  connection,
  onClose,
}: {
  item: VaultItem;
  uses: VaultUse[] | undefined;
  usesLoading: boolean;
  /** The item's details didn't load: its uses are unknown, not none. */
  usesFailed: boolean;
  /** A contact whose fields haven't come yet (or didn't load): no form until they do. */
  fieldsPending: boolean;
  /** A contact whose saved fields can't be read on the server: who manages it types them again. */
  unreadable: boolean;
  connection: VaultConnection | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useVaultItemActions(org.id);
  const external = item.connectionId !== null;
  const editable = item.can.edit;
  const [draft, setDraft] = useState<ItemDraft>(() => draftOf(item));
  const [secret, setSecret] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const patch = patchOf(item, draft, secret, external);
  const dirty = Object.keys(patch).length > 0;
  const errors = tried ? draftErrors(t, item.kind, draft, secret ?? undefined, secret !== null) : {};
  const source = item.sourceName ?? connection?.name ?? "";

  const save = async () => {
    setTried(true);
    if (Object.keys(draftErrors(t, item.kind, draft, secret ?? undefined, secret !== null)).length > 0) return;
    const saved = await actions.update(item.id, patch);
    if (!saved) return;
    toast.show(t("vault.item.saved"));
    onClose();
  };
  const setAccess = async (next: VaultItem["access"]) => {
    const saved = await actions.update(item.id, { access: next });
    if (saved) toast.show(t("vault.access.saved"));
    return saved !== null;
  };
  const follow = async (on: boolean) => {
    const saved = await actions.update(item.id, on ? { accessFromConnection: true } : { access: item.access });
    if (saved) toast.show(t("vault.access.saved"));
  };
  const remove = async () => {
    if (!(await actions.remove(item.id))) return;
    setDeleting(false);
    toast.show(t("vault.item.deleted", { title: item.title }));
    onClose();
  };

  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("common.close")}
      unsaved={dirty}
      className="vlt-details"
      size="lg"
      title={item.title}
      icon={<VaultTile kind={item.kind} size="lg" />}
      subtitle={
        <span className="vlt-details__sub">
          <span>{t(`vault.kind.${item.kind}`)}</span>
          <span aria-hidden="true">·</span>
          <span>{item.scope === "team" ? t(modeKey(org, "vault.scope.team")) : t("vault.scope.personal")}</span>
          <ItemChips item={item} />
        </span>
      }
      footer={
        editable ? (
          <>
            {item.can.delete && (
              <Button
                variant="ghost"
                icon="trash"
                className="ac-btn--danger vlt-foot__start"
                onClick={() => setDeleting(true)}
              >
                {t("vault.item.delete")}
              </Button>
            )}
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!dirty || actions.updating || fieldsPending}
              loading={actions.updating}
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t("common.close")}</Button>
        )
      }
    >
      <div className="vlt-layout">
        <Locked when={actions.updating}>
          <div className="vlt-details__main">
            {external && editable && <SettingNote icon="plug">{t("vault.item.editIn", { source })}</SettingNote>}
            {item.missing && <SettingNote icon="alert">{t("vault.item.missingText", { source })}</SettingNote>}
            {unreadable && <SettingNote icon="alert">{t("vault.item.unreadable")}</SettingNote>}
            {fieldsPending ? (
              usesFailed ? (
                <p className="vlt-uses__none">{t("common.loadFailed")}</p>
              ) : (
                <LoadingList count={3} />
              )
            ) : (
              <ItemFields
                kind={item.kind}
                draft={draft}
                onDraft={(p) => setDraft((d) => ({ ...d, ...p }))}
                readOnly={!editable}
                locked={external}
                errors={errors}
                secret={
                  item.kind === "contact" ? null : (
                    <SecretValue
                      item={item}
                      canChange={editable && !external}
                      value={secret}
                      onValue={setSecret}
                      error={errors.secret}
                    />
                  )
                }
              />
            )}
          </div>
          {/* The fields on the left; who has access and its recent uses beside them (ADR 0144 §7). */}
          <aside className="vlt-aside">
            <DetailsSection title={t("vault.access.title")}>
              <ScopeLine scope={item.scope} />
              <AccessBlock
                scope={item.scope}
                access={item.access}
                editable={editable && !item.accessFromConnection}
                saving={actions.updating}
                onChange={setAccess}
              >
                {external && editable && (
                  <div className="vlt-access__follow">
                    <span className="small muted">
                      {item.accessFromConnection
                        ? t("vault.access.follows", { source })
                        : t("vault.access.own", { source })}
                    </span>
                    <Button
                      size="sm"
                      disabled={actions.updating}
                      onClick={() => void follow(!item.accessFromConnection)}
                    >
                      {item.accessFromConnection ? t("vault.access.changeHere") : t("vault.access.useConnection")}
                    </Button>
                  </div>
                )}
              </AccessBlock>
            </DetailsSection>
            <DetailsSection title={t("vault.use.title")} count={uses?.length || undefined}>
              {usesLoading && !uses ? (
                <LoadingList count={2} />
              ) : usesFailed && !uses ? (
                <p className="vlt-uses__none">{t("common.loadFailed")}</p>
              ) : uses && uses.length > 0 ? (
                <ul className="vlt-uses">
                  {uses.map((u) => (
                    <UseRow key={u.id} use={u} />
                  ))}
                </ul>
              ) : (
                <p className="vlt-uses__none">{t("vault.use.none")}</p>
              )}
            </DetailsSection>
          </aside>
        </Locked>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("vault.item.deleteTitle", { title: item.title })}
        description={t("vault.item.deleteText")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={actions.removing} disabled={actions.removing} onClick={() => void remove()}>
            {t("vault.item.delete")}
          </Button>
        </DialogFooter>
      </Dialog>
    </DetailsDialog>
  );
}

/** What changed, as the server takes it: only the fields that differ (a password manager's own ones never). */
function patchOf(item: VaultItem, d: ItemDraft, secret: string | null, external: boolean): VaultItemPatch {
  const p: VaultItemPatch = {};
  if (d.description.trim() !== item.description) p.description = d.description.trim();
  if (item.kind === "key" && d.keyName.trim() !== (item.keyName ?? "")) p.keyName = d.keyName.trim();
  if (external) return p;
  // A login with no name goes by its site's, a key by its variable's.
  const title =
    d.title.trim() ||
    (item.kind === "login" ? (hostOf(vaultOrigin(d.website)) ?? "") : item.kind === "key" ? d.keyName.trim() : "");
  if (title !== item.title) p.title = title;
  if (item.kind === "login") {
    if (d.website.trim() !== (item.website ?? "")) p.website = d.website.trim();
    if (d.match !== item.match) p.match = d.match;
    if (d.username.trim() !== (item.username ?? "")) p.username = d.username.trim();
  }
  if (item.kind === "contact") {
    const next = cleanContact(d.contact);
    const before = cleanContact(item.contact ?? {});
    if (CONTACT_FIELDS.some((f) => next[f] !== before[f])) p.contact = next;
  }
  if (secret) p.secret = secret;
  return p;
}
