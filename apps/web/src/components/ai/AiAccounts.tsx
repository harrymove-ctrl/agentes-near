import type { AiAccounts as AiAccountsView } from "@agenteschat/client";
import { keys, useAiAccounts, useAiStatus, useApi, useMachines } from "@agenteschat/client";
import {
  agentsToGive,
  endsOnClaude,
  groupPlans,
  identityUnknown,
  offersSignInAgain,
  type PlanAccount,
  unusedCopies,
} from "@agenteschat/client/lib/ai-accounts";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentAi, aiStateOf } from "@agenteschat/client/lib/no-ai";
import { isPlanId, planOf, signInProviderOf } from "@agenteschat/client/lib/plans";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
  Menu,
  MenuItem,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { AddAccount } from "./AddAccountFlow";
import { PlanHold, usePlanHold } from "./ConnectAiSteps";

/*
 * What the owner of a plan account does with it (ADR 0059), where Configurações › IA e uso opens the account: what its
 * sign-in needs, then giving it to one more agent where it thinks for all of them (`shared`), renaming it, signing in
 * again (a new key for a coding plan, to every login) and disconnecting it. Its logins (one per agent) act as one.
 */

type Row = AiAccountsView["accounts"][number];
type Open = { type: "rename" | "again" | "remove"; account: PlanAccount<Row> };

