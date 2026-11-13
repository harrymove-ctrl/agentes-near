import type { ConnectorDef } from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useChannels,
  useCreateAgent,
  useDms,
  useMembers,
  useSkill,
  useSkills,
} from "@agenteschat/client";
import { type Level, saveLevels } from "@agenteschat/client/lib/access-levels";
import { errorText as failureText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  type AgentAppearance,
  type AgentColor,
  agentTones,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  OptionList,
  PixelSky,
  pixelBurst,
  playAgentReaction,
  prefersReducedMotion,
  randomAppearance,
  setGaze,
  spriteTone,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useConnectedById } from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LookPicker } from "@/components/AgentFields";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { agentCoverOptions, facePool } from "@/components/Sky";
import {
  BLANK_LOOK,
  type CardLevel,
  freeHandle,
  handleForName,
  PERSONAL_STARTERS,
  type PersonalStarter,
  presetChannels,
  ROLE_DEFAULTS,
  ROLE_GROUPS,
  type RoleGroupId,
  type RoleId,
  savePart,
  starterApps,
  takenHandles,
} from "@/lib/new-agent";
import { useScrollEdges } from "@/lib/scroll-edges";
import { useToast } from "@/lib/toast";
import { AppsPickerDialog } from "./AppsPicker";
import { useNewAgentBrain } from "./useNewAgentBrain";
import "../team-plan.css";
import "./new-agent-card.css";

/*
 * A new agent (ADR 0164): one dialog for every way in. On the left, from scratch first, then the ready-made starting
 * points (a personal workspace's starters, a team's roles by area); on the right, the agent's own card, edited in
 * place: it introduces itself in a speech bubble on its sky (its name and what it does, in its own voice), its look
 * (tried on by pointing), the connected apps it will use at their levels, its skills, where it works and how it works
 * (its instructions). Creating it flies it to its row in the sidebar and opens its chat, whose checklist asks only for
 * what is missing (first tasks and the apps still to connect included).
 */

type Look = Required<AgentAppearance>;
type LookPatch = Partial<Look>;
type TeamRole = Exclude<RoleId, "custom">;
/** A starting point: from scratch, a personal starter or a team's ready-made role. */
type Pick = "zero" | PersonalStarter["id"] | TeamRole;

interface Draft {
  name: string;
  /** What it does, in its own voice: its bubble on the card, its first message, its setup's `hello`. */
  what: string;
  look: Look;
  /** The connected apps it gets at once, at their levels (catalog ids). */
  apps: Record<string, CardLevel>;
  /** The skills it opens when needed (library ids); null: its starting point's suggestions, as they load. */
  skills: string[] | null;
  /** How it works: its instructions, edited on the card. */
  instructions: string;
}

export interface NewAgentRequest {
  /** A channel's "Criar agente": it starts in that channel too. */
  channelId?: string | null;
  /** Back from connecting an app elsewhere (OAuth): the card as it was, and the app that just connected. */
  resume?: { sel: Pick; drafts: Partial<Record<Pick, Draft>>; connected: string | null };
}

/**
 * Connecting an app from the card may sign in on the provider's page, which reloads the app: the card waits here for
 * the way back (`?newAgent=resume`, plus the server's `?connected=`), for an hour, in this tab only.
 */
const RESUME_KEY = "agentes:new-agent";
const RESUME_PARAM = "newAgent";
const RESUME_TTL = 60 * 60 * 1000;
interface Saved {
  org: string;
  at: number;
  channelId: string | null;
  sel: Pick;
  drafts: Partial<Record<Pick, Draft>>;
  /** The app being connected (catalog id). */
  pending: string;
}

function saveForReturn(saved: Omit<Saved, "at">) {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...saved, at: Date.now() }));
  } catch {
    // No storage (a private window): back from the provider the card starts over.
  }
}

function forgetReturn() {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    // Nothing kept.
  }
}

/** The card to reopen when this page is the way back from connecting one of its apps; takes its parameters out. */
function takeResume(orgId: string): NewAgentRequest | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (url.searchParams.get(RESUME_PARAM) !== "resume") return null;
  const connected = url.searchParams.get("connected");
  for (const param of [RESUME_PARAM, "connected", "outcome"]) url.searchParams.delete(param);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  let saved: Saved | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null") as Saved | null;
  } catch {
    saved = null;
  }
  forgetReturn();
  if (!saved || saved.org !== orgId || Date.now() - saved.at > RESUME_TTL) return null;
  return {
    channelId: saved.channelId,
    resume: { sel: saved.sel, drafts: saved.drafts, connected: connected === saved.pending ? connected : null },
  };
}

/** The level an app comes onto the card at: write for a person's own agent, a team's at its role's (else read). */
function cardLevelFor(personal: boolean, role: RoleId | null, appId: string): CardLevel | null {
  if (personal) return "write";
  const level = (ROLE_DEFAULTS[role ?? "custom"].levels as Record<string, Level>)[appId];
  return level === "none" ? null : level === "write" ? "write" : "read";
}

interface Flight {
  agentId: string;
  look: Look;
  from: DOMRect;
}

const NewAgentContext = createContext<{ open: (request?: NewAgentRequest) => void } | null>(null);

/** Opens the new agent's dialog. Null outside the workspace shell (an isolated page in a test). */
export const useNewAgent = () => useContext(NewAgentContext);

/** The dialog for the whole workspace (the sidebar, the pages and the menus open it), and the new agent's flight. */
export function NewAgentProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const [request, setRequest] = useState<(NewAgentRequest & { n: number }) | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const open = useCallback(
    (next?: NewAgentRequest) => {
      // Who may not create agents gets the page's own words about it.
      if (!can(org, "create_agents")) {
        void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } });
        return;
      }
      setRequest((current) => ({ ...(next ?? {}), n: (current?.n ?? 0) + 1 }));
    },
    [org, navigate],
  );
  const value = useMemo(() => ({ open }), [open]);
  useEffect(() => {
    const onAsk = () => open();
    window.addEventListener(NEW_AGENT_EVENT, onAsk);
    return () => window.removeEventListener(NEW_AGENT_EVENT, onAsk);
  }, [open]);
  // Back from connecting one of the card's apps on the provider's page: the card as it was.
  useEffect(() => {
    const back = takeResume(org.id);
    if (back) setRequest({ ...back, n: 1 });
  }, [org.id]);
  return (
    <NewAgentContext.Provider value={value}>
      {children}
      {request && (
        <NewAgentDialog
          key={request.n}
          request={request}
          onClose={() => setRequest(null)}
          onCreated={(f) => {
            setRequest(null);
            if (f) setFlight(f);
          }}
        />
      )}
      {flight && <AgentFlight flight={flight} onDone={() => setFlight(null)} />}
    </NewAgentContext.Provider>
  );
}

