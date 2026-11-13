import {
  keys,
  type Memory,
  useAgentAccess,
  useAgentBrain,
  useAgentDetail,
  useAgentForYou,
  useAiStatus,
  useApi,
  useApprovalRules,
  useMemory,
  useMemoryAboutMe,
  useMemoryAction,
  useModelLabel,
  useModels,
  useRemoveApprovalRule,
  useUsage,
} from "@agenteschat/client";
import { approvalRuleServer, approvalRuleWords, approvalTitle } from "@agenteschat/client/lib/approval-words";
import { listsAgent, seesDetails } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { effortLevel } from "@agenteschat/client/lib/brain-advanced";
import { modelUnpriced } from "@agenteschat/client/lib/endpoints";
import { formatPercent, lowerFirst, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentPlan, aiStateOf, planLabel, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { planMeterText, usageShown } from "@agenteschat/client/lib/plan-usage";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { apiModelName, autoMakerOf, isAuto } from "@agenteschat/client/lib/providers";
import { isRightHand, tellsNameStory } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { planLine } from "@agenteschat/ui/plan-state";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  AgentAvatar,
  Button,
  EmptyState,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  IconButton,
  type IconName,
  Locked,
  PixelOrbit,
  ProviderLogo,
  Segmented,
  Sky,
  SwipeRow,
  Text,
  useReducedMotion,
  useToast,
  WithPresence,
} from "@/ui";
import { CoverParallax, useCoverScroll, useScrollFade } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { LetMeTalkButton } from "../chat/ReachLines";
import { AgentComputerButton, AgentComputerPicture } from "../computer/AgentComputerRow";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { chatHref } from "../links/logic";
import { UsageQueueSheet } from "../queue/UsageQueueSheet";
import { openRightHandSettings, RightHandMine } from "../right-hand/SettingsScreen";
import { useConnectedById } from "../settings/hooks";
import { agentBadgeInset } from "../shared/Face";
import { useColors, useDirectory, useErrorToast, useMeId, useNow, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { PushedHeader } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { WaitingCard } from "../shared/WaitingCard";
import { useAgentProfileStatus, usePresenceOf } from "../status/hooks";
import { StatusCard } from "../status/StatusCard";
import { openAgentUsage } from "../usage/UsageScreen";
import { openAgentEdit } from "./AgentEditScreen";
import { useAgentMailboxes } from "./AgentMailSection";
import {
  agoOf,
  byPlaybook,
  canEditMemories,
  type DidLine,
  didLines,
  knownAboutMe,
  modelRow,
  plainRole,
  spendOf,
  statusCardShown,
  usesOf,
} from "./logic";
import { MergeReposSection } from "./MergeReposSection";
import { MonthPixels } from "./MonthPixels";
import { openAgentMore } from "./more-link";
import { AgentSetupCard } from "./setup/SetupCard";
import { useMemoryOriginText } from "./useMemoryOriginText";
import { agoShort, workTitle, workWhere } from "./work";

/** Rows of "O que fez por você" before "Ver tudo". */
const DID_SHOWN = 4;

/** Built-in areas in "Can use": their tile. */
const AREA_ICON: Record<string, IconName> = {
  context: "brain",
  drive: "drive",
  issues: "issue",
  calendar: "clock",
  wiki: "doc",
  skills: "sparkle",
  schedule: "clock",
  sandbox: "laptop",
  browser: "globe",
  setup: "pen",
  desktop: "laptop",
};

/** The profile's views: what it is on and did for you, what it can reach, what it knows. */
type ProfileTab = "today" | "access" | "memory";

/**
 * An agent's profile as a teammate: its sky and living body (its presence on the badge), its name and one plain line
 * of what it does, Chat (and its computer beside it), then three views on the grouped gray. Today: what waits on you,
 * what it is on now, what it did for you and its month in one row. Access: what it thinks with, what it can use (apps,
 * areas and mailboxes in one list), what it runs without asking and who answers for it. Memory: what it knows about
 * you and how it works (tap to correct or forget, for its owner and admins). Someone it doesn't answer sees only what
 * it is on now.
 */
export function AgentProfileScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const agent = useDirectory().anyAgent(id);
  // No longer in the team (archived or deleted): its messages name it, it has no profile.
  if (agent?.former) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title={agent.name} solid={false} />
        <EmptyState icon="agent" title={t("profile.former")} />
      </View>
    );
  }
  return (
    <SheetHostProvider>
      <Profile id={id} />
    </SheetHostProvider>
  );
}

