import type {
  Connection,
  SkillAgentChange,
  SkillChoice,
  SkillDetail,
  SkillFile,
  SkillSkipped,
  SkillSourceUpdate,
  SkillVia,
} from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useGitHubRepos,
  useSkill,
  useSkillAction,
  useSkillSettings,
  useSkills,
  useSkillUsage,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { SKILL_ASSET_MB } from "@agenteschat/client/lib/files";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  changedByText,
  changesSinceLink,
  githubRepoLink,
  hiddenRepoOf,
  hiddenRepoText,
  pickSkills,
  SKILL_FILES_SHOWN,
  SKILL_UPDATE_TOAST,
  type SkillText,
  searchRepos,
  skillPendingViews,
  skillPickOf,
  skillRefusalText,
  skillRemovalText,
  skillSourceViaText,
  skillUpdateErrorText,
  skillUpdateWords,
  skillViaText,
  skippedSkillText,
} from "@agenteschat/client/lib/skills";
import { diffLines } from "@agenteschat/ui/diff";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  DiffView,
  EmptyState,
  Filters,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  SearchField,
  Segmented,
  Text,
  useToast,
} from "@/ui";
import { SocialMark } from "@/ui/auth/SocialMarks";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { MessageText } from "../chat/MessageText";
import { ConnectSheet } from "../connectors/ConnectSheet";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useErrorToast } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { useStepText } from "./hooks";
import { isGithubSkillLink, SKILLS_INLINE, searchSkills, skillLine, skillSourceKey } from "./logic";
import { confirmAction, Gap, SettingsPage } from "./parts";

/** Opens a skill of the library (its page). */
const openSkill = (id: string) => router.push(`/settings/skills/${id}`);

/**
 * Skills (admins), as the web's: the workspace's library, each skill with what it is for, where it came from, its
 * version and how many agents use it; "Instalar skill" first, a search once the list is long. A skill opens its page.
 */
