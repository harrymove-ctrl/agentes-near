import type { Agent, AgentAudience, AgentSetupStep, AudienceMode } from "@agenteschat/client";
import {
  keys,
  useAgentAccess,
  useAgentBrain,
  useAgentDetail,
  useAiStatus,
  useApi,
  useCatalog,
  useConfirmSetup,
  useCredentials,
  useModels,
  usePlatformKey,
  useRoles,
  useUpdateAgent,
  useWidenAudience,
} from "@agenteschat/client";
import {
  type AccessResource,
  asksAt,
  type Level,
  type LevelState,
  levelOf,
  resourcesOf,
} from "@agenteschat/client/lib/access-levels";
import { channelsAfter, sameAudience } from "@agenteschat/client/lib/agent-edit";
import { audienceModeKey, audienceModeTextKey, audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { rolePicksInSight } from "@agenteschat/client/lib/personal-view";
import { planOf } from "@agenteschat/client/lib/plans";
import { AUTO, modelChoices } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  askedLine,
  nextStep,
  setupApps,
  setupDone,
  setupRole,
  setupRow,
  setupSteps,
  setupTaskKeys,
  suggestedChannels,
} from "@agenteschat/client/lib/setup-checklist";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  AffixInput,
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  gradientOf,
  Icon,
  type IconName,
  Message,
  MessageText,
  RoleMark,
  Select,
  Textarea,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LevelRow,
  ResourceIcon,
  resourceName,
  toolLabel,
  useConnectedById,
  useSetLevels,
} from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ModelSelect, modelOptions, NO_OWNER, OwnerSelect } from "@/components/AgentFields";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { PlanReplies } from "@/components/ai/PlanReplies";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useChannelActions } from "@/components/channel-actions";
import { SetupBand } from "@/components/new-agent/SetupBand";
import { useOrg } from "@/components/org-context";
import { useWidenAsk } from "@/components/ReachLines";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { useToast } from "@/lib/toast";
import { useVisibleChannels } from "@/pages/agent/pieces";
import "./agent-setup.css";

/*
 * A new agent's setup checklist (ADR 0155 §2): the top of its chat, drawn by the app and never stored, in its voice.
 * Five steps (think, apps, channels, who talks to it, how it works); each button opens a small dialog with the
 * suggestion marked, nothing changes without confirming. Only who may set the agent up sees it: who manages agents
 * all the steps, its owner the ones they may change. Its profile shows the same card while something is left.
 */

const STEP_ICON: Record<AgentSetupStep, IconName> = {
  ai: "bolt",
  apps: "plug",
  where: "channel",
  who: "members",
  how: "document",
};

/**
 * The steps this person sees for this agent (none: the checklist isn't theirs, or the agent has none). Alone in a
 * personal workspace there is nobody else to talk to it: "who" waits until someone joins (ADR 0159), read live.
 */
export function useSetupSteps(agent: Agent | undefined): AgentSetupStep[] {
  const { org, me } = useOrg();
  const { solo } = usePersonalView();
  const steps = agent ? setupSteps(agent, { meId: me.user.id, admin: can(org, "manage_agents") }) : [];
  // Alone in a personal workspace there are no group conversations in sight either: no "where" (ADR 0164).
  return solo ? steps.filter((s) => s !== "who" && s !== "where") : steps;
}

/**
 * What its checklist reads for this person (ADR 0155 §2): their steps, the ones done (confirmed, or done as its data
 * says), and whether everything it reads has loaded.
 */
function useSetupProgress(agent: Agent) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const admin = can(org, "manage_agents");
  const steps = useSetupSteps(agent);
  const status = useAiStatus(org.id);
  const access = useAgentAccess(org.id, agent.id, admin && steps.includes("apps"));
  const detail = useAgentDetail(org.id, agent.id);
  const visible = useVisibleChannels();
  const connectors = access.data ? resourcesOf(access.data).filter((r) => r.kind === "connector") : [];
  const granted = connectors.filter((r) => levelOf(r) !== "none");
  const visibleIds = new Set(visible.list.map((c) => c.id));
  const inChannels = (detail.data?.channels ?? []).filter((c) => visibleIds.has(c.id));
  const aiState = aiStateOf(status.data, agent.id);
  // On a billing hold nothing thinks, a saved key included: the AI row leads to the plan.
  const held = usePlanHold() !== null;
  // "Agora não" to apps on the right hand's card is for the team: its agents don't ask again.
  const appsLater = dir.agents.find(isRightHand)?.setup?.done.includes("apps") ?? false;
  const done = agent.setup
    ? setupDone(agent.setup, {
        ai: !held && (aiState === "ready" || aiState === "waiting"),
        apps: granted.length > 0 || appsLater,
        where: inChannels.length > 0,
      })
    : new Set<AgentSetupStep>();
  const doneHere = steps.filter((s) => done.has(s));
  return {
    steps,
    done,
    doneHere,
    all: doneHere.length === steps.length,
    // Everything it reads has loaded: a step that turns done after this was done now (its line and the burst).
    ready: status.isSuccess && detail.isSuccess && visible.ready && (!steps.includes("apps") || !access.isPending),
    held,
    connectors,
    granted,
    inChannels,
    visible,
  };
}