function Profile({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const failed = useErrorToast();
  const sheet = useSheet();
  const when = useWhen();
  const meId = useMeId();
  const org = useOrg().org;
  const insets = useSafeAreaInsets();
  const now = useNow();
  // The cover's sky lags behind the scroll and stretches on pull; the agent fades as it nears the bar.
  const { y, onScroll } = useCoverScroll();
  const underBar = AVATAR_TOP - (insets.top + BAR_HEIGHT);
  const avatarFade = useScrollFade(y, underBar - 30, underBar + 70);
  const agent = dir.agentById.get(id);
  const models = useModels();
  // Someone it doesn't answer (not its owner, not an admin) sees only its public card: no tools, memory or month.
  const details = seesDetails(agent);
  // The team's right hand (ADR 0137): what it is and how it works, its model, Configurar for who manages agents.
  const rightHand = isRightHand(agent);
  // A personal workspace's agent (ADR 0159 §3): its rules, repositories and the rest in Advanced.
  const personal = isPersonal(org);
  // Which view shows: the one last chosen, on every profile (a person who reads memories keeps reading memories).
  const [tab, setTabState] = useState<ProfileTab>(() => profileTabOf(readValueSync(STORED.agentProfileTab)));
  const setTab = (next: ProfileTab) => {
    setTabState(next);
    void writeValue(STORED.agentProfileTab, next === "today" ? null : next);
  };
  // A hello when its profile opens (a rare, small moment): it smiles once, unless it is at work.
  const hello = useHello();
  const reduced = useReducedMotion();
  const modelLabel = useModelLabel();
  const detail = useAgentDetail(orgId, id);
  const access = useAgentAccess(orgId, id, details);
  const usage = useUsage(orgId);
  const forYou = useAgentForYou(orgId, id);
  const knows = useMemoryAboutMe(orgId, id);
  const mailboxes = useAgentMailboxes(id, details && !rightHand);
  const work = useWorkingNow().filter((w) => w.agentId === id);
  const asking = useWaitingApprovals().filter((a) => a.agentId === id);
  // On a billing hold an AI comes after the plan: no row to connect one.
  const held = usePlanHold(orgId, org) !== null;
  const aiStatus = useAiStatus(orgId);
  const noAi = !held && aiStateOf(aiStatus.data, id) === "no_ai";
  const waitingNow = asking[0];
  const [allDid, setAllDid] = useState(false);
  const look = agentLook(agent);
  const name = agent?.name ?? detail.data?.name ?? "";
  const g = genderOf(name);
  const ownerId = agent?.ownerUserId ?? null;
  const owner = ownerId ? dir.memberById.get(ownerId)?.name : undefined;
  const mine = Boolean(meId && ownerId === meId);
  const roleName = (agent?.role || detail.data?.role || "").trim();
  const plain = plainRole(agent?.instructions || detail.data?.instructions);
  const busy = work.length > 0;
  const editable = canEditMemories(agent, { id: meId, org });
  // Its presence (ADR 0084): the badge, and the card with what it does where nothing else here says it.
  const status = useAgentProfileStatus(id, name);
  const statusLine = usePresenceOf().agent(id)?.status?.status ?? null;
  const decides = mine || can(org, "manage_agents");
  // The request in the card above leaves the list, so it is said once.
  const did = didLines(forYou.data?.items).filter(
    (l) => !(waitingNow && l.href?.kind === "approval" && l.href.id === waitingNow.id),
  );
  const memories = knownAboutMe(knows.data);
  const learned = byPlaybook(memories);
  const uses = usesOf(access.data);
  const connected = useConnectedById();
  // A computer brain: its maker's mark and the model by the plan that pays for it ("Sonnet pelo plano do Claude"; its
  // computer only where it tells two apart).
  const thinks =
    agent?.brain && agent.brain.kind !== "model" ? brainLine(t, agent.brain, "", { agents: dir.agents }) : null;
  // As the web's cell: the plan as the row's name ("Pensa com" › "Claude"), the model under it, and its effort for who
  // sees it (its owner and admins) where the model is fixed (Automático picks the effort too).
  const effortView = useAgentBrain(orgId, id, decides && thinks !== null).data;
  const brainKind = agent?.brain?.kind;
  const thinksPlan =
    brainKind && brainKind !== "model"
      ? planLabel(t, planOfAccount({ kind: brainKind, provider: agent?.brain?.provider ?? null }))
      : null;
  const thinksModel = isAuto(agent?.brain?.model) ? t("brain.auto.label") : (agent?.brain?.model ?? null);
  const thinksEffort =
    effortView && effortView.brain !== "model" && !isAuto(effortView.effectiveModel)
      ? t("agentPage.work.cell.effort", {
          level: t(`agentPage.work.brain.effortsLower.${effortLevel(effortView.effort)}`),
        })
      : null;
  const thinksSpeed = agent?.brain?.speed ? t("agentPage.work.brain.speeds.fast") : null;
  const thinksUnder = [thinksModel, thinksEffort, thinksSpeed].filter(Boolean).join(" · ");
  const spend = detail.data
    ? spendOf({
        budgetUsedPercent: detail.data.budgetUsedPercent,
        monthlyBudgetUsd: detail.data.monthlyBudgetUsd ?? null,
        ...(detail.data.defaultBudgetUsd !== undefined ? { defaultBudgetUsd: detail.data.defaultBudgetUsd } : {}),
        usage: usage.data?.find((u) => u.agentId === id) ?? null,
      })
    : null;
  // On a plan, its limits first and the budget only once it spent through the API (ADR 0063 §5).
  const shown = usageShown(agent?.brain, detail.data?.budgetUsedPercent ?? 0);
  const money = (v: number) =>
    new Intl.NumberFormat(i18n.language || "en", { style: "currency", currency: "USD" }).format(v);
  const originText = useMemoryOriginText();
  // Forgetting is the list's swipe (as the system's lists delete), confirmed by a system alert that says what stays.
  const memoryAct = useMemoryAction(orgId, id);
  const forgetAsk = (m: Memory) =>
    Alert.alert(
      t("mobile.intentAgents.knows.forgetTitle"),
      t("mobile.intentAgents.knows.forgetBody", agentGrammar(name)),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("mobile.intentAgents.knows.forget"),
          style: "destructive",
          onPress: () =>
            memoryAct.mutate(
              { type: "archive", id: m.id, archived: true },
              {
                onSuccess: () => toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId: id }),
                onError: failed,
              },
            ),
        },
      ],
    );

  const openDm = (to: { agentId: string } | { userId: string } = { agentId: id }) =>
    api.dms
      .open(orgId, to)
      .then(({ channelId }) => {
        void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
        router.push(chatHref(channelId));
      })
      .catch(failed);

  const open = (href: DidLine["href"]) => {
    if (!href) return;
    if (href.kind === "issue") router.push(`/issues/${href.number}`);
    else if (href.kind === "chat") router.push(chatHref(href.channelId, href.threadId));
    else if (href.kind === "file") router.push({ pathname: "/file/[id]", params: { id: href.id } });
    else router.push(`/approval/${href.id}`);
  };

  const memoryRow = (m: Memory) => {
    const row = (
      <GroupedRow
        icon="brain"
        label={m.summary ?? memoryLine(t, m)}
        labelLines={2}
        sub={originText(m)}
        // The same screen Memória opens for it (one place to read, fix or forget a memory).
        chevron
        onPress={() => router.push(`/memory/${m.id}`)}
      />
    );
    if (!editable) return <Fragment key={m.id}>{row}</Fragment>;
    return (
      <SwipeRow
        key={m.id}
        right={{
          label: t("mobile.intentAgents.knows.forget"),
          icon: "trash",
          color: c.danger,
          ink: c.bg,
          onAction: () => forgetAsk(m),
        }}
      >
        {/* The swipe's pane shows under the row, so the row is opaque, in the list's own white. */}
        <View style={{ backgroundColor: c.raised }}>{row}</View>
      </SwipeRow>
    );
  };

  const ownerLine = rightHand
    ? null
    : mine
      ? t("mobile.intentAgents.ownerYou")
      : owner
        ? t("mobile.intentAgents.owner", { name: owner })
        : null;
  // The right hand's one role name, as its row in Conversas and its conversation's header say it.
  const roleLine = rightHand
    ? t("rightHand.labelCapitalized")
    : [roleName || null, plain ? (roleName ? lowerFirst(plain, i18n.language) : plain) : null]
        .filter(Boolean)
        .join(" · ");
  const shownDid = allDid ? did : did.slice(0, DID_SHOWN);
  // One fact under each line: when. What it was is in the line itself and in its tile.
  const didSub = (l: DidLine) => when.short(l.at);
  const didHead = t("mobile.intentAgents.did.title", agentGrammar(name));

  // "This month" in one row (ADR 0063 §5): the plan it thinks with, or its model, and how much of it is used; the
  // budget once it spent through the API. The usage page has the rest.
  const meter = planMeterText(t, i18n.language);
  const planNow = shown.plan ? planLine(shown.plan.usage, meter, now) : null;
  // The budget's share as the web says it ("<1%" for a little spent); money only where the API gives it (ADR 0026).
  const budgetText = () => {
    if (!spend || !shown.budget) return null;
    if (spend.kind === "money")
      return t("settings.usageAgentLine", { spent: money(spend.spentUsd), budget: money(spend.budgetUsd) });
    return `${formatPercent(i18n.language, spend.percent)} ${t("mobile.agent.ofMonthBudget")}`;
  };
  const budgetLine = budgetText();
  // On Automático, the maker of the key it runs on ("Claude"), as the right hand's panel names its key.
  const apiModel = !agent?.model
    ? null
    : apiModelName(t, agent.model, modelLabel(agent.model) ?? undefined, autoMakerOf(aiStatus.data, id));
  const monthLabel =
    shown.plan?.account ?? thinksPlan ?? thinks?.text ?? apiModel ?? t("usageViews.agent.title", agentGrammar(name));
  // A plan's maker, or the maker Automático's models come from through the API.
  const monthMark = thinks?.mark ?? agent?.brain?.maker;
  // A short value fits on the right ("week 40%", "$3.20 of $50.00"); a sentence goes under the name.
  const monthValue = planNow?.top
    ? `${meter.short(planNow.top)} ${planNow.top.used}%`
    : !shown.plan && spend?.kind === "money"
      ? budgetLine
      : null;
  const budgetUnder = budgetLine !== null && monthValue !== budgetLine;
  const monthSub = [
    planNow?.alert ?? null,
    budgetUnder ? budgetLine : null,
    !budgetUnder && budgetLine && spend && spend.fraction >= 1 ? t(`mobile.agent.exhausted${g}`, { name }) : null,
    // A model with no price can't count against the budget: said where the budget is.
    budgetLine && agent && modelUnpriced(models.data?.models, agent.model) ? t("endpoint.budgetUnpriced") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // What it is on now, each thing said once: the request waiting on you as its card (it leaves "What it did for
  // you"), its status card only where no job row or request says it, then the jobs themselves.
  const left = waitingNow ? timeLeft(t, waitingNow.expiresAt, new Date(now)) : null;
  const review = () => {
    if (waitingNow) router.push(`/approval/${waitingNow.id}`);
  };
  const showsStatus =
    Boolean(status?.card) && statusCardShown(statusLine, { working: busy, asking: asking.length > 0 });
  const nowBlock = (
    <>
      {noAi ? (
        <View style={styles.block}>
          <GroupedList>
            <GroupedRow
              icon="bolt"
              label={t("noAi.agent", agentGrammar(agent?.name ?? ""))}
              labelLines={3}
              chevron
              onPress={() => openConnectAi({ agentId: id, plan: agentPlan(agent) ?? undefined })}
            />
          </GroupedList>
        </View>
      ) : null}
      {waitingNow ? (
        <View style={styles.block}>
          <WaitingCard
            agentId={id}
            // Its name is right above the card: the kind line says what it asks, not who.
            kind={{ icon: "shield", label: t("mobile.intentAgents.asksApproval") }}
            title={approvalTitle(t, waitingNow)}
            expires={left ? { createdAt: waitingNow.createdAt, expiresAt: waitingNow.expiresAt } : null}
            action={{ label: t("mobile.chats.wait.review"), onPress: review }}
            onPress={review}
            accessibilityLabel={[t("ask.kind.approval"), approvalTitle(t, waitingNow)].join(", ")}
          />
        </View>
      ) : null}
      {showsStatus && status?.card ? (
        <View style={styles.block}>
          <StatusCard
            emoji={status.card.emoji}
            icon={status.card.icon}
            text={status.card.text}
            note={status.card.note}
          />
        </View>
      ) : null}
      {status?.waiting ? (
        <View style={styles.block}>
          <Button
            variant="secondary"
            size="sm"
            icon="wait"
            label={t("queue.see")}
            onPress={() => sheet.open(<UsageQueueSheet agentId={id} />)}
          />
        </View>
      ) : null}
      {work.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.home.workingNow")}</GroupedHeader>
          <GroupedList>
            {work.map((w) => (
              <GroupedRow
                key={w.key}
                leading={
                  <View style={styles.orbit}>
                    <PixelOrbit color={look.color} size={14} />
                  </View>
                }
                label={workTitle(t, w)}
                sub={[w.what ? workWhere(t, w) : null, agoShort(t, agoOf(w.since, now))].filter(Boolean).join(" · ")}
                chevron
                onPress={() =>
                  w.missionId ? router.push(`/mission/${w.missionId}`) : router.push(chatHref(w.channelId, w.threadId))
                }
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );

  const todayView = (
    <>
      {nowBlock}
      <AgentComputerPicture agentId={id} />
      {/* What it thinks with and how much of it is used this month, one row (ADR 0063 §5): the plan or key as its
          name, the usage under it. The usage page has the rest. */}
      <GroupedHeader>{t("mobile.intentAgents.thinks")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          {...(monthMark ? { leading: <ProviderLogo id={monthMark} size="sm" /> } : { icon: "key" as const })}
          label={monthLabel}
          {...(monthValue ? { value: monthValue } : {})}
          {...(monthSub ? { sub: monthSub, subLines: 2 } : {})}
          chevron
          onPress={() => openAgentUsage(id)}
        />
      </GroupedList>
      {forYou.data || forYou.isError ? (
        <>
          <GroupedHeader>{didHead}</GroupedHeader>
          {/* Its month, day by day, in its own tones (the web's Activity tab), on the gray above the list. */}
          {detail.data && detail.data.runsThisMonth > 0 ? (
            <View style={styles.pixels}>
              <MonthPixels
                perDay={detail.data.runsByDay}
                color={look.color}
                label={t("agentPage.activity.chartLabel", {
                  count: detail.data.runsThisMonth,
                  month: new Intl.DateTimeFormat(when.locale, { month: "long", timeZone: "UTC" }).format(new Date()),
                })}
              />
            </View>
          ) : null}
          <GroupedList>
            {shownDid.map((l) => (
              <GroupedRow
                key={l.key}
                icon={l.icon}
                label={t(`mobile.intentAgents.did.${l.title.key}`, l.title.values)}
                sub={didSub(l)}
                {...(l.href ? { chevron: true, onPress: () => open(l.href) } : {})}
              />
            ))}
            {did.length > DID_SHOWN ? (
              // The rest of the month folds under one row that says how many there are.
              <GroupedRow
                key="all"
                label={allDid ? t("mobile.intentAgents.did.seeLess") : t("mobile.intentAgents.did.seeAll")}
                {...(allDid ? {} : { value: String(did.length) })}
                chevron={!allDid}
                onPress={() => setAllDid((v) => !v)}
              />
            ) : null}
          </GroupedList>
          {did.length === 0 ? <GroupedFooter>{t(`mobile.intentAgents.did.empty${g}`, { name })}</GroupedFooter> : null}
        </>
      ) : null}
    </>
  );

  // The approval rule under what it can use: in one sentence, naming whoever decides for it.
  const asksNote = () => {
    if (decides) return t("mobile.intentAgents.uses.asksYou");
    return owner ? t("mobile.intentAgents.uses.asksOwner", { name: owner }) : t("mobile.intentAgents.uses.asksAdmins");
  };
  const usesNote =
    uses.lines.length === 0 && mailboxes.length === 0
      ? t("mobile.intentAgents.uses.empty")
      : uses.asks
        ? asksNote()
        : null;
  const accessView = (
    <>
      {thinks ? (
        <>
          <GroupedHeader>{t("mobile.intentAgents.thinks")}</GroupedHeader>
          <GroupedList>
            {/* Its owner and admins open its AI: the account, the plan's usage, who it replies to. */}
            <GroupedRow
              leading={thinks.mark ? <ProviderLogo id={thinks.mark} size="sm" /> : undefined}
              label={thinksPlan ?? thinks.text}
              {...(thinksUnder ? { sub: thinksUnder, subLines: 2 } : {})}
              {...(decides ? { chevron: true, onPress: () => openAgentAi(id) } : {})}
            />
          </GroupedList>
        </>
      ) : null}
      {access.data || mailboxes.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.agent.canUse")}</GroupedHeader>
          <GroupedList>
            {uses.lines.map((u) =>
              "area" in u.label ? (
                <GroupedRow
                  key={u.key}
                  icon={AREA_ICON[u.label.area] ?? "doc"}
                  label={t(`mobile.intentAgents.uses.area.${u.label.area}`, { defaultValue: u.label.area })}
                  value={t(`mobile.intentAgents.uses.level.${u.level}`)}
                />
              ) : (
                <GroupedRow
                  key={u.key}
                  leading={
                    <ConnectorIcon
                      def={(u.connectionId ? connected.get(u.connectionId)?.def : null) ?? null}
                      image={u.connectionId ? connected.get(u.connectionId)?.image : null}
                      label={u.label.text}
                      size={30}
                    />
                  }
                  label={u.label.text}
                  value={t(`mobile.intentAgents.uses.level.${u.level}`)}
                />
              ),
            )}
            {/* Its mailboxes beside its apps (ADR 0038): a tap on one's own changes the level. */}
            {mailboxes.map((m) =>
              m.remove ? (
                <ButtonRow
                  key={`mail:${m.id}`}
                  icon="mail"
                  label={m.address}
                  sub={m.sub}
                  value={m.level}
                  below={
                    <View style={styles.remove}>
                      <Button
                        variant="secondary"
                        size="sm"
                        label={m.remove.label}
                        disabled={m.remove.busy}
                        onPress={m.remove.onPress}
                      />
                    </View>
                  }
                />
              ) : (
                <GroupedRow
                  key={`mail:${m.id}`}
                  icon="mail"
                  label={m.address}
                  {...(m.sub ? { sub: m.sub, subLines: 2 } : {})}
                  value={m.level}
                  {...(m.onPress ? { onPress: m.onPress } : {})}
                />
              ),
            )}
            {decides ? (
              // A new service for this agent starts in Conectores (who uses it is chosen there).
              <GroupedRow
                key="connect"
                icon="plus"
                label={t("mobile.connectors.fromAgent")}
                chevron
                onPress={() => router.push("/connectors")}
              />
            ) : null}
          </GroupedList>
          {usesNote ? <GroupedFooter>{usesNote}</GroupedFooter> : null}
        </>
      ) : null}
      {personal ? (
        // A personal workspace keeps its rules, repositories and the rest in Advanced (ADR 0159 §3).
        rightHand ? null : (
          <View style={styles.apart}>
            <GroupedList>
              <GroupedRow icon="more" label={t("agentPage.tabs.advanced")} chevron onPress={() => openAgentMore(id)} />
            </GroupedList>
          </View>
        )
      ) : (
        <>
          <AlwaysApproved agentId={id} name={name} mayRemove={mine || can(org, "approve_actions")} />
          <MergeReposSection agentId={id} name={name} mayEdit={mine || can(org, "manage_agents")} />
          {ownerLine ? (
            <View style={styles.apart}>
              <GroupedList>
                <GroupedRow icon="person" label={ownerLine} />
              </GroupedList>
            </View>
          ) : null}
        </>
      )}
    </>
  );

  // Who may correct what it knows, said once under the memories (a tap corrects, a swipe forgets).
  const editFoot = editable
    ? t("mobile.intentAgents.knows.footSwipe")
    : owner
      ? t("mobile.intentAgents.knows.footOwner", { name: owner })
      : t("mobile.intentAgents.knows.footAdmins");
  const memoryKnows = (
    <>
      <GroupedHeader>{t("mobile.intentAgents.knows.title", agentGrammar(name))}</GroupedHeader>
      <GroupedList>{learned.people.map(memoryRow)}</GroupedList>
      <GroupedFooter>
        {learned.people.length > 0 ? editFoot : t(`mobile.intentAgents.knows.empty${g}`, { name })}
      </GroupedFooter>
      {learned.playbook.length > 0 ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("agentPage.memory.playbook", agentGrammar(name)) }),
              text: t("agentPage.memory.playbookNote"),
            }}
          >
            {t("agentPage.memory.playbook", agentGrammar(name))}
          </GroupedHeader>
          <GroupedList>{learned.playbook.map(memoryRow)}</GroupedList>
          {learned.people.length === 0 ? <GroupedFooter>{editFoot}</GroupedFooter> : null}
        </>
      ) : null}
    </>
  );
  const memoryView = (
    <>
      {knows.data ? memoryKnows : null}
      {/* What people told it to always do, under what it learned, as the web's Memória. */}
      <GivenRules agentId={id} name={name} />
    </>
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        // The browser card's own text field: its buttons and the page take a tap with the keyboard up.
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      >
        <View style={styles.cover}>
          <CoverParallax y={y} style={StyleSheet.absoluteFill}>
            <Sky color={look.color} depth={1} style={StyleSheet.absoluteFill} />
          </CoverParallax>
          {/* Its presence is the badge; a screen reader hears it in words, with why. */}
          <Animated.View style={avatarFade} {...(status ? { accessible: true, accessibilityLabel: status.line } : {})}>
            <WithPresence size={FACE} presence={status?.presence} inset={agentBadgeInset(look, FACE)}>
              <AgentAvatar
                agent={look}
                size={FACE}
                mode={busy ? "run" : "idle"}
                {...(hello && !busy ? { expression: "happy" as const } : {})}
              />
            </WithPresence>
          </Animated.View>
        </View>
        <View style={styles.prof}>
          <Text variant="display2" style={styles.center}>
            {name}
          </Text>
          {roleLine ? (
            <Text variant="small" tone="muted" numberOfLines={2} style={styles.center}>
              {roleLine}
            </Text>
          ) : null}
          {tellsNameStory(agent) ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {t("rightHand.profile.nameStory")}
            </Text>
          ) : null}
          <View style={styles.acts}>
            <View style={styles.grow}>
              {details || !ownerId ? (
                <Button
                  variant="primary"
                  wide
                  label={t("mobile.agent.talk")}
                  disabled={!listsAgent(org, agent)}
                  onPress={() => void openDm()}
                />
              ) : (
                <Button
                  variant="primary"
                  wide
                  label={t("profile.askAccess")}
                  onPress={() => void openDm({ userId: ownerId })}
                />
              )}
            </View>
            {details && !rightHand ? (
              <View style={styles.grow}>
                <AgentComputerButton agentId={id} />
              </View>
            ) : null}
          </View>
          {agent?.canTalk === false ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {details ? t("mobile.agent.cantTalk") : t("profile.detailsHidden", agentGrammar(name))}
            </Text>
          ) : null}
          {agent ? <LetMeTalkButton agent={agent} /> : null}
        </View>

        {/* A new agent's checklist (ADR 0155 §2), while something is left. */}
        {agent && !rightHand ? (
          <View style={styles.setup}>
            <AgentSetupCard agent={agent} place="profile" />
          </View>
        ) : null}

        {rightHand && agent ? (
          <View style={styles.page}>
            {nowBlock}
            <GroupedHeader>{t("rightHand.settings.mine")}</GroupedHeader>
            <RightHandMine agent={agent} />
            <GroupedHeader>{t("rightHand.profile.how")}</GroupedHeader>
            <GroupedList>
              <GroupedRow icon="shield" label={t("rightHand.profile.permissions")} labelLines={2} />
              <GroupedRow icon="lock" label={t("rightHand.profile.private")} labelLines={2} />
              <GroupedRow icon="hash" label={t("rightHand.profile.channels")} labelLines={2} />
              <GroupedRow
                {...(agent.brain?.maker
                  ? { leading: <ProviderLogo id={agent.brain.maker} size="sm" /> }
                  : { icon: "brain" as const })}
                label={t("rightHand.profile.model")}
                {...modelRow(
                  t,
                  agent.brain,
                  apiModelName(t, agent.model, modelLabel(agent.model) ?? undefined, autoMakerOf(aiStatus.data, id)),
                )}
              />
            </GroupedList>
          </View>
        ) : details ? (
          <>
            <View style={styles.tabs}>
              <Segmented
                items={[
                  { key: "today", label: t("common.today") },
                  { key: "access", label: t("agentPage.fields.levels") },
                  { key: "memory", label: t("agentPage.tabs.memory") },
                ]}
                value={tab}
                onChange={(k) => setTab(k as ProfileTab)}
                wide
              />
            </View>
            {/* A view picked fades in; the one the profile opens on just shows. */}
            <LayoutAnimationConfig skipEntering>
              <Animated.View key={tab} entering={reduced ? undefined : TAB_IN} style={styles.page}>
                {tab === "today" ? todayView : tab === "access" ? accessView : memoryView}
              </Animated.View>
            </LayoutAnimationConfig>
          </>
        ) : (
          <View style={styles.page}>{nowBlock}</View>
        )}
      </Animated.ScrollView>
      <View style={styles.bar} pointerEvents="box-none">
        {/* Its person changes its look; admins, everything ("Editar", as the web's Configurações). The right hand's
            settings open for everyone: each person has their own there. */}
        <PushedHeader
          plate
          solid={false}
          {...(rightHand
            ? { action: { label: t("rightHand.profile.configure"), onPress: openRightHandSettings } }
            : decides && agent
              ? { action: { label: t("agent.edit"), onPress: () => openAgentEdit(id) } }
              : {})}
        />
      </View>
    </View>
  );
}

