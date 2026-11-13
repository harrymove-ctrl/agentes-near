import type { AgentBrain, AgentBrainInput, AgentSetup, BrainKind, MachineAccount } from "@agenteschat/client";
import { keys, useAgents, useApi, useSetComputerTarget, useUpdateAgent } from "@agenteschat/client";
import type { BrainScreen } from "@agenteschat/client/lib/agent-edit";
import { autonomyWords, setupOutcome } from "@agenteschat/client/lib/agent-setup";
import { signInPlan } from "@agenteschat/client/lib/ai-accounts";
import { EVERYONE_AUDIENCE, setupPlanQuestion } from "@agenteschat/client/lib/audience";
import { thinksWith } from "@agenteschat/client/lib/brain";
import {
  type Advanced,
  advancedDefaults,
  advancedParts,
  EFFORT_LEVELS,
  type EffortLevel,
  isAdvancedDefault,
} from "@agenteschat/client/lib/brain-advanced";
import { brainModelLine, brainPickText } from "@agenteschat/client/lib/brain-picker";
import { contextSize } from "@agenteschat/client/lib/context-limits";
import { keyRefusal } from "@agenteschat/client/lib/errors";
import { namesText } from "@agenteschat/client/lib/format";
import { type AiChoice, planMark } from "@agenteschat/client/lib/no-ai";
import { usageWhen } from "@agenteschat/client/lib/plan-usage";
import { geminiPersonal, isPlanId, planFreeHint, signInProviderOf } from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, keyRuns, providerLabel } from "@agenteschat/client/lib/providers";
import {
  AvatarStack,
  Button,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  EffortPixels,
  Icon,
  type IconName,
  OptionCard,
  ProviderLogo,
  planState,
  SettingNote,
} from "@agenteschat/ui";
import { extraUsageOn } from "@agenteschat/ui/plan-state";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { NO_COMPUTER } from "@/components/AgentComputer";
import { DEFAULT_KEY } from "@/components/AgentFields";
import { AddAccount, OpenPage } from "@/components/ai/AddAccountFlow";
import { PlanHold } from "@/components/ai/ConnectAiSteps";
import { PlanReplies } from "@/components/ai/PlanReplies";
import { HaveList, HaveRow, sortHave } from "@/components/arrival/ConnectHave";
import { sceneTeam, TeamScene, useDawn } from "@/components/arrival/TeamScene";
import { useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { useWidenAsk } from "@/components/ReachLines";
import { ToolsOffHereNote, useIsThisMac } from "@/components/ThisMac";
import { useAdminsLock } from "@/hooks/usePersonalView";
import { modelLimitText } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { useAgentEdit } from "../context";
import {
  BrainLine,
  ContextField,
  Fold,
  PickList,
  type PickOption,
  PlanWindows,
  SpeedField,
  SwitchLine,
  useGlide,
} from "./pieces";
import { SetupCopyDialog } from "./SetupCopyDialog";
import { type BrainRow, useBrainState } from "./state";
import { useRefresh, useWork } from "./work";
import "./brain-dialog.css";

/*
 * "Quem pensa" (ADR 0032 §5, addendum 2026-11-10): the same dialog as Connect from a conversation (ADR 0160,
 * addendum). The sky with the agent awake and the AI's mark at the trail's end, the title, one thing in the middle and
 * a footer that is always the same. It opens on the account in use with its limits, the model and "Mais opções" one
 * line each; or, with that account at its limit, on the accounts with room. Each screen saves its own change: another
 * account (for the others on it too, when it thinks for all of them), the model, how it thinks. After a switch,
 * "Desfazer" puts back what each agent had. Screens slide in from the side they come from, and the dialog's height
 * glides between them.
 */

type Screen = "glance" | "switch" | "all" | "team" | "limit" | "model" | "more" | "computer" | "add" | "done";

/** What this agent thought with before a switch, for "Desfazer". */
interface Before {
  brain: BrainKind;
  account: string | null;
  model: string | null;
  machineId: string;
  key: string | undefined;
  apiModel: string;
  onlyOwner: boolean;
}

/** A switch made here: to what, what each agent had, and what to say. */
interface Switched {
  row: BrainRow;
  before: Before;
  others: { id: string; name: string; brain: BrainKind; account: string | null; model: string | null }[];
  line: string;
  missed: string[];
  /** "Atende outras pessoas" off after it, as the server put it. */
  onlyOwnerAfter: boolean;
}

interface MoreDraft extends Advanced {
  extraUsage: boolean;
}

/** The effort's ramp: Automático is the model's choice, not a level (an automatic model picks the effort too). */
const EFFORTS: readonly EffortLevel[] = EFFORT_LEVELS;

/**
 * `at`: a screen to open on, past the first one, which "back" leads to (a link's, e.g. the notification "Escolher
 * outro modelo" opens the model). One this person can't change opens the first screen.
 */
export function BrainDialog({ onClose, at }: { onClose: () => void; at?: BrainScreen }) {
  const work = useWork();
  // Every screen starts from what is saved: the dialog mounts once it is loaded.
  if (!work.brain.data || !work.computer.data) return null;
  return <BrainFlow view={work.brain.data} onClose={onClose} at={at} />;
}

function BrainFlow({ view, onClose, at }: { view: AgentBrain; onClose: () => void; at?: BrainScreen }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const adminsOnly = useAdminsLock();
  const { agent, g, saved, can, draft, ownerFirst } = useAgentEdit();
  const work = useWork();
  const update = useUpdateAgent(org.id, agent.id);
  const setTarget = useSetComputerTarget(org.id);
  const connect = useConnectAi();
  const asks = useWidenAsk(agent);
  const hasOthers = (useAgents(org.id).data ?? []).some((a) => a.id !== agent.id);
  // Accounts a sign-in here just brought, before the next fetch has them.
  const [added, setAdded] = useState<MachineAccount[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const s = useBrainState(view, { added, signingIn });

  const mayModel = s.kind === "model" ? can("model") : can("brain");
  // The way through the screens: back pops one, a save lands on the first again. At its limit it opens on the way out,
  // unless a link asked for a screen of its own.
  const [trail, setTrail] = useState<Screen[]>(() => {
    const asked = at === "model" ? mayModel : at === "switch" ? can("brain") : at === "more";
    return at && asked ? ["glance", at] : [s.limitedNow ? "limit" : "glance"];
  });
  const screen: Screen = trail[trail.length - 1] ?? "glance";
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const go = (next: Screen) => {
    setDir("fwd");
    setTrail((tr) => [...tr, next]);
  };
  const back = () => {
    setDir("back");
    setTrail((tr) => (tr.length > 1 ? tr.slice(0, -1) : tr));
  };
  const home = () => {
    setDir("back");
    setTrail(["glance"]);
  };

  const [picked, setPicked] = useState<string>();
  const [aim, setAim] = useState<BrainRow>();
  const [teamToo, setTeamToo] = useState(true);
  const [adding, setAdding] = useState<{ row: BrainRow; again?: MachineAccount; also?: MachineAccount }>();
  const [arrived, setArrived] = useState<MachineAccount | null>(null);
  const [modelPick, setModelPick] = useState<string>();
  const [more, setMore] = useState<MoreDraft | null>(null);
  const [fold, setFold] = useState<"effort" | "speed" | "context" | null>(null);
  const [machinePick, setMachinePick] = useState<string>();
  const [copying, setCopying] = useState(false);
  const [withAutonomy, setWithAutonomy] = useState(true);
  const [switched, setSwitched] = useState<Switched | null>(null);
  const [busy, setBusy] = useState(false);
  const [footAt, setFootAt] = useState<HTMLElement | null>(null);

  // Opening it is looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);

  // A new screen takes the focus where it starts (never on the first opening, which the dialog's own focus has).
  const screenRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new screen takes the focus
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    screenRef.current?.focus({ preventScroll: true });
  }, [screen, trail.length]);
  const glide = useGlide<HTMLDivElement>(`${screen}:${trail.length}`);

  const failed = (e: unknown) => {
    toast.show(keyRefusal(t, e)?.text ?? t("agentPage.work.failed"), "error");
    refresh();
  };
  const mailNote = (name: string | undefined) => (
    <span className="ac-iconline">
      <Icon name="mail" />
      <span>{t("connectAi.chat.told", { name: name ?? "" })}</span>
    </span>
  );

  // ── switching ──
  const selectable = s.rows.filter((r) => !r.off);
  // The one with most room comes picked; what is in use or can't be picked never is.
  const selected = s.rows.find((r) => r.id === picked) ?? (picked === s.currentRow?.id ? s.currentRow : undefined);
  const switchSel = picked !== undefined ? selected : sortHave(selectable)[0];
  const limitSel = s.offers.find((r) => r.id === picked) ?? s.offers[0];

  /** This agent onto `row`, in the right order: its computer, then who thinks. */
  const saveRow = async (row: BrainRow): Promise<AgentBrain | null> => {
    if (row.kind === "key") {
      const result = view.brain !== "model" ? await api.agents.setBrain(org.id, agent.id, { brain: "model" }) : null;
      if (row.keyId !== undefined) {
        const key = row.keyId === DEFAULT_KEY ? null : row.keyId;
        if (key !== (saved.key ?? null)) {
          // A key kept earlier may have run out of credit: "now thinks with it" has to be true. Whoever may not try
          // keys gets no answer here, and the run says it if it fails.
          if (key)
            await api.agents.checkCredential(org.id, key).catch((e) => {
              if (keyRefusal(t, e)) throw e;
            });
          const cred = s.credentials.find((c) => c.id === key);
          // The agent's model where the key runs it, else Automático, which follows the key.
          const fits = !cred || keyRuns(cred, saved.model, s.models);
          await update.mutateAsync({ credentialId: key, ...(fits ? {} : { model: AUTO }) });
        }
      }
      return result;
    }
    if (row.moves) await setTarget.mutateAsync({ agentId: agent.id, machineId: row.moves.machineId });
    // Another plan has other models: it starts on its own default, and an agent on Automático stays automatic.
    const auto = view.brain === "model" ? isAuto(view.effort) : isAuto(view.effectiveModel);
    return api.agents.setBrain(org.id, agent.id, {
      brain: row.brain,
      ...(row.choice !== s.savedCard ? { model: auto ? AUTO : null } : {}),
      ...(row.kind === "account" && row.account
        ? { account: row.account.id, ...(row.act === "move" ? { moveAccount: true } : {}) }
        : row.kind === "own"
          ? { account: null }
          : {}),
    });
  };

  const switchTo = async (row: BrainRow, withTeam: boolean) => {
    const team = withTeam ? s.team : [];
    setBusy(true);
    try {
      const before: Before = {
        brain: view.brain,
        account: view.account,
        model: view.model,
        machineId: work.machineId,
        key: saved.key,
        apiModel: saved.model,
        onlyOwner: view.onlyOwner,
      };
      // What each of the others had, read before anything changes ("Desfazer" puts it back).
      const theirs = await Promise.all(
        team.map((a) =>
          api.agents.brain(org.id, a.id).then(
            (b) => ({ id: a.id, name: a.name, brain: b.brain, account: b.account, model: b.model }),
            () => null,
          ),
        ),
      );
      const result = await saveRow(row);
      const others: Switched["others"] = [];
      const missed: string[] = [];
      for (const [i, a] of team.entries()) {
        const was = theirs[i];
        // Each by the server's own rules: one it refuses keeps what it had, said by name.
        const ok =
          was &&
          (await api.agents
            .setBrain(org.id, a.id, {
              brain: row.brain,
              account: row.kind === "account" ? (row.account?.id ?? null) : null,
            })
            .then(
              () => true,
              () => false,
            ));
        if (ok && was) others.push(was);
        else missed.push(a.name);
      }
      refresh(team.map((a) => a.id));
      // Moved onto a plan it answers only its owner from now on (ADR 0059 §5): said, with that owner's name to anyone
      // else. Another account of the same plan changes nobody it answers.
      const owner =
        row.brain !== "model" && row.brain !== view.brain && result?.onlyOwner === true && !view.onlyOwner
          ? view.canUsePlans
            ? t("common.you")
            : ownerFirst
          : null;
      const movedTo = row.moves ? s.nameOf(row.moves.name) : null;
      const names = [agent.name, ...others.map((o) => o.name)];
      const line =
        names.length > 1
          ? t("connectAi.doneAll", { names: namesText(t, names, 2), label: row.title })
          : t(
              owner
                ? movedTo
                  ? "agentPage.work.saved.brainMovedOwner"
                  : "agentPage.work.saved.brainOwner"
                : movedTo
                  ? "agentPage.work.saved.brainMoved"
                  : "agentPage.work.saved.brain",
              { ...g, brain: row.title, computer: movedTo ?? "", owner: owner ?? "" },
            );
      setSwitched({ row, before, others, line, missed, onlyOwnerAfter: result?.onlyOwner ?? view.onlyOwner });
      setPicked(undefined);
      setDir("fwd");
      setTrail(["glance", "done"]);
      // Off the plan it still answers only its owner: one click lets back in whoever it answered before. "Só algumas
      // pessoas ou papéis" with nobody picked has no one to let back in: no action.
      if (row.kind === "key" && view.brain !== "model" && view.onlyOwner) {
        const people = (agent.audience?.userIds?.length ?? 0) + (agent.audience?.roleIds?.length ?? 0);
        toast.show(
          t("aiAccounts.share.backOnApi", g),
          "info",
          agent.audience?.mode === "people" && people === 0
            ? undefined
            : {
                label: people ? t("aiAccounts.share.letPeople", g) : t("aiAccounts.share.letEveryone", g),
                run: () =>
                  void api.agents.setBrain(org.id, agent.id, { onlyOwner: false }).then(
                    () => refresh(),
                    () => toast.show(t("agentPage.work.failed"), "error"),
                  ),
              },
        );
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  /** "Desfazer": each agent the switch changed back to what it had, this one's computer and key too. */
  const undo = async () => {
    if (!switched) return;
    const { row, before: b, others } = switched;
    setBusy(true);
    try {
      if (row.moves)
        await setTarget.mutateAsync({ agentId: agent.id, machineId: b.machineId === NO_COMPUTER ? null : b.machineId });
      // Only a key picked by name changed the key (and maybe the model): those go back.
      if (row.kind === "key" && row.keyId !== undefined)
        await update.mutateAsync({ credentialId: b.key ?? null, model: b.apiModel });
      const share = b.onlyOwner !== switched.onlyOwnerAfter ? { onlyOwner: b.onlyOwner } : {};
      // From one key to another the brain never changed: only the key and the model go back.
      if (b.brain !== "model" || row.brain !== "model")
        await api.agents.setBrain(
          org.id,
          agent.id,
          b.brain === "model"
            ? { brain: "model", ...share }
            : { brain: b.brain, account: b.account, model: b.model, ...share },
        );
      for (const o of others)
        await api.agents
          .setBrain(org.id, o.id, { brain: o.brain, account: o.account, model: o.model })
          .catch(() => undefined);
      refresh(others.map((o) => o.id));
      setSwitched(null);
      home();
      toast.show(t("agentPage.work.brain.v2.undone"));
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  /** A row picked to switch to: its sign-in first where it needs one, whom it is for where others share the account. */
  const confirm = (row: BrainRow) => {
    if (row.act === "also" || row.act === "again") {
      // A sign-in happens on the agent's computer: with none there is nothing to sign in on (its button is off).
      if (!row.account || !view.computer) return;
      setAdding(row.act === "also" ? { row, also: row.account } : { row, again: row.account });
      return go("add");
    }
    if (s.takesTeam(row)) {
      setAim(row);
      setTeamToo(true);
      return go("team");
    }
    void switchTo(row, false);
  };
  const connectOther =
    view.canUsePlans && connect && !s.hold
      ? () => {
          onClose();
          connect.open({ agentId: agent.id, chat: true });
        }
      : null;

  // ── the model ──
  const modelValue = modelPick ?? (s.kind === "model" ? saved.model : s.shownModel || AUTO);
  const modelSaved = s.kind === "model" ? saved.model : s.shownModel || AUTO;
  const cursorPlanSays = s.kind === "cursor" && s.planModels.some((m) => m.inPlan);
  const autoPick: PickOption = { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") };
  const modelOptions: PickOption[] =
    s.kind === "model"
      ? [
          autoPick,
          // The model it has stays a choice when its list is out of reach (OpenRouter's) or no longer has it.
          ...(isAuto(saved.model) || s.keyModels.some((o) => o.value === saved.model)
            ? []
            : [{ value: saved.model, label: saved.model }]),
          ...s.keyModels.map((o) => ({
            value: o.value,
            label: o.label,
            ...(typeof o.description === "string" ? { description: o.description } : {}),
            ...(o.group ? { group: o.group } : {}),
            ...(o.disabled ? { disabled: true } : {}),
            keywords: brainPickText(o),
          })),
        ]
      : [
          autoPick,
          ...(!s.shownModel || isAuto(s.shownModel) || s.planModels.some((m) => m.value === s.shownModel)
            ? []
            : [{ value: s.shownModel, label: s.shownModel }]),
          ...s.planModels.map((m) => {
            const line = brainModelLine(t, s.kind, s.plan, m, cursorPlanSays);
            return {
              value: m.value,
              label: m.label,
              ...(line ? { description: line } : {}),
              ...(m.needs ? { hint: t(`brain.modelNeeds.${m.needs}`) } : {}),
              ...(m.maker ? { group: providerLabel(m.maker) } : {}),
            };
          }),
        ];
  const modelChosen = modelOptions.find((o) => o.value === modelValue);
  const needs = s.planModels.find((m) => m.value === modelValue)?.needs;
  const saveModel = async () => {
    setBusy(true);
    try {
      if (s.kind === "model") await update.mutateAsync({ model: modelValue });
      else {
        // An automatic model picks the effort too; a fixed one takes the ramp's level.
        const next = isAuto(modelValue) ? AUTO : s.effort;
        const was = isAuto(view.effort) ? AUTO : s.effort;
        await api.agents.setBrain(org.id, agent.id, {
          brain: s.kind,
          model: modelValue === s.option?.defaultModel ? null : modelValue,
          ...(next !== was ? { effort: next } : {}),
        });
      }
      refresh();
      setModelPick(undefined);
      home();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  // ── how it thinks ──
  const moreNow: MoreDraft = {
    effort: s.effort,
    speed: s.speedOn ? view.speed : "standard",
    contextTokens: s.savedContext,
    onlyOwner: view.onlyOwner,
    fallback: view.fallback,
    extraUsage: view.extraUsage,
  };
  const m = more ?? moreNow;
  const openMore = () => {
    setMore(moreNow);
    setFold(null);
    go("more");
  };
  const saveMore = async () => {
    const input: AgentBrainInput = {};
    if (s.kind !== "model") {
      const was = isAuto(view.effort) ? AUTO : s.effort;
      if (!isAuto(s.modelNow) && m.effort !== was) input.effort = m.effort;
      if (s.speedOn && m.speed !== view.speed) input.speed = m.speed;
      if (m.fallback !== view.fallback) input.fallback = m.fallback;
      if (m.onlyOwner !== view.onlyOwner) input.onlyOwner = m.onlyOwner;
      if (m.extraUsage !== view.extraUsage) input.extraUsage = m.extraUsage;
    }
    if (m.contextTokens !== s.savedContext) input.contextTokens = m.contextTokens;
    if (Object.keys(input).length === 0) return home();
    // Letting more people in on someone else's plan asks first: it spends their plan.
    if (input.onlyOwner === false && !(await asks.ask(EVERYONE_AUDIENCE)([]))) return;
    setBusy(true);
    try {
      const result = await api.agents.setBrain(org.id, agent.id, { brain: s.kind, ...input });
      refresh();
      if (input.onlyOwner !== undefined)
        toast.show(
          !m.onlyOwner && result.onlyOwner
            ? t("aiAccounts.share.pickPeople", g)
            : !m.onlyOwner
              ? t("aiAccounts.share.savedEveryone", g)
              : view.canUsePlans
                ? t("aiAccounts.share.savedOwner", g)
                : t("aiAccounts.share.savedOwnerOf", { ...g, owner: ownerFirst ?? "" }),
          !m.onlyOwner && result.onlyOwner ? "info" : undefined,
        );
      setMore(null);
      home();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const machineValue = machinePick ?? work.machineId;
  const machineChosen = s.runsOn.find((x) => x.machineId === machineValue);
  const saveMachine = async () => {
    if (!machineChosen) return;
    setBusy(true);
    try {
      await setTarget.mutateAsync({ agentId: agent.id, machineId: machineChosen.machineId });
      refresh();
      toast.show(t("agentPage.work.saved.computer", { ...g, computer: s.nameOf(machineChosen.name) }));
      setMachinePick(undefined);
      home();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  // ── "Usar em outros agentes" (ADR 0094): what is saved, each agent taking it by its own rules ──
  const brainName = s.savedCard === "key" ? s.modelName : thinksWith(t, s.savedCard, s.modelName);
  const where = s.homeOf(s.savedCard);
  const carried = withAutonomy ? view.autonomy : undefined;
  const autonomy = carried ? { autonomy: carried } : {};
  const setup: AgentSetup | null =
    s.kind === "model"
      ? {
          brain: "model",
          model: saved.model,
          // Only admins see and change the key: anyone else's leaves each agent's own.
          // The workspace's default key is the picker's placeholder, not a key id: it goes as null.
          ...(can("key") ? { key: saved.key === DEFAULT_KEY ? null : (saved.key ?? null) } : {}),
          contextTokens: s.shownContext,
          ...autonomy,
        }
      : where
        ? {
            brain: s.kind,
            machineId: where.machineId,
            account: view.accountsSupported && view.computer ? view.account : null,
            model: view.effectiveModel === s.option?.defaultModel ? null : view.effectiveModel,
            effort: isAuto(view.effectiveModel) ? AUTO : s.effort,
            ...(s.speedOn ? { speed: view.speed } : {}),
            contextTokens: s.shownContext,
            fallback: view.fallback,
            onlyOwner: view.onlyOwner,
            ...autonomy,
          }
        : null;
  const setupText = [
    brainName,
    ...advancedParts(t, i18n.language, {
      kind: s.kind,
      autoModel: isAuto(s.modelNow),
      apiKey: s.apiKey,
      now: {
        effort: s.effort,
        speed: s.speedOn ? view.speed : "standard",
        contextTokens: s.shownContext,
        onlyOwner: view.onlyOwner,
        fallback: view.fallback,
      },
    }),
    ...(carried ? [autonomyWords(t, carried)] : []),
  ].join(" · ");
  // It thinks with nothing yet (a plan with no sign-in there): nothing to take elsewhere.
  const thinksWithNothing =
    s.kind !== "model" && s.currentRow?.kind === "plan" && view.accountsSupported && view.computer !== null;
  const copyOn = setup !== null && hasOthers && !thinksWithNothing;
  const copyTo = async (agentIds: string[], opens: { agent: string; owner: string }[]) => {
    if (!setup) return;
    // Letting more people talk to agents on other people's plans asks once, before anything saves.
    if (
      !(await asks.confirm(setupPlanQuestion(t, { kind: s.kind, provider: s.currentAccount?.provider ?? null }, opens)))
    )
      return;
    setBusy(true);
    try {
      const results = await api.agents.applySetup(org.id, { setup, agentIds });
      refresh(agentIds);
      // Nova missão starts from each agent's Autonomia.
      void qc.invalidateQueries({ queryKey: [...keys.missions(org.id), "eligible"] });
      const { done, autonomyOnly, missed } = setupOutcome(results, agentIds.length);
      if (done > 0) toast.show(t("agentPage.work.brain.copy.done", { count: done, setup: setupText }));
      if (autonomyOnly > 0) toast.show(t("agentPage.work.brain.copy.autonomyOnly", { count: autonomyOnly }));
      if (missed > 0) toast.show(t("agentPage.work.brain.copy.missed", { count: missed }), "error");
      setCopying(false);
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // ── what the screens say ──
  const toolOffHere =
    useIsThisMac(org.id, view.computer?.machineId ?? "") && view.options.some((o) => o.reason === "tool_off");
  const modelLimit = modelLimitText(t, i18n.language, s.usage, s.savedCard, s.shownModel);
  // Where its plan would think, when that says something the row in use doesn't (offline, no computer has it). With
  // no computer for it, why not and what to do (its panel's words) come before the bare "no computer has it".
  const savedSide =
    s.currentRow?.kind === "plan" || s.savedCard === "key"
      ? null
      : s.homeOf(s.savedCard)
        ? s.side(s.savedCard)
        : { icon: "block" as IconName, text: s.reason(s.savedCard) ?? s.side(s.savedCard)?.text ?? "" };
  const lendsAny = view.canUseOthersPlans === true && s.listed.some((a) => !a.mine && a.ownerId !== agent.ownerUserId);
  const pairer = work.machines.data?.find((x) => x.id === view.computer?.machineId)?.pairedBy?.name.split(" ")[0];
  // On someone else's computer only whoever connected it adds a sign-in: with nothing of the owner's there, it says so.
  const lockedHere =
    view.canUsePlans &&
    !view.canManageAccounts &&
    view.computer !== null &&
    !s.rows.some((r) => r.kind === "account" || r.kind === "own");
  const team = [agent, ...s.team];
  const scene =
    (screen === "team" && teamToo) || (screen === "done" && (switched?.others.length ?? 0) > 0)
      ? sceneTeam(team, agent)
      : [agent];
  // While the account in use is at its limit the agent sleeps under the night; another account brings the day.
  const asleep = s.limitedNow && screen !== "done";
  const day = useDawn(!asleep);
  const markOf: AiChoice | undefined =
    screen === "switch" || screen === "all"
      ? (switchSel?.choice ?? s.savedCard)
      : screen === "limit"
        ? (limitSel?.choice ?? s.savedCard)
        : screen === "team"
          ? (aim?.choice ?? s.savedCard)
          : screen === "done"
            ? (switched?.row.choice ?? s.savedCard)
            : s.savedCard;
  const addAcc = adding?.also ?? adding?.again;
  const title =
    screen === "switch"
      ? t("agentPage.work.brain.v2.switchTitle", g)
      : screen === "all"
        ? t("connectAi.chat.allTitle")
        : screen === "team"
          ? t("agentPage.work.brain.v2.teamTitle")
          : screen === "limit"
            ? t("agentPage.work.brain.v2.limitTitle", g)
            : screen === "model"
              ? t("agentPage.work.brain.v2.modelTitle", g)
              : screen === "more"
                ? t("agentPage.work.brain.v2.moreTitle", g)
                : screen === "computer"
                  ? t("agentPage.work.computer.title", g)
                  : screen === "add"
                    ? adding?.again
                      ? t(isPlanId(adding.row.choice) ? "aiAccounts.page.newKey" : "agentPage.work.brain.signInAgain")
                      : t(`agentPage.work.brain.add.title.${addAcc?.kind ?? "claude_code"}`)
                    : screen === "done"
                      ? t("agentPage.work.brain.v2.doneTitle")
                      : t("agentPage.work.brain.v2.title", g);

  const body = (): ReactNode => {
    if (screen === "glance")
      return (
        <>
          {s.hold && <PlanHold hold={s.hold} />}
          {s.hold && s.savedCard === "key" && can("brain") && (
            <SettingNote icon="clock">{t("connectAi.key.closed")}</SettingNote>
          )}
          <div className="bd-use">
            <p className="arrival-opts__label">{t("agentPage.work.brain.account")}</p>
            {s.currentRow && <HaveRow item={s.currentRow} checked still />}
            {s.usage && <PlanWindows usage={s.usage} />}
          </div>
          {arrived && (
            <SettingNote icon="check" live>
              {t("agentPage.work.brain.add.done", { account: arrived.label, computer: s.computerName })}
            </SettingNote>
          )}
          {s.kind !== "model" && !view.canUsePlans && ownerFirst && (
            <SettingNote icon="info">{t("agentPage.work.brain.accountWho", { ...g, owner: ownerFirst })}</SettingNote>
          )}
          {savedSide?.text && <SettingNote icon={savedSide.icon}>{savedSide.text}</SettingNote>}
          {modelLimit && (
            <SettingNote icon="alert" live>
              {modelLimit}
            </SettingNote>
          )}
          {s.savedCard === "gemini" && geminiPersonal(s.currentAccount) && (
            <SettingNote icon="alert">{t("connectAi.plan.gemini.warning")}</SettingNote>
          )}
          {toolOffHere && <ToolsOffHereNote />}
          <div className="bd-lines">
            <BrainLine
              label={t("agentPage.work.brain.planModel")}
              lead={
                isAuto(s.modelNow) ? (
                  <Icon name="bulb" size={16} />
                ) : s.modelMaker ? (
                  <ProviderLogo id={s.modelMaker} size="xs" />
                ) : undefined
              }
              value={s.modelName}
              onOpen={
                mayModel
                  ? () => {
                      setModelPick(undefined);
                      go("model");
                    }
                  : undefined
              }
            />
            <BrainLine label={t("agentPage.work.brain.v2.more")} value={s.moreLine} onOpen={openMore} />
          </div>
          {s.kind === "model" && !can("model") && <SettingNote icon="lock">{adminsOnly}</SettingNote>}
        </>
      );
    if (screen === "switch" || screen === "all")
      return (
        <>
          {s.hold && <PlanHold hold={s.hold} />}
          <HaveList
            items={s.rows}
            value={switchSel?.id}
            onChange={setPicked}
            all={screen === "all"}
            onAll={() => go("all")}
            disabled={busy}
            pinned={{ label: t("agentPage.work.brain.v2.inUse"), items: s.currentRow ? [s.currentRow] : [] }}
            label={title}
          />
          {lockedHere && (
            <SettingNote icon="lock">
              {t("connectAi.accountsLocked", { name: pairer ?? "", computer: s.computerName })}
            </SettingNote>
          )}
          {lendsAny && <SettingNote icon="info">{t("agentPage.work.brain.accountOthers")}</SettingNote>}
          {connectOther && screen === "switch" && (
            <button type="button" className="arrival-have__link arrival-have__link--other" onClick={connectOther}>
              <Icon name="plus" size={16} />
              <span>{t("connectAi.chat.other")}</span>
              <Icon name="chevronRight" size={16} />
            </button>
          )}
        </>
      );
    if (screen === "team") {
      // Whom it is for, as two cards with their faces: this agent alone, or every agent of theirs on the account.
      return (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
          <div className="arrival-for" role="group" aria-label={t("agentPage.work.brain.v2.teamAria")}>
            <OptionCard pressed={!teamToo} onClick={() => setTeamToo(false)}>
              <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
              <span className="ac-option__text">
                <span className="ac-option__title">{t("agentPage.work.brain.v2.justOne", g)}</span>
                {agent.role && <span className="ac-option__desc">{agent.role}</span>}
              </span>
            </OptionCard>
            <OptionCard pressed={teamToo} onClick={() => setTeamToo(true)}>
              <AvatarStack>
                {team.slice(0, 4).map((a) => (
                  <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="sm" />
                ))}
              </AvatarStack>
              <span className="ac-option__text">
                <span className="ac-option__title">{t("agentPage.work.brain.v2.everyone")}</span>
                <span className="ac-option__desc">
                  {namesText(
                    t,
                    team.map((a) => a.name),
                    2,
                  )}
                </span>
              </span>
            </OptionCard>
          </div>
          <div className="bd-use">
            <p className="arrival-opts__label">{t("agentPage.work.brain.v2.target")}</p>
            {aim && <HaveRow item={aim} checked still />}
          </div>
        </>
      );
    }
    if (screen === "limit") {
      const until = s.usage ? planState(s.usage).until : null;
      const account = s.currentRow?.title ?? "";
      return (
        <>
          <div className="bd-step">
            <p>
              {until
                ? t("agentPage.work.brain.v2.limitBack", { account, when: usageWhen(t, i18n.language, until) })
                : t("agentPage.work.brain.v2.limitSoon", { account })}
            </p>
            <span>{t("agentPage.work.brain.v2.limitHelp", g)}</span>
          </div>
          {s.offers.length > 0 && (
            <HaveList
              items={[]}
              pinned={{ label: t("connectAi.chat.best"), items: s.offers }}
              value={limitSel?.id}
              onChange={setPicked}
              disabled={busy}
              label={title}
            />
          )}
          {can("brain") && (
            <button
              type="button"
              className="arrival-have__link arrival-have__link--other"
              onClick={() => {
                setPicked(undefined);
                go("switch");
              }}
            >
              <Icon name="layers" size={16} />
              <span>{t("agentPage.work.brain.v2.switch")}</span>
              <Icon name="chevronRight" size={16} />
            </button>
          )}
          {connectOther && s.offers.length === 0 && (
            <button type="button" className="arrival-have__link" onClick={connectOther}>
              <Icon name="plus" size={16} />
              <span>{t("connectAi.chat.other")}</span>
              <Icon name="chevronRight" size={16} />
            </button>
          )}
        </>
      );
    }
    if (screen === "model")
      return (
        <>
          <PickList
            options={modelOptions}
            value={modelValue}
            onChange={setModelPick}
            label={title}
            {...(s.kind === "model" ? { searchLabel: t("models.search") } : {})}
          />
          {/* What a chosen model needs from its plan's account, with where to give it. */}
          {needs && s.plan && (
            <SettingNote icon="info" live>
              {t(`brain.modelHow.${needs}`)}
              <span style={{ display: "block", marginTop: 8 }}>
                <OpenPage href={s.plan.site}>
                  {t("aiAccounts.add.openKeys", { site: new URL(s.plan.site).host })}
                </OpenPage>
              </span>
            </SettingNote>
          )}
          {planFreeHint(t, s.plan) && <SettingNote icon="info">{planFreeHint(t, s.plan)}</SettingNote>}
        </>
      );
    if (screen === "more") {
      const autoModel = isAuto(s.modelNow);
      const shownContext =
        m.contextTokens !== null && s.contextOptions.includes(m.contextTokens) ? m.contextTokens : null;
      const line = (key: "effort" | "speed" | "context", label: string, value: string, content: ReactNode) => (
        <>
          <BrainLine
            label={label}
            value={value}
            folds
            open={fold === key}
            controls={`bd-fold-${key}`}
            onOpen={() => setFold(fold === key ? null : key)}
          />
          <Fold id={`bd-fold-${key}`} open={fold === key}>
            {content}
          </Fold>
        </>
      );
      return (
        <div className="bd-lines">
          {s.kind !== "model" &&
            line(
              "effort",
              t("agentPage.work.brain.effort"),
              autoModel ? t("brain.auto.label") : t(`agentPage.work.brain.efforts.${m.effort}`),
              autoModel ? (
                // "Automático" picks the effort too: said where the ramp would be.
                <p className="bd-fold__hint">{t("agentPage.work.brain.effortText.auto")}</p>
              ) : (
                <EffortPixels
                  label={t("agentPage.work.brain.effort")}
                  value={m.effort}
                  onValueChange={(e) => setMore({ ...m, effort: e })}
                  color={draft.look.color}
                  steps={EFFORTS.map((e) => ({ value: e, label: t(`agentPage.work.brain.efforts.${e}`) }))}
                  hint={(e) => t(`agentPage.work.brain.effortText.${e}`)}
                />
              ),
            )}
          {s.speedOn &&
            line(
              "speed",
              t("agentPage.work.brain.speed"),
              t(`agentPage.work.brain.speeds.${m.speed}`),
              <SpeedField value={m.speed} onChange={(v) => setMore({ ...m, speed: v })} />,
            )}
          {line(
            "context",
            t("agentPage.work.brain.context"),
            shownContext ? contextSize(shownContext) : t("brain.auto.label"),
            <ContextField
              value={m.contextTokens}
              options={s.contextOptions}
              onChange={(n) => setMore({ ...m, contextTokens: n })}
            />,
          )}
          {s.kind !== "model" && s.apiKey && (
            <SwitchLine
              label={t("agentPage.work.brain.v2.fallback")}
              hint={t("agentPage.work.brain.fallbackHint", g)}
              checked={m.fallback}
              onChange={(on) => setMore({ ...m, fallback: on })}
            />
          )}
          {s.kind !== "model" && agent.ownerUserId && (
            <div className="bd-row">
              <PlanReplies
                agent={agent.name}
                owner={view.canUsePlans ? undefined : (ownerFirst ?? undefined)}
                on={!m.onlyOwner}
                onChange={(on) => setMore({ ...m, onlyOwner: !on })}
                brain={s.kind}
                plan={signInPlan(view, s.agentRow, s.kind)}
                coding={s.plan}
              />
            </div>
          )}
          {s.kind !== "model" && s.usage && extraUsageOn(s.usage) && (
            <SwitchLine
              label={t("usageCard.extraTitle")}
              hint={t("usageCard.extraHint")}
              checked={m.extraUsage}
              // Paid extra usage bills the plan's owner: someone else's plan given to this agent is theirs to turn on.
              disabled={!(s.currentAccount ? s.currentAccount.mine : view.canUsePlans)}
              onChange={(on) => setMore({ ...m, extraUsage: on })}
            />
          )}
          {s.runsOn.length > 1 && can("machine") && (
            <BrainLine
              label={t("agentPage.work.brain.v2.computer")}
              value={s.computerName}
              onOpen={() => {
                setMachinePick(undefined);
                go("computer");
              }}
            />
          )}
          {copyOn && (
            <BrainLine
              label={t("agentPage.work.brain.copy.row")}
              value={t("agentPage.work.brain.copy.rowLine")}
              opensDialog
              onOpen={() => setCopying(true)}
            />
          )}
        </div>
      );
    }
    if (screen === "computer")
      return (
        <PickList
          options={s.runsOn.map((x) => ({
            value: x.machineId,
            label: s.nameOf(x.name),
            description: x.online ? t("agentPage.work.computer.online") : t("agentPage.work.computer.offline"),
          }))}
          value={machineValue}
          onChange={setMachinePick}
          label={title}
        />
      );
    if (screen === "add" && adding && addAcc && view.computer) {
      const coding = isPlanId(adding.row.choice) ? adding.row.choice : undefined;
      const provider = coding ?? signInProviderOf(addAcc.provider);
      const signedIn = (a: MachineAccount) => {
        setAdded((list) => [...list.filter((x) => x.id !== a.id), a]);
        // The account in use signed in again: nothing to switch, it thinks again.
        if (a.id === view.account) {
          setArrived(a);
          refresh();
          home();
          return;
        }
        void switchTo({ ...adding.row, id: `account:${a.id}`, account: a, act: "use", current: false }, false);
      };
      return (
        <div className="arrival-main__steps">
          <AddAccount
            key={addAcc.id}
            machineId={view.computer.machineId}
            kind={addAcc.kind}
            computer={s.computerName}
            again={adding.again?.id}
            fresh
            {...(provider ? { provider } : {})}
            email={addAcc.email}
            local={view.ownSignIn}
            onAdded={signedIn}
            onUse={signedIn}
            onSigningIn={setSigningIn}
            actionsAt={footAt}
          />
        </div>
      );
    }
    if (screen === "done" && switched)
      return (
        <div className="bd-step">
          <p>{switched.line}</p>
          <span>{t("agentPage.work.brain.v2.doneSub")}</span>
          {switched.missed.length > 0 && (
            <SettingNote icon="alert" live>
              {t("agentPage.work.brain.v2.missed", {
                count: switched.missed.length,
                names: namesText(t, switched.missed, 2),
              })}
            </SettingNote>
          )}
        </div>
      );
    return null;
  };

  /** The footer, always the same: a quiet note at its start, the second action, the main one at its end. */
  const footer = (o: { note?: ReactNode; second?: ReactNode; main?: ReactNode }) => (
    <DialogFooter
      key={screen}
      className={cx("bd-foot", o.note && o.second && o.main ? "bd-foot--two" : null)}
      {...(o.note ? { note: o.note } : {})}
    >
      {o.second}
      {o.main}
    </DialogFooter>
  );
  const cancel = (
    <Button variant="ghost" disabled={busy} onClick={back}>
      {t("common.cancel")}
    </Button>
  );
  const finish = (
    <Button variant="primary" onClick={onClose}>
      {t("agentPage.work.brain.v2.finish")}
    </Button>
  );
  const foot = (): ReactNode => {
    if (screen === "add") return <div className="ac-dialog__foot arrival-chat__acts" ref={setFootAt} />;
    if (screen === "glance") {
      const signIn =
        s.signInAgain && s.currentRow && s.currentAccount && view.computer
          ? { row: s.currentRow, again: s.currentAccount }
          : null;
      return footer({
        note: (
          <span className="ac-iconline">
            <Icon name="info" />
            <span>{t("agentPage.work.brain.v2.only", g)}</span>
          </span>
        ),
        second: can("brain") && (
          <Button
            onClick={() => {
              setPicked(undefined);
              setArrived(null);
              go("switch");
            }}
          >
            {t("agentPage.work.brain.v2.switch")}
          </Button>
        ),
        main: signIn ? (
          <Button
            variant="primary"
            onClick={() => {
              setAdding(signIn);
              go("add");
            }}
          >
            {t(isPlanId(s.savedCard) ? "aiAccounts.page.newKey" : "agentPage.work.brain.signInAgain")}
          </Button>
        ) : (
          finish
        ),
      });
    }
    if (screen === "switch" || screen === "all") {
      const row = switchSel;
      return footer({
        note: row?.lends ? mailNote(row.ownerName) : undefined,
        second: cancel,
        main: (
          <Button
            variant="primary"
            disabled={!row || row.current || row.off || (row.signIn === true && !view.computer) || busy}
            loading={busy}
            onClick={() => row && confirm(row)}
          >
            {!row
              ? // Nothing to switch to (the one in use alone): the screen's own words, never "Switch to" and nothing.
                t("agentPage.work.brain.v2.switch")
              : row.act === "again"
                ? t(isPlanId(row.choice) ? "aiAccounts.page.newKey" : "agentPage.work.brain.signInAgain")
                : row.act === "also"
                  ? t("connectAi.signInFor", g)
                  : t("agentPage.work.brain.v2.switchTo", { label: row.title })}
          </Button>
        ),
      });
    }
    if (screen === "team")
      return footer({
        note: aim?.lends ? mailNote(aim.ownerName) : undefined,
        second: cancel,
        main: (
          <Button
            variant="primary"
            disabled={!aim || busy}
            loading={busy}
            onClick={() => aim && void switchTo(aim, teamToo)}
          >
            {teamToo
              ? t("agentPage.work.brain.v2.switchMany", { count: team.length })
              : t("agentPage.work.brain.v2.switchTo", { label: aim?.title ?? "" })}
          </Button>
        ),
      });
    if (screen === "limit")
      return footer({
        note: limitSel?.lends ? mailNote(limitSel.ownerName) : undefined,
        second: <Button onClick={onClose}>{t("agentPage.work.brain.v2.wait")}</Button>,
        main: limitSel && can("brain") && (
          <Button variant="primary" disabled={busy} loading={busy} onClick={() => confirm(limitSel)}>
            {t("connectAi.use", { label: limitSel.title })}
          </Button>
        ),
      });
    if (screen === "model")
      return footer({
        second: cancel,
        main: (
          <Button
            variant="primary"
            disabled={modelValue === modelSaved || busy}
            loading={busy}
            onClick={() => void saveModel()}
          >
            {t("connectAi.use", { label: modelChosen?.label ?? modelValue })}
          </Button>
        ),
      });
    if (screen === "more") {
      const now: Advanced = {
        effort: m.effort,
        speed: m.speed,
        contextTokens: m.contextTokens,
        onlyOwner: m.onlyOwner,
        fallback: m.fallback,
      };
      return footer({
        second: (
          <Button
            disabled={isAdvancedDefault(s.kind, now) || busy}
            onClick={() => setMore({ ...m, ...advancedDefaults(s.kind, now) })}
          >
            {t("agentPage.work.brain.advanced.defaults")}
          </Button>
        ),
        main: (
          <Button variant="primary" disabled={busy} loading={busy} onClick={() => void saveMore()}>
            {t("agentPage.work.brain.v2.finish")}
          </Button>
        ),
      });
    }
    if (screen === "computer")
      return footer({
        second: cancel,
        main: (
          <Button
            variant="primary"
            disabled={!machineChosen || machineValue === work.machineId || busy}
            loading={busy}
            onClick={() => void saveMachine()}
          >
            {t("agentPage.work.computer.useMachine", { computer: machineChosen ? s.nameOf(machineChosen.name) : "" })}
          </Button>
        ),
      });
    if (screen === "done")
      return footer({
        second: (
          <Button disabled={busy} loading={busy} onClick={() => void undo()}>
            {t("agentPage.work.brain.v2.undo")}
          </Button>
        ),
        main: finish,
      });
    return null;
  };

  const hasBack = trail.length > 1 && screen !== "done";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="arrival arrival-chat bd"
    >
      <div className="arrival-hero">
        <TeamScene
          agents={scene}
          lead={agent.id}
          asleep={asleep}
          day={day}
          expression={screen === "done" ? "happy" : undefined}
        >
          {markOf && (
            <>
              <span
                // A switch done lights the trail anew, one pixel after the other.
                key={screen === "done" ? "lit" : "still"}
                className="team-scene__trail"
                data-state={busy ? "walk" : asleep ? undefined : "done"}
                data-lit={screen === "done" || undefined}
              >
                {[0, 1, 2, 3, 4].map((n) => (
                  <i key={n} style={{ "--n": n } as CSSProperties} />
                ))}
              </span>
              {/* Another account's mark comes in where the last one stood. */}
              <span key={markOf} className="team-scene__mark">
                {markOf === "key" ? <Icon name="key" /> : <ProviderLogo id={planMark(markOf)} size="tile" />}
              </span>
            </>
          )}
        </TeamScene>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="bd-glide" ref={glide}>
        {/* The screen takes the focus as it comes: named by its title, so a screen reader says where it is (the drawn
            title is hidden from it, and a dialog's own name isn't read again on a move inside). */}
        {/* biome-ignore lint/a11y/useSemanticElements: a screen of the dialog, not a group of form fields */}
        <div
          key={`${screen}:${trail.length}`}
          ref={screenRef}
          className="bd-screen"
          data-dir={dir}
          tabIndex={-1}
          role="group"
          aria-label={title}
        >
          {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
          <div className="arrival-lede arrival-lede--row">
            {hasBack && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="chevronLeft"
                aria-label={t("common.back")}
                disabled={busy}
                onClick={back}
              />
            )}
            <p className="arrival-lede__title" aria-hidden="true">
              {title}
            </p>
          </div>
          <DialogBody>{body()}</DialogBody>
        </div>
        {foot()}
      </div>
      {copying && setup && (
        <SetupCopyDialog
          setup={setup}
          setupText={setupText}
          autonomy={view.autonomy}
          withAutonomy={withAutonomy}
          onWithAutonomy={setWithAutonomy}
          busy={busy}
          onClose={() => setCopying(false)}
          onUse={(agentIds, opens) => void copyTo(agentIds, opens)}
        />
      )}
      {asks.dialog}
    </Dialog>
  );
}
