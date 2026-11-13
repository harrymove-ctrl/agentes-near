import type { Agent, MailAccount, MailConnectError, MailPolicy, MailProviders } from "@agenteschat/client";
import {
  keys,
  useAgentMail,
  useAgents,
  useMailAction,
  useMailProviders,
  useMailSuggestedAddresses,
} from "@agenteschat/client";
import { LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText, knownErrorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  CUSTOM_PRESET,
  choiceOf,
  defaultPolicy,
  fromMailLevel,
  isAddress,
  MAIL_ACTIONS,
  MAIL_BRANDS,
  type MailChoice,
  mailAccessOf,
  mailActionsChanged,
  mailActionsFrom,
  mailErrorOf,
  mailReviewTools,
  normalizePolicy,
  notIcloudMail,
  setMailLevel,
  splitEmails,
} from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  AvatarStack,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
  Segmented,
  Select,
  useUnsavedInDialog,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AddressList } from "@/components/AddressList";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { FlowTitle } from "@/components/FlowTitle";
import { LoadingList, useStepText } from "@/components/Loading";
import { MailRulesPanel } from "@/components/MailRules";
import { useOrg } from "@/components/org-context";
import { reviewNote, ToolLevelsView, ToolReview, type ToolReviewState } from "@/components/ToolReview";
import { useDirectory } from "@/hooks/useDirectory";
import { useEdited } from "@/hooks/useEdited";
import { takesConnectorReturn } from "@/lib/desktop";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * People's mailboxes for agents (ADR 0038), in the connectors' own shapes:
 * catalog cards (Gmail, Outlook, iCloud, Outro email), the same
 * 3-step connect flow (conectar → o que faz → quem pode usar), a connected
 * row and "Reconectar". Gmail/Outlook sign in on the provider's page;
 * iCloud and the rest take an app password, then say which other
 * addresses the mailbox has (replies go out from the one the email arrived at).
 */

export const mailChoiceName = (t: TFunction, choice: MailChoice) => t(`mail.choice.${choice}.name`);

/** The catalog cards this server can connect (Gmail/Outlook need Composio; the rest IMAP). */
export function mailChoices(providers: MailProviders | undefined): MailChoice[] {
  if (!providers) return [];
  return [
    ...(providers.composio ? (["gmail", "outlook"] as const) : []),
    ...(providers.imap && providers.presets.some((p) => p.id === "icloud") ? (["icloud"] as const) : []),
    ...(providers.imap ? (["other"] as const) : []),
  ];
}

export function MailIcon({ choice, size = "md" }: { choice: MailChoice; size?: "md" | "lg" }) {
  const { t } = useTranslation();
  if (choice === "other") {
    return (
      <span
        className={`connector-icon${size === "lg" ? " connector-icon--lg" : ""} connector-icon--mono`}
        aria-hidden="true"
      >
        <Icon name="mail" />
      </span>
    );
  }
  return <ConnectorIcon def={MAIL_BRANDS[choice] ?? null} label={mailChoiceName(t, choice)} size={size} />;
}

/** How a mailbox connects, for the card's one tag. */
export const mailAuthKind = (choice: MailChoice) =>
  choice === "gmail" || choice === "outlook" ? "oneClick" : "appPassword";

export type MailFlowState =
  /** `connected`: the app password worked; now the mailbox's other addresses. */
  | { step: 0; choice: MailChoice; connected?: MailAccount }
  | { step: 1 | 2; account: MailAccount }
  | { step: 3; account: MailAccount; agentIds: string[] };