/**
 * "Aprovado sempre", as on the web's Ferramentas e acesso: what the agent runs without asking, approved for good
 * from a request, by whom and when. Its owner and whoever decides approvals take one back with its ×, at once.
 * Shown only when there is something.
 */
export function AlwaysApproved({ agentId, name, mayRemove }: { agentId: string; name: string; mayRemove: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useErrorToast();
  const when = useWhen();
  const dir = useDirectory();
  const connected = useConnectedById();
  const rules = useApprovalRules(orgId, agentId);
  const remove = useRemoveApprovalRule(orgId, agentId);
  const list = rules.data ?? [];
  if (list.length === 0) return null;
  return (
    <>
      <GroupedHeader>{t("agentPage.access.always.title")}</GroupedHeader>
      <GroupedList>
        {list.map((rule) => {
          const what = approvalRuleWords(t, rule);
          const who = rule.createdByUserId ? dir.memberById.get(rule.createdByUserId)?.name : undefined;
          const at = when.short(rule.createdAt);
          return (
            <ButtonRow
              key={rule.id}
              leading={
                <ConnectorIcon
                  def={(rule.connectionId && connected.get(rule.connectionId)?.def) || null}
                  image={rule.connectionId ? connected.get(rule.connectionId)?.image : null}
                  label={approvalRuleServer(t, rule)}
                  size={30}
                />
              }
              label={what}
              labelLines={2}
              sub={
                who
                  ? t("agentPage.access.always.by", { name: who, when: at })
                  : t("agentPage.access.always.byNobody", { when: at })
              }
              trailing={
                mayRemove ? (
                  <IconButton
                    icon="x"
                    label={t("agentPage.access.always.remove", { what })}
                    disabled={remove.isPending}
                    onPress={() =>
                      remove.mutate(rule.id, {
                        onSuccess: () => toast({ title: t("agentPage.access.always.removed", { name }), agentId }),
                        onError: failed,
                      })
                    }
                  />
                ) : undefined
              }
            />
          );
        })}
      </GroupedList>
      <GroupedFooter>{t("agentPage.access.always.help")}</GroupedFooter>
    </>
  );
}

/**
 * A row of a grouped list that holds its own button (a rule's ×, a mailbox's Remove access), drawn as `GroupedRow`
 * draws its rows. A plain view, not a pressable one: a pressable row would fold the button into itself for
 * VoiceOver. `GroupedList` reads `icon` and `leading` for where its hairline starts.
 */
function ButtonRow({
  icon,
  leading,
  label,
  labelLines = 1,
  sub,
  value,
  trailing,
  below,
}: {
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  labelLines?: number;
  sub?: string | null;
  value?: string;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={styles.row}>
      {icon ? (
        <View style={styles.lead}>
          <View style={[styles.tile, { backgroundColor: c.sunken }]}>
            <Icon name={icon} size={16} color={c.ink2} />
          </View>
        </View>
      ) : null}
      {leading ? <View style={styles.lead}>{leading}</View> : null}
      <View style={styles.grow}>
        <View accessible accessibilityLabel={[label, sub].filter(Boolean).join(", ")}>
          <Text variant="body" numberOfLines={labelLines}>
            {label}
          </Text>
          {sub ? (
            <Text variant="footnote" tone="faint" numberOfLines={2}>
              {sub}
            </Text>
          ) : null}
        </View>
        {below}
      </View>
      {value ? (
        <Text variant="callout" tone="faint" numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {trailing}
    </View>
  );
}

/**
 * "Regras que as pessoas deram", as on the web's Memória: what people told it to always do, by whom and when. Its
 * giver, the agent's owner and admins take one back with a swipe, confirmed by a system alert (never a bare × that
 * deletes on the tap). Shown only when there is something.
 */
function GivenRules({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useErrorToast();
  const when = useWhen();
  const memory = useMemory(orgId, agentId);
  const remove = useMemoryAction(orgId, agentId);
  const list = (memory.data ?? []).filter((m) => m.kind === "rule" && !m.archived);
  if (list.length === 0) return null;
  const ask = (m: Memory) =>
    Alert.alert(t("mobile.intentAgents.knows.ruleTitle"), t("mobile.intentAgents.knows.ruleBody", agentGrammar(name)), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.intentAgents.knows.ruleRemove"),
        style: "destructive",
        onPress: () =>
          remove.mutate(
            { type: "archive", id: m.id, archived: true },
            {
              onSuccess: () => toast({ title: t("agentPage.memory.ruleRemoved"), agentId }),
              onError: failed,
            },
          ),
      },
    ]);
  return (
    <>
      <GroupedHeader>{t("agentPage.memory.rules")}</GroupedHeader>
      <GroupedList>
        {list.map((m) => {
          const row = (
            <GroupedRow
              icon="flag"
              label={m.text}
              labelLines={3}
              sub={t("agentPage.memory.ruleBy", {
                name: m.origin?.name ?? t("memory.origin.someone"),
                date: when.short(m.origin?.at ?? m.updatedAt),
              })}
            />
          );
          if (!m.removable) return <Fragment key={m.id}>{row}</Fragment>;
          return (
            <SwipeRow
              key={m.id}
              right={{
                label: t("mobile.intentAgents.knows.ruleRemove"),
                icon: "trash",
                color: c.danger,
                ink: c.bg,
                onAction: () => ask(m),
              }}
            >
              <View style={{ backgroundColor: c.raised }}>{row}</View>
            </SwipeRow>
          );
        })}
      </GroupedList>
      <GroupedFooter>{t("agentPage.memory.rulesNote")}</GroupedFooter>
    </>
  );
}

/** "Corrigir uma memória": edit the text (the old one stays in the history) or forget it (archived). */
export function MemoryFix({
  memory: m,
  agentId,
  agentName,
  g,
  source,
  onSee,
  onDone,
  title,
}: {
  memory: Memory;
  agentId: string;
  agentName: string;
  g: string;
  source: string;
  onSee: (() => void) | undefined;
  onDone: () => void;
  /** In place of "Corrigir a memória de…" (the team's memory, ADR 0167). */
  title?: string;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const toast = useToast();
  const action = useMemoryAction(orgId, agentId);
  const [text, setText] = useState(m.text);
  const changed = text.trim() !== "" && text.trim() !== m.text.trim();
  const failed = useErrorToast();
  const save = () =>
    action.mutate(
      { type: "edit", id: m.id, text: text.trim() },
      {
        onSuccess: () => {
          toast({ title: t("mobile.intentAgents.fix.saved"), agentId });
          onDone();
        },
        onError: failed,
      },
    );
  const forget = () =>
    action.mutate(
      { type: "archive", id: m.id, archived: true },
      {
        onSuccess: () => {
          toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId });
          onDone();
        },
        onError: failed,
      },
    );
  return (
    <>
      <SheetTitle title={title ?? t(`mobile.intentAgents.fix.title${g}`, { name: agentName })} />
      <Locked when={action.isPending}>
        <TextArea value={text} onChangeText={setText} autoFocus maxLength={8000} />
      </Locked>
      <View style={styles.src}>
        <Icon name="chat" size={15} color={c.muted} />
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.grow}>
          {source}
        </Text>
        {onSee ? (
          <Pressable
            onPress={onSee}
            accessibilityRole="link"
            hitSlop={12}
            style={({ pressed }) => (pressed ? styles.pressed : null)}
          >
            <Text variant="small" tone="ink2" style={styles.bold}>
              {t("mobile.intentAgents.fix.see")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Button
        variant="primary"
        wide
        icon="check"
        label={t("mobile.intentAgents.fix.save")}
        disabled={!changed || action.isPending}
        onPress={save}
      />
      <Button
        variant="ghost"
        wide
        label={t("mobile.intentAgents.fix.forget")}
        disabled={action.isPending}
        onPress={forget}
      />
    </>
  );
}

const TAB_IN = FadeIn.duration(160);

/** A saved tab, or Hoje. */
const profileTabOf = (v: string | null): ProfileTab => (v === "access" || v === "memory" ? v : "today");

/** How long the face holds its smile when the profile opens. */
const HELLO_MS = 900;

/** True for a moment after the profile opens: the face's hello. */
function useHello() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const off = setTimeout(() => setOn(false), HELLO_MS);
    return () => clearTimeout(off);
  }, []);
  return on;
}

