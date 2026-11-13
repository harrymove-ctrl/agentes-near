import type { Agent, AgentAudience, AgentDetail, AgentInput, AgentSkill } from "@agenteschat/client";
import {
  keys,
  useAgentAccess,
  useAgentDetail,
  useAgentGroups,
  useAgentRepos,
  useAgentSkills,
  useCredentials,
  useModels,
  useProposals,
  useRuns,
  useSettings,
  useUpdateAgent,
} from "@agenteschat/client";
import { type Level, levelsOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { groupOf, NO_GROUP } from "@agenteschat/client/lib/agent-groups";
import { audienceOf, audiencePatch, seesDetails } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { pendingOnAgent } from "@agenteschat/client/lib/proposals";
import { isAuto } from "@agenteschat/client/lib/providers";
import { type RepoChoice, repoChoiceOf, repoListOf, reposText } from "@agenteschat/client/lib/repos";
import { isRightHand, tellsNameStory } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  colorKey,
  cx,
  Dialog,
  DialogFooter,
  EmptyState,
  Icon,
  type IconName,
  Menu,
  MenuItem,
  normalizeAppearance,
  PageHeader,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { resourceName, useConnectedById, useSetLevels } from "@/components/AccessLevels";
import { audienceValid } from "@/components/AgentAudience";
import { DEFAULT_KEY, keyOptions, NO_OWNER, usd } from "@/components/AgentFields";
import { DeleteAgentDialog } from "@/components/DeleteAgentDialog";
import { LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useWidenAsk } from "@/components/ReachLines";
import { RightHandSettingsSection } from "@/components/RightHandSettings";
import { useDirectory } from "@/hooks/useDirectory";
import {
  AGENT_TABS,
  type AgentSection,
  type AgentTab,
  type BrainScreen,
  budgetValue,
  canEdit,
  changedKeys,
  channelsAfter,
  dropFields,
  type Edits,
  FIELD_PLACE,
  type Field,
  type Look,
  lineChanges,
  PERSONAL_AGENT_TABS,
  revertKey,
  type Saved,
  shownAgentTab,
  thisMonth,
  type Viewer,
} from "@/lib/agent-edit";
import { fullLook, lookOf } from "@/lib/look";
import { handleAfterRename, handleProblemText, readBudget, takenHandles } from "@/lib/new-agent";
import { useToast } from "@/lib/toast";
import { AccessTab } from "./agent/AccessTab";
import { ActivityTab } from "./agent/ActivityTab";
import { AdvancedTab } from "./agent/AdvancedTab";
import { type AgentEdit, AgentEditProvider, type Change, type Draft } from "./agent/context";
import { FilesTab } from "./agent/FilesTab";
import { AgentHero } from "./agent/Hero";
import { InstructionsTab } from "./agent/InstructionsTab";
import { MemoryTab } from "./agent/MemoryTab";
import { OverviewTab } from "./agent/OverviewTab";
import { AgentPublicCard } from "./agent/PublicCard";
import { useVisibleChannels } from "./agent/pieces";
import { RepoDialog } from "./agent/Repos";
import { SaveBar } from "./agent/SaveBar";
import { SettingsTab } from "./agent/SettingsTab";
import { UsageTab } from "./agent/UsageTab";
import { type WorkDialog, WorkDialogs } from "./agent/Work";

const sortIds = (ids: string[]) => [...ids].sort();

/**
 * The tabs always in the bar; the rest live in its "More" menu, and the one open from there shows in the bar. A
 * personal workspace's bar (ADR 0159 §3) is `PERSONAL_AGENT_TABS`, with Advanced instead of "More".
 */
const MAIN_TABS: AgentTab[] = ["overview", "instructions", "memory", "activity"];
const MORE_TABS = AGENT_TABS.filter((id) => !MAIN_TABS.includes(id) && id !== "advanced");
const PERSONAL_TABS: readonly AgentTab[] = PERSONAL_AGENT_TABS;
const MORE_ICON: Partial<Record<AgentTab, IconName>> = {
  access: "plug",
  files: "file",
  usage: "clock",
  settings: "settings",
};

export interface AgentPageProps {
  agentId: string;
  tab: AgentTab;
  section?: AgentSection;
  /** With the section "brain": the screen "Quem pensa" opens on (a notification's "Escolher outro modelo"). */
  brainAt?: BrainScreen;
  /** The memory or skill a link opened Memória at. */
  item?: string;
  /** Changes the tab (and section) in the URL. */
  onNavigate: (tab: AgentTab, section?: AgentSection) => void;
  /** Shown in the panel beside its DM (like a thread's), not as a page: closes the panel. */
  onClose?: () => void;
  /** The panel was asked to close (a new number each time): close, asking first when something is unsaved. */
  closeRequest?: number;
}

/** The agent page: the agent on its sky, tabs, inline editing with one save bar. */
export function AgentPage(props: AgentPageProps) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(props.agentId);
  // Only the full profile edits, so only it asks before closing; every other view here closes on the request.
  const full = Boolean(agent && !dir.loading && seesDetails(agent) && !isRightHand(agent));
  const closeRef = useRef(props.onClose);
  closeRef.current = full ? undefined : props.onClose;
  useEffect(() => {
    if (props.closeRequest) closeRef.current?.();
  }, [props.closeRequest]);
  if (dir.loading) {
    return (
      <div className="page page--full">
        <LoadingPage rows={6} />
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="page page--full">
        <EmptyState icon="agent">{t("agent.notFound")}</EmptyState>
      </div>
    );
  }
  // The right hand (ADR 0137) has no tabs: its instructions are the product's. Its page is its settings, each
  // person's own and, for who manages agents, the workspace's.
  if (isRightHand(agent)) {
    return (
      <div className="page page--full">
        <PageHeader title={agent.name} meta={t("settings.sectionText.right_hand")} />
        {tellsNameStory(agent) && <p className="small muted">{t("rightHand.profile.nameStory")}</p>}
        <RightHandSettingsSection agent={agent} />
      </div>
    );
  }
  if (!seesDetails(agent)) return <AgentPublicCard agent={agent} />;
  return <AgentProfile key={agent.id} agent={agent} {...props} />;
}