/**
 * The top of a new agent's DM: its greeting and the checklist, as its first message. The greeting asks for help only
 * when something is left as the conversation first shows its checklist loaded; done meanwhile, the ask stays as asked.
 */
export function AgentSetupIntro({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const progress = useSetupProgress(agent);
  const [asks, setAsks] = useState<boolean | null>(null);
  if (asks === null && progress.ready) setAsks(!progress.all);
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);
  const person = me.user.name.split(/\s+/)[0] ?? me.user.name;
  // A ready-made role's name, else the role it was given (a template's "Atendimento"); only an agent with neither
  // says back what it was asked.
  const own = agent.role.trim();
  // Made from its card (ADR 0164): it says what it said there, in its own voice.
  const hello = agent.setup?.hello?.trim() || null;
  const asked = hello || role || own ? null : askedLine(agent.instructions);
  const roleName = role
    ? roleWord(t(`newAgent.roles.${role}.name`), i18n.language)
    : own
      ? roleWord(own, i18n.language)
      : null;
  return (
    <Message
      agent
      avatar={<AgentAvatar agentId={agent.id} name={agent.name} />}
      author={agent.name}
      time={<time dateTime={agent.createdAt}>{formatTime(i18n.language, agent.createdAt)}</time>}
    >
      <MessageText>
        {/* A typed message's Markdown wrapper (MessageBody): without it, a paragraph keeps the browser's margins. */}
        <div className="md md--message">
          <p>
            {roleName
              ? t("agentSetup.greetingRole", { ...g, person, role: roleName })
              : t("agentSetup.greeting", { ...g, person })}
            {hello && ` ${/[.!?…]$/.test(hello) ? hello : `${hello}.`}`}
            {asked && ` ${t("agentSetup.asked", { what: asked })}`}
            {asks && ` ${t("agentSetup.lead")}`}
          </p>
        </div>
      </MessageText>
      <AgentSetupCard agent={agent} place="dm" />
    </Message>
  );
}

/** "Atendimento" → "atendimento" in a sentence; an acronym ("QA") stays as it is. */
const roleWord = (name: string, locale: string) =>
  name.length <= 3 && name === name.toUpperCase() ? name : name.toLocaleLowerCase(locale);

/**
 * The checklist card. `dm`: under the agent's greeting, in its voice ("Pra eu começar"); `profile`: on its page
 * ("Para o Leo começar"), gone once everything is done.
 */