/** Height of the sky cover, the bar's area included. */
const COVER_HEIGHT = 250;
/** The agent's face, unframed, and the room under it at the cover's foot. */
const FACE = 96;
const COVER_FOOT = 14;
/** Where the agent's top sits in the cover, and the bar's height. */
const AVATAR_TOP = COVER_HEIGHT - COVER_FOOT - FACE;
const BAR_HEIGHT = 44;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { position: "absolute", top: 0, left: 0, right: 0 },
  // Not clipped: on a pull the sky grows up into the gap above the content.
  cover: { height: COVER_HEIGHT, alignItems: "center", justifyContent: "flex-end", paddingBottom: COVER_FOOT },
  // Face, name 28, what it does 15: 8 apart; the buttons 16 under them.
  prof: { paddingHorizontal: 24, gap: 8 },
  center: { textAlign: "center" },
  // Chat and Computador side by side, the same width (one primary); 16 under the words (8 of `prof` and 8 here).
  acts: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  setup: { paddingHorizontal: 16, marginTop: 22 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  // `Segmented` sizes to its labels: a row centers it under the centered head, 16 under the buttons.
  tabs: { paddingHorizontal: 16, paddingTop: 16 },
  page: { paddingHorizontal: 16 },
  block: { marginTop: 16 },
  // The orbit centered in the row's 36 leading column, where a tile would sit.
  orbit: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  pixels: { marginBottom: 12 },
  apart: { marginTop: 24 },
  remove: { marginTop: 6, alignSelf: "flex-start" },
  // As `GroupedRow`'s own row, tile and value.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  // One leading column for a tile or a mark, as `GroupedRow`'s (36, a framed face's width): the text starts at 62 in
  // every row, these included.
  lead: { width: 36, alignItems: "center", justifyContent: "center" },
  tile: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  value: { flexShrink: 1, maxWidth: "50%" },
  src: { flexDirection: "row", alignItems: "center", gap: 6 },
});