function AgentProfile({
  agent,
  tab,
  section,
  brainAt,
  item,
  onNavigate,
  onClose,
  closeRequest,
}: AgentPageProps & { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const dir = useDirectory(org.id);
  const admin = can(org, "manage_agents");
  const viewer: Viewer = admin ? "admin" : agent.ownerUserId === me.user.id ? "owner" : "member";
  // A personal workspace's page (ADR 0159 §3): a shorter bar, the hard parts in Advanced; every address still works.
  const personal = isPersonal(org);
  const view = shownAgentTab(tab, section, personal);
  const models = useModels();
  const detail = useAgentDetail(org.id, agent.id);
  const settings = useSettings(org.id);
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const access = useAgentAccess(org.id, agent.id);
  const repos = useAgentRepos(org.id, agent.id);
  const groups = useAgentGroups(org.id);
  const library = useAgentSkills(org.id, agent.id);
  const proposals = useProposals(org.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const visible = useVisibleChannels();
  const items = useConnectedById();
  const update = useUpdateAgent(org.id, agent.id);
  const asks = useWidenAsk(agent);
  const setLevels = useSetLevels();
  const [edits, setEdits] = useState<Edits>({});
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** The dialog of the sentence under the name that is open (who thinks, where it works, the browser). */
  const [work, setWork] = useState<WorkDialog | null>(null);
  /** The repositories picker: open, with a repository to add ("Liberar"). */
  const [picking, setPicking] = useState<{ add?: string } | null>(null);
  const top = useRef<HTMLDivElement>(null);

  /* ---------- What the server has ---------- */

  const resources = useMemo(() => (access.data ? resourcesOf(access.data) : []), [access.data]);
  const saved = useMemo<Saved>(() => {
    const d: AgentDetail | undefined = detail.data;
    const visibleIds = new Set(visible.list.map((c) => c.id));
    const cred = d?.credentialId ?? null;
    return {
      name: agent.name,
      handle: agent.handle,
      role: agent.role ?? "",
      look: fullLook(lookOf(agent)),
      instructions: agent.instructions,
      model: agent.model,
      key:
        admin && d && settings.data
          ? cred && cred !== settings.data.defaultCredentialId
            ? cred
            : DEFAULT_KEY
          : undefined,
      budget: admin && d ? (d.monthlyBudgetUsd ?? null) : undefined,
      owner: agent.ownerUserId ?? NO_OWNER,
      audience: audienceOf(agent),
      levels: access.data ? levelsOf(access.data) : undefined,
      repos: repos.data ? repoChoiceOf(repos.data) : undefined,
      skills: library.data ? sortIds(library.data.filter((s) => s.enabled).map((s) => s.id)) : undefined,
      channels:
        d && visible.ready ? sortIds(d.channels.map((c) => c.id).filter((id) => visibleIds.has(id))) : undefined,
      group: groups.data ? (groupOf(groups.data, agent.id)?.id ?? NO_GROUP) : undefined,
    };
  }, [agent, admin, detail.data, settings.data, access.data, repos.data, library.data, visible, groups.data]);

  /* ---------- The draft ---------- */

  const draft: Draft = {
    name: edits.name ?? saved.name,
    handle: handleAfterRename(saved, edits.name ?? saved.name, edits.handle),
    role: edits.role ?? saved.role,
    look: edits.look ?? saved.look,
    instructions: edits.instructions ?? saved.instructions,
    model: edits.model ?? saved.model,
    key: edits.key ?? saved.key,
    budget:
      edits.budget ??
      (saved.budget === undefined || saved.budget === null
        ? ""
        : new Intl.NumberFormat(i18n.language, { useGrouping: false, maximumFractionDigits: 2 }).format(saved.budget)),
    owner: edits.owner ?? saved.owner,
    audience: edits.audience ?? saved.audience,
    levels: { ...(saved.levels ?? {}), ...(edits.levels ?? {}) },
    repos: edits.repos ?? saved.repos,
    skills: edits.skills ?? saved.skills,
    channels: edits.channels ?? saved.channels,
    group: edits.group ?? saved.group,
  };

  /* ---------- What changed, said in words ---------- */

  const g = agentGrammar(agent.name);
  const ownerFirst = agent.ownerUserId ? (dir.memberById.get(agent.ownerUserId)?.name.split(/\s+/)[0] ?? null) : null;
  const lookText = (l: Look) =>
    [
      t(`look.colors.${colorKey(l.color)}`),
      t(`look.eyesNames.${l.eyes}`),
      ...(l.accessory !== "none" ? [t(`look.accessories.${l.accessory}`)] : []),
    ].join(" · ");
  const memberName = (id: string) =>
    id === NO_OWNER ? t("newAgent.noOwnerOption") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  const audienceText = (a: AgentAudience, owner: string) => {
    const first = (id: string) => memberName(id).split(/\s+/)[0] ?? "";
    if (a.mode === "everyone") return t("audience.summary.everyone");
    if (a.mode === "owner")
      return owner === NO_OWNER ? t("audience.summary.nobody") : t("audience.summary.owner", { name: first(owner) });
    const ids = [...new Set([...(owner === NO_OWNER ? [] : [owner]), ...a.userIds])];
    const roles = (a.roleIds ?? []).flatMap((id) => dir.roleName(id) ?? []);
    const names = [...roles, ...ids.map(first)];
    return names.length ? joinNames(names, t) : t("audience.summary.nobody");
  };
  const budgetText = (amount: number | null) =>
    amount === null
      ? settings.data?.defaultAgentBudgetUsd === undefined
        ? t("agentPage.budgetDefault")
        : t("agentPage.budgetDefaultAmount", { amount: usd(t, i18n.language, settings.data.defaultAgentBudgetUsd) })
      : t("agentPage.perMonth", { amount: usd(t, i18n.language, amount) });
  const keyText = (k: string) =>
    keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null).find((o) => o.value === k)
      ?.label ?? t("newAgent.defaultKey");
  const channelText = (ids: string[]) =>
    ids.length
      ? ids.map((id) => `#${visible.list.find((c) => c.id === id)?.name ?? ""}`).join(", ")
      : t("agentPage.none");
  const modelText = (id: string) =>
    isAuto(id) ? t("brain.auto.label") : (models.data?.models.find((m) => m.id === id)?.label ?? id);
  const groupText = (id: string | undefined) => groups.data?.find((g) => g.id === id)?.name ?? t("agentGroups.none");
  const resourceById = new Map(resources.map((r) => [r.id, r]));

  const changes: Change[] = changedKeys(saved, edits).map(({ key, field, resource }) => {
    const place = FIELD_PLACE[field];
    // In a personal workspace the built-in areas' levels and the skills are in Advanced, as Configurações' advanced
    // sections are; the apps' levels stay in "Can use".
    const advanced =
      personal &&
      (field === "skills" || (field === "levels" && resourceById.get(resource ?? "")?.kind !== "connector"));
    const base = {
      key,
      field,
      tab: advanced ? ("advanced" as const) : shownAgentTab(place.tab, place.sec, personal),
      sec: place.sec,
    };
    const label = (f: Field) => t(`agentPage.fields.${f}`);
    switch (field) {
      case "name":
        return { ...base, label: label("name"), was: saved.name, now: draft.name || t("agentPage.empty") };
      case "handle":
        return { ...base, label: label("handle"), was: `@${saved.handle}`, now: `@${draft.handle}` };
      case "role":
        return {
          ...base,
          label: label("role"),
          was: saved.role || t("agentPage.empty"),
          now: draft.role || t("agentPage.empty"),
        };
      case "look":
        return { ...base, label: label("look"), was: lookText(saved.look), now: lookText(draft.look) };
      case "instructions": {
        const { added, removed } = lineChanges(saved.instructions, draft.instructions);
        const parts = [
          added ? t("agentPage.lines.added", { count: added }) : "",
          removed ? t("agentPage.lines.removed", { count: removed }) : "",
        ].filter(Boolean);
        return { ...base, label: label("instructions"), was: "", now: parts.join(", ") || t("agentPage.lines.edited") };
      }
      case "levels": {
        const r = resource ? resourceById.get(resource) : undefined;
        return {
          ...base,
          label: r ? resourceName(t, r, items) : label("levels"),
          was: t(`access.level.${saved.levels?.[resource ?? ""] ?? "none"}`),
          now: t(`access.level.${draft.levels[resource ?? ""] ?? "none"}`),
        };
      }
      case "repos":
        return {
          ...base,
          label: label("repos"),
          was: saved.repos ? reposText(t, saved.repos) : "",
          now: draft.repos ? reposText(t, draft.repos) : "",
        };
      case "skills":
        return {
          ...base,
          label: label("skills"),
          was: t("agentPage.skillsOn", { count: saved.skills?.length ?? 0 }),
          now: t("agentPage.skillsOn", { count: draft.skills?.length ?? 0 }),
        };
      case "model":
        return { ...base, label: label("model"), was: modelText(saved.model), now: modelText(draft.model) };
      case "key":
        return {
          ...base,
          label: label("key"),
          was: keyText(saved.key ?? DEFAULT_KEY),
          now: keyText(draft.key ?? DEFAULT_KEY),
        };
      case "budget": {
        const now = budgetValue(draft.budget);
        return {
          ...base,
          label: label("budget"),
          was: budgetText(saved.budget ?? null),
          now: now === undefined ? draft.budget : budgetText(now),
        };
      }
      case "owner":
        return { ...base, label: label("owner"), was: memberName(saved.owner), now: memberName(draft.owner) };
      case "audience":
        return {
          ...base,
          label: label("audience"),
          was: audienceText(saved.audience, saved.owner),
          now: audienceText(draft.audience, draft.owner),
        };
      case "channels":
        return {
          ...base,
          label: label("channels"),
          was: channelText(saved.channels ?? []),
          now: channelText(draft.channels ?? []),
        };
      case "group":
        return { ...base, label: label("group"), was: groupText(saved.group), now: groupText(draft.group) };
      default:
        // The computer and who thinks are saved by their own dialogs (the sentence under the name).
        return { ...base, label: label(field), was: "", now: "" };
    }
  });
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const fields = new Set(changes.map((c) => c.field));
  const errors = {
    name: fields.has("name") && !draft.name.trim() ? t("newAgent.errors.nameRequired") : undefined,
    handle: fields.has("handle")
      ? (handleProblemText(t, draft.handle, takenHandles(dir.agents, dir.members, agent.id)) ?? undefined)
      : undefined,
    budget: edits.budget !== undefined && readBudget(edits.budget).invalid ? t("agent.budgetInvalid") : undefined,
    audience:
      (fields.has("audience") || fields.has("owner")) &&
      !audienceValid(draft.audience, draft.owner === NO_OWNER ? null : draft.owner)
        ? draft.audience.mode === "owner"
          ? t("audience.modeText.noOwner")
          : t("audience.pickSomeone")
        : undefined,
    repos:
      fields.has("repos") && draft.repos?.mode === "some" && draft.repos.list.length === 0
        ? t("repos.emptyError")
        : undefined,
  };
  const problem = errors.name ?? errors.handle ?? errors.budget ?? errors.audience ?? errors.repos;
  const dirty = changes.length > 0;

  /* ---------- Editing ---------- */

  const set: AgentEdit["set"] = (field, value) => setEdits((e) => ({ ...e, [field]: value }));
  const setLevel = (id: string, level: Level) =>
    setEdits((e) => ({ ...e, levels: { ...(e.levels ?? {}), [id]: level } }));
  // Undoing the @ a new name gave keeps the one it has; any other change goes back to what is saved.
  const revert = (key: string) =>
    setEdits((e) => (key === "handle" ? { ...e, handle: saved.handle } : revertKey(e, key)));
  const discard = () => setEdits({});

  const goTo = (next: AgentTab, sec?: AgentSection) => {
    onNavigate(next, sec);
    const el = top.current;
    // The tabs stay where they are; the content starts from the top of the tabs.
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView?.({ block: "start" });
  };
  // "Quem pensa" is a dialog, not a section: a link to it opens the dialog.
  useEffect(() => {
    if (section === "brain") setWork("brain");
  }, [section]);
  // A section in the URL: scroll to it once Configurações shows.
  useEffect(() => {
    if ((view !== "settings" && view !== "advanced") || !section) return;
    const timer = setTimeout(() =>
      document.getElementById(`agp-sec-${section}`)?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
    return () => clearTimeout(timer);
  }, [view, section]);

  /* ---------- Saving ---------- */

  const save = async (): Promise<boolean> => {
    if (saving) return false;
    if (!dirty) return true;
    if (problem) {
      toast.show(problem, "error");
      return false;
    }
    if (fields.has("audience") && !(await asks.ask(draft.audience)([]))) return false;
    setSaving(true);
    const done: Field[] = [];
    let failed = false;
    const fail = (e: unknown, silent: boolean) => {
      failed = true;
      if (silent) toast.show(errorText(t, e), "error");
    };
    // 1. The agent itself: one PATCH (the owner may send only the look and the audience).
    const patch: Partial<AgentInput> = {};
    const patchFields: Field[] = [];
    const put = <K extends keyof typeof patch>(field: Field, k: K, v: (typeof patch)[K]) => {
      patch[k] = v;
      patchFields.push(field);
    };
    if (fields.has("name")) put("name", "name", draft.name.trim());
    if (fields.has("handle")) put("handle", "handle", draft.handle);
    if (fields.has("role")) put("role", "role", draft.role.trim());
    if (fields.has("instructions")) put("instructions", "instructions", draft.instructions);
    if (fields.has("model")) put("model", "model", draft.model);
    if (fields.has("key")) put("key", "credentialId", draft.key === DEFAULT_KEY ? null : (draft.key ?? null));
    if (fields.has("budget")) put("budget", "monthlyBudgetUsd", budgetValue(draft.budget) ?? null);
    if (fields.has("owner")) put("owner", "ownerUserId", draft.owner === NO_OWNER ? null : draft.owner);
    if (fields.has("audience")) {
      put("audience", "audience", audiencePatch(draft.audience));
    }
    if (fields.has("look")) put("look", "appearance", normalizeAppearance(draft.look));
    if (patchFields.length > 0) {
      try {
        const next = await update.mutateAsync(patch);
        // Show the saved values at once (the lists refetch behind).
        qc.setQueryData<Agent[]>(keys.agents(org.id), (list) =>
          list?.map((a) => (a.id === agent.id ? { ...a, ...next } : a)),
        );
        if (patch.credentialId !== undefined || patch.monthlyBudgetUsd !== undefined) {
          qc.setQueryData<AgentDetail>(keys.agentDetail(org.id, agent.id), (old) =>
            old
              ? {
                  ...old,
                  ...(patch.credentialId !== undefined ? { credentialId: patch.credentialId } : {}),
                  ...(patch.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: patch.monthlyBudgetUsd } : {}),
                }
              : old,
          );
        }
        done.push(...patchFields);
      } catch (e) {
        fail(e, false);
      }
    }
    // 2. Access levels: one write (reads the grants fresh, sets every changed level).
    if (!failed && fields.has("levels")) {
      const levels: Record<string, Level> = {};
      for (const c of changes) {
        const id = c.key.slice("levels:".length);
        const l = edits.levels?.[id];
        if (c.field === "levels" && l) levels[id] = l;
      }
      try {
        await setLevels.mutateAsync({ agentId: agent.id, changes: levels });
        done.push("levels");
      } catch (e) {
        fail(e, false);
      }
    }
    // 2b. GitHub repositories: the whole ordered list (empty = every repository).
    if (!failed && fields.has("repos") && draft.repos) {
      try {
        const next = await api.repositories.set(org.id, agent.id, repoListOf(draft.repos));
        qc.setQueryData<string[]>(keys.agentRepos(org.id, agent.id), next);
        done.push("repos");
      } catch (e) {
        fail(e, true);
      }
    }
    // 3. Skills: the whole library with on/off.
    if (!failed && fields.has("skills") && library.data) {
      try {
        const on = new Set(draft.skills ?? []);
        const next = await api.skills.setForAgent(
          org.id,
          agent.id,
          library.data.map((s) => ({ skillId: s.id, enabled: on.has(s.id) })),
        );
        qc.setQueryData<AgentSkill[]>(keys.agentSkills(org.id, agent.id), next);
        void qc.invalidateQueries({ queryKey: keys.skills(org.id) });
        done.push("skills");
      } catch (e) {
        fail(e, true);
      }
    }
    // 4. Channels: the PUT replaces the list, so start from what the server has now (DMs, private channels).
    if (!failed && fields.has("channels")) {
      try {
        const current = await api.agents.channels(org.id, agent.id);
        const next = await api.agents.setChannels(
          org.id,
          agent.id,
          channelsAfter(current, saved.channels ?? [], draft.channels ?? []),
        );
        qc.setQueryData<AgentDetail>(keys.agentDetail(org.id, agent.id), (old) =>
          old ? { ...old, channels: next } : old,
        );
        void qc.invalidateQueries({ queryKey: keys.agentDetail(org.id, agent.id) });
        done.push("channels");
      } catch (e) {
        fail(e, true);
      }
    }
    // 5. Its group (at the end of the chosen one).
    if (!failed && fields.has("group") && draft.group) {
      try {
        const next = await api.agentGroups.move(org.id, agent.id, {
          groupId: draft.group === NO_GROUP ? null : draft.group,
        });
        qc.setQueryData(keys.agentGroups(org.id), next);
        done.push("group");
      } catch (e) {
        fail(e, true);
      }
    }
    setEdits((e) => dropFields(e, done));
    setSaving(false);
    if (!failed) toast.show(t("agent.savedToast", agentGrammar(draft.name.trim() || agent.name)));
    return !failed;
  };

  // ⌘/Ctrl+S saves.
  const keyboard = useRef({ save, dirty });
  keyboard.current = { save, dirty };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        if (!keyboard.current.dirty) return;
        e.preventDefault();
        void keyboard.current.save();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- Leaving with unsaved changes ---------- */

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirtyRef.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  });

  // Closing the panel with unsaved changes asks first, like leaving the page.
  const [closing, setClosing] = useState(false);
  const close = onClose && (() => (dirtyRef.current ? setClosing(true) : onClose()));
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (closeRequest) closeRef.current?.();
  }, [closeRequest]);

  /* ---------- Archiving and deleting ---------- */

  /** Out of the team: its page closes on the workspace (its unsaved changes go with it). */
  const leave = () => {
    setEdits({});
    dirtyRef.current = false;
    void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
  };
  const archive = useMutation({
    mutationFn: () => api.agents.archive(org.id, agent.id),
    onSuccess: () => {
      setArchiving(false);
      // Desfazer runs after this page closed: the call's own promise, never a mutation's callbacks.
      toast.show(t("agentPage.archive.done", g), "success", {
        label: t("agentPage.undo"),
        run: () =>
          void api.agents
            .unarchive(org.id, agent.id)
            .then(async () => {
              await qc.invalidateQueries({ queryKey: keys.agents(org.id) });
              await navigate({ to: "/org/$orgId/agents/$agentId", params: { orgId: org.id, agentId: agent.id } });
            })
            .catch((e: unknown) => toast.show(errorText(t, e), "error")),
      });
      void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
      leave();
    },
  });

  /* ---------- Tabs ---------- */

  const pending = pendingOnAgent(proposals.data ?? [], agent.id).length;
  const failures =
    viewer === "member" ? 0 : (runs.data ?? []).filter((r) => r.status === "failed" && thisMonth(r.createdAt)).length;
  const tabLabel = (id: AgentTab): ReactNode => {
    const n = changes.filter((c) => c.tab === id).length;
    let badge: ReactNode = null;
    if (n > 0)
      badge = (
        <span className="agp-badge agp-badge--edit ac-num" title={t("agentPage.changesCount", { count: n })}>
          <Icon name="edit" size={14} />
          {n}
        </span>
      );
    else if (id === "memory" && pending > 0)
      badge = (
        <span
          className="agp-badge agp-badge--ask ac-num"
          title={t("agentPage.memory.waitingCount", { count: pending })}
        >
          {pending}
        </span>
      );
    else if ((id === "activity" || (personal && id === "advanced" && view !== "activity")) && failures > 0)
      badge = (
        <span className="agp-badge ac-num" title={t("agentPage.activity.failuresCount", { count: failures })}>
          {failures}
        </span>
      );
    return (
      <>
        {t(
          personal && (id === "access" || id === "settings") ? `agentPage.tabs.${id}Personal` : `agentPage.tabs.${id}`,
        )}
        {badge}
      </>
    );
  };

  // Unsaved changes on a tab inside "More": its trigger counts them.
  const moreChanges = changes.filter((c) => MORE_TABS.includes(c.tab) && c.tab !== view).length;

  const value: AgentEdit = {
    agent,
    viewer,
    g,
    saved,
    draft,
    edits,
    set,
    setLevel,
    revert,
    changes,
    changeOf: (key) => byKey.get(key),
    can: (field) => canEdit(viewer, field),
    errors,
    resources,
    accessState: access.isLoading ? "loading" : access.data ? "ready" : "unavailable",
    goTo,
    pickRepos: (add) => {
      goTo("access");
      setPicking({ add });
    },
    ownerFirst,
    openWork: setWork,
    workOpen: work,
    save,
    saving,
  };

  return (
    <AgentEditProvider value={value}>
      <div className={cx("page page--full agp", onClose && "agp--panel")} data-dirty={dirty || undefined}>
        <AgentHero
          onArchive={() => setArchiving(true)}
          panel={Boolean(onClose)}
          onExpand={
            onClose &&
            (() =>
              void navigate({
                to: "/org/$orgId/agents/$agentId",
                params: { orgId: org.id, agentId: agent.id },
                search: { tab: tab === "overview" ? undefined : tab, sec: section },
              }))
          }
        />
        <div className="agp-tabs" ref={top}>
          <Tabs
            label={t("agentPage.tabsLabel", g)}
            value={view}
            onValueChange={(next) => goTo(next)}
            items={(personal
              ? [...PERSONAL_TABS, ...(PERSONAL_TABS.includes(view) ? [] : [view])]
              : [...MAIN_TABS, ...(MORE_TABS.includes(view) ? [view] : [])]
            ).map((id) => ({
              value: id,
              label: tabLabel(id),
            }))}
            after={
              personal ? undefined : (
                <Menu
                  align="end"
                  label={t("agentPage.tabs.more")}
                  trigger={
                    <button type="button" className="ac-tab agp-more">
                      {t("agentPage.tabs.more")}
                      {moreChanges > 0 && (
                        <span
                          className="agp-badge agp-badge--edit ac-num"
                          title={t("agentPage.changesCount", { count: moreChanges })}
                        >
                          <Icon name="edit" size={14} />
                          {moreChanges}
                        </span>
                      )}
                      <Icon name="chevronDown" size={14} />
                    </button>
                  }
                >
                  {MORE_TABS.filter((id) => id !== view).map((id) => (
                    <MenuItem key={id} icon={MORE_ICON[id]} onSelect={() => goTo(id)}>
                      {tabLabel(id)}
                    </MenuItem>
                  ))}
                </Menu>
              )
            }
          >
            <TabPanel value={view}>
              <div className="agp-view" key={view}>
                {view === "overview" && <OverviewTab />}
                {view === "instructions" && <InstructionsTab />}
                {view === "access" && <AccessTab part={personal ? "basic" : "all"} />}
                {view === "memory" && <MemoryTab item={item} />}
                {view === "files" && <FilesTab />}
                {view === "usage" && <UsageTab />}
                {view === "activity" && <ActivityTab />}
                {view === "settings" && (
                  <SettingsTab
                    part={personal ? "basic" : "all"}
                    section={section}
                    onSection={(sec) => goTo("settings", sec)}
                    onArchive={() => setArchiving(true)}
                    onDelete={() => setDeleting(true)}
                  />
                )}
                {view === "advanced" && (
                  <AdvancedTab
                    section={section}
                    onSection={(sec) => goTo("settings", sec)}
                    onOpen={(next) => goTo(next)}
                    onArchive={() => setArchiving(true)}
                    onDelete={() => setDeleting(true)}
                  />
                )}
              </div>
            </TabPanel>
          </Tabs>
        </div>
        <SaveBar saving={saving} onSave={() => void save()} onDiscard={discard} onJump={(c) => goTo(c.tab, c.sec)} />
      </div>
      {picking && (
        <RepoDialog
          add={picking.add}
          onClose={() => setPicking(null)}
          onUse={(next: RepoChoice) => {
            set("repos", next);
            setPicking(null);
          }}
        />
      )}

      <WorkDialogs
        open={work}
        brainAt={section === "brain" ? brainAt : undefined}
        onClose={() => {
          setWork(null);
          if (section === "brain") onNavigate(tab);
        }}
      />

      <Dialog
        open={blocker.status === "blocked" || closing}
        onOpenChange={(o) => {
          if (o) return;
          setClosing(false);
          blocker.reset?.();
        }}
        title={t("agentPage.leave.title")}
        description={t("agentPage.leave.text", { count: changes.length, ...g })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button
            onClick={() => {
              setClosing(false);
              blocker.reset?.();
            }}
          >
            {t("edit.keepEditing")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!closing) return blocker.proceed?.();
              setClosing(false);
              setEdits({});
              onClose?.();
            }}
          >
            {t("agentPage.leave.discard")}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t("agentPage.archive.title", g)}
        description={t("agentPage.archive.text", g)}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setArchiving(false)}>{t("common.cancel")}</Button>
          <Button variant="danger" icon="archive" loading={archive.isPending} onClick={() => archive.mutate()}>
            {t("agentPage.archive.button")}
          </Button>
        </DialogFooter>
      </Dialog>

      <DeleteAgentDialog agent={deleting ? agent : null} onClose={() => setDeleting(false)} onDeleted={leave} />
      {asks.dialog}
    </AgentEditProvider>
  );
}
