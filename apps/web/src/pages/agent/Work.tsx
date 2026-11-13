import type { BrainKind, Machine } from "@agenteschat/client";
import {
  DESKTOP_TOOL_SCOPE,
  profilesApply,
  profilesOfAgent,
  useAiStatus,
  useApi,
  useBrowserProfileMutations,
  useBrowserProfiles,
  useMachines,
  useModels,
  useSetComputerTarget,
  useUpdateAgentBrowserSettings,
} from "@agenteschat/client";
import { saveLevels } from "@agenteschat/client/lib/access-levels";
import type { BrainScreen } from "@agenteschat/client/lib/agent-edit";
import { ownSignInName } from "@agenteschat/client/lib/ai-accounts";
import { effortLevel } from "@agenteschat/client/lib/brain-advanced";
import { computerNameOf, setupPortrait, WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import {
  allowsInApp,
  commandInReason,
  computerKind,
  computerState,
  machineReasonText,
  toolOnCommand,
} from "@agenteschat/client/lib/machines";
import {
  type AiChoice,
  aiChoiceOf,
  aiStateOf,
  planLabel,
  planMark,
  planOfAccount,
} from "@agenteschat/client/lib/no-ai";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import { brainModelChoice, brainModelChoices, isPlanId, planOf } from "@agenteschat/client/lib/plans";
import { apiProviderOf, isAuto } from "@agenteschat/client/lib/providers";
import { cleanSite, SITE } from "@agenteschat/client/lib/sites";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  GroupHeading,
  Icon,
  type IconName,
  Input,
  Locked,
  LogoMark,
  OptionList,
  ProviderLogo,
  SettingNote,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { NO_COMPUTER, useNoComputer } from "@/components/AgentComputer";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import {
  OpenPrefsButton,
  ReconnectThisMacButton,
  ThisMacButton,
  useAgentsHere,
  useIsThisMac,
  useThisMac,
} from "@/components/ThisMac";
import { useComputerEdition } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { inDesktopApp } from "@/lib/desktop";
import { planWord } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { BrainDialog } from "./brain/BrainDialog";
import { useRefresh, useWork } from "./brain/work";
import { useAgentEdit } from "./context";
import "@/components/browser/browser.css";

/*
 * What the agent works with, under its name: where it works, who thinks and the browser, each opening its dialog. A
 * choice brings what it depends on along and says so before; "Usar" saves at once. Who thinks has a dialog of its own
 * (`brain/`), each of its screens saving its own change.
 */

export type WorkDialog = "brain" | "computer" | "browser";

/**
 * A cell of the memory's counts, or (`row`) a row of the overview's fact sheet (Ficha.tsx): its icon, what it is, the value; a button
 * for who may change it, which opens its dialog (`open`: that dialog is open now).
 */
export function Cell({
  icon,
  label,
  value,
  more,
  sub,
  muted,
  openLabel,
  onOpen,
  row,
  open,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  more?: string | null;
  sub?: string | null;
  muted?: boolean;
  openLabel?: string;
  onOpen?: () => void;
  row?: boolean;
  open?: boolean;
}) {
  const body = (
    <>
      <span className="agp-cell__key">{icon}</span>
      <span className="agp-cell__text">
        <small>{label}</small>
        <span
          className="agp-cell__value"
          data-muted={muted || undefined}
          data-name={(typeof value === "string" && /^[#@]/.test(value)) || undefined}
        >
          {value}
          {more && <span className="agp-cell__more"> · {more}</span>}
          {/* A row of the fact sheet says its note on the value's line. */}
          {row && sub && <span className="agp-cell__sub">{sub}</span>}
        </span>
        {!row && sub && <span className="agp-cell__sub">{sub}</span>}
      </span>
    </>
  );
  if (!onOpen) return <div className={row ? "agp-cell agp-cell--ro agp-frow" : "agp-cell agp-cell--ro"}>{body}</div>;
  return (
    <button
      type="button"
      className={row ? "agp-cell agp-frow" : "agp-cell"}
      data-open={open || undefined}
      aria-haspopup="dialog"
      aria-label={openLabel}
      onClick={onOpen}
    >
      {body}
      <Icon name={row ? "chevronRight" : "chevronDown"} size={14} className="agp-cell__chev" />
    </button>
  );
}

/**
 * How it works, the first group of the overview's fact sheet (Ficha.tsx): the computer's entry (`before`), where it works, who thinks
 * (with the effort) and the browser, one row each opening its dialog, then what it may use and its usage (`after`).
 * Where comes first: who thinks depends on it. `open`: the row whose dialog is open.
 */
export function WorkCard({
  onOpen,
  open,
  before,
  after,
}: {
  onOpen: (dialog: WorkDialog) => void;
  open?: string | null;
  before?: ReactNode;
  after?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, viewer, saved, can, g } = useAgentEdit();
  const noComputer = useNoComputer();
  const edition = useComputerEdition(org.id);
  const models = useModels();
  const work = useWork();
  const connect = useConnectAi();
  const aiStatus = useAiStatus(org.id);
  // With no AI it thinks with nothing, whatever it is set to: the cell says so, as the badge by its name does.
  const noAi = aiStateOf(aiStatus.data, agent.id) === "no_ai";
  const held = usePlanHold() !== null;
  const view = work.brain.data;
  const kind: BrainKind = view?.brain ?? agent.brain?.kind ?? "model";
  // What pays: the API key, or the plan of the account it thinks with (the agent list's until its view loads).
  const ai: AiChoice = view
    ? aiChoiceOf(view)
    : kind === "model"
      ? "key"
      : planOfAccount({ kind, provider: agent.brain?.provider ?? null });
  // The model's maker; on Automático, the maker the server says its models come from.
  const keyProvider = apiProviderOf(saved.model, models.data?.models ?? []) ?? agent.brain?.maker;
  const orgModel = isAuto(saved.model)
    ? t("brain.auto.label")
    : (models.data?.models.find((m) => m.id === saved.model)?.label ?? saved.model);
  const shownPlanModel = view ? view.effectiveModel : (agent.brain?.model ?? null);
  const plan = isPlanId(ai) ? planOf(ai) : undefined;
  const effectiveChoice = view?.effectiveModel ? brainModelChoice(kind, plan, view.effectiveModel) : null;
  const planModel = isAuto(shownPlanModel)
    ? t("brain.auto.label")
    : view
      ? (brainModelChoices(
          plan,
          view.options.find((o) => o.kind === kind)?.models ?? [],
          view.accounts.find((a) => a.id === view.account)?.provider,
        ).find((c) => c.value === effectiveChoice)?.label ?? view.effectiveModel)
      : shownPlanModel;
  // The account by its name only where its plan has more than one there (Claude's and ChatGPT's count the computer's
  // own sign-in), else the plan's name.
  const planAccounts = view?.accountsSupported ? view.accounts.filter((a) => planOfAccount(a) === ai) : [];
  const accountWord =
    ai === "key" || planAccounts.length + (isPlanId(ai) ? 0 : 1) < 2
      ? null
      : view?.account
        ? (planAccounts.find((a) => a.id === view.account)?.label ?? null)
        : ownSignInName(
            t,
            view?.ownSignIn === true && view.canUsePlans,
            computerNameOf(t, org.name, view?.computer?.name ?? "", isPersonal(org)),
            kind === "model" ? undefined : kind,
          );
  // Near or at its plan's limit: said where the account is.
  const usage =
    !view || kind === "model"
      ? null
      : view.account
        ? view.accounts.find((a) => a.id === view.account)?.usage
        : view.ownUsage[kind];
  // On a plan the label names it ("Pensa com Claude"), so the line under it is the account and its usage alone.
  const sub =
    ai === "key"
      ? t("brain.foot.api")
      : [accountWord, planWord(t, i18n.language, usage)].filter(Boolean).join(" · ") || null;
  // Automático picks the effort with the model: only a fixed model says its effort.
  const effort =
    kind !== "model" && view && !isAuto(shownPlanModel)
      ? t("agentPage.work.cell.effort", {
          level: t(`agentPage.work.brain.effortsLower.${effortLevel(view.effort)}`),
        })
      : null;
  const speed = agent.brain?.speed ? t("agentPage.work.brain.speeds.fast") : null;
  const target = work.target;
  const machine = target?.kind === "machine" ? target : null;
  // Read once the server says where it works: "no computer" never shows while that loads.
  const choice = target && !machine ? noComputer.choice(true) : null;
  // No computer yet where the workspace's own is on its way: it works there once it's ready.
  const waiting = choice === "workspace" ? noComputer.setup : null;
  const member = viewer === "member";
  const reason = work.browser.data?.reason;
  const machineRow = machine ? work.machines.data?.find((m) => m.id === machine.machineId) : undefined;
  // Only a switch that is off has a step there: `not_reported` and `not_installed` are on, `outdated` has none.
  const steps = !member && work.browserWord === "waiting" && machine && reason === "switched_off";
  const desktopGranted = (work.scopes.data ?? []).some(
    (s) => s.connectionId === null && s.scope === DESKTOP_TOOL_SCOPE,
  );
  return (
    <div className="agp-work">
      <GroupHeading id="agp-ficha-work" title={t("agentPage.work.cell.label", g)} />
      <section className="agp-workcard agp-ficha__card" aria-labelledby="agp-ficha-work">
        {before}
        {/* The Cloud's agents all work on the workspace's own computer, whose state the page's computer entry says:
              nothing to pick, so no cell. */}
        {!member && edition === "selfhost" && (
          <Cell
            row
            icon={<Icon name={choice === "none" ? "dash" : "computer"} size={16} />}
            label={choice === "none" ? t("computer.target.label") : t("agentPage.work.cell.computer")}
            value={machine ? machine.name : choice ? noComputer.label(choice) : null}
            sub={waiting ? t(waiting.chipKey) : choice === "none" ? t("computer.target.noneText") : null}
            open={open === "computer"}
            openLabel={t("agentPage.work.open.computer", g)}
            onOpen={can("machine") ? () => onOpen("computer") : undefined}
          />
        )}
        {/* On a billing hold an AI comes after the plan: no "Sem IA" or Connect here, as on its chip. */}
        {noAi && held ? null : noAi ? (
          <Cell
            row
            icon={<Icon name="plug" size={16} />}
            label={t("agentPage.work.cell.brain")}
            value={t("noAi.chip")}
            sub={t("connectAi.title.any")}
            muted
            openLabel={t("connectAi.title.any")}
            onOpen={connect ? () => connect.open({ agentId: agent.id }) : undefined}
          />
        ) : (
          <Cell
            row
            icon={
              ai !== "key" ? (
                <ProviderLogo id={planMark(ai)} size="sm" />
              ) : keyProvider ? (
                <ProviderLogo id={keyProvider} size="sm" />
              ) : (
                <Icon name="brainAgent" size={16} />
              )
            }
            label={
              ai === "key"
                ? t("agentPage.work.cell.brain")
                : t("agentPage.work.cell.brainWith", { plan: planLabel(t, ai) })
            }
            value={ai === "key" ? orgModel : planModel}
            more={ai === "key" ? null : [effort, speed].filter(Boolean).join(" · ")}
            sub={sub}
            open={open === "brain"}
            openLabel={t("agentPage.work.open.brain")}
            onOpen={can("brain") || can("model") ? () => onOpen("brain") : undefined}
          />
        )}
        {!member && (
          <Cell
            row
            icon={<Icon name={work.browserWord === "off" ? "block" : "globe"} size={16} />}
            label={t("agentPage.work.cell.browser")}
            value={t(`agentPage.work.browser.${work.browserWord}`)}
            muted={work.browserWord === "off"}
            open={open === "browser"}
            openLabel={t("agentPage.work.open.browser")}
            onOpen={() => onOpen("browser")}
          />
        )}
        {after}
      </section>
      {machine && !machine.online && kind !== "model" && (
        <SettingNote icon="pause">
          {edition === "cloud"
            ? t("agentPage.work.offlineCloud", {
                ...g,
                computer: computerNameOf(t, org.name, machine.name, isPersonal(org)),
              })
            : t("agentPage.work.offline", {
                ...g,
                computer: computerNameOf(t, org.name, machine.name, isPersonal(org)),
              })}
          <ThisMacReconnect machineId={machine.machineId} />
        </SettingNote>
      )}
      {steps && <BrowserSteps computer={machine.name} machineId={machine.machineId} />}
      {!member && desktopGranted && machineRow && <DesktopUseNote machine={machineRow} />}
    </div>
  );
}

/**
 * The agent may use apps on its desktop, and its Linux computer says what that still lacks there (ADR 0062):
 * the computer's own words, with the command in them to copy. Mac and Windows computers never have it, which
 * their own page says.
 */
function DesktopUseNote({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { g } = useAgentEdit();
  const use = m.desktopUse;
  if (m.os !== "linux" || !use || use.available || !use.reason) return null;
  const command = commandInReason(use.reason);
  return (
    <div className="brw-note ac-iconline">
      <Icon name="computer" size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block" }}>
          {t("desktop.use.agent", { ...g, computer: computerNameOf(t, org.name, m.name, isPersonal(org)) })}
        </span>
        <span className="small muted">{machineReasonText(t, use, "desktop_use_install")}</span>
        {command && <CommandBlock command={command} />}
      </div>
    </div>
  );
}

/** In agentes for Mac, when the offline computer is this very Mac: "Reconectar" right there (ADR 0036). */
function ThisMacReconnect({ machineId }: { machineId: string }) {
  const { org } = useOrg();
  const here = useIsThisMac(org.id, machineId);
  return here ? (
    <span style={{ display: "block", marginTop: 8 }}>
      <ReconnectThisMacButton orgId={org.id} />
    </span>
  ) : null;
}

/**
 * The steps card's head: the computer on the title's first line, then Esperando with its loader, under the title from
 * its words' edge when the row has no room for both.
 */
function StepsHead({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="brw-steps__head ac-iconline">
      <Icon name="computer" size={16} />
      <span className="brw-steps__headline">
        <b>{title}</b>
        <span className="brw-steps__wait" role="status">
          <Icon name="spinner" size={14} />
          {t("agentPage.work.steps.waiting")}
        </span>
      </span>
    </div>
  );
}

/**
 * What turns the computer's browser on, there; the page notices by itself. The app's three clicks, drawn small; on a
 * Linux computer, which may be a server without the app, the command too. In agentes for Mac on this very Mac: one
 * button to Preferences → Ferramentas instead (ADR 0036). Nothing once its switch is on, or on the workspace's own
 * computer, which nobody here reaches.
 */
export function BrowserSteps({ computer, machineId }: { computer: string; machineId?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const here = useIsThisMac(org.id, machineId ?? "");
  const row = useMachines(org.id).data?.find((m) => m.id === machineId);
  if (row?.kind === "managed" || row?.access?.tools.browser) return null;
  if (here) {
    return (
      <section className="brw-steps" aria-label={t("machines.thisMac.browserTitle")}>
        <StepsHead title={t("machines.thisMac.browserTitle")} />
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small muted" style={{ flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.browserText")}
          </span>
          <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
        </div>
      </section>
    );
  }
  const step = (n: number, shot: ReactNode, text: string) => (
    <div className="brw-step">
      <div className="brw-step__shot" aria-hidden="true">
        {shot}
      </div>
      <p>
        <i>{n}</i>
        {text}
      </p>
    </div>
  );
  const bar = (hit?: boolean) => (
    <div className="brw-mbar">
      <span />
      <span />
      <span className="brw-mbar__me" data-hit={hit || undefined}>
        <LogoMark size={12} />
      </span>
      <b>14:32</b>
    </div>
  );
  return (
    <section className="brw-steps" aria-label={t("agentPage.work.steps.title", { computer })}>
      <StepsHead title={t("agentPage.work.steps.title", { computer })} />
      {row && !allowsInApp(row.os) ? (
        <div className="stack-4" style={{ gap: 6 }}>
          <span className="small">{t("browser.machine.offHelp")}</span>
          <span className="small muted">{t("machines.access.grantTerminal")}</span>
          <CommandBlock command={toolOnCommand(row, "browser")} />
        </div>
      ) : (
        <div className="brw-steps__grid">
          {step(1, bar(true), t("agentPage.work.steps.one"))}
          {step(
            2,
            <>
              {bar()}
              <div className="brw-mmenu">
                <span>{t("agentPage.work.steps.menuOpen")}</span>
                <hr />
                <span data-hl>{t("agentPage.work.steps.menuPrefs")}</span>
                <span>{t("agentPage.work.steps.menuPause")}</span>
                <hr />
                <span>{t("agentPage.work.steps.menuQuit")}</span>
              </div>
            </>,
            t("agentPage.work.steps.two"),
          )}
          {step(
            3,
            <div className="brw-mwin">
              <div className="brw-mwin__bar">{t("agentPage.work.steps.tools")}</div>
              <div className="brw-mwin__row">
                Claude Code <i data-on />
              </div>
              <div className="brw-mwin__row">
                {t("agentPage.work.steps.commands")} <i data-on />
              </div>
              <div className="brw-mwin__row" data-hl>
                {t("agentPage.work.computer.browser")} <i data-flip />
              </div>
            </div>,
            t("agentPage.work.steps.three"),
          )}
        </div>
      )}
      <p className="brw-steps__done ac-iconline">
        <Icon name="check" size={14} />
        {t("agentPage.work.steps.done")}
      </p>
    </section>
  );
}

/** The dialog that is open, if any. */
export function WorkDialogs({
  open,
  brainAt,
  onClose,
}: {
  open: WorkDialog | null;
  /** The screen "Quem pensa" opens on, from a link; its first one otherwise. */
  brainAt?: BrainScreen;
  onClose: () => void;
}) {
  // Who thinks has its own dialog, under the sky like Connect's (ADR 0032 §5, addendum 2026-11-10).
  if (open === "brain") return <BrainDialog onClose={onClose} at={brainAt} />;
  if (open === "computer") return <ComputerDialog onClose={onClose} />;
  if (open === "browser") return <BrowserDialog onClose={onClose} />;
  return null;
}

/** The computers this person may give the agent (the server checks again). */
function usePickable() {
  const { me } = useOrg();
  const { viewer } = useAgentEdit();
  const work = useWork();
  return (work.machines.data ?? []).filter(
    (m) => viewer === "admin" || m.pairedBy?.id === me.user.id || m.id === work.machineId,
  );
}

function Footer({
  note,
  disabled,
  busy,
  primary,
  onClose,
  onUse,
}: {
  note?: ReactNode;
  disabled: boolean;
  busy: boolean;
  primary: string;
  onClose: () => void;
  onUse: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter note={note}>
      <Button onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={disabled} loading={busy} onClick={onUse}>
        {primary}
      </Button>
    </DialogFooter>
  );
}

// ── Onde trabalha ───────────────────────────────────────────────────────────

function ComputerDialog({ onClose }: { onClose: () => void }) {
  const work = useWork();
  if (!work.computer.data || !work.machines.data) return null;
  return <ComputerForm onClose={onClose} />;
}

function ComputerForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { agent, g } = useAgentEdit();
  const work = useWork();
  const pickable = usePickable();
  const setTarget = useSetComputerTarget(org.id);
  const noComputer = useNoComputer();
  const listed = noComputer.pending ? pickable.filter((m) => m.kind !== "managed") : pickable;
  const none = noComputer.choice(work.machineId === NO_COMPUTER);
  // The workspace's own computer on its way stands in for no computer: what it will be (every brain, the
  // browser) and when.
  const workspace = none === "workspace" ? noComputer.setup : null;
  const [choice, setChoice] = useState(work.machineId);
  // In the desktop app, this computer not yet in the organization (where agents may work on it): connect it
  // from here and pick it (ADR 0036).
  const thisMac = useThisMac(org.id);
  const agentsHere = useAgentsHere();
  const thisMacFree = agentsHere && canDo(org, "pair_computers") && thisMac.isSuccess && !thisMac.data;
  const [busy, setBusy] = useState(false);
  const view = work.brain.data;
  const brain = view?.brain ?? "model";
  const optionsOf = (id: string) => view?.machines.find((m) => m.machineId === id)?.options ?? [];
  const has = (id: string, k: BrainKind) => optionsOf(id).some((o) => o.kind === k && o.available);
  const browserOf = (m: Machine | undefined) =>
    !m ? "none" : m.access?.tools.browser && m.browser?.available ? "ready" : m.browser ? "pending" : "none";
  const offers = (m: Machine) => {
    const list = [
      ...(has(m.id, "claude_code") ? [t("brain.card.claude_code")] : []),
      ...(has(m.id, "codex") ? [t("brain.card.codex")] : []),
      ...(has(m.id, "cursor") ? [t("brain.card.cursor")] : []),
      ...(browserOf(m) === "ready"
        ? [t("agentPage.work.computer.browser")]
        : browserOf(m) === "pending"
          ? [t("agentPage.work.computer.browserPending")]
          : []),
    ];
    return list.length ? list.join(" · ") : t("agentPage.work.computer.onlyModel");
  };
  const also = (id: string) => {
    if (id === work.machineId) return [];
    if (id === NO_COMPUTER && workspace) return [t("computerSetup.agentWaiting", g)];
    const m = pickable.find((x) => x.id === id);
    return [
      ...(brain !== "model" && !has(id, brain)
        ? [t("agentPage.work.computer.alsoBrain", { brain: t(`brain.card.${brain}`) })]
        : []),
      ...(m && !m.online ? [t("agentPage.work.computer.alsoOffline", g)] : []),
    ];
  };
  const status = (m: Machine) =>
    m.online ? t("agentPage.work.computer.online") : t("agentPage.work.computer.offline");
  const chosen = pickable.find((m) => m.id === choice);
  const use = async () => {
    setBusy(true);
    try {
      await setTarget.mutateAsync({ agentId: agent.id, machineId: choice === NO_COMPUTER ? null : choice });
      // What the new computer can't do goes back to the organization's model (said before, in the dialog).
      if (brain !== "model" && (choice === NO_COMPUTER ? !workspace : !has(choice, brain)))
        await api.agents.setBrain(org.id, agent.id, { brain: "model" });
      refresh();
      toast.show(
        chosen || workspace
          ? t("agentPage.work.saved.computer", {
              ...g,
              computer: chosen
                ? computerNameOf(t, org.name, chosen.name, isPersonal(org))
                : noComputer.label("workspace"),
            })
          : t("agentPage.work.saved.none", g),
      );
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const note = (id: string) =>
    also(id).length > 0 ? (
      <div className="stack-4" style={{ gap: 6 }}>
        {also(id).map((a) => (
          <SettingNote key={a} icon="alert" live>
            {a}
          </SettingNote>
        ))}
      </div>
    ) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.work.computer.title", g)}
      description={t("agentPage.work.computer.sub", g)}
      closeLabel={t("common.close")}
      width={640}
      className="agp-wdlg"
    >
      <Locked when={busy}>
        <DialogBody>
          <OptionList
            aria-label={t("agentPage.work.computer.title", g)}
            value={choice}
            onValueChange={setChoice}
            options={[
              ...(none
                ? [
                    {
                      value: NO_COMPUTER,
                      // Portraits are as wide as their drawings: one column keeps the titles in line.
                      leading: (
                        <span className="machine-row__pic">
                          {none === "none" ? (
                            <Icon name="dash" size={20} />
                          ) : (
                            <ComputerPortrait
                              kind={WORKSPACE_COMPUTER_KIND}
                              state={workspace ? setupPortrait(workspace, false) : "online"}
                            />
                          )}
                        </span>
                      ),
                      title: noComputer.label(none),
                      description: workspace ? t(workspace.textKey) : t("computer.target.noneText"),
                      children: note(NO_COMPUTER),
                    },
                  ]
                : []),
              ...listed.map((m) => ({
                value: m.id,
                leading: (
                  <span className="machine-row__pic">
                    <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} />
                  </span>
                ),
                title: m.name,
                description: `${status(m)} · ${offers(m)}`,
                children: note(m.id),
              })),
            ]}
          />
        </DialogBody>
      </Locked>
      <Footer
        note={
          thisMacFree ? (
            <ThisMacButton orgId={org.id} canPair folders={false} onConnected={setChoice} />
          ) : (
            <Link
              to="/org/$orgId/settings/$section"
              params={{ orgId: org.id, section: "devices" }}
              className="small agp-wdlg__link"
            >
              <Icon name="plus" size={14} />
              {t("agentPage.work.computer.connect")}
            </Link>
          )
        }
        disabled={choice === work.machineId}
        busy={busy}
        primary={
          chosen
            ? t("agentPage.work.computer.useMachine", {
                computer: computerNameOf(t, org.name, chosen.name, isPersonal(org)),
              })
            : workspace
              ? t("agentPage.work.computer.useMachine", { computer: noComputer.label("workspace") })
              : t("agentPage.work.use")
        }
        onClose={onClose}
        onUse={() => void use()}
      />
    </Dialog>
  );
}

// ── Navegador ───────────────────────────────────────────────────────────────

/** The agent's own browser in its profile choice (ADR 0110): any value that isn't a profile's id. */
const OWN_BROWSER = "own";

function BrowserDialog({ onClose }: { onClose: () => void }) {
  const work = useWork();
  if (!work.browser.data || !work.scopes.data || !work.computer.data || !work.machines.data) return null;
  return <BrowserForm onClose={onClose} />;
}

function BrowserForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const edition = useComputerEdition(org.id);
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { agent, g, viewer } = useAgentEdit();
  const work = useWork();
  const pickable = usePickable();
  const setTarget = useSetComputerTarget(org.id);
  const saveSites = useUpdateAgentBrowserSettings(org.id, agent.id);
  const profileActions = useBrowserProfileMutations(org.id);
  const profiles = useBrowserProfiles(org.id);
  const dir = useDirectory(org.id);
  const mine = profilesOfAgent(profiles.data, agent.id);
  const savedProfile = work.browser.data?.profileId ?? null;
  const [profile, setProfile] = useState<string>(savedProfile ?? OWN_BROWSER);
  const profileId = profile === OWN_BROWSER ? null : profile;
  const admin = viewer === "admin";
  const domains = work.browser.data?.allowedDomains ?? [];
  const [mode, setMode] = useState<"any" | "only" | "off">(
    work.granted ? (domains.length > 0 ? "only" : "any") : "off",
  );
  const [sites, setSites] = useState(domains);
  const [typed, setTyped] = useState("");
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  // With no computer the browser needs a connected one: the first with the browser ready, else any.
  const ready = (m: Machine) => Boolean(m.access?.tools.browser && m.browser?.available);
  const moveTo =
    mode !== "off" && work.machineId === NO_COMPUTER
      ? (pickable.find((m) => ready(m) && m.online) ?? pickable.find(ready) ?? pickable[0] ?? null)
      : null;
  const add = () => {
    const site = cleanSite(typed);
    if (!site) return;
    if (!SITE.test(site)) return setBad(true);
    setTyped("");
    setBad(false);
    if (!sites.includes(site)) setSites([...sites, site]);
  };
  const on = mode !== "off";
  const sitesNow = mode === "only" ? sites : [];
  const unchanged =
    on === work.granted &&
    (!on || (JSON.stringify(sitesNow) === JSON.stringify(domains) && profileId === savedProfile));
  const noComputer = on && work.machineId === NO_COMPUTER && !moveTo;
  // Profiles only where they exist: its browser's computer is single mode, or it already has one (on such a computer).
  const browserMachineId = moveTo?.id ?? work.browser.data?.machine?.id ?? work.machineId;
  const withProfiles = mine.length > 0 || profilesApply(work.machines.data?.find((m) => m.id === browserMachineId));
  // On the Cloud the agent's browser comes with the workspace's computer: it can be turned on while that one is prepared.
  const blocked = noComputer && edition !== "cloud";
  const use = async () => {
    setBusy(true);
    try {
      if (moveTo) await setTarget.mutateAsync({ agentId: agent.id, machineId: moveTo.id });
      if (admin && on !== work.granted) {
        await saveLevels(api, org.id, agent.id, { "area:browser": on ? "write" : "none" });
      }
      if (on && JSON.stringify(sitesNow) !== JSON.stringify(domains))
        await saveSites.mutateAsync(sitesNow.length ? sitesNow : null);
      if (on && profileId !== savedProfile)
        await profileActions.setDefault.mutateAsync({ agentId: agent.id, profileId });
      refresh();
      const where = moveTo ?? pickable.find((m) => m.id === work.machineId);
      toast.show(
        !on
          ? t("agentPage.work.saved.browserOff", g)
          : on === work.granted
            ? t("agentPage.work.saved.sites")
            : where && !ready(where)
              ? t("agentPage.work.saved.browserWaiting", {
                  computer: computerNameOf(t, org.name, where.name, isPersonal(org)),
                })
              : t("agentPage.work.saved.browserOn", g),
      );
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const lead = (icon: IconName) => (
    <span className="agp-wdlg__key">
      <Icon name={icon} size={20} />
    </span>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.work.browserDialog.title", g)}
      description={t("agentPage.work.browserDialog.sub")}
      closeLabel={t("common.close")}
      width={720}
      className="agp-wdlg"
    >
      <Locked when={busy}>
        <DialogBody>
          <div className="ac-form">
            <OptionList
              aria-label={t("agentPage.work.browserDialog.title", g)}
              layout="cards"
              value={mode}
              onValueChange={(v) => (admin || v !== "off" ? setMode(v) : undefined)}
              options={[
                {
                  value: "any",
                  leading: lead("globe"),
                  title: t("agentPage.work.browserDialog.any"),
                  description: t("agentPage.work.browserDialog.anyText"),
                  disabled: !admin && !work.granted,
                },
                {
                  value: "only",
                  leading: lead("lock"),
                  title: t("agentPage.work.browserDialog.only"),
                  description: t("agentPage.work.browserDialog.onlyText"),
                  disabled: !admin && !work.granted,
                },
                {
                  value: "off",
                  leading: lead("block"),
                  title: t("agentPage.work.browserDialog.off"),
                  description: t("agentPage.work.browserDialog.offText"),
                  disabled: !admin,
                },
              ]}
            />
            {mode === "only" && (
              <div className="brw-sites">
                {sites.map((d) => (
                  <span key={d} className="brw-site">
                    <Icon name="globe" size={14} />
                    {d}
                    <button
                      type="button"
                      aria-label={t("browser.agent.removeSite", { site: d })}
                      onClick={() => setSites(sites.filter((x) => x !== d))}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
                <Input
                  className="brw-sites__add"
                  value={typed}
                  placeholder={`${t("browser.agent.addSite")} · ${t("browser.agent.addSiteHint")}`}
                  aria-label={t("browser.agent.addSite")}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setBad(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add();
                    }
                  }}
                  onBlur={add}
                />
              </div>
            )}
            {bad && <SettingNote icon="alert">{t("browser.agent.badSite")}</SettingNote>}
            {!admin && <SettingNote icon="lock">{t("agentPage.work.browserDialog.admins")}</SettingNote>}
            {moveTo && (
              <SettingNote icon="arrowRight" live>
                {t("agentPage.work.browserDialog.moves", {
                  ...g,
                  computer: computerNameOf(t, org.name, moveTo.name, isPersonal(org)),
                })}
              </SettingNote>
            )}
            {noComputer && (
              <SettingNote icon="alert">
                {edition === "cloud"
                  ? t("agentPage.work.browserDialog.noComputerCloud", {
                      computer: t(modeKey(org, "computerSetup.titleInSentence"), { org: org.name }),
                    })
                  : t("agentPage.work.browserDialog.noComputer")}
              </SettingNote>
            )}
            {blocked && inDesktopApp() && (
              <ThisMacButton orgId={org.id} canPair={canDo(org, "pair_computers")} folders={false} />
            )}
            {on && (moveTo ? !ready(moveTo) : work.browser.data?.reason === "switched_off") && (
              <BrowserSteps
                computer={moveTo?.name ?? work.browser.data?.machine?.name ?? ""}
                machineId={moveTo?.id ?? work.browser.data?.machine?.id}
              />
            )}
            {on && !withProfiles && <SettingNote icon="lock">{t("browser.agent.signedIn", g)}</SettingNote>}
            {on && withProfiles && (
              <div className="ac-field">
                <span className="ac-field__label" id="agent-browser-profile">
                  {t("browser.profiles.agentChoice", g)}
                </span>
                <OptionList
                  aria-labelledby="agent-browser-profile"
                  value={profile}
                  onValueChange={setProfile}
                  options={[
                    {
                      value: OWN_BROWSER,
                      leading: lead("person"),
                      title: t("browser.profiles.own", g),
                      description: t("browser.profiles.ownText", g),
                      ...(savedProfile === null ? { tag: t("browser.profiles.default") } : {}),
                    },
                    ...mine.map((p) => {
                      const holder = p.holder?.type === "agent" ? dir.agentById.get(p.holder.agentId)?.name : undefined;
                      return {
                        value: p.id,
                        leading: lead("globe"),
                        title: p.name,
                        description: p.holder
                          ? t("browser.profiles.inUsePerson", {
                              name:
                                holder ??
                                (p.holder.type === "person" ? dir.memberById.get(p.holder.userId)?.name : "") ??
                                "",
                            })
                          : t("browser.profiles.free"),
                        ...(savedProfile === p.id ? { tag: t("browser.profiles.default") } : {}),
                      };
                    }),
                  ]}
                />
                {!canDo(org, "manage_connectors") && (
                  <div className="row">
                    <Button
                      size="sm"
                      icon="plus"
                      loading={profileActions.request.isPending}
                      onClick={() =>
                        profileActions.request.mutate(agent.id, {
                          onSuccess: () => toast.show(t("browser.profiles.asked")),
                          onError: () => toast.show(t("browser.profiles.failed"), "error"),
                        })
                      }
                    >
                      {t("browser.profiles.askMore")}
                    </Button>
                    <span className="small muted">{t("browser.profiles.askHelp", g)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogBody>
      </Locked>
      <Footer
        disabled={unchanged || blocked}
        busy={busy}
        primary={t("agentPage.work.use")}
        onClose={onClose}
        onUse={() => void use()}
      />
    </Dialog>
  );
}
