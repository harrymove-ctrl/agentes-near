import type { Agent } from "@agenteschat/client";
import {
  ApiError,
  keys,
  type Me,
  meQuery,
  type OrgSummary,
  useAiStatus,
  useAuthConfig,
  type WorkspaceMode,
} from "@agenteschat/client";
import { billingHoldOf } from "@agenteschat/client/lib/billing";
import { accountOutOfReach } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { settingUp } from "@agenteschat/client/lib/guards";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { type AiChoice, planLabel, teamThinks } from "@agenteschat/client/lib/no-ai";
import {
  landingOf,
  type OnboardingStepId,
  type RailStep,
  railState,
  stepIndex,
} from "@agenteschat/client/lib/onboarding";
import { finishOnboarding, isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { browserTimezone, timezoneName } from "@agenteschat/client/lib/routines";
import { aboutOf, type BusinessType } from "@agenteschat/client/lib/team-plan";
import type { WorkAreaAnswer } from "@agenteschat/client/lib/work-area";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  AgentSticker,
  Avatar,
  Button,
  Chip,
  Field,
  Icon,
  Input,
  Locked,
  Logo,
  Menu,
  MenuItem,
  setGaze,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { DeleteAccountDialog } from "@/components/DeleteAccount";
import { DeleteWorkspaceDialog } from "@/components/DeleteWorkspace";
import { ErrorState } from "@/components/Loading";
import { COMPACT_QUERY, DESKTOP_QUERY, useMediaQuery } from "@/components/NavDrawer";
import { OrgProvider } from "@/components/org-context";
import { ImageCropDialog, OrgMark } from "@/components/ProfilePhoto";
import { BootSplash, OnboardingHorizon, OnboardingProgress } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import { ZonePicker } from "@/components/ZoneSelect";
import { ARRIVAL_BETA_ONLY, ARRIVAL_PARAM } from "@/lib/arrival";
import { sendNewLink } from "@/lib/email-confirmation";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { usePaidReturn } from "@/lib/paid-return";
import { usePlanOffer } from "@/lib/plan-offer";
import { returnPlace } from "@/lib/return-to";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { AiHost, AiStage, AiStep } from "./onboarding/AiStep";
import { AreaStep } from "./onboarding/AreaStep";
import { OnboardingPreview, type PreviewAgent } from "./onboarding/OnboardingPreview";
import { PeopleStep } from "./onboarding/PeopleStep";
import { PurposeCards } from "./onboarding/PurposeCards";
import { BusinessStep, PlanStep, TeamStep, useTemplate } from "./onboarding/steps";
import { TeamSource, useTeamSource } from "./onboarding/TeamSource";
import { TeamStart } from "./onboarding/TeamStart";
import "./onboarding.css";

/** Back from paying, `/me` is asked again this often until the hold lifts (as the hold's banner does). */
const PAID_POLL_MS = 5000;
/** On the step that connects an AI, its status is read this often: a connection made in another tab moves it on. */
const AI_POLL_MS = 10_000;
/**
 * Once a team is here, the agents are read this often: an AI app creating them through MCP may still be at it after
 * the first one moves the rail on, and this page has no socket to say so.
 */
const TEAM_POLL_MS = 5000;

/**
 * The onboarding (ADR 0162): the blue rail with Lodi on its horizon, one step at a time, read from the workspace's own
 * data so a workspace left at any step resumes there. First what the workspace is for (ADR 0159). A company or team
 * goes on with its name (which creates it), what it does, its team (agents brought from another app, a template made
 * in one click, or none for now: its right hand alone), the plan where the workspace waits for its first one, an AI
 * for the team to think with, and the people who work there, invited last (ADR 0162, amended 2026-11-11). A
 * personal workspace has no name to ask nor a business: its agents (brought, or none for now), the plan, the AI. On
 * wide screens its sidebar fills in beside the question, and the team on its stage beside the AI step. A team's opens
 * in #general, a personal one or one whose plan was left for later in its right hand's DM, on its arrival (ADR 0160):
 * the beta notice alone once the rail offered an AI, or when the plan was left (the card there leads with the plan).
 */
export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const phone = useMediaQuery(COMPACT_QUERY);
  const wide = useMediaQuery(DESKTOP_QUERY);

  // What it is for (ADR 0159), asked before the workspace exists; a company or team then goes on to its name.
  const [purpose, setPurpose] = useState<WorkspaceMode | null>(null);
  const [forTeam, setForTeam] = useState(false);
  const personal = purpose === "personal";
  const [org, setOrg] = useState("");
  // The zone the person picked here, if they did.
  const [zone, setZone] = useState<string | null>(null);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [logo, setLogo] = useState<{ imageBase64: string; contentType: string } | null>(null);
  const [logoDirty, setLogoDirty] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  // Made here; else the one this person is setting up (another tab, a visit cut short), which resumes.
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  // A done step the person went back to, else the step the data says.
  const [picked, setPicked] = useState<RailStep | null>(null);
  // What step 2 picked in this visit: step 3 starts on its template.
  const [business, setBusiness] = useState<BusinessType | null>(null);
  // The AI step was on screen in this visit: once the team thinks, its done screen stays until "Go to the workspace"
  // (a team's: until Continuar, the people step next).
  const [aiSeen, setAiSeen] = useState(false);
  // A team went on from the AI step to inviting people (Continuar on its done screen, or "Connect later").
  const [aiLeft, setAiLeft] = useState(false);
  // What the AI step's dialog connected last in this visit, said on the done screen and the rail ("Claude"), with
  // whether the workspace had a key then.
  const [aiPick, setAiPick] = useState<{ choice: AiChoice; key: boolean } | null>(null);
  const [polling, setPolling] = useState(false);
  // "Apagar este workspace" (`?delete=1`, which the phone's onboarding opens) and "Apagar conta", kept in the address.
  const [deleting, setDeleting] = useOpenParam("delete");
  const [account, setAccount] = useOpenParam("account");
  const lodiRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const me = useQuery({ ...meQuery(api), refetchOnWindowFocus: "always" });
  const config = useAuthConfig();
  const authConfig = config.data;
  const unfinished = me.data?.organizations.find(settingUp);
  // Finished and on its way into the workspace, the data no longer says a step (`onboarding` is gone): the workspace
  // and its last step stay until it opens.
  const leaving = useRef(false);
  const lastTarget = useRef<{ orgId: string; generalChannelId: string } | null>(null);
  const target =
    created ??
    (unfinished?.onboarding
      ? { orgId: unfinished.id, generalChannelId: unfinished.onboarding.generalChannelId }
      : leaving.current
        ? lastTarget.current
        : null);
  lastTarget.current = target;
  const orgId = target?.orgId ?? null;
  const mine = me.data?.organizations.find((o) => o.id === orgId);
  // Asked again whenever the tab comes back, as `me` is: a step answered meanwhile in another tab or on the phone moves
  // this one on, so its button never makes a second team.
  const settings = useQuery({
    queryKey: keys.settings(orgId ?? ""),
    queryFn: () => api.orgs.settings(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const agents = useQuery({
    queryKey: keys.agents(orgId ?? ""),
    queryFn: () => api.agents.list(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
    refetchInterval: (q) => (q.state.data?.some((a) => !isRightHand(a)) ? TEAM_POLL_MS : false),
  });
  const lodi = agents.data?.find(isRightHand);
  // In the order they were made (the server's), a template's team in its template's order: as every screen lists it.
  const team = (agents.data ?? []).filter((a) => !isRightHand(a));
  const context = settings.data?.context?.trim() ?? "";
  // The furthest step the server keeps for it: "import" once a team's "I don't use any yet" was answered, "agents" once
  // the team step was left with no agents, "computer" once its plan step showed, "ai" once a team left its AI step for
  // later, "team" once its people were invited (ADR 0162).
  const passed = mine?.onboarding?.step;
  // The AI step was shown, in this visit or an earlier one that left it for later: the workspace opens without asking
  // for an AI again.
  const aiLaterSaved = passed !== undefined && stepIndex(passed) >= stepIndex("ai");
  const held = billingHoldOf(mine?.standing) === "payment";
  // Back from paying, until the billing service lifts the hold: `/me` again meanwhile, as the hold's banner does.
  const paid = usePaidReturn(orgId ?? "", held);
  useQuery({ ...meQuery(api), enabled: paid, refetchInterval: PAID_POLL_MS });
  // Made here as "For me", one being set up that is, or "For me" picked and not made yet: the rail shows the personal
  // path from the first question on (ADR 0159).
  const personalNow = isPersonal(mine) || (personal && (created !== null || orgId === null));

  // Whether the right hand and its team think, the last step's answer: read on a hold too, so the step after the plan
  // opens as soon as it lifts.
  const ids = lodi ? [lodi.id, ...team.map((a) => a.id)] : [];
  const status = useAiStatus(orgId ?? "", orgId !== null && lodi !== undefined, polling ? AI_POLL_MS : false);
  // Read again when the agents change (a team made or brought, here or in another tab): a read from before them says
  // nothing of them.
  const idsKey = ids.join(",");
  const readFor = useRef(idsKey);
  useEffect(() => {
    if (readFor.current === idsKey) return;
    const before = readFor.current;
    readFor.current = idsKey;
    if (before !== "" && orgId) void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
  }, [idsKey, orgId, qc]);
  // An old read being asked again is waited for, as one that doesn't list every agent yet is (`teamThinks`). One read
  // after the list that still leaves an agent out (archived meanwhile) answers for those it lists: nothing waits on it.
  const listed =
    status.data && status.dataUpdatedAt >= agents.dataUpdatedAt
      ? ids.filter((id) => status.data?.agents.some((a) => a.agentId === id))
      : null;
  const thinks =
    status.isStale && status.isFetching
      ? undefined
      : (teamThinks(ids, status.data) ?? (listed ? teamThinks(listed, status.data) : undefined));
  const railAt = (pick: RailStep | null) =>
    railState({
      orgId,
      standing: mine?.standing,
      billingUrl: authConfig?.billingUrl,
      context,
      team: team.length,
      picked: pick,
      personal: personalNow,
      funnel: { thinks, passed },
    });
  const reachedRail = railAt(picked);
  // The person's own area, asked once per account (no step of its own on the rail): right before the team step, on the
  // step before it, a team's "What you do" or a personal workspace's purpose. Stored as an area or `skipped`, so a
  // reload before either asks again and one after never does.
  const [areaDone, setAreaDone] = useState(false);
  const areaAsked = (me.data?.user.workArea ?? null) !== null || areaDone;
  const asksArea = !areaAsked && orgId !== null && picked === null && reachedRail.at === "team" && team.length === 0;
  // Connected on its step in this visit, a team's AI step stays on screen (what was connected, the Connect dialog still
  // over it) until its Continuar: the people step never takes its place under the person (ADR 0162, amended 2026-11-11).
  const keepAi =
    picked === null &&
    aiSeen &&
    !aiLeft &&
    reachedRail.thinks &&
    reachedRail.at !== "ai" &&
    reachedRail.steps.includes("people");
  const rail = asksArea ? railAt(personalNow ? "name" : "business") : keepAi ? railAt("ai") : reachedRail;
  // The server's billing too: a plan step passed on the way to the people step is listed only where there is billing.
  const loaded =
    orgId === null ||
    (settings.data !== undefined &&
      agents.data !== undefined &&
      mine !== undefined &&
      (authConfig !== undefined || config.isError));
  // Everything else answered, the AI decides between its step and opening: while that read is on its way, the step on
  // screen stays (a template's button pending), never a splash between it and the next one.
  const deciding =
    lodi !== undefined && thinks === undefined && !status.isError && (rail.at === "ai" || rail.at === "open");
  const lastRail = useRef<typeof rail | null>(null);
  // How many agents the team had on that step: a team that arrives while the AI is read (made from a template, brought
  // from another app) keeps the screen that made it, its button pending, rather than its list for a moment.
  const lastTeam = useRef(0);
  const frozen = deciding || leaving.current ? lastRail.current : null;
  const { steps, at, reached, step, index, thinks: thinksNow } = frozen ?? rail;
  // A team's rail ends on inviting people (ADR 0162, amended 2026-11-11).
  const hasPeople = steps.includes("people");
  useEffect(() => {
    if (!loaded || deciding || leaving.current) return;
    lastRail.current = rail;
    lastTeam.current = team.length;
  });
  useEffect(() => setPolling(step === "ai"), [step]);
  // Before the workspace exists, what it is for comes first.
  const asking = orgId === null && !forTeam;
  // On that question the chosen answer's agents look at the pointer (`PurposeScene`, its `data-gaze`).
  useEffect(() => {
    if (!asking) return;
    const look = (e: PointerEvent) => setGaze({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", look);
    return () => {
      window.removeEventListener("pointermove", look);
      setGaze(null);
    };
  }, [asking]);
  // Read from the first step, so the plan step has it when it opens.
  const plans = usePlanOffer(i18n.language);
  const offer = plans.offer;
  // Read once is enough: a refetch that fails later keeps the step on screen with what it read. The plan step opens
  // whole, back from the billing page too: with its price, or with none once the list is late, never a line that changes.
  // A first visit that only the AI's answer can place (its step or opening) waits for it, as for the workspace's data.
  const known = loaded && !(deciding && frozen === null) && !(step === "plan" && plans.loading);
  const name = (mine?.name ?? org).trim();
  // Back on step 1, the workspace's own zone (saved on another visit, maybe another device), never this browser's.
  const zoneNow = zone ?? settings.data?.timezone ?? browserTimezone() ?? "UTC";
  const kind = business ?? aboutOf(t, context).business;
  // A personal workspace never gets a template in the rail (ADR 0159): its card makes its agents later.
  const template = useTemplate(orgId, kind, step === "business" || (step === "team" && !personalNow));

  // The AI step shown from a read that lists every agent: from then on, the team thinking shows its done screen.
  useEffect(() => {
    if (known && at === "ai" && !deciding) setAiSeen(true);
  }, [known, at, deciding]);
  // On the AI step with every agent thinking: its done screen (a team's, gone back to, too: Continuar leads on).
  const aiDone = step === "ai" && thinksNow && (aiSeen || hasPeople);
  // The rail ends on the AI step and it is done: every step answered, none current.
  const allDone = aiDone && !hasPeople;
  // What the dialog connected is named only where the status doesn't say otherwise (a key connected some other way
  // after it): a key needs the workspace's key, a plan no key that came after it.
  const keyNow = status.data?.apiKey === true;
  const aiNamed = aiPick && (aiPick.choice === "key" ? keyNow : !keyNow || aiPick.key) ? aiPick.choice : null;
  // The team step's question and the agents it brings from another app (ADR 0055): at the page, so they outlive the
  // step's own views and the rail's moves; an import applying, or its report up, pins the team step.
  const holdTeam = useCallback((hold: boolean) => setPicked(hold ? "team" : null), []);
  const source = useTeamSource(orgId, { personal: personalNow, passed, onHold: holdTeam });
  const holding = source.holding;
  const view = source.view;
  // A team just made or brought, on the team step it was made on, until the AI's read places the next step.
  const arriving = frozen !== null && step === "team" && lastTeam.current === 0 && team.length > 0;
  // The team made, and no import holding the step: who is in it.
  const teamList = team.length > 0 && !holding && !arriving;
  // Nothing opens by itself while the person is on a step they chose: the AI's done screen, an import's report or its
  // files copying, a step they went back to.
  const stay = aiSeen || holding || picked !== null;

  /** A step the server saved, in `/me` as it answered, where the rail reads it. */
  const remember = (id: string, saved: { step: OnboardingStepId } | null) => {
    const now = qc.getQueryData<Me>(keys.me);
    if (!saved || !now) return;
    const organizations = now.organizations.map((o) =>
      o.id === id && o.onboarding ? { ...o, onboarding: { ...o.onboarding, step: saved.step } } : o,
    );
    qc.setQueryData<Me>(keys.me, { ...now, organizations });
  };
  // A plan step shown is marked as passed, so that once paid it stays on the rail as answered; a server that never
  // held the workspace for a plan has no plan step at all (ADR 0162).
  const markPlan = useMutation({
    meta: { silent: true },
    mutationFn: (id: string) => api.orgs.saveOnboarding(id, { step: "computer" }),
    onSuccess: (saved, id) => remember(id, saved),
  });
  // A team's "Connect later" goes on to inviting people, kept as "ai" so a reload resumes there (ADR 0162, amended
  // 2026-11-11).
  const aiLater = useMutation({
    mutationFn: (id: string) => api.orgs.saveOnboarding(id, { step: "ai" }),
    onSuccess: (saved, id) => {
      remember(id, saved);
      setAiLeft(true);
      setPicked(null);
    },
  });
  useEffect(() => {
    if (!known || !orgId || step !== "plan" || !held || markPlan.status !== "idle") return;
    if (passed !== undefined && stepIndex(passed) >= stepIndex("computer")) return;
    markPlan.mutate(orgId);
  });

  // On agentes.chat Cloud, while sign-up is by invitation, only accounts early access allowed make workspaces (ADR 0078).
  const inviteOnly = me.data?.user.canCreateWorkspace === false && orgId === null;
  const emails = sendsEmail(authConfig);
  const email = me.data?.user.email ?? "";
  // Their face in the first question's drawings: the account's photo (Google's), else their initials.
  const you = { name: me.data?.user.name || email, image: me.data?.user.image ?? null };
  // The address this tab's sign-up was emailed a link to confirm: the step says where it went. Read once and
  // forgotten once confirmed or set up, so a later onboarding (another workspace) says nothing of it.
  const [sentTo] = useState(() => sessionStore.get(STORAGE_KEYS.confirmationSent));
  const verified = me.data?.user.emailVerified === true;
  const confirmationSent = email !== "" && sentTo === email && !verified;
  // Early access counts only for a confirmed address (ADR 0078 §4): held here unconfirmed, a new link is the way on.
  const confirmFirst = inviteOnly && emails && email !== "" && !verified && !confirmationSent;
  useEffect(() => {
    if (verified) sessionStore.remove(STORAGE_KEYS.confirmationSent);
  }, [verified]);
  const resend = useMutation({ mutationFn: () => sendNewLink({ auth, t, show: toast.show }, email) });
  // The area goes on at once, kept in `/me` as answered; a save that fails never holds the onboarding.
  const saveArea = useMutation({
    meta: { silent: true },
    mutationFn: (area: WorkAreaAnswer) => api.account.setWorkArea(area),
  });
  const answerArea = (area: WorkAreaAnswer) => {
    setAreaDone(true);
    const now = qc.getQueryData<Me>(keys.me);
    if (now) qc.setQueryData<Me>(keys.me, { ...now, user: { ...now.user, workArea: area } });
    saveArea.mutate(area);
  };

  // Someone who already has a workspace can give up on a new one: back to the one they were in (or any other).
  const others = (me.data?.organizations ?? []).filter((o) => o.id !== orgId && !settingUp(o));
  const leaveTo = others.find((o) => o.id === storage.get(STORAGE_KEYS.lastOrg)) ?? others[0];

  const open = useMutation({
    // "done": opening by itself; "later": the last step's buttons ("Connect later", "Go to the workspace", "Invite
    // later"), which land the same way; "invited": the people step's invitations sent; "skipped": the plan left for
    // later.
    mutationFn: async (how: "done" | "later" | "invited" | "skipped") => {
      if (!target) return;
      leaving.current = true;
      // The invitations went: kept as "team" first, so a finish that fails resumes past the step, never asking again.
      if (how === "invited") await api.orgs.saveOnboarding(target.orgId, { step: "team" });
      const done = await finishOnboarding(api, target.orgId);
      sessionStore.remove(STORAGE_KEYS.confirmationSent);
      // The answer that finished it says who the person is now: it opens without asking the server again.
      if (done.me) qc.setQueryData(keys.me, done.me);
      else await qc.invalidateQueries({ queryKey: keys.me });
      const params = { orgId: target.orgId };
      // Wherever it opens, on its arrival (ADR 0160): the beta notice, then Connect an AI; the notice alone once the
      // rail offered the AI (in this visit, or left for later in an earlier one), or when the plan was left for later
      // (the right hand's card leads with the plan).
      const offered = aiSeen || aiLaterSaved || how === "skipped";
      const search = { [ARRIVAL_PARAM]: offered ? ARRIVAL_BETA_ONLY : 1 } as never;
      if (landingOf(how === "skipped" ? "skipped" : "done", personalNow) === "rightHand" && done.agentId)
        await navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { ...params, agentId: done.agentId }, search });
      else
        await navigate({
          to: "/org/$orgId/c/$channelId",
          params: { ...params, channelId: target.generalChannelId },
          search,
        });
    },
    // Opening by itself, a failure is the page's own (below); from a button, the step stays and a toast says it.
    onError: (e, how) => {
      leaving.current = false;
      if (how !== "done") toast.show(errorText(t, e), "error");
    },
  });

  const save = useMutation({
    // Owning a workspace that waits for its first plan is said in place, with the way to that plan.
    meta: { silent: true },
    onError: (e) => {
      if (errorCode(e) !== "org.create_unpaid") toast.show(errorText(t, e), "error");
    },
    mutationFn: async () => {
      let made: { orgId: string; generalChannelId: string } | null = null;
      // `/me` as the create answered it, while nothing after it changed it.
      let now: Me | undefined;
      if (!orgId) {
        const res = await api.orgs.create({
          // "For me": no name to ask, the word for it in the person's language (renamed in Settings like any other).
          name: personal ? t("onboarding.personal.name") : org.trim(),
          ...(personal ? { mode: "personal" as const } : {}),
          timezone: zoneNow,
          // The person's own zone, detected here: agents read the local time from it (the language is `useServerLocale`'s).
          memberTimezone: browserTimezone() ?? undefined,
        });
        made = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
        now = res.me;
      } else {
        await api.orgs.updateSettings(orgId, { name: org.trim(), ...(zone ? { timezone: zone } : {}) });
      }
      const id = made?.orgId ?? orgId ?? "";
      // The logo needs the workspace: picked before it existed, sent now (a team's only: "For me" asks none).
      if (logoDirty && !personal) {
        if (logo) await api.orgs.setLogo(id, logo);
        else await api.orgs.removeLogo(id);
        setLogoDirty(false);
        now = undefined;
      }
      // The next step's data first, then the workspace among mine: it shows at once, with no splash between.
      await Promise.all([
        qc.prefetchQuery({ queryKey: keys.settings(id), queryFn: () => api.orgs.settings(id) }),
        qc.prefetchQuery({ queryKey: keys.agents(id), queryFn: () => api.agents.list(id) }),
      ]);
      if (now) qc.setQueryData(keys.me, now);
      else await qc.invalidateQueries({ queryKey: keys.me });
      if (made) setCreated(made);
      setPicked(null);
    },
  });

  // Everything answered, and no plan to wait for: it opens (back here from another tab, or paid meanwhile), unless the
  // person stays on a step of their own.
  const opening = useRef(false);
  useEffect(() => {
    if (!known || at !== "open" || stay || opening.current || deleting !== null) return;
    opening.current = true;
    open.mutate("done");
  });

  // A new step, or a step's own new view (the team step's question, bringing, what was found, its report or its list;
  // the AI step's connected screen), replaces the pressed button under the focus: the focus goes to the new heading,
  // which is read out, and where Enter still reaches the step's action.
  const shownView = asksArea
    ? "area"
    : `${step}:${step === "team" ? (teamList ? "list" : view) : step === "ai" ? String(aiDone) : ""}`;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!known || shown.current === shownView) return;
    if (shown.current !== null) titleRef.current?.focus();
    shown.current = shownView;
  });
  // A dialog that closes on a button gone meanwhile (Connect an AI, over the cards its pick replaced) leaves the focus
  // on the page's body, out of the step's reach: Enter there still presses the step's action.
  useEffect(() => {
    const press = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.defaultPrevented || e.target !== document.body) return;
      // Never behind a dialog or a menu still open.
      if (document.querySelector("[role='dialog'], [role='menu']")) return;
      const go = mainRef.current?.querySelector<HTMLButtonElement>("button[data-enter]:not(:disabled)");
      if (!go) return;
      e.preventDefault();
      go.click();
    };
    document.addEventListener("keydown", press);
    return () => document.removeEventListener("keydown", press);
  }, []);

  const refused = save.error;
  const unpaidElsewhere =
    refused instanceof ApiError && refused.code === "org.create_unpaid" && typeof refused.params?.orgId === "string"
      ? refused.params.orgId
      : null;
  const busy = save.isPending || open.isPending || aiLater.isPending;
  const savedLogo = logoDirty ? null : mine?.logo;
  const shownLogo = logo ? `data:${logo.contentType};base64,${logo.imageBase64}` : (savedLogo ?? null);
  const lodiName = lodi?.name ?? RIGHT_HAND_DEFAULT.name;

  // A read that failed, or a workspace that wouldn't open by itself: said, with the way on, never a sky that waits for
  // nothing (from a button, its toast says it and the step stays).
  const failed =
    orgId === null
      ? null
      : ([settings, agents].find((q) => q.data === undefined && q.isError && !q.isFetching)?.error ??
        (at === "open" && open.isError && open.variables === "done" ? open.error : null));
  if (failed)
    return (
      <div className="page page--mid">
        <ErrorState
          error={failed}
          onRetry={() => {
            opening.current = false;
            open.reset();
            if (settings.isError) void settings.refetch();
            if (agents.isError) void agents.refetch();
          }}
        />
      </div>
    );
  if (!me.data || !known || (at === "open" && !stay && deleting === null)) return <BootSplash />;

  const lodiWords = { first: firstName(me.data.user.name), ...agentGrammar(lodiName) };
  // No agents besides the right hand (the team step left with none, ADR 0162 amended 2026-11-11, or a personal
  // workspace's "no agents yet"): the plan and AI steps speak of it, never of a team that isn't there.
  const alone = team.length === 0;
  // The team step's heading and Lodi's line from its source, until the team is made; then words for a team that
  // exists (back from a later step), never the template's.
  const teamHead = step === "team" && !teamList ? source.head(t, name) : null;
  const aiLabel = aiNamed && aiNamed !== "key" ? planLabel(t, aiNamed) : null;
  const say = asksArea
    ? t(personalNow ? "onboarding.flow.lodi.areaPersonal" : "onboarding.flow.lodi.area")
    : step === "name"
      ? t("onboarding.flow.lodi.name", lodiWords)
      : step === "business"
        ? t("onboarding.flow.lodi.business", lodiWords)
        : step === "team"
          ? (teamHead?.say ??
            t(personalNow ? "onboarding.flow.lodi.teamMadePersonal" : "onboarding.flow.lodi.teamMade", lodiWords))
          : step === "plan"
            ? t("onboarding.flow.lodi.planThen", lodiWords)
            : step === "people"
              ? t(emails ? "onboarding.flow.lodi.people" : "onboarding.flow.lodi.peopleLink", lodiWords)
              : aiDone
                ? t(hasPeople ? "onboarding.flow.lodi.connectedThen" : "onboarding.flow.lodi.connected", lodiWords)
                : hasPeople
                  ? // Not the last step: the people come after it.
                    t(alone ? "onboarding.flow.lodi.aiThenAlone" : "onboarding.flow.lodi.aiThen", lodiWords)
                  : t(personalNow || alone ? "onboarding.flow.lodi.aiPersonal" : "onboarding.flow.lodi.ai", lodiWords);
  const title = asksArea
    ? t("onboarding.flow.area.title")
    : asking
      ? t("onboarding.purpose.title")
      : step === "name"
        ? t("onboarding.workspace.title")
        : step === "business"
          ? t("agentSetup.firstRun.about.title", { org: name })
          : step === "team"
            ? (teamHead?.title ?? t(personalNow ? "onboarding.flow.steps.teamPersonal" : "onboarding.flow.team.title"))
            : step === "plan"
              ? t(personalNow ? "onboarding.flow.plan.titlePersonal" : "onboarding.flow.plan.title")
              : step === "people"
                ? t("onboarding.flow.people.title")
                : aiDone
                  ? personalNow || alone
                    ? t("onboarding.flow.ai.doneTitlePersonal", agentGrammar(lodiName))
                    : t("onboarding.flow.ai.doneTitle", { org: name })
                  : personalNow
                    ? t("onboarding.flow.ai.titlePersonal")
                    : alone
                      ? // The right hand alone (the team step left with no agents): by its name, as its stage says it.
                        t("onboarding.flow.ai.titleAlone", agentGrammar(lodiName))
                      : t("arrival.connect.title");
  const lead = asksArea
    ? t("onboarding.flow.area.lead")
    : asking
      ? t("onboarding.purpose.lead")
      : step === "name"
        ? t("onboarding.workspace.lead")
        : step === "business"
          ? t("agentSetup.firstRun.about.desc")
          : step === "team"
            ? (teamHead?.lead ?? t("onboarding.flow.team.madeLead"))
            : step === "plan"
              ? t(
                  personalNow
                    ? "onboarding.flow.plan.leadPersonal"
                    : alone
                      ? "onboarding.flow.plan.leadAlone"
                      : "onboarding.flow.plan.lead",
                )
              : step === "people"
                ? // A server that sends no email invites through its link only (ADR 0090).
                  t(emails ? "onboarding.flow.people.lead" : "members.dialog.linkStep.lead")
                : aiDone
                  ? aiLabel
                    ? t("onboarding.flow.ai.doneLead", { label: aiLabel })
                    : t("onboarding.flow.ai.doneLeadAny")
                  : t("arrival.connect.text");
  // Its own back: the first question from the name, the workspace the person came from, the team step's previous
  // view, the team from the AI step (nothing to go back to once it thinks), the AI step from the people step.
  let back: { label: string; go: () => void } | null = null;
  if (asksArea) {
    // A team's goes back to what it does, its answers kept; a personal workspace's purpose is never asked again.
    if (!personalNow) back = { label: t("onboarding.back"), go: () => setPicked("business") };
  } else if (step === "name" && orgId === null && forTeam) {
    back = { label: t("onboarding.back"), go: () => setForTeam(false) };
  } else if (step === "name" && leaveTo) {
    const href = returnPlace(leaveTo.id);
    back = { label: t("onboarding.leave", { name: leaveTo.name }), go: () => void navigate({ href }) };
  } else if (step === "team" && !teamList && source.back) {
    back = { label: t("onboarding.back"), go: source.back };
  } else if (step === "ai" && !aiDone) {
    back = { label: t("onboarding.back"), go: () => setPicked("team") };
  } else if (step === "people") {
    back = { label: t("onboarding.back"), go: () => setPicked("ai") };
  }
  const answered = Math.min(reached, steps.length);
  // A personal workspace's own words for its steps (ADR 0159), from the first question on; it never invites here.
  const stepName = (s: RailStep) =>
    personalNow && s !== "business" && s !== "people"
      ? t(`onboarding.flow.steps.${s}Personal`)
      : t(`onboarding.flow.steps.${s}`);
  const values: Partial<Record<RailStep, string>> = {
    // A personal workspace's first answer is what it is for, never its name ("Pessoal", ADR 0159).
    name: personalNow ? t("onboarding.purpose.personal") : name || undefined,
    business:
      kind && kind !== "other"
        ? t(`teamPlan.business.${kind}`)
        : context
          ? t("onboarding.railValue.context")
          : undefined,
    // Answered with no agents (shown only once answered): they come later.
    team: team.length
      ? joinNames(
          team.map((a) => a.name),
          t,
        )
      : t("onboarding.railValue.later"),
    plan: steps.includes("plan") && !held ? t("onboarding.railValue.on") : undefined,
    // Connected, or (a team's) left for later on the way to its people.
    ai: thinksNow
      ? (aiLabel ?? t("onboarding.railValue.ai"))
      : aiLaterSaved
        ? t("onboarding.railValue.later")
        : undefined,
  };

  // Beside the team step: what an import would bring, else the template's team while the templates show, or while
  // "Start with a ready-made team" is picked on how to start (ADR 0162, amended 2026-11-11).
  const brought = step === "team" ? source.preview : null;
  const templateShown =
    step === "team" &&
    team.length === 0 &&
    !personalNow &&
    (view === "template" || (view === "start" && source.start === "template"));
  const coming =
    step === "team" && team.length === 0
      ? (brought?.channels ?? (templateShown ? (template.chosen?.team.newChannels ?? []) : []))
      : [];
  const preview: PreviewAgent[] = [
    { name: lodiName, role: t("rightHand.label"), look: lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance },
    ...(team.length > 0
      ? team.map((a: Agent) => ({
          name: a.name,
          role: a.role,
          look: lookOf(a),
          asleep: step === "plan" || step === "ai",
        }))
      : brought
        ? brought.agents
        : templateShown && template.chosen
          ? // In the template's order, the team's once made: making it moves no row.
            template.chosen.team.agents.map((a) => ({ name: a.name, role: a.role, look: lookOf(a), fresh: true }))
          : []),
  ];
  const crew = lodi ? [lodi, ...team] : team;

  return (
    <div className="onb onb--rail">
      <aside className="onb__rail">
        <div className="onb__top">
          <span className="onb__brand">
            <Logo size={22} />
          </span>
          <Menu
            align={phone ? "end" : "start"}
            label={t("onboarding.flow.account")}
            trigger={
              <button type="button" className="onb__me" aria-label={t("onboarding.flow.account")}>
                <Avatar kind="person" name={me.data.user.name} imageUrl={me.data.user.image} size="sm" />
              </button>
            }
          >
            {orgId && (
              <MenuItem icon="trash" danger onSelect={() => setDeleting(1)}>
                {t("onboarding.deleteLink")}
              </MenuItem>
            )}
            {accountOutOfReach(me.data.organizations) && (
              <MenuItem icon="trash" danger onSelect={() => setAccount("delete")}>
                {t("deleteAccount.menu")}
              </MenuItem>
            )}
            <MenuItem
              icon="arrowRight"
              danger
              onSelect={async () => {
                await auth.signOut();
                qc.clear();
                await navigate({ to: "/login" });
              }}
            >
              {t("auth.signOut")}
            </MenuItem>
          </Menu>
        </div>
        {!phone && (
          <div className="onb__progress">
            <span className="onb__progress-text">
              <span>
                {answered === steps.length
                  ? t("onboarding.progress.done")
                  : t("onboarding.progress.left", { count: steps.length - answered })}
              </span>
              <span>{t("agentSetup.count", { done: answered, total: steps.length })}</span>
            </span>
            <OnboardingProgress progress={answered / steps.length} />
          </div>
        )}
        <StepRail
          label={t("onboarding.stepsLabel")}
          // Once the team thinks on a rail that ends there, every step done with its answer under it, none current.
          current={allDone ? steps.length : index}
          onGo={(i) => {
            // Back on the name, its field holds the saved one, to change or clear.
            if (steps[i] === "name") setOrg(name);
            setPicked(steps[i] ?? null);
          }}
          doneLabel={t("onboarding.stepDone")}
          steps={steps.map((s, i) => ({
            id: s,
            name: stepName(s),
            done: i < reached,
            // Never back to what can't be answered again: a personal workspace's purpose once it exists, a plan
            // already on; nor anywhere while an import holds the team step.
            disabled:
              i > reached ||
              busy ||
              holding ||
              (s === "name" && personalNow && orgId !== null) ||
              (s === "plan" && !held),
            value: values[s],
          }))}
        />
        {!phone && (
          <div className="onb__lodi" ref={lodiRef}>
            <p className="onb__say" key={step}>
              {say}
            </p>
            <span className="onb__lodi-who">
              <AgentSticker
                appearance={lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance}
                mood="wave"
                size={64}
                seed="lodi"
              />
              <Chip className="sky-chip">{lodiName}</Chip>
            </span>
          </div>
        )}
        {!phone && <OnboardingHorizon progress={answered / steps.length} clear={() => [lodiRef.current]} />}
        {orgId && (
          <DeleteWorkspaceDialog
            org={{ id: orgId, name }}
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            onDeleted={() => void navigate({ to: "/org/$orgId", params: { orgId } })}
          />
        )}
        <DeleteAccountDialog open={account === "delete"} onClose={() => setAccount(null)} />
      </aside>

      <main
        className="onb__main"
        ref={mainRef}
        onKeyDown={(e) => {
          // Enter presses the step's button that shows ↵ (the plan has none), except where Enter means something else
          // (Shift+Enter: a new line in the business's sentence; any Enter in another box of text, such as a pasted
          // reply from another app, which is a new line there).
          const el = e.target as HTMLElement;
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          // On an answer of the first question too: a radio takes no Enter of its own (it stops it, though).
          const answer = el.matches("[role='radio']");
          if (!answer && e.defaultPrevented) return;
          if (
            !answer &&
            el.closest("button, a, textarea:not(.onb__line), [role='dialog'], [role='listbox'], [role='combobox']")
          )
            return;
          const go = e.currentTarget.querySelector<HTMLButtonElement>("button[data-enter]:not(:disabled)");
          if (!go) return;
          e.preventDefault();
          go.click();
        }}
      >
        <div className="onb__cols">
          {/* Outside the step, as the rail is on wide screens: the pixel agent walks on as a step is done. */}
          {phone && (
            <div className="onb__phone-top">
              <OnboardingProgress progress={answered / steps.length} />
              <div className="onb__lodi-row">
                <AgentAvatar name={lodiName} appearance={lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance} size="sm" />
                <p className="onb__say" key={step}>
                  {say}
                </p>
              </div>
            </div>
          )}
          <StepHost step={step} org={mine} me={me.data}>
            <div className="onb__body" key={asksArea ? "area" : asking ? "purpose" : step}>
              {back && (
                <button type="button" className="onb__back" onClick={back.go} disabled={busy}>
                  <Icon name="chevronLeft" size={16} />
                  {back.label}
                </button>
              )}
              <header className="onb__head">
                {/* Once the team thinks on a rail that ends there, it is done: no step to count. */}
                {!asking && !allDone && (
                  <p className="onb__eyebrow">{t("onboarding.flow.stepOf", { n: index + 1, total: steps.length })}</p>
                )}
                <h1 className="onb__title" ref={titleRef} tabIndex={-1}>
                  {title}
                </h1>
                <p className="onb__lead">{lead}</p>
              </header>

              {asksArea && <AreaStep onAnswer={answerArea} />}
              {step === "name" && !asksArea && (
                <>
                  <Locked when={busy}>
                    {asking ? (
                      <div className="onb__answer">
                        <PurposeCards value={purpose} onValueChange={setPurpose} you={you} />
                        {unpaidElsewhere && (
                          <UnpaidNote
                            orgId={unpaidElsewhere}
                            name={me.data.organizations.find((o) => o.id === unpaidElsewhere)?.name}
                            billing={Boolean(authConfig?.billingUrl)}
                          />
                        )}
                      </div>
                    ) : (
                      <div className="onb__answer">
                        <div className="onb__ws">
                          <button
                            type="button"
                            className="onb__logo"
                            aria-label={
                              logo ? t("onboarding.workspace.logoChange") : t("onboarding.workspace.logoPick")
                            }
                            title={t("onboarding.workspace.logoHelp")}
                            onClick={() => setLogoOpen(true)}
                          >
                            {shownLogo ? (
                              <OrgMark logo={shownLogo} size={48} />
                            ) : org.trim() || name ? (
                              <span className="onb__logo-letter">{(org.trim() || name).charAt(0).toUpperCase()}</span>
                            ) : (
                              <Icon name="upload" />
                            )}
                          </button>
                          <Input
                            className="onb__big"
                            aria-label={t("onboarding.workspace.name")}
                            value={org}
                            onChange={(e) => setOrg(e.target.value)}
                            placeholder={t("onboarding.workspace.namePlaceholder")}
                            spellCheck={false}
                            autoFocus
                          />
                        </div>
                        {zoneOpen ? (
                          <Field
                            label={t("onboarding.workspace.timezone")}
                            id="org-zone"
                            hint={{
                              name: t("common.about", { label: t("onboarding.workspace.timezone") }),
                              text: t("onboarding.workspace.timezoneHelp"),
                            }}
                          >
                            <ZonePicker
                              id="org-zone"
                              value={zoneNow}
                              onChange={setZone}
                              suggested={[browserTimezone() ?? "", "UTC"].filter(Boolean)}
                            />
                          </Field>
                        ) : (
                          <p className="onb__help">
                            {t("onboarding.workspace.zone", { zone: timezoneName(zoneNow, i18n.language) })} ·{" "}
                            <button type="button" className="ac-link onb__link" onClick={() => setZoneOpen(true)}>
                              {t("onboarding.workspace.zoneChange")}
                            </button>
                          </p>
                        )}
                        <ImageCropDialog
                          open={logoOpen}
                          onClose={() => setLogoOpen(false)}
                          title={t("orgLogo.title")}
                          help={t("orgLogo.help")}
                          placeholder={<OrgMark size={56} />}
                          hasImage={shownLogo !== null}
                          removeLabel={t("orgLogo.remove")}
                          format="image/png"
                          save={async (image) => {
                            setLogo(image);
                            setLogoDirty(true);
                          }}
                          remove={async () => {
                            setLogo(null);
                            setLogoDirty(true);
                          }}
                          onSaved={() => setLogoOpen(false)}
                          onRemoved={() => setLogoOpen(false)}
                        />
                        {unpaidElsewhere && (
                          <UnpaidNote
                            orgId={unpaidElsewhere}
                            name={me.data.organizations.find((o) => o.id === unpaidElsewhere)?.name}
                            billing={Boolean(authConfig?.billingUrl)}
                          />
                        )}
                      </div>
                    )}
                  </Locked>
                  {inviteOnly && (
                    <p className="onb__help onb__note ac-iconline" role="status">
                      <Icon name="lock" size={14} />
                      <span>
                        {authConfig?.supportEmail
                          ? t("onboarding.workspace.inviteOnlyAsk", { email: authConfig.supportEmail })
                          : t("onboarding.workspace.inviteOnly")}
                      </span>
                    </p>
                  )}
                  {(confirmationSent || confirmFirst) && (
                    <p className="onb__help onb__note ac-iconline" role="status">
                      <Icon name="mail" size={14} />
                      <span>
                        {confirmationSent
                          ? t("onboarding.confirmation.sent", { email })
                          : t("onboarding.confirmation.first")}
                        {!resend.data && (
                          <>
                            <br />
                            <button
                              type="button"
                              className="ac-link onb__link"
                              onClick={() => resend.mutate()}
                              disabled={resend.isPending}
                            >
                              {t("auth.sendNewLink")}
                            </button>
                          </>
                        )}
                      </span>
                    </p>
                  )}
                  <div className="onb__actions">
                    <Button
                      variant="primary"
                      block
                      kbd={["↵"]}
                      data-enter=""
                      onClick={() => (asking && !personal ? setForTeam(true) : save.mutate())}
                      disabled={(asking ? !purpose : !org.trim()) || inviteOnly || busy}
                      loading={save.isPending}
                    >
                      {t("onboarding.actions.continue")}
                    </Button>
                  </div>
                </>
              )}
              {step === "business" && orgId && !asksArea && (
                <BusinessStep
                  orgId={orgId}
                  context={context}
                  business={kind}
                  onDone={(picked) => {
                    // Another business starts the team step on its own template again; the same keeps the one picked.
                    if (picked !== kind) template.pick(null);
                    setBusiness(picked);
                    setPicked(null);
                  }}
                />
              )}
              {step === "team" &&
                orgId &&
                (teamList || view === "template" ? (
                  <TeamStep
                    orgId={orgId}
                    team={teamList ? team : []}
                    waiting={arriving}
                    template={template}
                    reviewer={lodiName}
                    onContinue={() => setPicked(null)}
                  />
                ) : view === "start" ? (
                  <TeamStart
                    state={source}
                    template={template}
                    lodi={{ name: lodiName, look: lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance }}
                  />
                ) : (
                  <TeamSource state={source} orgId={orgId} personal={personalNow} org={name} />
                ))}
              {step === "plan" && orgId && (
                <PlanStep
                  orgId={orgId}
                  // No agents yet (a personal workspace's, or a team step left with none): its right hand, asleep until
                  // the plan.
                  team={team.length > 0 ? team : lodi ? [lodi] : []}
                  offer={offer}
                  skipping={open.isPending}
                  onSkip={() => open.mutate("skipped")}
                  next={steps.includes("ai")}
                  confirming={paid}
                  personal={personalNow}
                />
              )}
              {step === "ai" && orgId && (
                <AiStep
                  orgId={orgId}
                  agents={crew}
                  done={aiDone}
                  leaving={open.isPending || aiLater.isPending}
                  picked={aiNamed}
                  next={hasPeople}
                  onConnected={(choice) => setAiPick({ choice, key: keyNow })}
                  // A team's goes on to inviting people; a personal workspace's finishes it.
                  onLater={() => (hasPeople ? aiLater.mutate(orgId) : open.mutate("later"))}
                  onEnter={() => {
                    if (!hasPeople) return open.mutate("later");
                    setAiLeft(true);
                    setPicked(null);
                  }}
                />
              )}
              {step === "people" && orgId && (
                <PeopleStep
                  orgId={orgId}
                  org={name}
                  email={me.data.user.email}
                  byLink={!emails}
                  leaving={open.isPending}
                  onSent={() => open.mutate("invited")}
                  onLater={() => open.mutate("later")}
                />
              )}
            </div>
            {wide &&
              (step === "ai" && mine ? (
                // The team on its stage, asleep until it thinks, in place of the sidebar.
                <AiStage agents={crew} lead={lodi} awake={aiDone} personal={personalNow} />
              ) : (
                <OnboardingPreview
                  org={name || t("onboarding.flow.preview.name")}
                  logo={shownLogo}
                  // A personal workspace's #general is out of sight (ADR 0159).
                  channels={[...(personalNow ? [] : ["general"]), ...coming]}
                  fresh={coming}
                  orgId={team.length > 0 && !personalNow ? orgId : null}
                  agents={preview}
                  person={me.data.user}
                  personal={personalNow}
                />
              ))}
          </StepHost>
        </div>
      </main>
    </div>
  );
}