export function SkillsScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const admin = can(org, "manage_agents");
  const skills = useSkills(orgId, admin);
  const list = skills.data ?? [];
  const usage = useSkillUsage(orgId, admin && list.length > 0);
  const settings = useSkillSettings(orgId, admin);
  const action = useSkillAction(orgId);
  const failed = useErrorToast();
  const [q, setQ] = useState("");
  const unavailable = skills.isError && (skills.error as { status?: number }).status === 404;
  const shown = searchSkills(list, q);
  const none = skills.isSuccess && list.length === 0;
  const install = () => router.push("/settings/skills/new");
  return (
    <SettingsPage title={t("skills.title")}>
      <GroupedFooter>{t("settings.sectionText.skills")}</GroupedFooter>
      {!admin ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : unavailable ? (
        <View style={styles.note}>
          <Note icon="info">{t("skills.unavailable")}</Note>
        </View>
      ) : (
        <>
          {none ? null : (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow icon="plus" label={t("skills.install")} chevron onPress={install} />
              </GroupedList>
            </>
          )}
          {settings.data ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  label={t("skills.agentsImprove")}
                  labelLines={2}
                  hint={{
                    name: t("common.about", { label: t("skills.agentsImprove") }),
                    text: t("skills.agentsImproveHelp"),
                  }}
                  toggle={settings.data.agentsImprove}
                  disabled={action.isPending}
                  onPress={() =>
                    action.mutate(
                      { type: "settings", settings: { agentsImprove: !settings.data?.agentsImprove } },
                      { onError: failed },
                    )
                  }
                />
              </GroupedList>
            </>
          ) : null}
          {list.length > SKILLS_INLINE ? (
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("skills.search")}
                accessibilityLabel={t("skills.search")}
              />
            </View>
          ) : (
            <Gap />
          )}
          {skills.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
          {skills.isError && !skills.data ? (
            <View style={styles.note}>
              <Note icon="x">{t("common.loadFailed")}</Note>
            </View>
          ) : null}
          {none ? <FirstUse place="skills" size="panel" acts label={t("skills.install")} onPress={install} /> : null}
          {list.length > 0 && shown.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("skills.noResults", { q: q.trim() })}
              action={
                <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
              }
            />
          ) : null}
          {shown.length > 0 ? (
            <GroupedList>
              {shown.map((s) => (
                <GroupedRow
                  key={s.id}
                  label={s.name}
                  sub={s.description}
                  subLines={2}
                  below={
                    <Text variant="caption" tone="faint" numberOfLines={1}>
                      {skillLine(t, s, usage.get(s.id)?.length ?? 0)}
                    </Text>
                  }
                  chevron
                  onPress={() => openSkill(s.id)}
                />
              ))}
            </GroupedList>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

/**
 * A skill's page (the web's sheet): where it came from, its version and when it changed under the title; what it is
 * for; its SKILL.md drawn; its files (scripts run on the agent's computer); then Editar, "Atualizar do link" for a
 * skill that came from a link, and Remover (the confirmation names the agents that lose it).
 */
export function SkillScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const admin = can(org, "manage_agents");
  const skill = useSkill(orgId, id || null);
  const action = useSkillAction(orgId);
  const usage = useSkillUsage(orgId, admin);
  const s = skill.data;
  const users = usage.get(id) ?? [];
  const via = s ? skillSourceViaText(t, s) : null;
  const subtitle = s
    ? [
        t(`skills.source.${skillSourceKey(s)}`),
        t("skills.version", { version: s.version }),
        t("skills.updated", { when: relativeTime(t, i18n.language, s.updatedAt) }),
      ].join(" · ")
    : undefined;
  const failed = useErrorToast();

  const refresh = (item: SkillDetail) =>
    action.mutate(
      { type: "updateFromSource", id: item.id },
      {
        onSuccess: (r) => {
          successHaptic();
          toast({ title: t(SKILL_UPDATE_TOAST[(r as SkillSourceUpdate).status], { name: item.name }), icon: "check" });
        },
        // A repository none of the workspace's GitHub reads, as Instalar skill says it.
        onError: (e) => toast({ title: skillRefusalText(t, e, can(org, "manage_connectors")), icon: "x" }),
      },
    );
  const remove = (item: SkillDetail) =>
    confirmAction({
      title: t("skills.removeTitle", { name: item.name }),
      text: skillRemovalText(t, users),
      action: t("skills.remove"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        action.mutate(
          { type: "remove", id: item.id },
          {
            onSuccess: () => {
              toast({ title: t("skills.removed", { name: item.name }), icon: "check" });
              goBack();
            },
            onError: failed,
          },
        ),
    });
  const fileFacts = (f: SkillFile): { value: string; sub?: string } =>
    f.status === "script"
      ? { value: t("skills.runsOnPc") }
      : f.status === "ignored"
        ? {
            value: t("skills.needsSandbox"),
            sub: t("common.joinSentences", {
              a: t("skills.reinstall"),
              b: t("skills.assetLimit", { max: SKILL_ASSET_MB }),
            }),
          }
        : { value: f.mime };

  return (
    <SettingsPage title={s?.name ?? t("skills.title")} subtitle={subtitle}>
      {skill.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {skill.isError && !s ? (
        <View style={[styles.note, styles.retry]}>
          <Note icon="x">{t("common.loadFailed")}</Note>
          <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void skill.refetch()} />
        </View>
      ) : null}
      {s ? (
        <>
          {s.description ? <GroupedFooter>{s.description}</GroupedFooter> : null}
          {via ? (
            <View style={styles.note}>
              <Note icon={<SocialMark provider="github" color={c.muted} size={15} />}>{via}</Note>
            </View>
          ) : null}
          {admin ? <SourceUpdate skill={s} /> : null}
          {admin ? <AgentImprove skill={s} /> : null}
          <Gap />
          <GroupedList>
            <View style={styles.page}>
              <MessageText body={s.body} />
            </View>
          </GroupedList>
          {s.files.length > 0 ? (
            <>
              <GroupedHeader>{t("skills.files")}</GroupedHeader>
              <GroupedList>
                {s.files.slice(0, SKILL_FILES_SHOWN).map((f) => (
                  <GroupedRow key={f.path} label={f.path} labelLines={2} {...fileFacts(f)} />
                ))}
                {s.files.length > SKILL_FILES_SHOWN ? (
                  <GroupedRow label={t("skills.moreFiles", { count: s.files.length - SKILL_FILES_SHOWN })} />
                ) : null}
              </GroupedList>
            </>
          ) : null}
          {admin ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="pen"
                  label={t("skills.edit")}
                  chevron
                  onPress={() => router.push({ pathname: "/settings/skills/edit", params: { id: s.id } })}
                />
                {s.source === "url" && s.sourceUrl ? (
                  <GroupedRow
                    icon="down"
                    label={t("skills.refresh")}
                    disabled={action.isPending}
                    onPress={() => refresh(s)}
                  />
                ) : null}
                <GroupedRow
                  icon="x"
                  label={t("skills.remove")}
                  danger
                  disabled={action.isPending}
                  onPress={() => remove(s)}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      ) : null}
    </SettingsPage>
  );
}

/** A line diff of two texts, as the web's: what it is for (when it changed) over its SKILL.md. */
function TextDiff({ before, after }: { before: SkillText; after: SkillText }) {
  const { t } = useTranslation();
  if (before.description === after.description && before.body === after.body)
    return <GroupedFooter>{t("skills.diff.same")}</GroupedFooter>;
  return (
    <View style={styles.diff}>
      {before.description !== after.description ? (
        <DiffView prose lines={diffLines([before.description], [after.description])} />
      ) : null}
      {before.body !== after.body ? (
        <DiffView lines={diffLines(before.body.split("\n"), after.body.split("\n"))} />
      ) : null}
    </View>
  );
}

/** What the waiting update changes, as the web's: the ways to read it as pills, then each file that runs. */
function PendingDiff({ skill: s }: { skill: SkillDetail }) {
  const { t } = useTranslation();
  const views = skillPendingViews(s);
  const [tab, setTab] = useState<string>(views[0]?.id ?? "link");
  if (!s.pending) return <GroupedFooter>{t("skills.diff.unavailable")}</GroupedFooter>;
  const view = views.find((v) => v.id === tab) ?? views[0];
  return (
    <>
      {views.length > 1 ? (
        <View style={styles.tabs}>
          <Filters
            items={views.map((v) => ({ key: v.id, label: t(`skills.diff.${v.id}`) }))}
            value={view?.id ?? "link"}
            onChange={setTab}
          />
        </View>
      ) : null}
      {view ? <TextDiff before={view.before} after={view.after} /> : null}
      {s.pending.files.length > 0 ? (
        <>
          <GroupedHeader>{t("skills.diff.files")}</GroupedHeader>
          {s.pending.files.map((f) => (
            <View key={f.path} style={styles.diff}>
              <Text variant="caption" tone="muted">
                {`${f.path} · ${t(f.before === null && !f.large ? "skills.diff.newFile" : "skills.diff.changedFile")}`}
              </Text>
              {f.large || f.after === null ? (
                <Text variant="caption" tone="faint">
                  {t("skills.diff.large")}
                </Text>
              ) : (
                <DiffView lines={diffLines(f.before?.split("\n") ?? [], f.after.split("\n"))} />
              )}
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

/**
 * A skill from a link, as the web's sheet: an update waiting because it changes files that run or would replace what
 * agents changed, with what changed on each side, who changed it and when, and the choice (Usar a versão do link,
 * Manter a dos agentes); after either, a row with Desfazer; why its last update failed; "Atualizar sozinha".
 */
function SourceUpdate({ skill: s }: { skill: SkillDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const failed = useErrorToast();
  const { orgId } = useOrg();
  const action = useSkillAction(orgId);
  const agents = useAgents(orgId);
  if (s.source !== "url" || !s.sourceUrl) return null;
  const words = skillUpdateWords(t, i18n.language, s);
  const waiting = words.waiting;
  const nameOf = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? t("channel.unknownAgent");
  const by = changedByText(t, i18n.language, changesSinceLink(s), nameOf);
  const said = (title: string) => {
    successHaptic();
    toast({ title, icon: "check" });
  };
  const reopened = () => said(t("skills.pending.reopened", { name: s.name }));
  const undo = () =>
    action.mutate(
      { type: "undoUpdate", id: s.id },
      {
        onSuccess: () =>
          s.lastUpdate?.waited
            ? reopened()
            : said(t("skills.undone", { name: s.name, version: s.lastUpdate?.fromVersion ?? 0 })),
        onError: failed,
      },
    );
  return (
    <>
      {waiting ? (
        <>
          <View style={styles.note}>
            <Note icon="shield">{waiting.title}</Note>
          </View>
          <Gap />
          <GroupedList>
            <GroupedRow icon="down" label={waiting.since} labelLines={2} />
            {by ? <GroupedRow icon="agent" label={by} labelLines={3} /> : null}
          </GroupedList>
          <PendingDiff skill={s} />
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="check"
              label={waiting.apply}
              disabled={action.isPending}
              onPress={() =>
                action.mutate(
                  { type: "approveUpdate", id: s.id },
                  {
                    onSuccess: (r) =>
                      said(
                        (r as SkillSourceUpdate).status === "waiting"
                          ? t("skills.pending.changedAgain", { name: s.name })
                          : t(waiting.applied, { name: s.name }),
                      ),
                    onError: failed,
                  },
                )
              }
            />
            <GroupedRow
              icon="x"
              label={waiting.keep}
              disabled={action.isPending}
              onPress={() =>
                action.mutate(
                  { type: "dismissUpdate", id: s.id },
                  { onSuccess: () => said(t(waiting.kept, { name: s.name })), onError: failed },
                )
              }
            />
          </GroupedList>
          <GroupedFooter>{waiting.lead}</GroupedFooter>
        </>
      ) : null}
      {words.kept ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="undo"
              label={t("skills.undo")}
              sub={words.kept}
              disabled={action.isPending}
              onPress={() =>
                action.mutate({ type: "reopenUpdate", id: s.id }, { onSuccess: reopened, onError: failed })
              }
            />
          </GroupedList>
        </>
      ) : null}
      {s.updateError ? (
        <View style={styles.note}>
          <Note icon="x">{skillUpdateErrorText(t, s.updateError)}</Note>
        </View>
      ) : null}
      <Gap />
      <GroupedList>
        <GroupedRow
          label={t("skills.autoUpdate")}
          hint={{ name: t("common.about", { label: t("skills.autoUpdate") }), text: t("skills.autoUpdateHelp") }}
          toggle={s.autoUpdate ?? false}
          disabled={action.isPending}
          onPress={() =>
            action.mutate({ type: "update", id: s.id, patch: { autoUpdate: !s.autoUpdate } }, { onError: failed })
          }
        />
        {words.last ? (
          <GroupedRow
            icon="undo"
            label={words.last.undo}
            sub={words.last.line}
            disabled={action.isPending}
            onPress={undo}
          />
        ) : null}
      </GroupedList>
    </>
  );
}

/** One change an agent made, as the web's: who and when; a tap opens its diff in place. */
function ChangeRow({ change: c, agent }: { change: SkillAgentChange; agent: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const line = t("skills.agentChange", { agent, when: relativeTime(t, i18n.language, c.at) });
  return (
    <>
      <GroupedRow
        icon="eye"
        label={line}
        labelLines={2}
        sub={c.undone ? t("skills.history.undone") : undefined}
        value={t(open ? "skills.history.hide" : "skills.history.show")}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View style={styles.page}>
          <DiffView lines={diffLines(c.before.split("\n"), c.after.split("\n"))} />
        </View>
      ) : null}
    </>
  );
}

/**
 * A person's skill as agents improve it, as the web's sheet: its own "Agentes melhoram esta skill sozinhos" (the
 * workspace's until set), and what the agents changed, newest first, each opening its diff, Desfazer for the newest
 * while it is still the skill's version.
 */
function AgentImprove({ skill: s }: { skill: SkillDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const failed = useErrorToast();
  const { orgId } = useOrg();
  const action = useSkillAction(orgId);
  const settings = useSkillSettings(orgId);
  const agents = useAgents(orgId);
  if (s.origin === "agent") return null;
  const change = s.lastUpdate?.agentId ? s.lastUpdate : null;
  const nameOf = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? t("channel.unknownAgent");
  const on = s.agentsImprove ?? settings.data?.agentsImprove ?? true;
  return (
    <>
      <Gap />
      <GroupedList>
        <GroupedRow
          label={t("skills.agentsImproveThis")}
          labelLines={2}
          toggle={on}
          disabled={action.isPending}
          onPress={() =>
            action.mutate({ type: "update", id: s.id, patch: { agentsImprove: !on } }, { onError: failed })
          }
        />
        {change ? (
          <GroupedRow
            icon="undo"
            label={t("skills.undoAgentChange")}
            sub={t("skills.agentChange", {
              agent: change.agentId ? nameOf(change.agentId) : t("channel.unknownAgent"),
              when: relativeTime(t, i18n.language, change.at),
            })}
            disabled={action.isPending}
            onPress={() =>
              action.mutate(
                { type: "undoUpdate", id: s.id },
                {
                  onSuccess: () => {
                    successHaptic();
                    toast({ title: t("skills.undone", { name: s.name, version: change.fromVersion }), icon: "check" });
                  },
                  onError: failed,
                },
              )
            }
          />
        ) : null}
      </GroupedList>
      {s.changes ? (
        <>
          <GroupedHeader>{t("skills.history.title")}</GroupedHeader>
          {s.changes.length === 0 ? (
            <GroupedFooter>{t("skills.history.empty")}</GroupedFooter>
          ) : (
            <GroupedList>
              {s.changes.map((c) => (
                <ChangeRow key={c.id} change={c} agent={nameOf(c.agentId)} />
              ))}
            </GroupedList>
          )}
        </>
      ) : null}
    </>
  );
}

type InstallTab = "github" | "zip" | "write";

/** How many of the connected GitHub's repositories show at once: the search finds the rest. */
const REPOS_SHOWN = 30;

/**
 * "Instalar skill", as the web's dialog: from a GitHub link, a .zip from Arquivos, or written here. "Instalar" in the
 * bar; while it works, the step it is on; done, the skill's page in its place. A link holding several skills lists
 * them under the field, each checked to install, and "Instalar" installs those. Those it holds that can't be installed
 * follow, with why. With GitHub connected, its repositories follow the field ("Do GitHub conectado"): one tapped is
 * read to pick its skills. A private repository is read through the workspace's GitHub, and the screen says which
 * connection read it; when none can, "Conectar o GitHub" opens the connect sheet over it (or it says whom to ask),
 * and the link is read again once GitHub is connected.
 */
export function InstallSkillScreen({ initialUrl, forAgentId }: { initialUrl?: string; forAgentId?: string }) {
  return (
    <SheetHostProvider>
      <InstallSkill initialUrl={initialUrl} forAgentId={forAgentId} />
    </SheetHostProvider>
  );
}

/**
 * `forAgentId`: opened from that agent's card, a row (on by default) turns what installs on for it, as on the web, only
 * from the card's own link: one typed over it or a repository picked instead goes on for nobody.
 */
function InstallSkill({ initialUrl, forAgentId }: { initialUrl?: string; forAgentId?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const qc = useQueryClient();
  const sheet = useSheet();
  const { orgId, org } = useOrg();
  const action = useSkillAction(orgId);
  const repos = useGitHubRepos(orgId);
  const catalog = useCatalog();
  const github = catalog.data?.connectors.find((d) => d.id === "github");
  const [hidden, setHidden] = useState<ReturnType<typeof hiddenRepoOf>>(null);
  const [via, setVia] = useState<SkillVia | null>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<InstallTab>("github");
  const [url, setUrl] = useState("");
  const [zip, setZip] = useState<{ uri: string; name: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [choices, setChoices] = useState<SkillChoice[] | null>(null);
  const [skipped, setSkipped] = useState<SkillSkipped[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [turnOn, setTurnOn] = useState(true);
  const dir = useDirectory();
  // Only a live agent the server would turn it on for: not one archived or gone since its card, nor the right hand.
  const forAgent = forAgentId ? dir.agentById.get(forAgentId) : undefined;
  const forName = forAgent && !isRightHand(forAgent) ? forAgent.name : undefined;
  const cardLink = forAgentId && forName ? initialUrl?.trim() : undefined;
  const forCard = cardLink !== undefined && url.trim() === cardLink;
  /** The agent what installs from `link` goes on for, when the row shows it and is checked. */
  const sendFor = (link: string) =>
    turnOn && cardLink !== undefined && link.trim() === cardLink ? forAgentId : undefined;
  const busy = action.isPending || reading;
  const step = useStepText(busy, [
    t("skills.installStep.fetching"),
    t("skills.installStep.reading"),
    t("skills.installStep.saving"),
  ]);

  const done = (skill: unknown) => {
    const s = skill as SkillDetail;
    successHaptic();
    toast({ title: t("skills.installed", { name: s.name }), icon: "check" });
    router.replace(`/settings/skills/${s.id}`);
  };
  const onError = (e: unknown) => setError(errorText(t, e));
  const togglePick = (paths: string[], on: boolean) => setPicked(pickSkills(picked, paths, on));
  /** Reads a GitHub link: one skill installs at once, unless `list`; several (or `list`) are listed to pick. */
  const read = (link: string, list = false) => {
    setError(null);
    setHidden(null);
    const forAgent = sendFor(link);
    action.mutate(
      {
        type: "import",
        input: list ? { url: link, list } : { url: link, ...(forAgent ? { forAgentId: forAgent } : {}) },
      },
      {
        onSuccess: (result) => {
          const found = skillPickOf(result);
          if (!found) return done(result);
          setChoices(found.choices);
          setSkipped(found.skipped);
          setVia(found.via);
          setPicked(new Set());
        },
        onError: (e) => {
          const missing = hiddenRepoOf(e);
          if (missing) setHidden(missing);
          else onError(e);
        },
      },
    );
  };
  // An agent's card: its link read once, its skills listed to pick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening only
  useEffect(() => {
    if (!initialUrl || !isGithubSkillLink(initialUrl)) return;
    setUrl(initialUrl);
    read(initialUrl, true);
  }, []);
  const pickRepo = (fullName: string) => {
    const link = githubRepoLink(fullName);
    setUrl(link);
    setChoices(null);
    read(link, true);
  };
  const mayConnect = can(org, "manage_connectors") && Boolean(github);
  const said = hidden ? hiddenRepoText(t, hidden, mayConnect) : null;
  const connect = () => {
    if (!github) return;
    const link = url.trim();
    // Opens on connecting, even over a connection GitHub refuses (a connected service opens on who uses it).
    sheet.open(<ConnectSheet def={github} start="connect" />, {
      // Closed with GitHub connected: the link again, to pick.
      onClose: () => {
        const now = qc.getQueryData<Connection[]>(keys.connections(orgId)) ?? [];
        if (now.some((x) => x.connector === "github" && !x.revokedAt)) read(link, true);
      },
    });
  };
  const found = searchRepos(repos.data, q).flatMap((a) => a.repositories);
  const total = (repos.data?.accounts ?? []).reduce((n, a) => n + a.repositories.length, 0);
  const pickZip = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/zip", "application/x-zip-compressed"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return;
    setZip({ uri: a.uri, name: a.name });
    setError(null);
  };
  const submit = async () => {
    if (busy) return;
    setError(null);
    if (tab === "github") {
      if (!isGithubSkillLink(url)) {
        setError(t("skills.githubInvalid"));
        return;
      }
      if (!choices) {
        read(url.trim());
        return;
      }
      if (picked.size === 0) {
        setError(t("skills.pickMissing"));
        return;
      }
      const paths = choices.map((c) => c.path).filter((p) => picked.has(p));
      const onSuccess = (installed: unknown) => {
        const list = installed as SkillDetail[];
        if (list.length === 1) return done(list[0]);
        successHaptic();
        toast({ title: t("skills.installedMany", { count: list.length }), icon: "check" });
        goBack();
      };
      action.mutate({ type: "importPicked", url: url.trim(), paths, forAgentId: sendFor(url) }, { onSuccess, onError });
      return;
    }
    if (tab === "zip") {
      if (!zip) {
        setError(t("skills.zipMissing"));
        return;
      }
      setReading(true);
      let zipBase64: string;
      try {
        zipBase64 = await new File(zip.uri).base64();
      } catch {
        setError(t("common.unknownError"));
        return;
      } finally {
        setReading(false);
      }
      action.mutate({ type: "import", input: { zipBase64 } }, { onSuccess: done, onError });
      return;
    }
    if (!(form.name.trim() && form.description.trim() && form.body.trim())) {
      setError(t("skills.writeMissing"));
      return;
    }
    action.mutate(
      { type: "create", input: { name: form.name.trim(), description: form.description.trim(), body: form.body } },
      { onSuccess: done, onError },
    );
  };

  return (
    <SettingsPage
      title={t("skills.install")}
      action={{ label: t("skills.installSubmit"), disabled: busy, onPress: () => void submit() }}
      locked={busy}
    >
      <View style={styles.tabs}>
        <Segmented
          items={[
            { key: "github", label: t("skills.tab.github") },
            { key: "zip", label: t("skills.tab.zip") },
            { key: "write", label: t("skills.tab.write") },
          ]}
          value={tab}
          onChange={(k) => {
            setTab(k as InstallTab);
            setError(null);
          }}
        />
      </View>
      {tab === "github" ? (
        <>
          <GroupedHeader
            hint={{ name: t("common.about", { label: t("skills.githubUrl") }), text: t("skills.githubHelp") }}
          >
            {t("skills.githubUrl")}
          </GroupedHeader>
          <TextArea
            value={url}
            onChangeText={(next) => {
              setUrl(next);
              setChoices(null);
              setHidden(null);
            }}
            placeholder="https://github.com/…"
            multiline={false}
            minHeight={50}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            accessibilityLabel={t("skills.githubUrl")}
          />
          {choices ? (
            <GroupedFooter>{t("skills.pickLead", { count: choices.length + skipped.length })}</GroupedFooter>
          ) : null}
          {said ? (
            <View style={styles.hidden}>
              <Note icon="lock" live>
                {said.text}
              </Note>
              {said.connect ? (
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("skills.hidden.connectButton")}
                  leading={(color) => <SocialMark provider="github" color={color} size={16} />}
                  onPress={connect}
                />
              ) : null}
            </View>
          ) : null}
          {choices && via ? (
            <View style={styles.note}>
              <Note icon={<SocialMark provider="github" color={c.muted} size={15} />}>{skillViaText(t, via, url)}</Note>
            </View>
          ) : null}
          {choices ? (
            <GroupedList>
              <GroupedRow
                label={t("skills.pickAll")}
                checked={picked.size === choices.length}
                onPress={() =>
                  togglePick(
                    choices.map((c) => c.path),
                    picked.size < choices.length,
                  )
                }
              />
              {choices.map((c) => (
                <GroupedRow
                  key={c.path}
                  label={c.name}
                  sub={
                    c.replaces
                      ? `${t(c.replaces === "removed" ? "skills.pickReplacesRemoved" : "skills.pickReplaces", { name: c.name })}\n${c.description}`
                      : c.description
                  }
                  subLines={c.replaces ? 3 : 2}
                  checked={picked.has(c.path)}
                  onPress={() => togglePick([c.path], !picked.has(c.path))}
                />
              ))}
              {skipped.map((s) => (
                <GroupedRow key={s.path} label={s.path} sub={skippedSkillText(t, s)} subLines={3} disabled />
              ))}
            </GroupedList>
          ) : repos.data?.connected ? (
            <>
              <GroupedHeader>{t("skills.connectedRepos")}</GroupedHeader>
              {total > SKILLS_INLINE ? (
                <View style={styles.search}>
                  <SearchField
                    value={q}
                    onChangeText={setQ}
                    placeholder={t("repos.search")}
                    accessibilityLabel={t("repos.search")}
                  />
                </View>
              ) : null}
              {found.length > 0 ? (
                <GroupedList>
                  {found.slice(0, REPOS_SHOWN).map((r) => (
                    <GroupedRow
                      key={r.fullName}
                      icon={r.private ? "lock" : "globe"}
                      label={r.fullName}
                      sub={r.private ? t("repos.private") : t("repos.public")}
                      chevron
                      disabled={busy}
                      onPress={() => pickRepo(r.fullName)}
                    />
                  ))}
                </GroupedList>
              ) : (
                <GroupedFooter>{q.trim() ? t("repos.noMatch", { q: q.trim() }) : t("repos.none")}</GroupedFooter>
              )}
              {found.length > REPOS_SHOWN ? <GroupedFooter>{t("skills.reposMore")}</GroupedFooter> : null}
            </>
          ) : null}
          {forCard ? (
            <GroupedList>
              <GroupedRow
                label={t("skills.forAgent", { agent: forName, count: Math.max(picked.size, 1) })}
                checked={turnOn}
                onPress={() => setTurnOn((on) => !on)}
              />
            </GroupedList>
          ) : null}
        </>
      ) : tab === "zip" ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="file"
              label={t("skills.zipPick")}
              sub={zip?.name ?? t("skills.zipNone")}
              chevron
              onPress={() => void pickZip()}
            />
          </GroupedList>
          <GroupedFooter>{t("skills.zipHelp")}</GroupedFooter>
        </>
      ) : (
        <>
          <GroupedHeader>{t("skills.name")}</GroupedHeader>
          <TextArea
            value={form.name}
            onChangeText={(name) => setForm((f) => ({ ...f, name }))}
            multiline={false}
            minHeight={50}
            accessibilityLabel={t("skills.name")}
          />
          <GroupedHeader
            hint={{ name: t("common.about", { label: t("skills.description") }), text: t("skills.descriptionHelp") }}
          >
            {t("skills.description")}
          </GroupedHeader>
          <TextArea
            value={form.description}
            onChangeText={(description) => setForm((f) => ({ ...f, description }))}
            minHeight={64}
            accessibilityLabel={t("skills.description")}
          />
          <GroupedHeader hint={{ name: t("common.about", { label: t("skills.body") }), text: t("skills.bodyHelp") }}>
            {t("skills.body")}
          </GroupedHeader>
          <TextArea
            value={form.body}
            onChangeText={(body) => setForm((f) => ({ ...f, body }))}
            minHeight={220}
            autoCapitalize="none"
            accessibilityLabel={t("skills.body")}
          />
        </>
      )}
      {error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {step ? <GroupedFooter>{step}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/**
 * Editar, pushed over a skill's page: what it is for, its instructions (saving makes a new version) and whether new
 * agents get it. "Salvar" in the bar saves and goes back.
 */
export function EditSkillScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId } = useOrg();
  const skill = useSkill(orgId, id || null);
  const action = useSkillAction(orgId);
  const s = skill.data;
  const [form, setForm] = useState<{ description: string; body: string; defaultForNewAgents: boolean } | null>(null);
  // Filled once, from the skill as it is: a refetch must not undo what is being typed.
  useEffect(() => {
    if (s && !form) setForm({ description: s.description, body: s.body, defaultForNewAgents: s.defaultForNewAgents });
  }, [s, form]);
  const ready = Boolean(form?.description.trim()) && !action.isPending;
  const save = () => {
    if (!s || !form || !ready) return;
    action.mutate(
      { type: "update", id: s.id, patch: form },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("skills.saved", { name: s.name }), icon: "check" });
          goBack();
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  };
  return (
    <SettingsPage
      title={t("skills.edit")}
      subtitle={s?.name}
      action={{ label: t("skills.save"), disabled: !ready, onPress: save }}
      locked={action.isPending}
    >
      {!form ? (
        skill.isError ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )
      ) : (
        <>
          {s?.source === "url" ? <GroupedFooter>{t("skills.editLinkNote")}</GroupedFooter> : null}
          <GroupedHeader>{t("skills.description")}</GroupedHeader>
          <TextArea
            value={form.description}
            onChangeText={(description) => setForm({ ...form, description })}
            minHeight={64}
            accessibilityLabel={t("skills.description")}
          />
          <GroupedHeader hint={{ name: t("common.about", { label: t("skills.body") }), text: t("skills.newVersion") }}>
            {t("skills.body")}
          </GroupedHeader>
          <TextArea
            value={form.body}
            onChangeText={(body) => setForm({ ...form, body })}
            minHeight={300}
            autoCapitalize="none"
            accessibilityLabel={t("skills.body")}
          />
          <Gap />
          <GroupedList>
            <GroupedRow
              label={t("skills.defaultForNew")}
              labelLines={2}
              toggle={form.defaultForNewAgents}
              onPress={() => setForm({ ...form, defaultForNewAgents: !form.defaultForNewAgents })}
            />
          </GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  retry: { gap: 10, alignItems: "flex-start" },
  search: { paddingTop: 14, paddingBottom: 8 },
  loading: { marginVertical: 16 },
  page: { paddingHorizontal: 16, paddingVertical: 14 },
  diff: { gap: 8, paddingTop: 10, paddingHorizontal: 4 },
  tabs: { paddingTop: 10, paddingHorizontal: 4 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
  hidden: { gap: 12, paddingHorizontal: 4, paddingTop: 10, alignItems: "flex-start" },
});