/** Opens the new agent's dialog; outside the shell (a test's page), the full form. */
function useOpenNewAgent() {
  const { org } = useOrg();
  const navigate = useNavigate();
  const dialog = useNewAgent();
  return (request?: NewAgentRequest) =>
    dialog ? dialog.open(request) : void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } });
}

/** "Criar agente" on a page (Equipe, the agents' access): the new agent's dialog (ADR 0164). */
export function CreateAgentButton() {
  const { t } = useTranslation();
  const open = useOpenNewAgent();
  return (
    <Button variant="primary" icon="plus" onClick={() => open()}>
      {t("shell.createAgent")}
    </Button>
  );
}

/** "Criar agente" as a link beside a heading (Membros). */
export function CreateAgentLink() {
  const { t } = useTranslation();
  const open = useOpenNewAgent();
  return (
    <button type="button" className="ac-link" onClick={() => open()}>
      {t("shell.createAgent")}
    </button>
  );
}

/** The Mac menu bar's New agent (`MenuBarActions`, mounted outside the dialog's provider) asks through this event. */
export const NEW_AGENT_EVENT = "agentes:new-agent";

/** The ready-made words of a starting point: a personal starter's (`teamTemplates.agents`) or a role's. */
const isStarter = (pick: Pick): pick is PersonalStarter["id"] => PERSONAL_STARTERS.some((s) => s.id === pick);
const starterOf = (pick: Pick) => PERSONAL_STARTERS.find((s) => s.id === pick);
const roleOf = (pick: Pick): RoleId | null => (pick === "zero" || isStarter(pick) ? null : pick);
const GROUP_ICON: Record<RoleGroupId, "code" | "members" | "layers"> = {
  tech: "code",
  customers: "members",
  operations: "layers",
};
/**
 * The skills each starting point opens when needed, as the team templates name them (`teamTemplates.skills.{key}`),
 * matched in the workspace's library by name, best effort.
 */
const SKILL_SUGGESTIONS: Partial<Record<Pick, readonly string[]>> = {
  clara: ["schedule"],
  rui: ["proposal", "dunning"],
  dev: ["review"],
  qa: ["review"],
  support: ["voice", "answers"],
  sales: ["proposal", "voice"],
  marketing: ["voice"],
  content: ["voice"],
  finance: ["dunning"],
  assistant: ["schedule"],
};
/**
 * Where the list and the card don't fit side by side, the dialog takes two steps (ADR 0164, narrow screens): the
 * dialog is the viewport less 32px (a sheet from 640 down), and side by side needs the list's 440, the gap and a card
 * of about 420, inside the dialog's 20px insets.
 */
export const NEW_AGENT_STEPS_QUERY = "(max-width: 959px)";
/** The old form's helpers for instructions, reused on the card (`newAgent.tips.{tip}`). */
const TIPS = ["do", "avoid", "help"] as const;
/** About eight lines of instructions before they scroll. */
const HOW_MAX_HEIGHT = 184;
/** The server keeps at most this many apps in a new agent's setup (`SETUP_APPS_MAX`, ADR 0164). */
const SETUP_APPS_MAX = 12;
/** Name ideas for an agent from scratch, by what it will do (`newAgentCard.names.{theme}` and its `…Words`). */
const NAME_THEMES = ["agenda", "money", "travel", "training", "study", "clients"] as const;
/** A name or a title as a comparable slug ("Tom de voz" → "tom-de-voz"). */
const norm = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/** The words a text shares with another, by their first five letters (a rough "parecido"). */
const stems = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5)),
  );