/** The two answers to "What will you use agentes.chat for?" (ADR 0159), in this order. */

/**
 * The AI step and its stage inside the workspace's context and Connect an AI (ADR 0160), which the onboarding has
 * nowhere else; the people step inside the workspace's context, which the invite link's panel reads; any other step
 * as it is, so the earlier steps ask the server for nothing more.
 */
function StepHost({
  step,
  org,
  me,
  children,
}: {
  step: RailStep;
  org: OrgSummary | undefined;
  me: Me;
  children: ReactNode;
}) {
  if (org && step === "ai")
    return (
      <AiHost org={org} me={me}>
        {children}
      </AiHost>
    );
  if (org && step === "people")
    return (
      <OrgProvider org={org} me={me}>
        {children}
      </OrgProvider>
    );
  return <>{children}</>;
}

/**
 * Owning a workspace that waits for its first plan: said in place, with the way into that workspace (someone who came
 * back to this page after making it was looking for it, not for another) and the way to its plan.
 */
function UnpaidNote({ orgId, name, billing }: { orgId: string; name: string | undefined; billing: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <p className="onb__status ac-iconline" role="alert">
        <Icon name="pause" size={14} />
        <span>{t("standing.createUnpaid")}</span>
      </p>
      {(name || billing) && (
        <div className="row">
          {name && (
            <Button onClick={() => void navigate({ href: returnPlace(orgId) })}>
              {t("standing.createUnpaidOpen", { name })}
            </Button>
          )}
          {billing && (
            <BillingLinkButton orgId={orgId} from="new_workspace" icon="external">
              {t("standing.billing.cta.payment")}
            </BillingLinkButton>
          )}
        </div>
      )}
    </>
  );
}