/** The viewer's own account's notes and actions, by one of its logins; nothing for an account that isn't theirs. */
export function AccountActions({ machineId, accountId }: { machineId: string; accountId: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiAccounts(org.id);
  const machines = useMachines(org.id);
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const account = groupPlans(ai.data?.accounts ?? []).find((g) =>
    g.logins.some((l) => l.id === accountId && l.machineId === machineId),
  );
  const a = account?.logins.find((l) => l.shared === true) ?? account?.logins[0];
  if (!account || !a) return null;
  const { logins, signedOut, unknown } = account;
  const names = (list: string[]) => joinNames(list, t);
  const refetch = () => {
    for (const key of [keys.aiAccounts(org.id), keys.planUsage(org.id)]) void qc.invalidateQueries({ queryKey: key });
  };
  const machine = machines.data?.find((m) => m.id === a.machineId);
  const computer = computerNameOf(t, org.name, a.computer, isPersonal(org));

  // One more of the person's agents thinks with an account made for all of them there: no sign-in.
  const giveTo = async (agent: { id: string; name: string }) => {
    setBusy(true);
    try {
      await api.agents.setBrain(org.id, agent.id, { brain: a.kind, account: a.id });
      toast.show(t("aiAccounts.done.savedAgent", { agent: agent.name, label: a.label }));
      refetch();
      for (const key of [keys.agents(org.id), keys.aiStatus(org.id), keys.agentBrain(org.id, agent.id)])
        void qc.invalidateQueries({ queryKey: key });
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  const give = agentsToGive({
    account: a,
    agents: dir.agents,
    machine,
    viewerId: me.user.id,
    onKey: (id) => agentAi(dir.agentById.get(id), aiStateOf(status.data, id)) === "key",
  });

  // Every login of the account goes; `copies`: only those that think for no agent, each a sign-in made again.
  const remove = async (gone: Row[], done: string) => {
    setBusy(true);
    try {
      for (const l of gone) await api.machines.removeAccount(org.id, l.machineId, l.id);
      toast.show(done);
      setOpen(null);
      void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      refetch();
      setBusy(false);
    }
  };

  const copies = unusedCopies(account);
  const plan = planOf(a.provider);
  const allOut = signedOut.length === logins.length;
  // Of an account with a login per agent, the agents whose login is out.
  const outFor = allOut ? [] : signedOut.flatMap((l) => l.usedBy);
  // The email is the account's own line: here only what stands for it.
  const identity = a.email
    ? null
    : a.keyHint
      ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
      : identityUnknown(a, machine)
        ? t("aiAccounts.page.identityUnknown")
        : null;
  return (
    <div className="ai-accounts__own">
      {identity && <span className="small muted">{identity}</span>}
      {signedOut.length > 0 && (
        <SettingNote icon="alert">
          {outFor.length > 0
            ? t("aiAccounts.page.signedOutFor", { count: outFor.length, agents: names(outFor) })
            : plan
              ? t("aiAccounts.page.keyRefused")
              : t("aiAccounts.page.signedOut")}
        </SettingNote>
      )}
      {signedOut.length === 0 && unknown.length > 0 && (
        <SettingNote icon="info">{t("aiAccounts.page.statusUnknown")}</SettingNote>
      )}
      {copies.length > 0 && (
        <SettingNote icon="repeat">{t("aiAccounts.page.copies", { count: copies.length })}</SettingNote>
      )}
      <div className="ac-acts ai-accounts__acts">
        {give.length === 1 && give[0] ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => give[0] && void giveTo(give[0])}>
            {t("aiAccounts.page.useFor", agentGrammar(give[0].name))}
          </Button>
        ) : (
          give.length > 1 && (
            <Menu
              label={t("aiAccounts.page.useForMenu")}
              trigger={
                <Button variant="ghost" size="sm" disabled={busy}>
                  {t("aiAccounts.page.useForMenu")}
                </Button>
              }
            >
              {give.map((g) => (
                <MenuItem key={g.id} onSelect={() => void giveTo(g)}>
                  {g.name}
                </MenuItem>
              ))}
            </Menu>
          )
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen({ type: "rename", account })}>
          {t("aiAccounts.page.rename")}
        </Button>
        {(logins.some(offersSignInAgain) || plan) && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen({ type: "again", account })}>
            {plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain")}
          </Button>
        )}
        {copies.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void remove(copies, t("aiAccounts.page.copiesRemoved", { count: copies.length }))}
          >
            {t("aiAccounts.page.removeCopies")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ac-btn--danger"
          disabled={busy}
          onClick={() => setOpen({ type: "remove", account })}
        >
          {t("aiAccounts.page.disconnect")}
        </Button>
      </div>

      {open?.type === "rename" && open.account.logins[0] && (
        <RenameDialog
          account={open.account.logins[0]}
          onClose={() => setOpen(null)}
          onSaved={(label) => {
            toast.show(t("aiAccounts.page.renamed", { label }));
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open?.type === "again" && (
        <AgainDialog
          account={open.account}
          local={ai.data?.computers.find((c) => c.machineId === a.machineId)?.mine}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open?.type === "remove" && (
        <Dialog
          open
          onOpenChange={(o) => !o && !busy && setOpen(null)}
          title={t("aiAccounts.page.disconnectTitle", { label: a.label })}
          description={[
            account.usedBy.length > 0
              ? t("aiAccounts.page.disconnectAgents", {
                  count: account.usedBy.length,
                  agents: names(account.usedBy),
                  computer,
                })
              : t("aiAccounts.page.disconnectNone", { computer }),
            ...(logins.some((l) =>
              endsOnClaude(
                l,
                machines.data?.find((m) => m.id === l.machineId),
              ),
            )
              ? [t("aiAccounts.page.revokeOnClaude")]
              : []),
          ].join(" ")}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={() => void remove(logins, t("aiAccounts.page.disconnected", { label: a.label }))}
            >
              {t("aiAccounts.page.disconnect")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Signing in again: a coding plan's new key goes to every login of the account, a sign-in to its first login out
 * (else one unchecked, else its first). Closes once each login took it.
 */
function AgainDialog({
  account,
  local,
  onClose,
  onDone,
}: {
  account: PlanAccount<Row>;
  local: boolean | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const hold = usePlanHold();
  const added = useRef(new Set<string>());
  const a = account.signedOut[0] ?? account.unknown[0] ?? account.logins[0];
  if (!a) return null;
  const key = isPlanId(a.provider);
  const fanOut = key ? account.logins.map((l) => ({ id: l.id, again: l.id })) : undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={a.label} closeLabel={t("common.close")} width={520}>
      <DialogBody>
        {hold ? (
          <PlanHold hold={hold} />
        ) : (
          <AddAccount
            machineId={a.machineId}
            kind={a.kind}
            computer={a.computer}
            again={a.id}
            email={a.email}
            local={local}
            {...(signInProviderOf(a.provider) ? { provider: signInProviderOf(a.provider) } : {})}
            {...(fanOut ? { fanOut } : {})}
            onBack={onClose}
            onAdded={(_, login) => {
              added.current.add(login ?? a.id);
              if (added.current.size >= (fanOut?.length ?? 1)) onDone();
            }}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}

function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: Row;
  onClose: () => void;
  onSaved: (label: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const name = label.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("aiAccounts.page.renameTitle", { label: account.label })}
      closeLabel={t("common.close")}
      width={420}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name || busy) return;
          setBusy(true);
          api.machines.renameAccount(org.id, account.machineId, account.id, name).then(
            () => onSaved(name),
            () => {
              toast.show(t("agentPage.work.failed"), "error");
              setBusy(false);
            },
          );
        }}
      >
        <Locked when={busy}>
          <DialogBody>
            <Field
              label={t("aiAccounts.page.nameLabel")}
              id="ai-rename"
              hint={{
                name: t("common.about", { label: t("aiAccounts.page.nameLabel") }),
                text: t("aiAccounts.done.name"),
              }}
            >
              <Input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name || name === account.label}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