function NewAgentDialog({
  request,
  onClose,
  onCreated,
}: {
  request: NewAgentRequest;
  onClose: () => void;
  onCreated: (flight: Flight | null) => void;
}) {
  const { t } = useTranslation();
  const tt = t as unknown as (key: string, o?: Record<string, unknown>) => string;
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const personal = isPersonal(org);
  const managesAgents = can(org, "manage_agents");
  const agents = useAgents(org.id);
  const members = useMembers(org.id);
  const catalog = useCatalog();
  const connected = useConnectedById();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const library = useSkills(org.id);
  const create = useCreateAgent(org.id);
  const brain = useNewAgentBrain();
  const connectAi = useConnectAi();
  const qc = useQueryClient();

  const picks: Pick[] = useMemo(
    () => ["zero", ...(personal ? PERSONAL_STARTERS.map((s) => s.id) : ROLE_GROUPS.flatMap((g) => [...g.roles]))],
    [personal],
  );
  const back = request.resume && picks.includes(request.resume.sel) ? request.resume : null;
  const [sel, setSel] = useState<Pick>(back?.sel ?? picks[1] ?? "zero");
  const [drafts, setDrafts] = useState<Partial<Record<Pick, Draft>>>(() => {
    // Back from connecting an app: the cards as they were, that app on the one being made.
    if (!back) return {};
    const all = Object.fromEntries(
      Object.entries(back.drafts).map(([k, d]) => [k, { ...d, instructions: d?.instructions ?? "" }]),
    ) as Partial<Record<Pick, Draft>>;
    const d = all[back.sel];
    const level = back.connected ? (cardLevelFor(personal, roleOf(back.sel), back.connected) ?? "read") : null;
    if (d && back.connected && level) all[back.sel] = { ...d, apps: { ...d.apps, [back.connected]: level } };
    return all;
  });
  const [lookOpen, setLookOpen] = useState(false);
  // Narrow: the list, then the card (back keeps the pick and every card's edits). Back from a provider's page, the card.
  const steps = useMediaQuery(NEW_AGENT_STEPS_QUERY);
  const [step, setStep] = useState<"list" | "card">(back ? "card" : "list");
  const onCard = !steps || step === "card";
  const onList = !steps || step === "list";
  const [preview, setPreview] = useState<LookPatch | null>(null);
  const [picking, setPicking] = useState(false);
  // An app being connected from the picker: it lands on the card once it shows as connected.
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [appOpen, setAppOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingSkills, setAddingSkills] = useState(false);
  const [skillOpen, setSkillOpen] = useState<string | null>(null);
  // Name ideas for an agent from scratch: which three show, and the one pointed at (tried on in the bubble).
  const [nameRoll, setNameRoll] = useState(0);
  const [tryName, setTryName] = useState<string | null>(null);
  const cover = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const whatInput = useRef<HTMLTextAreaElement>(null);
  const howInput = useRef<HTMLTextAreaElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // The catalog's apps by id, and the ones connected here (what a new agent may use at once).
  const defs = useMemo(() => new Map((catalog.data?.connectors ?? []).map((d) => [d.id, d])), [catalog.data]);
  const items = useMemo(() => [...connected.values()], [connected]);
  const connectedApps = useMemo(() => {
    const out = new Map<string, string>();
    for (const item of items) if (item.def && !item.custom && !out.has(item.def.id)) out.set(item.def.id, item.id);
    return out;
  }, [items]);

  /**
   * A starting point's card as it opens: its name, its voice, its look, its instructions and the apps it gets at once:
   * only the ones connected here, each at its level (who doesn't manage agents gives none). Its starting point's other
   * apps are suggested by its chat's checklist.
   */
  const fresh = (pick: Pick): Draft => {
    const role = roleOf(pick);
    const starter = starterOf(pick);
    const apps: Record<string, CardLevel> = {};
    if (managesAgents)
      for (const appId of connectedApps.keys()) {
        const level = cardLevelFor(personal, role, appId);
        if (level) apps[appId] = level;
      }
    if (pick === "zero") return { name: "", what: "", look: { ...BLANK_LOOK }, apps, skills: null, instructions: "" };
    if (starter)
      return {
        name: starter.name,
        what: tt(`newAgent.hello.${starter.id}`),
        look: { ...starter.look },
        apps,
        skills: null,
        instructions: tt(`newAgent.starters.${starter.id}.instructions`),
      };
    const id = pick as TeamRole;
    return {
      name: tt(`newAgent.roles.${id}.agent`),
      what: tt(`newAgent.hello.${id}`),
      look: { ...ROLE_DEFAULTS[id].look } as Look,
      apps,
      skills: null,
      instructions: tt(`newAgent.roles.${id}.instructions`),
    };
  };
  const draft = drafts[sel] ?? fresh(sel);
  const update = (patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [sel]: { ...draft, ...patch } }));
  const look: Look = preview ? { ...draft.look, ...preview } : draft.look;
  const name = draft.name.trim();
  const g = agentGrammar(name);
  const role = roleOf(sel);
  const starter = starterOf(sel);
  const roleName = role
    ? tt(`newAgent.roles.${role}.name`)
    : starter
      ? tt(`teamTemplates.agents.${starter.id}.role`)
      : "";

  // Its skills: what its starting point suggests that the library has, and the ones on for new agents; hidden where
  // the library is empty or this server has none.
  const lib = library.data ?? [];
  const skillsShown = library.isSuccess && lib.length > 0;
  const suggestedSkills = (pick: Pick) => {
    const titles = (SKILL_SUGGESTIONS[pick] ?? []).flatMap((k) => [k, norm(tt(`teamTemplates.skills.${k}.name`))]);
    return lib
      .filter((s) => s.defaultForNewAgents || titles.some((x) => x && (norm(s.name) === x || norm(s.name).includes(x))))
      .map((s) => s.id);
  };
  const chosenSkills = (draft.skills ?? suggestedSkills(sel)).filter((id) => lib.some((s) => s.id === id));
  const skillName = (id: string) => lib.find((s) => s.id === id)?.name ?? "";

  // Name ideas while an agent from scratch has none: a pool that fits what it will do, else the usual one.
  const takenNames = useMemo(
    () => new Set((agents.data ?? []).map((a) => a.name.trim().toLocaleLowerCase())),
    [agents.data],
  );
  const ideas = useMemo(() => {
    if (sel !== "zero" || draft.name.trim()) return [];
    const list = (key: string) =>
      tt(key)
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
    const words = draft.what.toLocaleLowerCase().split(/[^\p{L}0-9]+/u);
    const theme = NAME_THEMES.find((th) =>
      list(`newAgentCard.names.${th}Words`).some((k) => words.some((w) => w.startsWith(k.toLocaleLowerCase()))),
    );
    const pool = list(theme ? `newAgentCard.names.${theme}` : "newAgentCard.names.any").filter(
      (n) => !takenNames.has(n.toLocaleLowerCase()),
    );
    if (pool.length === 0) return [];
    const at = (nameRoll * 3) % pool.length;
    return [0, 1, 2].map((i) => pool[(at + i) % pool.length] ?? "").filter((n, i, all) => n && all.indexOf(n) === i);
  }, [sel, draft.name, draft.what, nameRoll, takenNames, tt]);

  // Its @: from the name; a taken one gets the next free one, and the card says so.
  const handles = useMemo(() => takenHandles(agents.data ?? [], members.data ?? []), [agents.data, members.data]);
  const taken = useHeldWhile(handles, busy);
  const base = handleForName(name);
  const isTaken = base !== "" && taken.has(base);
  const handle = isTaken ? freeHandle(base, taken) : base;

  // Where it works (a team's): its role's channels among mine, and the channel it was made from.
  const dmIds = useMemo(() => new Set((dms.data ?? []).map((d) => d.channelId)), [dms.data]);
  const mine = useMemo(
    () => (channels.data ?? []).filter((c) => c.isMember && !dmIds.has(c.id) && addsAgentsTo(c, me.user.id, org)),
    [channels.data, dmIds, me.user.id, org],
  );
  const joins = useMemo(() => {
    const ids = new Set<string>(role ? presetChannels(role, mine) : []);
    if (request.channelId) ids.add(request.channelId);
    return mine.filter((c) => ids.has(c.id));
  }, [role, mine, request.channelId]);

  // A starting point already made that sounds like what was written from scratch.
  const similar = useMemo(() => {
    if (sel !== "zero") return null;
    const words = stems(draft.what);
    if (words.size === 0) return null;
    let best: { pick: Pick; score: number } | null = null;
    for (const pick of picks.slice(1)) {
      const s = starterOf(pick);
      const text = s
        ? `${tt(`teamTemplates.agents.${s.id}.role`)} ${tt(`teamTemplates.agents.${s.id}.line`)}`
        : `${tt(`newAgent.roles.${pick}.name`)} ${tt(`newAgent.roles.${pick}.desc`)}`;
      const score = [...stems(text)].filter((w) => words.has(w)).length;
      if (score > 0 && (!best || score > best.score)) best = { pick, score };
    }
    return best?.pick ?? null;
  }, [sel, draft.what, picks, tt]);

  const nameOf = (pick: Pick) => {
    const d = drafts[pick];
    if (d?.name.trim()) return d.name.trim();
    const s = starterOf(pick);
    return s ? s.name : pick === "zero" ? "" : tt(`newAgent.roles.${pick}.agent`);
  };
  // How it works: its instructions grow with what's written, up to about eight lines, then scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each change of the text or of the card
  useLayoutEffect(() => {
    const ta = howInput.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, HOW_MAX_HEIGHT)}px`;
  }, [draft.instructions, sel, lookOpen]);
  /** One of the old form's helpers ("O que fazer"…): its line at the end, the cursor after it. */
  const addTip = (tip: (typeof TIPS)[number]) => {
    const line = t(`newAgent.tips.${tip}.text`, { name: me.user.name.split(/\s+/)[0] ?? me.user.name });
    const text = draft.instructions;
    update({ instructions: (text.trim() ? `${text.replace(/\s+$/, "")}\n` : "") + line });
    setTimeout(() => {
      const ta = howInput.current;
      ta?.focus();
      ta?.setSelectionRange?.(ta.value.length, ta.value.length);
    });
  };
  // The list and the card's body fade at an edge only while there is more to scroll that way.
  useScrollEdges(list, [picks.length, step, steps]);
  useScrollEdges(body, [sel, lookOpen, draft, step, steps]);

  const ready = name !== "" && handle !== "" && (sel !== "zero" || draft.what.trim() !== "");
  const react = () => playAgentReaction(REACTION, "up");
  const hopFrom = useRef<DOMRect | null>(null);
  // While words are typed into its bubble it looks at them.
  const gazeAt = (el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect();
    if (r) setGaze({ x: r.left + r.width * 0.4, y: r.top + r.height / 2 });
  };
  const pick = (next: Pick, from?: HTMLElement | null) => {
    if (next === sel) return;
    setSel(next);
    setLookOpen(false);
    setPreview(null);
    // Picked with the pointer, it hops from its row into its own sky.
    if (from && !prefersReducedMotion()) hopFrom.current = from.getBoundingClientRect();
  };
  // Narrow, each step starts where the other left off: the card on its back arrow (no keyboard pops up on a phone,
  // unless from scratch its words come first), the list on the row it had, in sight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each step change
  useLayoutEffect(() => {
    if (!steps) return;
    if (step === "card") {
      if (!(sel === "zero" && !drafts.zero?.what)) backButton.current?.focus();
      return;
    }
    const row = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
    row?.focus();
  }, [step, steps]);
  /** A row chosen (a tap, a click, Enter on it): picked, and on a narrow screen its card comes next. */
  const choose = (next: Pick, from?: HTMLElement | null) => {
    pick(next, from);
    if (steps) setStep("card");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: after each pick
  useLayoutEffect(() => {
    const from = hopFrom.current;
    hopFrom.current = null;
    const to = hero.current;
    if (!from || !to) return;
    const r = to.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (r.left + r.width / 2);
    const dy = from.top + from.height / 2 - (r.top + r.height / 2);
    const k = from.width / (r.width || 1);
    to.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${k})` },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 26}px) scale(${(1 + k) / 2})`, offset: 0.5 },
        { transform: "none" },
      ],
      { duration: 440, easing: "cubic-bezier(.3,.7,.2,1)" },
    ).finished.then(react, () => {});
  }, [sel, step]);
  // From scratch, the words come first (on a narrow screen, once its card is shown).
  // biome-ignore lint/correctness/useExhaustiveDependencies: again when the card comes into view
  useEffect(() => {
    if (sel === "zero" && !drafts.zero?.what) whatInput.current?.focus();
  }, [sel, drafts.zero?.what, step]);

  const setLook = (patch: LookPatch) => {
    update({ look: { ...draft.look, ...patch } });
    setPreview(null);
    react();
  };
  // The names' dice: a few names flash in the bubble like a slot machine, then three new ideas, and a hop.
  const rollNames = async () => {
    if (!prefersReducedMotion()) {
      for (let i = 0; i < 6; i++) {
        setTryName(ideas[i % Math.max(1, ideas.length)] ?? null);
        setNameRoll((r) => r + 1);
        await new Promise((r) => setTimeout(r, 55 + i * 16));
      }
    }
    setTryName(null);
    setNameRoll((r) => r + 1);
    react();
  };
  // Sortear: a few quick looks, then the one it keeps, with a hop and a burst.
  const shuffle = async () => {
    const spins = prefersReducedMotion() ? 1 : 7;
    let next = draft.look;
    for (let i = 0; i < spins; i++) {
      next = randomAppearance(next) as Look;
      setPreview(next);
      await new Promise((r) => setTimeout(r, 60 + i * 18));
    }
    setPreview(null);
    update({ look: next });
    react();
    burst(hero.current, next.color);
  };

  const submit = async () => {
    if (!ready || busy) {
      if (!name) nameInput.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const what = draft.what.trim();
      // How it works, as written on the card; from scratch with nothing there, what it does.
      const instructions = draft.instructions.trim() || what;
      // Its checklist suggests its starting point's apps not connected yet, then the card's (ADR 0164).
      const later = Object.entries(starterApps({ role, starter: starter?.id ?? null })).filter(
        ([id]) => !connectedApps.has(id) && !draft.apps[id],
      );
      const setupApps = Object.fromEntries([...later, ...Object.entries(draft.apps)].slice(0, SETUP_APPS_MAX));
      const agent = await create.mutateAsync({
        name,
        handle,
        role: roleName,
        instructions,
        ...brain.input,
        // Its checklist suggests what its card said (ADR 0164).
        setup: {
          role,
          ...(starter ? { starter: starter.id } : {}),
          ...(what ? { hello: what } : {}),
          apps: setupApps,
        },
        ownerUserId: me.user.id,
        // A personal workspace's agent answers only its owner (ADR 0159); a team's, everyone.
        audience: { mode: personal ? "owner" : "everyone", userIds: [], roleIds: [], consultable: true },
        appearance: draft.look,
      });
      // The rest one part at a time: what fails is said, and it still ends on the new agent.
      const failures: unknown[] = [];
      await savePart(failures, () => brain.apply(agent.id));
      if (joins.length > 0)
        await savePart(failures, () =>
          api.agents.setChannels(
            org.id,
            agent.id,
            joins.map((c) => ({ channelId: c.id })),
          ),
        );
      // The connected apps at the card's levels; one taken off the card goes to none.
      if (managesAgents) {
        const chosen: Record<string, Level> = {};
        for (const item of items) {
          if (!item.def || item.custom) continue;
          chosen[`connector:${item.id}`] = draft.apps[item.def.id] ?? "none";
        }
        if (Object.keys(chosen).length > 0) await savePart(failures, () => saveLevels(api, org.id, agent.id, chosen));
      }
      const skills = library.data ?? [];
      if (skills.length > 0)
        await savePart(failures, () =>
          api.skills.setForAgent(
            org.id,
            agent.id,
            skills.map((s) => ({ skillId: s.id, enabled: chosenSkills.includes(s.id) })),
          ),
        );
      // Its AI was set after it was made: what the workspace knew of who can think is from before it existed.
      void qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) });
      if (failures.length > 0)
        toast.show(t("newAgent.partly", { ...agentGrammar(name), reason: failureText(t, failures[0]) }), "error");
      const from = hero.current?.getBoundingClientRect();
      onCreated(from && !prefersReducedMotion() ? { agentId: agent.id, look: draft.look, from } : null);
      void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: agent.id } });
    } catch (error) {
      toast.show(t("newAgentCard.failed", { reason: failureText(t, error) }), "error");
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.matches("input, textarea");
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !typing && list.current?.contains(target)) {
      e.preventDefault();
      const i = picks.indexOf(sel);
      const next = picks[Math.max(0, Math.min(picks.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))] ?? sel;
      pick(next);
      list.current?.querySelector<HTMLElement>(`[data-pick="${next}"]`)?.focus();
    } else if (e.key === "Enter" && !e.shiftKey && !target.matches("button")) {
      // In its instructions Enter is a new line; ⌘ or Ctrl with it still creates.
      if (target === howInput.current && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      if (!onCard) setStep("card");
      else if (target === whatInput.current && !name) nameInput.current?.focus();
      else void submit();
    }
  };

  const appIds = Object.keys(draft.apps);
  const levelFor = (appId: string): CardLevel => cardLevelFor(personal, role, appId) ?? "read";
  const takeApp = (appId: string) => {
    update({ apps: { ...draft.apps, [appId]: levelFor(appId) } });
    react();
  };
  // Connecting from the picker: kept for the way back if the provider's page reloads the app.
  const connectApp = (def: ConnectorDef) => {
    saveForReturn({
      org: org.id,
      channelId: request.channelId ?? null,
      sel,
      drafts: { ...drafts, [sel]: draft },
      pending: def.id,
    });
    setPending(def.id);
    setFlow({ step: 0, def });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the app being connected shows as connected
  useEffect(() => {
    if (!pending || !connectedApps.has(pending)) return;
    if (managesAgents) takeApp(pending);
    setPending(null);
    forgetReturn();
  }, [pending, connectedApps]);
  const skillsLeft = lib.filter((s) => !chosenSkills.includes(s.id));
  const appName = (id: string) => {
    const def = defs.get(id);
    return def ? connectorName(t, def) : id;
  };
  const appIcon = (id: string) => <ConnectorIcon def={defs.get(id) ?? null} label={appName(id)} />;

  const howLabel = name ? t("newAgentCard.how", g) : t("newAgentCard.howBlank");
  const toImport = () => {
    onClose();
    void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "import" } });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      // Narrow, the card's step is titled with its name, a back arrow before it; the list's needs no lead.
      title={steps && step === "card" && name ? name : t("newAgentCard.title")}
      description={steps ? undefined : t("newAgentCard.lead")}
      leading={
        steps && step === "card" ? (
          <Button
            ref={backButton}
            variant="ghost"
            size="sm"
            iconOnly
            icon="chevronLeft"
            aria-label={t("common.back")}
            onClick={() => {
              setLookOpen(false);
              setPreview(null);
              setStep("list");
            }}
          />
        ) : undefined
      }
      closeLabel={t("common.close")}
      width={1000}
      className="nac"
      onEscapeKeyDown={(e) => {
        // Esc closes the look first, then the dialog.
        if (lookOpen) {
          e.preventDefault();
          setLookOpen(false);
          setPreview(null);
        }
      }}
    >
      {/* The dialog's keys (arrows move the list, Enter creates) on a form: it holds the sections. */}
      <form
        className="nac__keys"
        data-steps={steps || undefined}
        data-step={steps ? step : undefined}
        onKeyDown={onKeyDown}
        onSubmit={(e) => e.preventDefault()}
      >
        <DialogBody>
          <div className="nac__grid">
            {onList && (
              <div className="nac__list" role="listbox" aria-label={t("newAgentCard.list")} ref={list}>
                <ListRow
                  pick="zero"
                  on={sel === "zero"}
                  face={
                    drafts.zero?.name.trim() || drafts.zero?.what.trim() ? (
                      <AgentAvatar appearance={drafts.zero.look} name={nameOf("zero")} />
                    ) : (
                      <span className="nac__blank">
                        <Icon name="plus" size={16} />
                      </span>
                    )
                  }
                  title={drafts.zero?.name.trim() || t("newAgentCard.zero")}
                  sub={drafts.zero?.what.trim() || t("newAgentCard.zeroSub")}
                  onPick={choose}
                />
                {personal ? (
                  <>
                    <p className="nac__group">{t("newAgent.roleGroups.personal")}</p>
                    {PERSONAL_STARTERS.map((s) => (
                      <ListRow
                        key={s.id}
                        pick={s.id}
                        on={sel === s.id}
                        face={<AgentAvatar appearance={drafts[s.id]?.look ?? s.look} name={nameOf(s.id)} />}
                        title={nameOf(s.id)}
                        sub={tt(`teamTemplates.agents.${s.id}.role`)}
                        onPick={choose}
                      />
                    ))}
                  </>
                ) : (
                  ROLE_GROUPS.map((group) => (
                    <div key={group.id} className="nac__groupbox">
                      <p className="nac__group">
                        <Icon name={GROUP_ICON[group.id]} size={14} />
                        {tt(`newAgent.roleGroups.${group.id}`)}
                      </p>
                      {group.roles.map((id) => (
                        <ListRow
                          key={id}
                          pick={id}
                          on={sel === id}
                          face={
                            <AgentAvatar
                              appearance={(drafts[id]?.look ?? ROLE_DEFAULTS[id].look) as Look}
                              name={nameOf(id)}
                            />
                          }
                          title={nameOf(id)}
                          sub={tt(`newAgent.roles.${id}.name`)}
                          onPick={choose}
                        />
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}

            {onCard && (
              <div className="tp-gallery__preview nac__card">
                <div className="nac__cover" ref={cover} data-look={lookOpen || undefined}>
                  <PixelSky
                    className="nac__sky"
                    options={agentCoverOptions(look.color as AgentColor, {
                      // It sits on the card's well: its last tone is the well's, in either theme.
                      surface: "--card-well",
                      clear: () => [hero.current, bubble.current, cover.current?.querySelector(".nac__acts") ?? null],
                      pool: facePool(cover, () => [hero.current]),
                    })}
                  />
                  <span className="nac__hero" ref={hero}>
                    <AgentAvatar
                      appearance={look}
                      name={name || t("newAgentCard.zero")}
                      size="xl"
                      framed={false}
                      reactionKey={REACTION}
                    />
                  </span>
                  {!lookOpen && (
                    <div className="nac__bubble" ref={bubble}>
                      <p className="nac__hi">
                        <span>
                          {name
                            ? t("newAgentCard.hi", g)
                            : tryName
                              ? t("newAgentCard.hi", agentGrammar(tryName))
                              : t("newAgentCard.hiBlank")}
                        </span>
                        <input
                          ref={nameInput}
                          className="nac__name"
                          value={draft.name}
                          maxLength={40}
                          placeholder={tryName ?? (sel === "zero" ? "…" : t("newAgentCard.namePlaceholder"))}
                          aria-label={t("newAgentCard.name")}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => update({ name: e.target.value })}
                          onFocus={() => gazeAt(bubble.current)}
                          onBlur={() => {
                            setGaze(null);
                            if (name) react();
                          }}
                        />
                        <span aria-hidden="true">.</span>
                      </p>
                      {ideas.length > 0 && (
                        <span className="nac__names">
                          <span>{t("newAgentCard.namesLead")}</span>
                          {ideas.map((idea) => (
                            <button
                              key={idea}
                              type="button"
                              className="nac__idea"
                              onPointerEnter={() => setTryName(idea)}
                              onPointerLeave={() => setTryName(null)}
                              onClick={() => {
                                setTryName(null);
                                update({ name: idea });
                                react();
                                burst(hero.current, look.color);
                              }}
                            >
                              {idea}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="nac__dice"
                            aria-label={t("newAgentCard.namesRoll")}
                            title={t("newAgentCard.namesRoll")}
                            onClick={() => void rollNames()}
                          >
                            <Icon name="shuffle" size={14} />
                          </button>
                        </span>
                      )}
                      <textarea
                        ref={whatInput}
                        className="nac__what"
                        rows={1}
                        value={draft.what}
                        maxLength={500}
                        placeholder={t("newAgentCard.whatPlaceholder")}
                        aria-label={t("newAgentCard.what")}
                        onChange={(e) => update({ what: e.target.value })}
                        onFocus={() => gazeAt(bubble.current)}
                        onBlur={() => setGaze(null)}
                      />
                      <Icon name="edit" size={14} className="nac__pen" />
                    </div>
                  )}
                  <span className="nac__acts">
                    <Button
                      size="sm"
                      icon={lookOpen ? "check" : "smile"}
                      className="nac__glass"
                      onClick={() => {
                        setLookOpen((o) => !o);
                        setPreview(null);
                      }}
                    >
                      {lookOpen ? t("newAgentCard.lookDone") : t("newAgentCard.look")}
                    </Button>
                    <Button
                      size="sm"
                      iconOnly
                      icon="shuffle"
                      className="nac__glass"
                      aria-label={t("newAgentCard.shuffle")}
                      title={t("newAgentCard.shuffle")}
                      onClick={() => void shuffle()}
                    />
                  </span>
                </div>

                <div className="nac__body" ref={body}>
                  {lookOpen ? (
                    <div className="nac__look">
                      <LookPicker look={draft.look} onPick={setLook} onPreview={setPreview} />
                    </div>
                  ) : (
                    <>
                      <span className="nac__handle">
                        {!name
                          ? roleName || t("newAgentCard.handleBlank")
                          : isTaken
                            ? t("newAgentCard.handleTaken", { ...g, handle })
                            : roleName
                              ? t("newAgentCard.handleRole", { handle, role: roleName })
                              : t("newAgentCard.handle", { handle })}
                      </span>
                      {similar && (
                        <span className="nac__similar">
                          <AgentAvatar
                            size="xs"
                            name={nameOf(similar)}
                            appearance={(starterOf(similar)?.look ?? ROLE_DEFAULTS[similar as TeamRole]?.look) as Look}
                          />
                          <span>{t("newAgentCard.similar", agentGrammar(nameOf(similar)))}</span>
                          <button type="button" className="ac-link" onClick={() => pick(similar)}>
                            {t("newAgentCard.similarAction", agentGrammar(nameOf(similar)))}
                          </button>
                        </span>
                      )}
                      <section className="nac__sec" aria-label={t("newAgentCard.uses")}>
                        <span className="nac__head">
                          <span className="nac__label">{t("newAgentCard.uses")}</span>
                          {managesAgents && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon="plus"
                              className="nac__plus"
                              aria-haspopup="dialog"
                              onClick={() => setPicking(true)}
                            >
                              {appIds.length ? t("newAgentCard.otherApp") : t("newAgentCard.chooseApps")}
                            </Button>
                          )}
                        </span>
                        <span className="nac__chips">
                          {appIds.length === 0 && <span className="nac__none">{t("newAgentCard.usesNone")}</span>}
                          {appIds.map((id) => (
                            <button key={id} type="button" className="ac-chip nac__app" onClick={() => setAppOpen(id)}>
                              {appIcon(id)}
                              <span className="ac-chip__text">{appName(id)}</span>
                              <span className="nac__level">{tt(`newAgentCard.level.${draft.apps[id] ?? "read"}`)}</span>
                            </button>
                          ))}
                        </span>
                      </section>
                      {skillsShown && (
                        <section className="nac__sec" aria-label={t("newAgentCard.skills")}>
                          <span className="nac__head">
                            <span className="nac__label">
                              {t("newAgentCard.skills")}
                              <span className="nac__help">
                                {" · "}
                                {name ? t("newAgent.skillsHelp", g) : t("newAgentCard.skillsHelpBlank")}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={addingSkills ? "chevronUp" : "plus"}
                              className="nac__plus"
                              aria-expanded={addingSkills}
                              disabled={skillsLeft.length === 0 && !addingSkills}
                              onClick={() => setAddingSkills((a) => !a)}
                            >
                              {chosenSkills.length ? t("newAgentCard.otherSkill") : t("newAgentCard.chooseSkills")}
                            </Button>
                          </span>
                          <span className="nac__chips">
                            {chosenSkills.length === 0 && (
                              <span className="nac__none">{t("newAgentCard.usesNone")}</span>
                            )}
                            {chosenSkills.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="ac-chip nac__app"
                                onClick={() => setSkillOpen(id)}
                              >
                                <Icon name="book" size={14} />
                                <span className="ac-chip__text">{skillName(id)}</span>
                              </button>
                            ))}
                          </span>
                          {addingSkills && skillsLeft.length > 0 && (
                            <span className="nac__offer">
                              {skillsLeft.map((s) => (
                                <button
                                  key={s.id}
                                  type="button"
                                  className="ac-chip nac__add"
                                  onClick={() => update({ skills: [...chosenSkills, s.id] })}
                                >
                                  <Icon name="book" size={14} />
                                  <span className="ac-chip__text">{s.name}</span>
                                  <Icon name="plus" size={14} />
                                </button>
                              ))}
                            </span>
                          )}
                        </section>
                      )}
                      {!personal && joins.length > 0 && (
                        <section className="nac__sec" aria-label={t("newAgentCard.worksIn")}>
                          <span className="nac__label">{t("newAgentCard.worksIn")}</span>
                          <span className="nac__chips">
                            {joins.map((c) => (
                              <span key={c.id} className="ac-chip">
                                <Icon name="channel" size={14} />
                                <span className="ac-chip__text">#{c.name}</span>
                              </span>
                            ))}
                          </span>
                        </section>
                      )}
                      <section className="nac__sec" aria-label={howLabel}>
                        <span className="nac__label">{howLabel}</span>
                        <span className="nac__how">
                          <textarea
                            ref={howInput}
                            className="nac__instr"
                            rows={3}
                            value={draft.instructions}
                            maxLength={50_000}
                            placeholder={t("newAgentCard.instructionsPlaceholder")}
                            aria-label={t("newAgent.instructions")}
                            onChange={(e) => update({ instructions: e.target.value })}
                          />
                          <Icon name="edit" size={14} className="nac__pen" />
                        </span>
                        <span className="nac__tips">
                          {TIPS.map((tip) => (
                            <Button key={tip} size="sm" variant="ghost" icon="plus" onClick={() => addTip(tip)}>
                              {t(`newAgent.tips.${tip}.title`)}
                            </Button>
                          ))}
                        </span>
                      </section>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogBody>
        {steps && step === "card" ? (
          // Narrow, the card's step ends on Create alone, the width of the sheet.
          <DialogFooter className="nac__foot nac__foot--create">
            <Button variant="primary" block loading={busy} disabled={!ready} onClick={() => void submit()}>
              {name ? t("newAgentCard.create", { name }) : t("newAgentCard.createBlank")}
            </Button>
          </DialogFooter>
        ) : (
          // Left: the import, and while nothing here can think, Connect AI over this dialog (the draft stays). Narrow,
          // the list's step has no Create: a row leads to its card.
          <DialogFooter
            className="nac__foot"
            note={
              <span className="nac__foot-left">
                <button type="button" className="ac-link nac__import" onClick={toImport}>
                  <Icon name="download" size={16} />
                  {t("newAgentCard.import")}
                </button>
                {!brain.hasAi && connectAi && (
                  <Button size="sm" icon="bolt" onClick={() => connectAi.open({ forNewAgent: true })}>
                    {t("noAi.banner.orgAction")}
                  </Button>
                )}
              </span>
            }
          >
            {!steps && (
              <>
                <Button onClick={onClose} disabled={busy}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" kbd={["↵"]} loading={busy} disabled={!ready} onClick={() => void submit()}>
                  {name ? t("newAgentCard.create", { name }) : t("newAgentCard.createBlank")}
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </form>
      {skillOpen && (
        <SkillDialog
          skillId={skillOpen}
          agentName={name}
          onRemove={() => {
            update({ skills: chosenSkills.filter((id) => id !== skillOpen) });
            setSkillOpen(null);
          }}
          onClose={() => setSkillOpen(null)}
        />
      )}
      {appOpen && (
        <AppLevelDialog
          def={defs.get(appOpen) ?? null}
          name={appName(appOpen)}
          agentName={name}
          level={draft.apps[appOpen] ?? "read"}
          onDone={(level) => {
            update({ apps: { ...draft.apps, [appOpen]: level } });
            setAppOpen(null);
          }}
          onRemove={() => {
            const { [appOpen]: _gone, ...rest } = draft.apps;
            update({ apps: rest });
            setAppOpen(null);
          }}
          onClose={() => setAppOpen(null)}
        />
      )}
      {picking && (
        <AppsPickerDialog
          agentName={name}
          connectors={catalog.data?.connectors ?? []}
          suggested={Object.keys(starterApps({ role, starter: starter?.id ?? null }))}
          connected={new Set(connectedApps.keys())}
          onCard={new Set(appIds)}
          canConnect={can(org, "manage_connectors")}
          onUse={(d) => takeApp(d.id)}
          onConnect={connectApp}
          onClose={() => setPicking(false)}
        />
      )}
      {/* Signing in on the provider's page comes back here, to this card (`takeResume`). */}
      <ConnectFlow
        flow={flow}
        onChange={setFlow}
        onClose={() => {
          // Closed here, nothing comes back from a provider's page; one that did connect still lands on the card.
          setFlow(null);
          forgetReturn();
        }}
        returnTo={typeof window === "undefined" ? undefined : `${window.location.pathname}?${RESUME_PARAM}=resume`}
      />
    </Dialog>
  );
}

/** The card's own face reacts (a hop and hearts) through this key. */
const REACTION = "new-agent-card";

const burst = (el: Element | null | undefined, color: string) => {
  if (!el || prefersReducedMotion()) return;
  const r = el.getBoundingClientRect();
  const c = color as AgentColor;
  pixelBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, agentTones(c), spriteTone(c));
};

/** The row's face when it was picked with the pointer (its hop starts there); none from the keyboard. */
const pointerFace = (e: ReactMouseEvent<HTMLButtonElement>) =>
  e.detail === 0 ? null : e.currentTarget.querySelector<HTMLElement>(".ac-avatar");

function ListRow({
  pick,
  on,
  face,
  title,
  sub,
  onPick,
}: {
  pick: Pick;
  on: boolean;
  face: ReactNode;
  title: string;
  sub: string;
  onPick: (pick: Pick, from?: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      tabIndex={on ? 0 : -1}
      data-pick={pick}
      // A face beside two lines: the name's capitals start at its top (`ac-faceline`), never centred on both lines;
      // an accessory drawn above the tile is ink, not layout, so it moves nothing.
      className="tp-gallery__item ac-faceline nac__item"
      onClick={(e) => onPick(pick, pointerFace(e))}
    >
      <span className="tp-gallery__faces nac__face" aria-hidden="true">
        {face}
      </span>
      <span className="tp-gallery__text">
        <b className="ac-captop">{title}</b>
        <small>{sub}</small>
      </span>
    </button>
  );
}

/** One skill on the card: what it is, the start of its manual, and taking it off. */
function SkillDialog({
  skillId,
  agentName,
  onRemove,
  onClose,
}: {
  skillId: string;
  agentName: string;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const skill = useSkill(org.id, skillId);
  const g = agentGrammar(agentName);
  const body = skill.data?.body.trim() ?? "";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={skill.data?.name ?? ""}
      leading={
        <span className="nac-skill__lead">
          <Icon name="book" size={18} />
        </span>
      }
      closeLabel={t("common.close")}
      width={460}
      className="nac-app"
    >
      <DialogBody>
        {skill.data?.description && <p className="nac-skill__line">{skill.data.description}</p>}
        {body && (
          <blockquote className="nac-skill__body">{body.length > 280 ? `${body.slice(0, 280)}…` : body}</blockquote>
        )}
        <p className="nac-app__asks ac-iconline">
          <Icon name="info" size={16} />
          <span>{agentName ? t("newAgentCard.skill.opens", g) : t("newAgentCard.skill.opensBlank")}</span>
        </p>
      </DialogBody>
      <DialogFooter
        note={
          <button type="button" className="ac-link" onClick={onRemove}>
            {agentName ? t("newAgentCard.skill.remove", g) : t("newAgentCard.skill.removeBlank")}
          </button>
        }
      >
        <Button variant="primary" onClick={onClose}>
          {t("newAgentCard.skill.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** One app on the card: how far the new agent goes there, what always asks first, and taking it off. */
function AppLevelDialog({
  def,
  name,
  agentName,
  level,
  onDone,
  onRemove,
  onClose,
}: {
  def: ConnectorDef | null;
  name: string;
  agentName: string;
  level: CardLevel;
  onDone: (level: CardLevel) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<CardLevel>(level);
  const asks = (def?.scopes ?? []).filter((s) => s.sensitive).map((s) => scopeText(t, s).label);
  const g = agentGrammar(agentName);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={name}
      leading={<ConnectorIcon def={def} label={name} />}
      description={
        agentName ? t("newAgentCard.app.lead", { ...g, app: name }) : t("newAgentCard.app.leadBlank", { app: name })
      }
      closeLabel={t("common.close")}
      width={460}
      className="nac-app"
    >
      <DialogBody>
        <OptionList<CardLevel>
          aria-label={name}
          value={value}
          onValueChange={setValue}
          options={[
            {
              value: "read",
              title: t("newAgentCard.app.read"),
              description: t("newAgentCard.app.readDesc", { app: name }),
            },
            {
              value: "write",
              title: t("newAgentCard.app.write"),
              description: t("newAgentCard.app.writeDesc", { app: name }),
            },
          ]}
        />
        <p className="nac-app__asks ac-iconline">
          <Icon name="shield" size={16} />
          <span>
            {asks.length > 0
              ? t("newAgentCard.app.asks", { actions: asks.slice(0, 3).join(", ") })
              : t("newAgentCard.app.asksAny")}
          </span>
        </p>
      </DialogBody>
      <DialogFooter
        note={
          <button type="button" className="ac-link" onClick={onRemove}>
            {t("newAgentCard.app.remove", { app: name })}
          </button>
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => onDone(value)}>
          {t("newAgentCard.app.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The new agent's flight (ADR 0164): from its card to its row in the sidebar, once that row is drawn, with a burst
 * where it lands. Its row's own face hides while it flies. Never with reduced motion (it isn't started then).
 */
function AgentFlight({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let stop = false;
    let tries = 0;
    let target: HTMLElement | null = null;
    const land = () => {
      if (target) target.style.visibility = "";
      done.current();
    };
    const go = () => {
      if (stop) return;
      target = document.querySelector<HTMLElement>(`[data-agent-row="${flight.agentId}"] .ac-avatar`);
      const me = el.current;
      if (!target || !me) {
        // Its row comes with the next agents' list; give up after about two seconds.
        if (++tries < 120) requestAnimationFrame(go);
        else land();
        return;
      }
      const to = target.getBoundingClientRect();
      const from = flight.from;
      target.style.visibility = "hidden";
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const k = to.width / (from.width || 1);
      me.animate(
        [
          { transform: "none" },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 70}px) scale(${((1 + k) / 2) * 1.06})`, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px) scale(${k})` },
        ],
        { duration: 760, easing: "cubic-bezier(.3,.7,.2,1)", fill: "forwards" },
      ).finished.then(
        () => {
          burst(target, flight.look.color);
          land();
        },
        () => land(),
      );
    };
    requestAnimationFrame(go);
    return () => {
      stop = true;
      if (target) target.style.visibility = "";
    };
  }, [flight]);
  const r = flight.from;
  return createPortal(
    <div
      ref={el}
      className="nac-flight"
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      aria-hidden="true"
    >
      <AgentAvatar appearance={flight.look} name="" size="xl" framed={false} />
    </div>,
    document.body,
  );
}