/** The connect flow for a mailbox: the same dialog, steps and footer as the other connectors. */
export function MailConnectFlow({
  flow,
  onChange,
  onClose,
}: {
  flow: MailFlowState | null;
  onChange: (flow: MailFlowState) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!flow) return null;
  const choice = flow.step === 0 ? flow.choice : choiceOf(flow.account);
  const name = flow.step === 0 ? mailChoiceName(t, choice) : flow.account.address;
  const title =
    flow.step === 0
      ? flow.connected
        ? t("mail.addresses.title", { address: flow.connected.address })
        : t("connectFlow.connectTitle", { name })
      : flow.step === 1
        ? t("connectFlow.toolsTitle", { name })
        : flow.step === 2
          ? t("connectFlow.whoTitle", { name })
          : t("mail.rulesTitle", { name });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={<FlowTitle tile={<MailIcon choice={choice} size="lg" />}>{title}</FlowTitle>}
      closeLabel={t("common.close")}
      width={620}
      className="cflow"
    >
      <ol className="cflow__steps" aria-label={t("connectFlow.steps")}>
        {([0, 1, 2, 3] as const).map((i) => (
          <li key={i} data-on={i <= flow.step || undefined} aria-current={i === flow.step ? "step" : undefined}>
            <span className="ac-visually-hidden">{i === 3 ? t("mail.rulesStep") : t(`connectFlow.step.${i}`)}</span>
          </li>
        ))}
      </ol>
      {flow.step === 0 &&
        (flow.connected ? (
          <AddressesStep
            account={flow.connected}
            onNext={(account) => onChange({ step: 1, account })}
            onClose={onClose}
          />
        ) : choice === "gmail" || choice === "outlook" ? (
          <OAuthStep provider={choice} onClose={onClose} />
        ) : (
          <ImapStep
            choice={choice}
            onConnected={(account) => onChange({ step: 0, choice, connected: account })}
            onClose={onClose}
          />
        ))}
      {flow.step === 1 && (
        <ActionsStep
          account={flow.account}
          onNext={() => onChange({ step: 2, account: flow.account })}
          onClose={onClose}
        />
      )}
      {flow.step === 2 && (
        <WhoStep
          key={flow.account.id}
          account={flow.account}
          onBack={() => onChange({ step: 1, account: flow.account })}
          onRules={(agentIds) => onChange({ step: 3, account: flow.account, agentIds })}
          onClose={onClose}
        />
      )}
      {flow.step === 3 && (
        <RulesStep
          account={flow.account}
          agentIds={flow.agentIds}
          onBack={() => onChange({ step: 2, account: flow.account })}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Step 1, Gmail/Outlook: one sentence and "Conectar com Google"; the provider sends the person back. */
function OAuthStep({ provider, onClose }: { provider: "gmail" | "outlook"; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { connectComposio } = useMailAction(org.id);
  const company = t(`mail.company.${provider}`);
  return (
    <>
      <DialogBody className="cflow__body">
        <p className="muted cflow__text">
          {t(`mail.choice.${provider}.text`)} {t("mail.oauthText", { company })}
        </p>
      </DialogBody>
      <DialogFooter bar note={t("connectFlow.nothingYet")}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={connectComposio.isPending}
          loading={connectComposio.isPending}
          onClick={() =>
            connectComposio.mutate(
              { provider, desktop: takesConnectorReturn() },
              { onSuccess: (started) => navigateAway(started.redirectUrl) },
            )
          }
        >
          {t("mail.continueWith", { company })}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "O que é uma senha de app?": what it is, three steps and the provider's page. */
export function AppPasswordHelp({ url, name }: { url: string | null; name: string }) {
  const { t } = useTranslation();
  return (
    <div className="mail-howto">
      <b>{t("mail.whatIs")}</b>
      <span className="small muted">{t("mail.whatIsText")}</span>
      <ol className="mail-howto__steps small">
        {(["1", "2", "3"] as const).map((n) => (
          <li key={n}>{t(`mail.step.${n}`)}</li>
        ))}
      </ol>
      {url && /^https:\/\//.test(url) && (
        <a className="ac-link small mail-howto__link" href={url} target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={14} />
          {t("mail.openPage", { name })}
        </a>
      )}
    </div>
  );
}

/**
 * Step 1, iCloud and "Outro email": the address and an app password (with
 * what that is and where to make one), then "Conectar" tests the login and
 * both servers. Hosts only under "Avançado" (and only for "Outro servidor").
 */
export function ImapStep({
  choice,
  onConnected,
  onClose,
}: {
  choice: "icloud" | "other";
  onConnected: (account: MailAccount) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const providers = useMailProviders(org.id);
  const { connectImap } = useMailAction(org.id);
  const presets = providers.data?.presets ?? [];
  const others = presets.filter((p) => p.id !== "icloud");
  const [picked, setPicked] = useState<string | null>(null);
  const preset = choice === "icloud" ? "icloud" : (picked ?? others[0]?.id ?? CUSTOM_PRESET);
  const current = presets.find((p) => p.id === preset) ?? null;
  const custom = preset === CUSTOM_PRESET;
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<MailConnectError | null>(null);
  useUnsavedInDialog(useEdited(true, [address, password, username, imapHost, imapPort, smtpHost, smtpPort]));
  const testing = useStepText(connectImap.isPending, [
    t("mail.testing.login"),
    t("mail.testing.send"),
    t("mail.testing.almost"),
  ]);
  const addressError = touched && !isAddress(address) ? t("mail.addressInvalid") : undefined;
  const webmail = choice === "icloud" ? notIcloudMail(address) : null;
  const passwordError = touched && !password.trim() ? t("mail.passwordInvalid") : undefined;
  const hostsMissing = custom && (!imapHost.trim() || !smtpHost.trim());
  const port = (v: string, fallback: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
  };

  const submit = () => {
    setTouched(true);
    setError(null);
    if (hostsMissing) setAdvanced(true);
    if (!isAddress(address) || !password.trim() || hostsMissing) return;
    connectImap.mutate(
      {
        preset,
        address: address.trim(),
        password: password.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(custom
          ? {
              imapHost: imapHost.trim(),
              imapPort: port(imapPort, 993),
              smtpHost: smtpHost.trim(),
              smtpPort: port(smtpPort, 587),
            }
          : {}),
      },
      {
        onSuccess: (account) => {
          toast.show(t("mail.connectedToast", { address: account.address }));
          onConnected(account);
        },
        onError: (e) => setError(mailErrorOf(e)),
      },
    );
  };

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Locked when={connectImap.isPending}>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t(`mail.imapText.${choice}`)}</p>
          {choice === "other" && (
            <Field label={t("mail.provider")} id="mail-preset">
              <Select
                value={preset}
                onValueChange={(v) => {
                  setPicked(v);
                  setError(null);
                }}
                options={[
                  ...others.map((p) => ({ value: p.id, label: p.label })),
                  { value: CUSTOM_PRESET, label: t("mail.providerCustom") },
                ]}
              />
            </Field>
          )}
          <Field
            label={t("mail.address")}
            id="mail-address"
            hint={
              webmail
                ? {
                    name: t("common.about", { label: t("mail.address") }),
                    text: t("mail.icloudHint", { name: webmail }),
                  }
                : undefined
            }
            error={addressError}
          >
            <Input
              type="email"
              autoComplete="email"
              inputMode="email"
              value={address}
              placeholder={t("mail.addressPlaceholder")}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <Field
            label={t("mail.password")}
            id="mail-password"
            hint={{ name: t("common.about", { label: t("mail.password") }), text: t("mail.passwordHelp") }}
            error={passwordError}
          >
            <Input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <AppPasswordHelp url={current?.appPasswordUrl ?? null} name={current?.label ?? mailChoiceName(t, choice)} />
          <p className="small muted mail-hint">
            <Icon name="info" size={14} />
            <span>{t("mail.dedicated")}</span>
          </p>
          {choice === "other" && (
            <details
              className="cflow__more"
              open={advanced || custom}
              onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>{t("mail.advanced")}</summary>
              <div className="cflow__key">
                <Field
                  label={t("mail.username")}
                  id="mail-username"
                  hint={{ name: t("common.about", { label: t("mail.username") }), text: t("mail.usernameHelp") }}
                >
                  <Input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
                </Field>
                {custom && (
                  <>
                    <div className="mail-host">
                      <Field label={t("mail.imapHost")} id="mail-imap-host">
                        <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
                      </Field>
                      <Field label={t("mail.port")} id="mail-imap-port">
                        <Input inputMode="numeric" value={imapPort} onChange={(e) => setImapPort(e.target.value)} />
                      </Field>
                    </div>
                    <div className="mail-host">
                      <Field label={t("mail.smtpHost")} id="mail-smtp-host">
                        <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                      </Field>
                      <Field label={t("mail.port")} id="mail-smtp-port">
                        <Input inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
                      </Field>
                    </div>
                    {touched && hostsMissing && <Alert>{t("mail.hostsRequired")}</Alert>}
                  </>
                )}
              </div>
            </details>
          )}
          {error && (
            <Alert>
              {t(error === "auth" && choice === "icloud" ? "mail.error.auth_icloud" : `mail.error.${error}`)}
            </Alert>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={testing ?? t("connectFlow.nothingYet")}>
        <Button type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={connectImap.isPending} loading={connectImap.isPending}>
          {t("mail.connect")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The mailbox's other addresses and the one new emails go out from, as a
 * draft: starts from what is saved plus the addresses its sent folder shows
 * (pre-filled until the person edits the list).
 */
function useAddressesDraft(account: MailAccount) {
  const { org } = useOrg();
  const suggested = useMailSuggestedAddresses(org.id, account.id);
  const [edited, setEdited] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const found = (suggested.data ?? []).filter((a) => a !== account.address && !account.aliases.includes(a));
  const aliases = edited ?? [...account.aliases, ...found];
  const addresses = [account.address, ...aliases];
  const chosen = picked ?? account.defaultFrom ?? account.address;
  const defaultFrom = addresses.includes(chosen) ? chosen : account.address;
  const savedFrom = account.defaultFrom ?? account.address;
  const same = aliases.length === account.aliases.length && aliases.every((a) => account.aliases.includes(a));
  return {
    searching: suggested.isLoading,
    found: edited === null && found.length > 0,
    aliases,
    addresses,
    defaultFrom,
    setAliases: (list: string[]) => setEdited(list.filter((a) => a !== account.address)),
    setDefaultFrom: setPicked,
    changed: !same || defaultFrom !== savedFrom,
    input: { aliases, defaultFrom: defaultFrom === account.address ? null : defaultFrom },
  };
}

/** "Outros endereços desta caixa" and "Emails novos saem de", for the step and the dialog. */
function AddressesFields({ account, draft }: { account: MailAccount; draft: ReturnType<typeof useAddressesDraft> }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="small muted">{t("mail.addresses.main", { address: account.address })}</p>
      <AddressList
        id={`mail-aliases-${account.id}`}
        label={t("mail.addresses.others")}
        example={
          draft.searching
            ? t("mail.addresses.searching")
            : draft.found
              ? t("mail.addresses.found")
              : t("mail.addresses.othersHelp")
        }
        values={draft.aliases}
        onChange={draft.setAliases}
        split={splitEmails}
        placeholder={t("mail.addresses.placeholder")}
        invalidText={t("mail.addresses.invalid")}
      />
      {draft.addresses.length > 1 && (
        <Field
          label={t("mail.addresses.newFrom")}
          id={`mail-new-from-${account.id}`}
          hint={{
            name: t("common.about", { label: t("mail.addresses.newFrom") }),
            text: t("mail.addresses.newFromHelp"),
          }}
        >
          <Select
            value={draft.defaultFrom}
            onValueChange={draft.setDefaultFrom}
            options={draft.addresses.map((a) => ({ value: a, label: a }))}
          />
        </Field>
      )}
    </>
  );
}

/** Step 1 (IMAP), after connecting: which other addresses the mailbox has. Nothing changed = straight on. */
function AddressesStep({
  account,
  onNext,
  onClose,
}: {
  account: MailAccount;
  onNext: (account: MailAccount) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { update } = useMailAction(org.id);
  const draft = useAddressesDraft(account);
  const next = () => {
    if (!draft.changed) return onNext(account);
    update.mutate({ accountId: account.id, ...draft.input }, { onSuccess: onNext });
  };
  return (
    <>
      <Locked when={update.isPending}>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("mail.addresses.lead")}</p>
          <AddressesFields account={account} draft={draft} />
          {update.isError && <Alert>{knownErrorText(t, update.error) ?? t("mail.actionsError")}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={t("mail.addresses.later")}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={update.isPending} loading={update.isPending} onClick={next}>
          {t("connectFlow.next")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "Endereços" on a connected mailbox: its other addresses and the one new emails go out from. */
export function MailAddressesDialog({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("mail.addresses.title", { address: account?.address ?? "" })}
      description={t("mail.addresses.lead")}
      closeLabel={t("common.close")}
      width={520}
    >
      {account && <AddressesDialogBody key={account.id} account={account} onClose={onClose} />}
    </Dialog>
  );
}

function AddressesDialogBody({ account, onClose }: { account: MailAccount; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { update } = useMailAction(org.id);
  const draft = useAddressesDraft(account);
  const save = () =>
    update.mutate(
      { accountId: account.id, ...draft.input },
      {
        onSuccess: () => {
          toast.show(t("mail.addresses.saved", { address: account.address }));
          onClose();
        },
      },
    );
  return (
    <>
      <Locked when={update.isPending}>
        <DialogBody className="cflow__body">
          <AddressesFields account={account} draft={draft} />
          {update.isError && <Alert>{knownErrorText(t, update.error) ?? t("mail.actionsError")}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!draft.changed || update.isPending}
          loading={update.isPending}
          onClick={save}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "Só Ana pode dar acesso…" for anyone but who connected the mailbox; nothing for them. */
function OwnerOnlyNote({ account }: { account: MailAccount }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  if (account.ownerUserId === me.user.id) return null;
  const owner = dir.memberById.get(account.ownerUserId ?? "")?.name;
  return (
    <p className="small muted cflow__text">
      {owner ? t("mail.agent.ownerOnly", { name: owner }) : t("mail.agent.ownerOnlyUnknown")}
    </p>
  );
}

/**
 * Step 2: what agents may do in this mailbox, in the standard tool review (Consulta · Muda · Aprovação · Desligada).
 * Only who connected it loosens these, so anyone else sees them read-only.
 */
function ActionsStep({ account, onNext, onClose }: { account: MailAccount; onNext: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const mine = account.ownerUserId === me.user.id;
  const toast = useToast();
  const { update } = useMailAction(org.id);
  const tools = mailReviewTools(t, account);
  const [state, setState] = useState<ToolReviewState>({ levels: {}, decided: new Set() });
  const next = () => {
    const chosen = mailActionsFrom(tools, state.levels);
    if (!mailActionsChanged(account, chosen)) return onNext();
    update.mutate({ accountId: account.id, ...chosen }, { onSuccess: onNext });
  };
  return (
    <>
      <Locked when={update.isPending}>
        <DialogBody className="cflow__body tr-body">
          <p className="muted cflow__text">{t("mail.toolsLead", { name: account.address })}</p>
          {mine ? (
            <ToolReview
              name={account.address}
              tools={tools}
              state={state}
              onChange={setState}
              onMoved={(m) => toast.show(m)}
            />
          ) : (
            <>
              <OwnerOnlyNote account={account} />
              <ToolLevelsView tools={tools} />
            </>
          )}
          {update.isError && <Alert>{knownErrorText(t, update.error) ?? t("mail.actionsError")}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={mine ? reviewNote(t, tools, state) : undefined}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={update.isPending} loading={update.isPending} onClick={mine ? next : onNext}>
          {t("connectFlow.next")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Step 3: one level per agent; each saves that agent's access to this mailbox (rules kept). Then the rules. Only who
 * connected the mailbox gives access (to agents that talk to them); anyone else here may only lower it.
 */
function WhoStep({
  account,
  onBack,
  onRules,
  onClose,
}: {
  account: MailAccount;
  onBack: () => void;
  /** Some agent has access: go on to its rules. */
  onRules: (agentIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const current = (agentId: string) => fromMailLevel(account.agents.find((a) => a.agentId === agentId)?.level);
  const levelsFor = (a: Agent): Level[] => {
    const may = mailAccessOf(account, {
      userId: me.user.id,
      talks: canTalk(a),
      managesAgent: can(org, "manage_agents") || a.ownerUserId === me.user.id,
    });
    if (may.gives) return LEVELS;
    return may.removes ? LEVELS.slice(0, LEVELS.indexOf(current(a.id)) + 1) : [current(a.id)];
  };
  const [who, setWho] = useState<Record<string, Level>>({});
  const levelOf = (agentId: string) => who[agentId] ?? current(agentId);
  const levelLabel = (l: Level) => t(`access.level.${l}`);
  const granted = list.filter((a) => levelOf(a.id) !== "none");

  const grant = useMutation({
    mutationFn: async () => {
      const changed = list.filter((a) => levelOf(a.id) !== current(a.id));
      for (const a of changed) await setMailLevel(api, org.id, a.id, account.id, levelOf(a.id));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.mail(org.id) });
      toast.show(t("connectFlow.saved", { count: granted.length, name: account.address }));
      // The rules are only for who connected the mailbox to set (anyone else's are ignored).
      if (granted.length > 0 && account.ownerUserId === me.user.id) onRules(granted.map((a) => a.id));
      else onClose();
    },
  });

  return (
    <>
      <Locked when={grant.isPending}>
        <DialogBody className="cflow__body">
          {agents.isLoading ? (
            <LoadingList count={3} />
          ) : list.length === 0 ? (
            <p className="muted">{t("connectFlow.noAgents")}</p>
          ) : (
            <>
              <div className="cflow__all">
                <span className="small muted">{t("connectFlow.all")}</span>
                {LEVELS.map((l) => (
                  <Button
                    key={l}
                    size="sm"
                    variant="ghost"
                    aria-label={t("connectFlow.allLevel", { level: levelLabel(l) })}
                    onClick={() =>
                      setWho(Object.fromEntries(list.filter((a) => levelsFor(a).includes(l)).map((a) => [a.id, l])))
                    }
                  >
                    {levelLabel(l)}
                  </Button>
                ))}
              </div>
              <ul className="cflow-agents">
                {list.map((a) => (
                  <li key={a.id} className="cflow-agent">
                    <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                    <span className="cflow-agent__name">
                      <span>{a.name}</span>
                      {a.role && <span className="small muted">{a.role}</span>}
                    </span>
                    <Segmented
                      size="sm"
                      label={t("connectFlow.levelOf", { name: a.name })}
                      value={levelOf(a.id)}
                      onValueChange={(l) => setWho((w) => ({ ...w, [a.id]: l }))}
                      options={levelsFor(a).map((l) => ({ value: l, label: levelLabel(l) }))}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="small muted cflow__asks">
            <Icon name="lock" />
            {t("connectFlow.asksCount", { count: MAIL_ACTIONS.approval.length })}
          </p>
          <p className="small muted cflow__text">{t("mail.whoLead")}</p>
          <OwnerOnlyNote account={account} />
          {grant.isError && <Alert>{errorText(t, grant.error)}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button disabled={grant.isPending} onClick={onBack}>
          {t("connectFlow.back")}
        </Button>
        <Button
          variant="primary"
          disabled={!agents.isSuccess || grant.isPending}
          loading={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {granted.length > 0 ? t("connectFlow.next") : t("connectFlow.grant")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Step 4: the rules of each agent with access (which folders it reads, from
 * whom, to whom it sends), one agent at a time. Optional: without rules an
 * agent sees every folder and every send asks.
 */
function RulesStep({
  account,
  agentIds,
  onBack,
  onClose,
}: {
  account: MailAccount;
  agentIds: string[];
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = (useAgents(org.id).data ?? []).filter((a) => agentIds.includes(a.id));
  const [agentId, setAgentId] = useState(agentIds[0] ?? "");
  const [edits, setEdits] = useState<Record<string, MailPolicy>>({});
  const save = useMutation({
    mutationFn: async () => {
      for (const [id, policy] of Object.entries(edits)) {
        const saved = (await api.mail.agent(org.id, id)).find((m) => m.accountId === account.id);
        if (!saved || saved.level === "none") continue;
        await api.mail.setAgent(org.id, id, account.id, {
          level: saved.level,
          canDelete: saved.canDelete,
          policy: normalizePolicy(policy),
        });
      }
    },
    onSuccess: () => {
      for (const id of Object.keys(edits)) void qc.invalidateQueries({ queryKey: keys.agentMail(org.id, id) });
      if (Object.keys(edits).length > 0) toast.show(t("mail.rulesSaved"));
      onClose();
    },
  });
  const agent = agents.find((a) => a.id === agentId);
  return (
    <>
      <Locked when={save.isPending}>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("mail.rulesLead", { name: account.address })}</p>
          {agents.length > 1 && (
            <Segmented
              size="sm"
              label={t("mail.rulesAgent")}
              value={agentId}
              onValueChange={setAgentId}
              options={agents.map((a) => ({ value: a.id, label: a.name }))}
            />
          )}
          {agent && (
            <AgentRules
              key={agent.id}
              agentId={agent.id}
              name={agent.name}
              account={account}
              policy={edits[agent.id]}
              onChange={(policy) => setEdits((e) => ({ ...e, [agent.id]: policy }))}
            />
          )}
          {save.isError && <Alert>{t("mail.agent.saveError.unknown")}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={t("mail.rulesLater")}>
        <Button disabled={save.isPending} onClick={onBack}>
          {t("connectFlow.back")}
        </Button>
        <Button variant="primary" disabled={save.isPending} loading={save.isPending} onClick={() => save.mutate()}>
          {Object.keys(edits).length > 0 ? t("mail.rulesSave") : t("mail.rulesSkip")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One agent's rules in step 4, starting from what it has. */
function AgentRules({
  agentId,
  name,
  account,
  policy,
  onChange,
}: {
  agentId: string;
  name: string;
  account: MailAccount;
  policy: MailPolicy | undefined;
  onChange: (policy: MailPolicy) => void;
}) {
  const { org } = useOrg();
  const saved = useAgentMail(org.id, agentId);
  if (saved.isLoading) return <LoadingList count={2} />;
  const mine = saved.data?.find((m) => m.accountId === account.id);
  const shown = policy ?? (mine ? { ...defaultPolicy(), ...mine.policy } : defaultPolicy());
  return (
    <div className="mail-rules-step">
      <span className="mail-rules-step__who">
        <AgentAvatar agentId={agentId} name={name} size="sm" />
        <b>{name}</b>
      </span>
      <MailRulesPanel account={account} policy={shown} onChange={onChange} />
    </div>
  );
}

/** One connected mailbox in "Conectados": the same row as the other connectors. */
export function MailRow({
  account,
  agents,
  admin,
  onTools,
  onWho,
  onAddresses,
  onReconnect,
  onDisconnect,
}: {
  account: MailAccount;
  agents: Agent[];
  admin: boolean;
  onTools: () => void;
  onWho: () => void;
  onAddresses: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const choice = choiceOf(account);
  const using = agents.filter((a) => account.agents.some((x) => x.agentId === a.id));
  const name = account.address;
  const meta = [
    t("connectors.connectedAs", { account: account.address }),
    relativeTime(t, i18n.language, account.createdAt),
  ];
  return (
    <div className="ac-list__row connected-row ac-mediarow">
      <span className="ac-mediarow__face">
        <MailIcon choice={choice} />
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span>{mailChoiceName(t, choice)}</span>
          {account.status === "needs_reconnect" ? (
            <Chip icon="alert" tone="waiting">
              {t("mail.status.needs_reconnect")}
            </Chip>
          ) : account.status === "pending" ? (
            <Chip icon="waiting" tone="waiting">
              {t("mail.status.pending")}
            </Chip>
          ) : (
            <Chip icon="check" tone="done">
              {t("mail.status.active")}
            </Chip>
          )}
        </span>
      </span>
      <div className="ac-mediarow__body">
        <span className="small muted">{meta.join(" · ")}</span>
        <span className="connected-row__who small muted">
          {using.length > 0 && (
            <AvatarStack>
              {using.slice(0, 5).map((a) => (
                <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
              ))}
            </AvatarStack>
          )}
          {using.length > 0
            ? t("connectors.usedBy", { count: using.length, total: agents.length })
            : t("connectors.usedByNone")}
        </span>
        {admin && (
          <div className="connected-row__actions">
            {account.status === "needs_reconnect" && (
              <Button size="sm" variant="primary" aria-label={t("mail.reconnectName", { name })} onClick={onReconnect}>
                {t("mail.reconnect")}
              </Button>
            )}
            <Button size="sm" aria-label={t("connectors.whoName", { name })} onClick={onWho}>
              {t("connectors.who")}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t("connectors.toolsName", { name })} onClick={onTools}>
              {t("connectors.tools")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("mail.addresses.buttonName", { name })}
              onClick={onAddresses}
            >
              {t("mail.addresses.button")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("connectors.disconnectName", { name })}
              onClick={onDisconnect}
            >
              {t("connectors.disconnect")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Reconectar" for an IMAP mailbox (a new app password). Gmail and Outlook sign in again instead.
 */
export function MailReconnectDialog({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const providers = useMailProviders(org.id, account !== null);
  const { update } = useMailAction(org.id);
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const preset = providers.data?.presets.find((p) => p.id === account?.preset) ?? null;
  const close = () => {
    setPassword("");
    setTouched(false);
    setError(null);
    onClose();
  };
  const submit = () => {
    setTouched(true);
    setError(null);
    if (!account || !password.trim()) return;
    update.mutate(
      { accountId: account.id, password: password.trim() },
      {
        onSuccess: (saved) => {
          toast.show(t("mail.reconnected", { address: saved.address }));
          close();
        },
        onError: setError,
      },
    );
  };
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(o) => !o && close()}
      title={t("mail.reconnectTitle", { address: account?.address ?? "" })}
      description={t("mail.reconnectText")}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={update.isPending}>
          <DialogBody className="cflow__body">
            <Field
              label={t("mail.password")}
              id="mail-reconnect-password"
              hint={{ name: t("common.about", { label: t("mail.password") }), text: t("mail.passwordHelp") }}
              error={touched && !password.trim() ? t("mail.passwordInvalid") : undefined}
            >
              <Input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <AppPasswordHelp
              url={preset?.appPasswordUrl ?? null}
              name={preset?.label ?? (account ? mailChoiceName(t, choiceOf(account)) : "")}
            />
            {error ? <Alert>{t(`mail.error.${mailErrorOf(error)}`)}</Alert> : null}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={update.isPending} loading={update.isPending}>
            {t("mail.reconnect")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Desconectar ana@empresa.com?": always confirmed. */
export function MailDisconnectDialog({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { disconnect } = useMailAction(org.id);
  const name = account?.address ?? "";
  const using = account?.agents.length ?? 0;
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.disconnectTitle", { name })}
      description={using > 0 ? t("connectors.disconnectText", { count: using }) : t("connectors.disconnectTextNone")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={disconnect.isPending}
          loading={disconnect.isPending}
          onClick={() =>
            account &&
            disconnect.mutate(account.id, {
              onSuccess: () => {
                toast.show(t("connectors.disconnected", { name }));
                onClose();
              },
            })
          }
        >
          {t("connectors.disconnect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
