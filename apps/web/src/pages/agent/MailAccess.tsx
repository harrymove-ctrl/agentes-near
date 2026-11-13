import type { AgentMailbox, MailAccount, MailPolicy } from "@agenteschat/client";
import { ApiError, useAgentMail, useMailAccounts, useSetAgentMail } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import { canTalk } from "@agenteschat/client/lib/audience";
import { forbiddenText, knownErrorText } from "@agenteschat/client/lib/errors";
import {
  choiceOf,
  defaultPolicy,
  fromMailLevel,
  MAIL_ACTIONS,
  mailAccessOf,
  normalizePolicy,
  toMailLevel,
} from "@agenteschat/client/lib/mail";
import { Alert, Button, Card, Chip, CountChip, Icon, Switch } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LevelRow } from "@/components/AccessLevels";
import { MailIcon, mailChoiceName } from "@/components/MailConnect";
import { MailRulesPanel, rulesCount } from "@/components/MailRules";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Email (ADR 0038): one row per mailbox of the
 * organization, the same level as the other connectors (Sem acesso · Ler ·
 * Ler e escrever), "Pode apagar emails" and the rules. Each mailbox saves on
 * its own ("Salvar"), outside the page's save bar. A mailbox still connecting
 * has no address and takes no access yet: its row says so and where to see it.
 * Only who connected a mailbox gives access to it; on anyone else's the row is
 * read-only, says who gives it, and admins and the agent's owner can remove it.
 */
export function MailAccessCard() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, can } = useAgentEdit();
  const accounts = useMailAccounts(org.id);
  const mail = useAgentMail(org.id, agent.id, (accounts.data?.length ?? 0) > 0);
  const list = accounts.data ?? [];
  // A server without email, or none connected: nothing to show here.
  if (list.length === 0) return null;
  return (
    <Card as="section" className="agp-card" aria-labelledby="ac-mail">
      <CardHead
        id="ac-mail"
        icon="mail"
        title={t("mail.agent.title")}
        action={<span className="small muted">{t("mail.agent.help", { org: org.name })}</span>}
      />
      <ul className="level-list" aria-label={t("mail.agent.title")}>
        {list.map((account) => {
          const name = account.address || mailChoiceName(t, choiceOf(account));
          const may = mailAccessOf(account, { userId: me.user.id, talks: canTalk(agent), managesAgent: can("levels") });
          return account.status === "pending" ? (
            <LevelRow
              key={account.id}
              icon={<MailIcon choice={choiceOf(account)} />}
              name={name}
              tag={
                <Chip icon="waiting" tone="waiting">
                  {t("mail.status.pending")}
                </Chip>
              }
              extra={<SeeInConnectors text={t("mail.agent.pending")} />}
              levels={["none"]}
              value="none"
            />
          ) : (
            <MailboxRow
              key={account.id}
              account={account}
              name={name}
              saved={mail.data?.find((m) => m.accountId === account.id) ?? null}
              loading={mail.isLoading}
              owner={
                account.ownerUserId === me.user.id ? null : (dir.memberById.get(account.ownerUserId ?? "")?.name ?? "")
              }
              editable={may.gives}
              removable={may.removes}
            />
          );
        })}
      </ul>
    </Card>
  );
}

/** What a mailbox's state means for the agent, and the way to Conectores, where it is fixed. */
function SeeInConnectors({ text }: { text: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <span className="small muted">
      {text}{" "}
      <Link className="ac-link" to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "connectors" }}>
        {t("mail.routine.openConnectors")}
      </Link>
    </span>
  );
}

interface Draft {
  level: Level;
  canDelete: boolean;
  policy: MailPolicy;
}

const draftOf = (saved: AgentMailbox | null): Draft => ({
  level: fromMailLevel(saved?.level),
  canDelete: saved?.canDelete ?? false,
  policy: saved ? { ...defaultPolicy(), ...saved.policy } : defaultPolicy(),
});

