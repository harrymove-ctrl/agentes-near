import type { ComputerBrain, MachineOutage, MachineOutages, OutageTarget } from "@agenteschat/client";
import { useMachineOutages, useMachines, useMoveAgents } from "@agenteschat/client";
import { awayText } from "@agenteschat/client/lib/computer-queue";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, timeAgo } from "@agenteschat/client/lib/format";
import { computerKind } from "@agenteschat/client/lib/machines";
import {
  type BrainUnavailable,
  brainName,
  brainsOf,
  outageKey,
  outageOf,
  targetBlock,
  targetsFor,
  waitingText,
} from "@agenteschat/client/lib/outages";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Checkbox,
  Chip,
  ComputerIcon,
  Dialog,
  DialogBody,
  DialogFooter,
  EventPillAction,
  Icon,
  Locked,
  OptionList,
  type OptionListItem,
  ProviderLogo,
  useNow,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { ReconnectThisMacButton, useIsThisMac } from "@/components/ThisMac";
import { useComputerEdition } from "@/components/WorkspaceComputer";
import { STORAGE_KEYS, storage, storedStrings } from "@/lib/storage";
import { useToast } from "@/lib/toast";

/**
 * "Computador desconectado": the notice at the top of the work area,
 * the "Trocar o computador" dialog, and the agent's one waiting card in the chat.
 */

/** Notices for everyone who can manage agents, one per offline computer, stacked. */
export function OutageNotices() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const manage = can(org, "manage_agents");
  const outages = useMachineOutages(org.id);
  const list = outages.data?.outages ?? [];
  // Outages whose notice the person closed (until that computer comes back: a new outage shows again).
  const [dismissed, setDismissed] = useState(() => storedStrings(STORAGE_KEYS.outagesDismissed));
  // Forget the closed ones whose computer came back (or whose agents moved away).
  const liveKeys = list.map(outageKey).join(",");
  useEffect(() => {
    if (!outages.data) return;
    const live = new Set(liveKeys ? liveKeys.split(",") : []);
    setDismissed((d) => {
      const kept = d.filter((k) => live.has(k));
      if (kept.length === d.length) return d;
      storage.set(STORAGE_KEYS.outagesDismissed, JSON.stringify(kept));
      return kept;
    });
  }, [outages.data, liveKeys]);
  const shown = list.filter((o) => o.agents.length > 0 && !dismissed.includes(outageKey(o)));
  if (!manage || shown.length === 0 || !outages.data) return null;
  const dismiss = (o: MachineOutage) => {
    const next = [...dismissed, outageKey(o)];
    storage.set(STORAGE_KEYS.outagesDismissed, JSON.stringify(next));
    setDismissed(next);
  };
  return (
    <section className="outages" aria-label={t("outage.region")} data-count={shown.length}>
      {shown.map((o) => (
        <OutageNotice key={outageKey(o)} outage={o} data={outages.data} onDismiss={() => dismiss(o)} />
      ))}
    </section>
  );
}