export function AgentSetupCard({ agent, place }: { agent: Agent; place: "dm" | "profile" }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const actions = useChannelActions();
  const connect = useConnectAi();
  const dir = useDirectory(org.id);
  const { steps, done, doneHere, all, ready, held, connectors, granted, inChannels, visible } = useSetupProgress(agent);
  const catalog = useCatalog();
  const items = useConnectedById();
  const [open, setOpen] = useState<AgentSetupStep | null>(null);
  const burstRef = useRef<HTMLCanvasElement>(null);
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);
  const next = nextStep(steps, done);
  const said = useDoneSay(ready, doneHere, steps.length, agent.appearance?.color, burstRef, (step) =>
    t(`agentSetup.say.${step}`, agentGrammar(agent.name)),
  );

  if (steps.length === 0 || (place === "profile" && all)) return null;

  const names = (list: AccessResource[]) =>
    joinNames(
      list.map((r) => resourceName(t, r, items)),
      t,
    );
  // The apps its card chose (ADR 0164), else its role's: the connected ones by name, else the catalog's names.
  const cardApps = setupApps(agent.setup);
  const suggestedApps = connectors.filter((r) => r.connector && cardApps[r.connector]);
  const unconnected = Object.keys(cardApps).filter((id) => !connectors.some((r) => r.connector === id));
  const catalogNames = unconnected.flatMap((id) => {
    const def = catalog.data?.connectors.find((d) => d.id === id);
    return def ? [connectorName(t, def)] : [];
  });
  const placeable = visible.list.filter((c) => addsAgentsTo(c, me.user.id, org));
  const firstChannel = placeable.find((c) => suggestedChannels(role, placeable).includes(c.id));
  const audience = audienceOf(agent);
  const onPlan = Boolean(agent.brain && agent.brain.kind !== "model");
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const ownerIsMe = agent.ownerUserId === me.user.id;

  const rowOf = (step: AgentSetupStep) =>
    setupRow(t, step, done.has(step), {
      org: org.name,
      role,
      granted: granted.length ? names(granted) : null,
      suggested: suggestedApps.length ? names(suggestedApps) : catalogNames.length ? joinNames(catalogNames, t) : null,
      channels: inChannels.length
        ? joinNames(
            inChannels.map((c) => `#${c.name}`),
            t,
          )
        : null,
      firstChannel: firstChannel ? `#${firstChannel.name}` : null,
      audience: audience.mode,
      otherOwner: !ownerIsMe && owner ? (owner.name.split(" ")[0] ?? owner.name) : null,
      onPlan,
      personal: isPersonal(org),
    });

  const act = (step: AgentSetupStep) => {
    if (step === "ai") connect?.open({ agentId: agent.id, chat: true });
    else setOpen(step);
  };
  const confirmed = () => setOpen(null);

  // Its role's first tasks (a blank agent's own two); a key a language lacks is left out.
  const anyKey = t as unknown as (key: string) => string;
  const tasks = setupTaskKeys(role, agent.setup?.starter)
    .filter((key) => i18n.exists(key))
    .map((key) => anyKey(key));
  const ask = (text: string) => {
    if (place === "dm" && actions?.fillComposer) {
      actions.fillComposer(text);
      return;
    }
    setDraftFor(`agent:${agent.id}`, text);
    void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: agent.id } });
  };

  // In its chat (ADR 0164) "how it works" starts done and stays on its page; who it talks to only informs there, not
  // counted: a plan that makes it answer only its owner says so.
  const inChat = place === "dm";
  const shown = inChat ? steps.filter((s) => s !== "how") : steps;
  const counted = inChat ? shown.filter((s) => s !== "who") : shown;
  const allHere = counted.every((s) => done.has(s));
  const title =
    place === "dm" ? (allHere ? t("agentSetup.ready", g) : t("agentSetup.title")) : t("agentSetup.titleProfile", g);
  const planOnly = onPlan && audience.mode === "owner" && ownerIsMe;
  return (
    <SetupCardView
      title={title}
      done={counted.filter((s) => done.has(s)).length}
      total={counted.length}
      place={place}
      burstRef={burstRef}
      band={
        inChat && (
          <SetupBand
            agent={agent}
            ready={ready}
            thinks={done.has("ai")}
            needsAi={steps.includes("ai")}
            apps={Object.keys(cardApps)
              .slice(0, 4)
              .map((id) => ({ id, granted: granted.some((r) => r.connector === id) }))}
          />
        )
      }
      rows={shown.map((s) => {
        const row = rowOf(s);
        const isDone = done.has(s);
        if (inChat && s === "who")
          return {
            key: s,
            icon: STEP_ICON[s],
            done: true,
            info: true,
            title: row.title,
            desc: planOnly ? t("agentSetup.who.todoPlanDesc") : undefined,
            action: { label: row.action, onClick: () => act(s) },
          };
        const acts = s !== "ai" || Boolean(connect);
        // On a hold it waits for the plan, whose one button is the hold's banner.
        if (s === "ai" && held && !isDone) {
          return {
            key: s,
            icon: STEP_ICON[s],
            done: false,
            title: row.title,
            desc: t("agentSetup.firstRun.afterPlan"),
            dim: true,
          };
        }
        const connectFirst = s === "apps" && !isDone && suggestedApps.length === 0 && catalogNames.length > 0;
        return {
          key: s,
          icon: STEP_ICON[s],
          done: isDone,
          title: row.title,
          desc: row.desc,
          saying: said?.step === s ? said.text : null,
          ...(acts
            ? {
                action: {
                  label: connectFirst ? t("agentSetup.firstRun.apps.connect") : row.action,
                  primary: s === next,
                  onClick: () => act(s),
                },
              }
            : {}),
        };
      })}
      foot={
        done.has("ai") &&
        tasks.length > 0 && (
          <SetupAsks
            lead={(inChat ? allHere : all) ? t("agentSetup.tasksAllDone") : t("agentSetup.tasksLead")}
            asks={tasks.map((task) => ({ label: task, onClick: () => ask(task) }))}
          />
        )
      }
    >
      {open === "apps" && (
        <AppsDialog agent={agent} connectors={connectors} onClose={() => setOpen(null)} onSaved={confirmed} />
      )}
      {open === "where" && <WhereDialog agent={agent} onClose={() => setOpen(null)} onSaved={confirmed} />}
      {open === "who" && <WhoDialog agent={agent} onClose={() => setOpen(null)} onSaved={confirmed} />}
      {open === "how" && <HowDialog agent={agent} onClose={() => setOpen(null)} onSaved={confirmed} />}
    </SetupCardView>
  );
}

/** One row of a checklist card, as drawn: its button, a second one ("Agora não"), or a link once done. */
export interface SetupCardRow {
  key: string;
  /** Only informs (who it talks to, in its chat, ADR 0164): drawn done with its line, not counted in the meter. */
  info?: boolean;
  icon: IconName;
  done: boolean;
  title: string;
  desc?: string | undefined;
  /** Its line just after it was done, in the agent's voice. */
  saying?: string | null;
  /** Its button (a link once done); none: nothing to press for this person, or the row waits (`dim`). */
  action?: { label: string; primary?: boolean; onClick: () => void };
  /** In place of its button: a link elsewhere (the plan's page). */
  actionNode?: ReactNode;
  skip?: { label: string; onClick: () => void; busy?: boolean };
  /** It waits for something else (the plan): drawn quieter, with no button. */
  dim?: boolean;
  /** What the row asks for in place (an address to invite), at its full width under its text. */
  form?: ReactNode;
}