function MailboxRow({
  account,
  name,
  saved,
  loading,
  owner,
  editable,
  removable,
}: {
  account: MailAccount;
  name: string;
  saved: AgentMailbox | null;
  loading: boolean;
  /** Who connected it, when it isn't the viewer ("" = a name we don't know); null = the viewer's own. */
  owner: string | null;
  editable: boolean;
  removable: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const set = useSetAgentMail(org.id);
  const base = JSON.stringify(draftOf(saved));
  const [edit, setEdit] = useState<{ from: string; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Remounts the rules (their typed-but-invalid text) after "Cancelar" or a save.
  const [round, setRound] = useState(0);
  const reset = () => {
    setEdit(null);
    setError(null);
    setRound((n) => n + 1);
  };
  // Edits stay until saved; a new server answer resets them.
  const draft = edit && edit.from === base ? edit.draft : draftOf(saved);
  const change = (next: Partial<Draft>) => {
    setError(null);
    setEdit({ from: base, draft: { ...draft, ...next } });
  };
  const dirty = JSON.stringify(draft) !== base;
  const asks =
    draft.level === "write" && !draft.policy.sendWithoutAsking
      ? MAIL_ACTIONS.approval.map((a) => t(`mail.action.${a}.name`))
      : [];
  const reconnect = account.status === "needs_reconnect";
  const save = (next: Draft = draft) =>
    set.mutate(
      {
        agentId: agent.id,
        accountId: account.id,
        input: { level: toMailLevel(next.level), canDelete: next.canDelete, policy: normalizePolicy(next.policy) },
      },
      {
        onSuccess: () => {
          reset();
          toast.show(
            next.level === "none" && !editable
              ? t("mail.agent.removed", { name: agent.name, address: name })
              : t("mail.agent.saved", { name: agent.name }),
          );
        },
        onError: (e) =>
          setError(
            e instanceof ApiError && e.status === 403
              ? forbiddenText(t, e)
              : (knownErrorText(t, e) ?? t("mail.agent.saveError.unknown")),
          ),
      },
    );
  const count = rulesCount(draft.policy);
  const ownerNote =
    owner === null ? null : (
      <span className="small muted">
        {owner ? t("mail.agent.ownerOnly", { name: owner }) : t("mail.agent.ownerOnlyUnknown")}
      </span>
    );
  return (
    <LevelRow
      icon={<MailIcon choice={choiceOf(account)} />}
      name={name}
      tag={
        reconnect ? (
          <Chip icon="alert" tone="waiting">
            {t("mail.status.needs_reconnect")}
          </Chip>
        ) : undefined
      }
      description={draft.level === "none" ? t("access.noneText") : t(`mail.agent.levelText.${draft.level}`)}
      extra={reconnect ? <SeeInConnectors text={t("mail.agent.needsReconnect")} /> : (ownerNote ?? undefined)}
      asks={asks}
      levels={["none", "read", "write"]}
      value={draft.level}
      onChange={editable && !loading ? (level) => change({ level }) : undefined}
      changed={dirty}
      below={
        draft.level !== "none" || dirty ? (
          <div className="mail-agent">
            {draft.level !== "none" && (
              <>
                <label className="routine-active" htmlFor={`mail-del-${account.id}`}>
                  <Switch
                    id={`mail-del-${account.id}`}
                    checked={draft.canDelete}
                    disabled={!editable}
                    onCheckedChange={(canDelete) => change({ canDelete })}
                    aria-describedby={`mail-del-${account.id}-help`}
                  />
                  <span>
                    {t("mail.agent.canDelete")}
                    <span id={`mail-del-${account.id}-help`} className="small muted mail-agent__help">
                      {t("mail.agent.canDeleteHelp")}
                    </span>
                  </span>
                </label>
                <details className="mail-rules">
                  <summary aria-label={t("mail.agent.rulesOf", { address: name })}>
                    <Icon name="filter" size={14} />
                    <span>{t("mail.agent.rules")}</span>
                    {count > 0 ? (
                      <CountChip size="sm">{count}</CountChip>
                    ) : (
                      <span className="small muted">{t("mail.agent.noRules")}</span>
                    )}
                  </summary>
                  <MailRulesPanel
                    key={round}
                    account={account}
                    policy={draft.policy}
                    onChange={(policy) => change({ policy })}
                    disabled={!editable}
                  />
                </details>
              </>
            )}
            {!editable && removable && saved && saved.level !== "none" && (
              <div className="mail-agent__save">
                <Button
                  size="sm"
                  disabled={set.isPending}
                  loading={set.isPending}
                  onClick={() => save({ ...draftOf(saved), level: "none", canDelete: false })}
                >
                  {t("mail.agent.remove")}
                </Button>
              </div>
            )}
            {error && <Alert>{error}</Alert>}
            {dirty && editable && (
              <div className="mail-agent__save">
                <span className="small muted">{t("mail.agent.unsaved")}</span>
                <Button size="sm" onClick={reset}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={set.isPending}
                  loading={set.isPending}
                  onClick={() => save()}
                >
                  {t("mail.agent.save")}
                </Button>
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