function OutageNotice({
  outage: o,
  data,
  onDismiss,
}: {
  outage: MachineOutage;
  data: MachineOutages;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  // In agentes for Mac, when it's this very Mac: say so, and reconnect from here (ADR 0036).
  const here = useIsThisMac(org.id, o.machineId);
  // The Cloud's one computer: its people are told it is being looked after, with no other computer to go to.
  const edition = useComputerEdition(org.id);
  const cloud = edition === "cloud";
  // "há 12 min" moves on by itself.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const names = joinNames(
    o.agents.map((a) => a.name),
    t,
  );
  const sub = [
    cloud ? t("outage.cloudSub") : null,
    t("outage.waitFor", { count: o.agents.length, names }),
    o.waitingRuns > 0 ? t("outage.stopped", { count: o.waitingRuns }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="outage" role="status">
      <ComputerIcon kind={computerKind(o.platform)} size={20} className="outage__icon" />
      <span className="outage__text">
        <b>
          {here
            ? t("machines.thisMac.outageTitle", { ago: timeAgo(t, o.offlineSince, now) })
            : cloud
              ? t("outage.titleCloud", { name: o.name, ago: timeAgo(t, o.offlineSince, now) })
              : t("outage.title", { name: o.name, ago: timeAgo(t, o.offlineSince, now) })}
        </b>
        <span>{sub}</span>
      </span>
      <span className="outage__crew">
        {o.agents.map((a) => (
          <AgentAvatar
            key={a.agentId}
            agentId={a.agentId}
            name={t("outage.asleep", { name: a.name })}
            size="sm"
            state="idle"
            expression="closed"
            labelled
          />
        ))}
      </span>
      <span className="outage__acts">
        <Button asChild variant="ghost" size="sm">
          <Link to="/org/$orgId/settings/devices/$deviceId" params={{ orgId: org.id, deviceId: o.machineId }}>
            {t("outage.view")}
          </Link>
        </Button>
        {here && <ReconnectThisMacButton orgId={org.id} primary />}
        {edition === "selfhost" && (
          <Button variant={here ? "ghost" : "primary"} size="sm" onClick={() => setOpen(true)}>
            {t("outage.switch")}
          </Button>
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="close"
        className="outage__close"
        aria-label={t("outage.dismiss")}
        onClick={onDismiss}
      />
      {open && <SwitchComputerDialog open={open} onOpenChange={setOpen} outage={o} data={data} />}
    </div>
  );
}

const brainList = (t: TFunction, brains: string[]) => joinNames(brains.map(brainName), t);

/** A target's row: its computer, whether it can take these agents, and why not in plain words. */
function targetOption(t: TFunction, target: OutageTarget, brains: ComputerBrain[]) {
  const needed = brainList(t, brains);
  const block = targetBlock(target, brains);
  const description =
    block === null
      ? t("outage.dialog.has", { brains: brainList(t, target.brains) })
      : block === "reason" && target.reasonOff
        ? t(`outage.dialog.reason.${target.reasonOff}`, {
            brains: needed,
            defaultValue: t("outage.dialog.block.reason"),
          })
        : t(`outage.dialog.block.${block}`, { brains: needed });
  return {
    value: target.machineId,
    title: target.name,
    tag: block ? undefined : t("outage.dialog.on"),
    description,
    leading: <ComputerIcon kind={computerKind(target.platform)} size={20} />,
    disabled: block !== null,
  } satisfies OptionListItem<string>;
}

/** "Trocar o computador": where the waiting agents go, and which of them. */
export function SwitchComputerDialog({
  open,
  onOpenChange,
  outage: o,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outage: MachineOutage;
  data: MachineOutages;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const move = useMoveAgents(org.id);
  const id = useId();
  const [picked, setPicked] = useState<string[]>(() => o.agents.map((a) => a.agentId));
  const chosenAgents = o.agents.filter((a) => picked.includes(a.agentId));
  // A target must run every brain of the agents chosen (all of them while none is chosen).
  const brains = brainsOf(chosenAgents.length > 0 ? chosenAgents : o.agents);
  // Which rows show doesn't change with the checks: only whether each can take who is checked.
  const targets = targetsFor(data, o.machineId);
  const options = targets.map((x) => targetOption(t, x, brains));
  const firstOpen = options.find((x) => !x.disabled)?.value ?? "";
  const [target, setTarget] = useState(firstOpen);
  // The chosen one can't take the agents anymore (a computer went off, other brains): the first that can.
  const valid = options.some((x) => x.value === target && !x.disabled);
  const value = valid ? target : firstOpen;
  const names = joinNames(
    o.agents.map((a) => a.name),
    t,
  );
  const nameOf = (agentId: string) => o.agents.find((a) => a.agentId === agentId)?.name ?? agentId;
  const submit = () => {
    const chosen = targets.find((x) => x.machineId === value);
    if (!chosen || picked.length === 0) return;
    const targetName = chosen.name;
    move.mutate(
      {
        machineId: o.machineId,
        agentIds: picked,
        target: { kind: "machine", machineId: chosen.machineId },
      },
      {
        onSuccess: (r) => {
          const text =
            r.moved.length > 0
              ? t("outage.done.moved", {
                  count: r.moved.length,
                  names: joinNames(r.moved.map(nameOf), t),
                  target: targetName,
                })
              : t("outage.done.none");
          const detail = [
            r.resumed > 0 ? t("outage.done.resumed", { count: r.resumed }) : null,
            r.stillWaiting > 0 ? t("outage.done.stillWaiting", { count: r.stillWaiting, name: o.name }) : null,
            ...r.skipped.map((s) =>
              t("outage.done.skipped", {
                name: nameOf(s.agentId),
                reason: t(`outage.done.skip.${s.reason}`, { defaultValue: t("outage.done.skip.other") }),
              }),
            ),
          ]
            .filter(Boolean)
            .join(" · ");
          toast.show(text, r.moved.length > 0 ? "info" : "error", undefined, detail || undefined);
          onOpenChange(false);
        },
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("outage.dialog.title")}
      description={t("outage.dialog.text", { count: o.agents.length, name: o.name, names })}
      closeLabel={t("outage.dialog.close")}
      width={520}
      className="outage-dialog"
    >
      <Locked when={move.isPending}>
        <DialogBody>
          <p className="outage-dialog__h">{t("outage.dialog.where")}</p>
          {options.length > 0 && (
            <OptionList
              aria-label={t("outage.dialog.whereLabel")}
              value={value}
              onValueChange={setTarget}
              options={options}
            />
          )}
          {!firstOpen && <p className="small muted outage-dialog__none">{t("outage.dialog.none")}</p>}
          <p className="outage-dialog__h outage-dialog__h--gap">{t("outage.dialog.who")}</p>
          <div className="outage-dialog__who">
            {o.agents.map((a) => {
              const check = `${id}-${a.agentId}`;
              const waiting = waitingText(t, a.waiting);
              return (
                <label key={a.agentId} htmlFor={check} className="outage-dialog__agent">
                  <Checkbox
                    id={check}
                    aria-label={a.name}
                    checked={picked.includes(a.agentId)}
                    onCheckedChange={(on) =>
                      setPicked((p) => (on ? [...p, a.agentId] : p.filter((x) => x !== a.agentId)))
                    }
                  />
                  <AgentAvatar agentId={a.agentId} name={a.name} size="sm" state="idle" expression="closed" />
                  <span className="outage-dialog__name">{a.name}</span>
                  {waiting && <small>{waiting}</small>}
                </label>
              );
            })}
          </div>
          <p className="outage-dialog__hint ac-iconline">
            <Icon name="info" size={16} />
            <span>{t("outage.dialog.hint", { name: o.name })}</span>
          </p>
        </DialogBody>
      </Locked>
      <DialogFooter bar note={t("outage.dialog.note", { name: o.name })}>
        <Button onClick={() => onOpenChange(false)}>{t("outage.dialog.cancel")}</Button>
        <Button variant="primary" disabled={picked.length === 0 || !value} loading={move.isPending} onClick={submit}>
          {t("outage.dialog.submit", { count: picked.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The agent's note "the computer brain can't answer" as one waiting pill: it waits for the computer, not for the
 * viewer (a quiet clock, what waits under it and, on a self-host, "Switch computer"), then a decided pill saying it is
 * back, or that the agent moved.
 */
export function WaitingCard({ notice, agentId }: { notice: BrainUnavailable; agentId: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // Only where people connect their own computers: a Cloud workspace has one, and nothing while that isn't known.
  const selfHost = useComputerEdition(org.id) === "selfhost";
  const switches = selfHost && can(org, "manage_agents");
  const [open, setOpen] = useState(false);
  const { outages, outage, mine, state, name } = useWaitState(notice, agentId);
  const waiting = mine ? waitingText(t, mine.waiting) : null;
  if (state !== "waiting") {
    const text = state === "back" ? t("outage.card.back", { name }) : t("outage.card.moved");
    return (
      <RequestDone done label={text}>
        {text}
      </RequestDone>
    );
  }
  const title = t("outage.card.waiting", { name });
  return (
    <>
      <RequestOpen
        mine={false}
        icon="waiting"
        label={title}
        action={
          switches && outage && outages.data ? (
            <EventPillAction onClick={() => setOpen(true)}>{t("outage.switch")}</EventPillAction>
          ) : undefined
        }
        below={
          <p className="ac-iconline">
            <ProviderLogo id={notice.brain} size="xs" />
            {[t("outage.card.text", { brain: brainName(notice.brain) }), waiting].filter(Boolean).join(" · ")}
          </p>
        }
      >
        {title}
      </RequestOpen>
      {open && outage && outages.data && (
        <SwitchComputerDialog open={open} onOpenChange={setOpen} outage={outage} data={outages.data} />
      )}
    </>
  );
}

/** Where the agent's offline note stands: still waiting for its computer, back, or moved to another one. */
function useWaitState(notice: BrainUnavailable, agentId: string | null) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const outages = useMachineOutages(org.id);
  const machines = useMachines(org.id);
  const who = notice.agentId ?? agentId;
  const outage = outageOf(outages.data, who, notice.machineId);
  const machine = useMemo(
    () =>
      (machines.data ?? []).find((m) =>
        notice.machineId ? m.id === notice.machineId : who ? m.agents.some((a) => a.id === who) : false,
      ),
    [machines.data, notice.machineId, who],
  );
  const mine = outage?.agents.find((a) => a.agentId === who);
  const state: "waiting" | "back" | "moved" = outages.data
    ? mine
      ? "waiting"
      : outage
        ? "moved"
        : "back"
    : machine?.online
      ? "back"
      : "waiting";
  // The name it had while offline stays once it is back (the computers list may not have it).
  const seen = useRef<string | null>(null);
  if (outage) seen.current = outage.name;
  const name = outage?.name ?? machine?.name ?? seen.current ?? t("outage.someComputer");
  return { outages, outage, mine, state, name };
}

/** "Away 3 min" on the waiting note's author line, beside its time, while its computer is still gone. */
export function AwayPill({ notice, agentId }: { notice: BrainUnavailable; agentId: string | null }) {
  const { t } = useTranslation();
  const { outage, state } = useWaitState(notice, agentId);
  const now = useNow(30_000);
  if (state !== "waiting" || !outage) return null;
  return (
    <Chip tone="waiting" className="cq-away">
      {awayText(t, outage.offlineSince, now)}
    </Chip>
  );
}