/**
 * A checklist card's drawing, the one for a new agent (ADR 0155 §2) and the right hand's first run (§6): the head and
 * its count, the segmented bar, the rows, a foot of asks. The data and dialogs are its users'.
 */
export function SetupCardView({
  title,
  done,
  total,
  place,
  rows,
  foot,
  band,
  burstRef,
  children,
}: {
  title: string;
  done: number;
  total: number;
  place: "dm" | "profile";
  rows: SetupCardRow[];
  foot?: ReactNode;
  /** On top of the card: a new agent's sky in its chat (`SetupBand`, ADR 0164). */
  band?: ReactNode;
  burstRef?: RefObject<HTMLCanvasElement | null>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="setup-cl" aria-label={title} data-place={place}>
      <canvas ref={burstRef} className="setup-cl__burst" aria-hidden="true" tabIndex={-1} />
      {band}
      <div className="setup-cl__head">
        <b>{title}</b>
        <small>{t("agentSetup.count", { done, total })}</small>
      </div>
      <div className="setup-cl__meter" aria-hidden="true">
        {rows
          .filter((r) => !r.info)
          .map((r, i) => (
            <i key={r.key} data-on={i < done || undefined} />
          ))}
      </div>
      <ul className="setup-cl__rows" aria-live="polite">
        {rows.map((r) => (
          <li
            key={r.key}
            className="setup-row ac-mediarow ac-mediarow--row"
            data-done={r.done || undefined}
            data-new={r.saying ? true : undefined}
            data-dim={r.dim || undefined}
          >
            <span className="ac-mediarow__face">
              {r.done ? (
                <span className="setup-row__check">
                  <Icon name="check" size={14} />
                </span>
              ) : (
                <Icon name={r.icon} size={20} />
              )}
            </span>
            <span className="ac-mediarow__head">
              <b className="setup-row__title">{r.title}</b>
              {r.done && r.action && (
                <button type="button" className="setup-row__link" onClick={r.action.onClick}>
                  {r.action.label}
                </button>
              )}
            </span>
            {(r.saying || ((!r.done || r.info) && r.desc)) && (
              <span className="ac-mediarow__body setup-row__text">
                {r.saying ? <span className="setup-row__say">{r.saying}</span> : <span>{r.desc}</span>}
              </span>
            )}
            {!r.done && r.form && <span className="ac-mediarow__body setup-row__form">{r.form}</span>}
            {!r.done && (r.action || r.actionNode || r.skip) && (
              <span className="ac-mediarow__end ac-mediarow__end--wrap setup-row__act">
                {r.skip && (
                  <Button size="sm" variant="ghost" disabled={r.skip.busy} onClick={r.skip.onClick}>
                    {r.skip.label}
                  </Button>
                )}
                {r.actionNode ??
                  (r.action && (
                    <Button
                      size="sm"
                      variant={r.action.primary ? "primary" : undefined}
                      disabled={r.skip?.busy}
                      onClick={r.action.onClick}
                    >
                      {r.action.label}
                    </Button>
                  ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {foot}
      {children}
    </section>
  );
}

/** The card's foot: a lead, then asks to press (each fills the composer, or sends). */
export function SetupAsks({ lead, asks }: { lead: string; asks: { label: string; onClick: () => void }[] }) {
  return (
    <div className="setup-cl__foot">
      <b>{lead}</b>
      <div className="setup-cl__tasks">
        {asks.map((a) => (
          <button key={a.label} type="button" className="setup-task ac-iconline" onClick={a.onClick}>
            <Icon name="message" size={16} />
            <span>{a.label}</span>
            <Icon name="arrowRight" size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A step done while the card is in view (after everything it reads has loaded): its line for a moment, and a burst of
 * pixels in the agent's colors, a bigger one when it was the last. `celebrates`: whether its line comes with the burst
 * (an invitation only sent says so, quietly).
 */
export function useDoneSay<S extends string>(
  ready: boolean,
  doneNow: readonly S[],
  total: number,
  color: string | undefined,
  burstRef: RefObject<HTMLCanvasElement | null>,
  sayOf: (step: S) => string,
  celebrates: (step: S) => boolean = () => true,
) {
  const [said, setSaid] = useState<{ step: S; text: string } | null>(null);
  const seen = useRef<Set<S> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useRef(sayOf);
  say.current = sayOf;
  const party = useRef(celebrates);
  party.current = celebrates;
  const doneKey = doneNow.join();
  useEffect(() => {
    if (!ready) return;
    const now = new Set(doneKey ? (doneKey.split(",") as S[]) : []);
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const fresh = [...now].find((s) => !before.has(s));
    const text = fresh ? say.current(fresh) : "";
    if (!fresh || !text) return;
    setSaid({ step: fresh, text });
    if (party.current(fresh)) burst(burstRef.current, color, now.size === total);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 2600);
  }, [ready, doneKey, total, color, burstRef]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return said;
}

/** A few pixels in the agent's colors burst from the card when a step is done (none with reduced motion). */
function burst(cv: HTMLCanvasElement | null, color: string | undefined, big: boolean) {
  if (!cv || typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = cv.getBoundingClientRect();
  const W = Math.round(r.width / 3);
  const H = Math.round(r.height / 3);
  const g = cv.getContext("2d");
  if (!W || !H || !g) return;
  cv.width = W;
  cv.height = H;
  const [top, bottom] = gradientOf(color);
  const tones = [top, bottom, "#ffffff", "#ffd36b"];
  const ps = Array.from({ length: big ? 90 : 34 }, () => ({
    x: W / 2,
    y: H * 0.62,
    vx: (Math.random() - 0.5) * (big ? 3.2 : 2.2),
    vy: -Math.random() * (big ? 3.4 : 2.4) - 0.6,
    c: tones[Math.floor(Math.random() * tones.length)] ?? top,
    s: Math.random() < 0.3 ? 2 : 1,
  }));
  let frame = 0;
  const step = () => {
    if (!cv.isConnected) return;
    g.clearRect(0, 0, W, H);
    frame++;
    for (const p of ps) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.09;
      g.fillStyle = p.c;
      g.globalAlpha = Math.max(0, 1 - frame / 70);
      g.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
    }
    if (frame < 70) requestAnimationFrame(step);
    else g.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(step);
}

/* ---------- The small dialogs behind the buttons: one step each, the suggestion marked ---------- */

export function StepDialog({
  title,
  description,
  wide,
  ok,
  okDisabled,
  busy,
  onOk,
  onClose,
  note,
  cancel = true,
  children,
}: {
  title: string;
  description?: string;
  wide?: boolean;
  ok: string;
  okDisabled?: boolean;
  busy: boolean;
  onOk: () => void;
  onClose: () => void;
  note?: ReactNode;
  /** False when its one button already closes it (nothing to save): no Cancelar beside it. */
  cancel?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={title}
      description={description}
      closeLabel={t("common.close")}
      width={wide ? 560 : 480}
      className="setup-dlg"
    >
      <DialogBody className="setup-dlg__body">{children}</DialogBody>
      <DialogFooter note={note}>
        {cancel && (
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
        )}
        <Button variant="primary" onClick={onOk} disabled={okDisabled} loading={busy}>
          {ok}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Saves a step's choice, then confirms the step; a failure says why and keeps the dialog. */
export function useStepSave(agent: Agent, step: AgentSetupStep, onSaved: () => void) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const confirm = useConfirmSetup(org.id, agent.id);
  const [busy, setBusy] = useState(false);
  const run = async (save: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await save();
      await confirm.mutateAsync(step);
      onSaved();
    } catch (e) {
      toast.show(errorText(t, e), "error");
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** "O que o Leo pode usar": the workspace's apps, its role's marked; reading never changes anything. */
function AppsDialog({
  agent,
  connectors,
  onClose,
  onSaved,
}: {
  agent: Agent;
  connectors: AccessResource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const items = useConnectedById();
  const setLevels = useSetLevels();
  const g = agentGrammar(agent.name);
  const suggested = setupApps(agent.setup);
  const suggestionOf = (r: AccessResource) => (r.connector ? suggested[r.connector] : undefined);
  // The role's apps first, each at its suggestion while it has none yet; the rest as they are.
  const ordered = [...connectors.filter(suggestionOf), ...connectors.filter((r) => !suggestionOf(r))];
  const [levels, setLevelsDraft] = useState<Record<string, LevelState>>(() =>
    Object.fromEntries(
      connectors.map((r) => {
        const now = levelOf(r);
        const wish = suggestionOf(r);
        return [r.id, now === "none" && wish && r.levels.includes(wish) ? wish : now];
      }),
    ),
  );
  const { busy, run } = useStepSave(agent, "apps", onSaved);
  const level = (r: AccessResource) => levels[r.id] ?? "none";
  const count = connectors.filter((r) => level(r) !== "none").length;
  const save = () =>
    run(async () => {
      const changes: Record<string, Level> = {};
      for (const r of connectors) {
        const l = level(r);
        if (l !== "custom" && l !== levelOf(r)) changes[r.id] = l;
      }
      if (Object.keys(changes).length > 0) await setLevels.mutateAsync({ agentId: agent.id, changes });
    });
  const toConnectors = () =>
    void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "connectors" } });
  // The card's apps not connected here yet (ADR 0164): each connects right here, then shows above at its level.
  const catalog = useCatalog();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const toConnect = Object.keys(suggested)
    .filter((id) => !connectors.some((r) => r.connector === id))
    .flatMap((id) => {
      const def = catalog.data?.connectors.find((d) => d.id === id && d.available && !d.soon);
      return def ? [def] : [];
    });
  return (
    <>
      <StepDialog
        title={t("agentSetup.apps.title", g)}
        description={t("agentSetup.apps.desc")}
        wide
        ok={count ? t("agentSetup.apps.ok", { count }) : t("agentSetup.apps.okNone")}
        busy={busy}
        onOk={() => void save()}
        onClose={onClose}
      >
        {toConnect.length > 0 && (
          <ul className="setup-apps" aria-label={t("agentSetup.suggested")}>
            {toConnect.map((def) => (
              <li key={def.id} className="setup-apps__row">
                <ConnectorIcon def={def} label={connectorName(t, def)} />
                <b>{connectorName(t, def)}</b>
                <small>{t("agentSetup.suggested")}</small>
                <Button size="sm" onClick={() => setFlow({ step: 0, def })}>
                  {t("agentSetup.firstRun.apps.connect")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {ordered.length === 0 ? (
          toConnect.length === 0 && (
            <p className="small muted">{t(modeKey(org, "agentSetup.apps.empty"), { org: org.name })}</p>
          )
        ) : (
          <ul className="level-list setup-dlg__apps" aria-label={t("access.kind.connectors")}>
            {ordered.map((r) => {
              const name = resourceName(t, r, items);
              return (
                <LevelRow
                  key={r.id}
                  icon={<ResourceIcon resource={r} items={items} name={name} />}
                  name={name}
                  asks={asksAt(r, level(r)).map((x) => toolLabel(t, r, x))}
                  levels={r.levels}
                  value={level(r)}
                  onChange={(l) => setLevelsDraft((d) => ({ ...d, [r.id]: l }))}
                  tag={suggestionOf(r) ? <span className="setup-tag">{t("agentSetup.suggested")}</span> : undefined}
                />
              );
            })}
          </ul>
        )}
        <Button variant="ghost" size="sm" icon="plus" className="setup-dlg__add" onClick={toConnectors}>
          {t("agentSetup.apps.connectOther")}
        </Button>
      </StepDialog>
      {/* Signing in elsewhere comes back to this conversation. */}
      <ConnectFlow
        flow={flow}
        onChange={setFlow}
        onClose={() => setFlow(null)}
        returnTo={typeof window === "undefined" ? undefined : window.location.pathname}
      />
    </>
  );
}

/** "Onde o Leo trabalha": the channels this person may put it in, its role's marked; its DM always counts. */
function WhereDialog({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const detail = useAgentDetail(org.id, agent.id);
  const visible = useVisibleChannels();
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);
  const placeable = visible.list.filter((c) => addsAgentsTo(c, me.user.id, org));
  const placeableIds = new Set(placeable.map((c) => c.id));
  const current = (detail.data?.channels ?? []).filter((c) => placeableIds.has(c.id)).map((c) => c.id);
  const suggested = new Set(suggestedChannels(role, placeable));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(current.length ? current : suggested));
  const { busy, run } = useStepSave(agent, "where", onSaved);
  const save = () =>
    run(async () => {
      const wanted = [...picked];
      if (wanted.length === current.length && wanted.every((id) => current.includes(id))) return;
      // The PUT replaces the list: start from what the server has now (its DMs, channels this person can't see).
      const now = await api.agents.channels(org.id, agent.id);
      await api.agents.setChannels(org.id, agent.id, channelsAfter(now, current, wanted));
      await qc.invalidateQueries({ queryKey: keys.agentDetail(org.id, agent.id) });
    });
  const only = placeable.find((c) => picked.has(c.id));
  const ok =
    picked.size === 0
      ? t("agentSetup.where.okNone")
      : picked.size === 1 && only
        ? t("agentSetup.where.okOne", { channel: `#${only.name}` })
        : t("agentSetup.where.ok", { count: picked.size });
  const order = [...placeable.filter((c) => suggested.has(c.id)), ...placeable.filter((c) => !suggested.has(c.id))];
  return (
    <StepDialog
      title={t("agentSetup.where.title", g)}
      description={t("agentSetup.where.desc")}
      ok={ok}
      busy={busy}
      okDisabled={!detail.isSuccess}
      onOk={() => void save()}
      onClose={onClose}
    >
      {order.length === 0 ? (
        <p className="small muted">{t("newAgent.noChannels")}</p>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: checkboxes that read their group's name, not a fieldset
        <div className="setup-dlg__list" role="group" aria-label={t("newAgent.channels")}>
          {order.map((c) => {
            const id = `setup-ch-${c.id}`;
            return (
              <label key={c.id} htmlFor={id} className="setup-check">
                <Checkbox
                  id={id}
                  checked={picked.has(c.id)}
                  onCheckedChange={(on) =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (on) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                />
                <span className="setup-check__text">
                  <b>
                    {`#${c.name}`}
                    {suggested.has(c.id) && <span className="setup-tag">{t("agentSetup.suggested")}</span>}
                  </b>
                  {c.topic && <span>{c.topic}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </StepDialog>
  );
}

const MODES: AudienceMode[] = ["everyone", "people", "owner"];

/** "Quem fala com o Leo": who may talk to it (a dropdown), the people and roles picked, its owner (admins). */
function WhoDialog({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const update = useUpdateAgent(org.id, agent.id);
  const widen = useWidenAudience(org.id, agent.id);
  const asks = useWidenAsk(agent);
  const confirm = useConfirmSetup(org.id, agent.id);
  const admin = can(org, "manage_agents");
  const g = agentGrammar(agent.name);
  const planKind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const brain = useAgentBrain(org.id, agent.id, planKind !== null).data;
  const saved = audienceOf(agent);
  const [audience, setAudience] = useState<AgentAudience>(saved);
  const [ownerId, setOwnerId] = useState(agent.ownerUserId ?? NO_OWNER);
  const [share, setShare] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = ownerId === NO_OWNER ? null : ownerId;
  const ownerName = owner ? dir.memberById.get(owner)?.name : undefined;
  const pickedPeople = new Set(audience.userIds);
  const pickedRoles = new Set(audience.roleIds ?? []);
  // A personal workspace's family picks people first, and a role only when one is worth it (ADR 0159).
  const personal = isPersonal(org);
  const allRoles = roles.data?.roles ?? [];
  const roleList = rolePicksInSight(org, allRoles, audience.roleIds ?? [])
    ? sortRoles(allRoles.filter((r) => !isEveryone(r)))
    : [];
  const people = dir.members.filter((m) => m.userId !== owner);
  const modeText = (mode: AudienceMode) =>
    mode === "owner"
      ? ownerName
        ? t("audience.modeText.owner", { ...g, owner: owner === me.user.id ? t("agentSetup.who.you") : ownerName })
        : t("audience.modeText.noOwner")
      : t(audienceModeTextKey(org, mode), g);
  const valid =
    audience.mode === "everyone" ||
    (audience.mode === "owner" ? Boolean(owner) : pickedPeople.size > 0 || pickedRoles.size > 0 || Boolean(owner));
  const shareOn = share ?? (brain ? !brain.onlyOwner : false);
  const ownerIsMe = owner === me.user.id;
  const picked = pickedPeople.size > 0 || pickedRoles.size > 0;
  const problem = valid
    ? undefined
    : audience.mode === "owner"
      ? t("audience.modeText.noOwner")
      : t("audience.pickSomeone");
  const planOwner = dir.memberById.get(agent.ownerUserId ?? "")?.name.split(" ")[0];
  // "Você sempre pode, como responsável" under the people picked.
  const always = ownerName
    ? t("audience.ownerAlways", { name: ownerIsMe ? t("agentSetup.who.youCap") : ownerName })
    : undefined;
  const save = async () => {
    setBusy(true);
    try {
      if (owner !== (agent.ownerUserId ?? null)) await update.mutateAsync({ ownerUserId: owner });
      if (!sameAudience(audience, saved)) {
        // The one save that asks first when it takes mailboxes away or opens someone else's plan (`useWidenAsk`).
        const next = audiencePatch(audience);
        if (!(await widen.saveAsync(next, asks.ask(next)))) return;
      }
      if (planKind && brain && share !== null && share === brain.onlyOwner) {
        await api.agents.setBrain(org.id, agent.id, { onlyOwner: !share });
        await qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) });
      }
      await confirm.mutateAsync("who");
      onSaved();
    } catch (e) {
      toast.show(errorText(t, e), "error");
    } finally {
      setBusy(false);
    }
  };
  const add = (value: string) => {
    const [kind, id] = value.split(":");
    if (!id) return;
    if (kind === "role") setAudience((a) => ({ ...a, roleIds: [...(a.roleIds ?? []), id] }));
    else setAudience((a) => ({ ...a, userIds: [...a.userIds, id] }));
  };
  const remove = (kind: "userIds" | "roleIds", id: string) =>
    setAudience((a) => ({ ...a, [kind]: (a[kind] ?? []).filter((x) => x !== id) }));
  const roleOptions = roleList
    .filter((r) => !pickedRoles.has(r.id))
    .map((r) => ({
      value: `role:${r.id}`,
      label: r.name,
      group: t("audience.roles"),
      leading: <RoleMark color={r.color} icon={r.icon} size={24} />,
    }));
  const peopleOptions = people
    .filter((m) => !pickedPeople.has(m.userId))
    .map((m) => ({
      value: `person:${m.userId}`,
      label: m.name,
      group: roleList.length ? t("audience.people") : undefined,
      leading: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
    }));
  const addOptions = personal ? [...peopleOptions, ...roleOptions] : [...roleOptions, ...peopleOptions];
  return (
    <StepDialog
      title={t("agentSetup.who.title", g)}
      ok={t("common.save")}
      busy={busy}
      okDisabled={!valid}
      onOk={() => void save()}
      onClose={onClose}
    >
      <Field
        label={t("audience.section")}
        hint={
          valid
            ? { name: t("common.about", { label: t("audience.section") }), text: modeText(audience.mode) }
            : undefined
        }
        error={problem}
      >
        <Select
          value={audience.mode}
          onValueChange={(mode) => setAudience((a) => ({ ...a, mode }))}
          options={MODES.map((mode) => ({
            value: mode,
            label: t(audienceModeKey(org, mode)),
            description: modeText(mode),
          }))}
        />
      </Field>
      {audience.mode === "people" && (
        <Field
          label={t("agentSetup.who.people")}
          hint={{ name: t("common.about", { label: t("agentSetup.who.people") }), text: always }}
        >
          <div className="setup-dlg__people">
            {(pickedPeople.size > 0 || pickedRoles.size > 0) && (
              <TokenList label={t("audience.picked")}>
                {roleList
                  .filter((r) => pickedRoles.has(r.id))
                  .map((r) => (
                    <li key={r.id}>
                      <Token
                        leading={<RoleMark color={r.color} icon={r.icon} size={18} />}
                        removeLabel={t("common.removeName", { name: r.name })}
                        onRemove={() => remove("roleIds", r.id)}
                      >
                        {r.name}
                      </Token>
                    </li>
                  ))}
                {people
                  .filter((m) => pickedPeople.has(m.userId))
                  .map((m) => (
                    <li key={m.userId}>
                      <Token
                        leading={<Avatar kind="person" size="xs" name={m.name} imageUrl={m.image} />}
                        removeLabel={t("common.removeName", { name: m.name })}
                        onRemove={() => remove("userIds", m.userId)}
                      >
                        {m.name}
                      </Token>
                    </li>
                  ))}
              </TokenList>
            )}
            {addOptions.length > 0 && (
              <Select
                value=""
                aria-label={t("agentSetup.who.add")}
                placeholder={picked ? t("agentSetup.who.addMore") : t("agentSetup.who.add")}
                onValueChange={add}
                options={addOptions}
              />
            )}
          </div>
        </Field>
      )}
      {planKind && brain && audience.mode !== "owner" && (
        <PlanReplies
          agent={agent.name}
          owner={brain.canUsePlans ? undefined : planOwner}
          on={shareOn}
          onChange={setShare}
          disabled={!brain.canEdit}
          brain={planKind}
          coding={planOf(agent.brain?.provider)}
        />
      )}
      {asks.dialog}
      {admin && (
        <Field
          label={t("newAgent.owner")}
          hint={{ name: t("common.about", { label: t("newAgent.owner") }), text: t("agentSetup.who.ownerHelp", g) }}
        >
          <OwnerSelect card={false} value={ownerId} onChange={setOwnerId} members={dir.members} meId={me.user.id} />
        </Field>
      )}
    </StepDialog>
  );
}

/** "Como o Leo trabalha": its instructions, its monthly limit when it pays per use, its model under "Mais opções". */
function HowDialog({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const update = useUpdateAgent(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const detail = useAgentDetail(org.id, agent.id);
  const g = agentGrammar(agent.name);
  const onApi = !agent.brain || agent.brain.kind === "model";
  // Money is for who sees it (admins): the agent's own limit, else the workspace's.
  const seesBudget = onApi && agent.monthlyBudgetUsd !== undefined;
  const [instructions, setInstructions] = useState(agent.instructions);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const [model, setModel] = useState(agent.model);
  const { busy, run } = useStepSave(agent, "how", onSaved);
  const typed = budget.trim().replace(",", ".");
  const amount = typed === "" ? null : Number(typed);
  const budgetOk = amount === null || (Number.isFinite(amount) && amount >= 0);
  const list = modelOptions(
    t,
    i18n.language,
    modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
  );
  const save = () =>
    run(async () => {
      const patch: Parameters<typeof update.mutateAsync>[0] = {};
      if (instructions !== agent.instructions) patch.instructions = instructions;
      if (seesBudget && amount !== (agent.monthlyBudgetUsd ?? null)) patch.monthlyBudgetUsd = amount;
      if (onApi && model !== agent.model) patch.model = model;
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);
    });
  const fallback = detail.data?.defaultBudgetUsd;
  return (
    <StepDialog
      title={t("agentSetup.how.title", g)}
      description={t(modeKey(org, "agentSetup.how.desc"))}
      ok={t("common.save")}
      busy={busy}
      okDisabled={!budgetOk}
      onOk={() => void save()}
      onClose={onClose}
    >
      <Field label={t("agentSetup.how.instructions")}>
        <Textarea
          className="setup-dlg__instr"
          rows={6}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Field>
      {seesBudget && (
        <Field
          label={t("agentSetup.how.budget")}
          hint={{
            name: t("common.about", { label: t("agentSetup.how.budget") }),
            text: t("agentSetup.how.budgetHelp", g),
          }}
          error={budgetOk ? undefined : t("agent.budgetInvalid")}
        >
          <AffixInput
            prefix="US$"
            inputMode="decimal"
            className="setup-dlg__budget"
            value={budget}
            placeholder={fallback !== undefined ? String(fallback) : undefined}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
      )}
      {onApi && (
        <details className="setup-dlg__more">
          <summary>
            <Icon name="chevronDown" size={16} />
            {t("agentSetup.how.more")}
          </summary>
          <Field
            label={t("agentSetup.how.model")}
            hint={{ name: t("common.about", { label: t("agentSetup.how.model") }), text: t("brain.auto.hint") }}
          >
            <ModelSelect
              aria-label={t("agentSetup.how.model")}
              value={model}
              onChange={setModel}
              options={[
                { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") },
                ...(model === AUTO || list.some((o) => o.value === model) ? [] : [{ value: model, label: model }]),
                ...list,
              ]}
            />
          </Field>
        </details>
      )}
    </StepDialog>
  );
}
