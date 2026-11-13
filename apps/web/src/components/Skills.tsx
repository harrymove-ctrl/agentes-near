import type {
  Skill,
  SkillAgentChange,
  SkillChoice,
  SkillDetail,
  SkillFile,
  SkillSkipped,
  SkillSourceUpdate,
  SkillVia,
} from "@agenteschat/client";
import {
  useAgents,
  useCatalog,
  useConnections,
  useGitHubRepos,
  useSkill,
  useSkillAction,
  useSkillSettings,
  useSkills,
  useSkillUsage,
} from "@agenteschat/client";
import { cardInstallAgent, cardInstallOf } from "@agenteschat/client/lib/action-cards";
import { fromConnection } from "@agenteschat/client/lib/connected";
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
  type SkillPendingView,
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
  skillWaitingChip,
  skippedSkillText,
} from "@agenteschat/client/lib/skills";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  CheckboxPill,
  Chip,
  DetailsDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Diff,
  diffLines,
  EmptyState,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
  List,
  ListRow,
  Locked,
  SearchField,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  useUnsavedInDialog,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { LoadingLine, LoadingList, useStepText } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useEdited } from "@/hooks/useEdited";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { inlineWords, Markdown } from "@/lib/markdown";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { useToast } from "@/lib/toast";

/** How many skills show without a search: past it, the settings card gets "Ver todas" and an agent's picker a search. */
const INLINE = 6;

const SOURCE_ICON: Record<Skill["source"], IconName> = {
  url: "link",
  upload: "attach",
  manual: "edit",
};

/** "GitHub" for github.com links, "Link" for other URLs, "Enviada", "Criada aqui". */
const sourceKey = (s: Pick<Skill, "source" | "sourceUrl">) =>
  s.source === "url" ? (/github\.com/i.test(s.sourceUrl ?? "") ? "github" : "url") : s.source;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function searchSkills(skills: Skill[], query: string, { nameOnly = false } = {}) {
  const q = fold(query.trim());
  return q ? skills.filter((s) => fold(nameOnly ? s.name : `${s.name} ${s.description}`).includes(q)) : skills;
}

/** A .zip as base64 (writes are JSON only). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** GitHub's own mark, as the connector catalog draws it (in ink), for a skill installed from github.com. */
const GITHUB_MARK = { iconUrl: "/connectors/github.svg", brandColor: null };

function SourceChip({ skill }: { skill: Skill }) {
  const { t } = useTranslation();
  const key = sourceKey(skill);
  const name = t(`skills.source.${key}`);
  return (
    <Chip
      icon={SOURCE_ICON[skill.source] ?? "document"}
      lead={key === "github" ? <ConnectorIcon def={GITHUB_MARK} label={name} /> : undefined}
    >
      {name}
    </Chip>
  );
}

function SkillRow({ skill, users, onOpen }: { skill: Skill; users: number | null; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ac-list__row skill-row">
      <button type="button" className="skill-row__name" onClick={onOpen}>
        {skill.name}
      </button>
      <span className="skill-row__meta">
        <SourceChip skill={skill} />
        {skill.defaultForNewAgents && <Chip icon="check">{t("skills.defaultChip")}</Chip>}
        {skill.pendingUpdate && !skill.pendingUpdate.dismissed ? (
          <Chip icon="alert">{t(skillWaitingChip(skill.pendingUpdate))}</Chip>
        ) : (
          skill.autoUpdate && <Chip icon="refresh">{t("skills.autoChip")}</Chip>
        )}
        <span className="small muted tabular">
          {t("skills.version", { version: skill.version })}
          {users !== null && <> · {t("skills.usedBy", { count: users })}</>}
        </span>
      </span>
      <span className="small muted">{inlineWords(skill.description)}</span>
    </div>
  );
}

/** One line led by GitHub's mark: which of the workspace's GitHub connections read a private repository. */
function ViaLine({ children }: { children: string }) {
  return (
    <p className="small muted ac-iconline skill-via">
      <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Configurações → Skills: the org library (admins manage it). `install`: back from connecting GitHub in Instalar
 * skill, the link it couldn't read, which the dialog reads again (`connected`: the server's `?connected=github`), and
 * `agent`, the agent whose card opened it: only when this tab opened that card's install (`cardInstallAgent`).
 * `skill`: the skill to open (a notice of its update from its link).
 */
export function SkillsSection({
  install,
  connected,
  skill,
  agent,
}: {
  install?: string;
  connected?: string;
  skill?: string;
  agent?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_agents");
  const skills = useSkills(org.id, admin);
  const [installing, setInstalling] = useState(Boolean(install));
  const [returned, setReturned] = useState(install);
  const [returnedFor] = useState(() =>
    cardInstallAgent(cardInstallOf(sessionStore.get(STORAGE_KEYS.skillInstallFor)), install, agent),
  );
  useEffect(() => {
    if (install || skill) window.history.replaceState(null, "", window.location.pathname);
    if (install) sessionStore.remove(STORAGE_KEYS.skillInstallFor);
  }, [install, skill]);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(skill ?? null);
  const list = skills.data ?? [];
  const usage = useSkillUsage(org.id, admin && list.length > 0);
  const settings = useSkillSettings(org.id, admin);
  const action = useSkillAction(org.id);
  const look = useRightHandLook();
  if (!admin) return null;
  const unavailable = skills.isError && (skills.error as { status?: number }).status === 404;
  const noSkills = skills.isSuccess && list.length === 0;
  return (
    <Card aria-labelledby="sec-skills">
      <CardHeader
        id="sec-skills"
        icon="bulb"
        title={t("skills.title")}
        action={
          !unavailable &&
          !noSkills && (
            <Button size="sm" icon="plus" onClick={() => setInstalling(true)}>
              {t("skills.install")}
            </Button>
          )
        }
      />
      {unavailable && <p className="small muted">{t("skills.unavailable")}</p>}
      {settings.data && (
        <span className="row" style={{ gap: 10, alignItems: "center" }}>
          <Switch
            id="skills-agents-improve"
            checked={settings.data.agentsImprove}
            disabled={action.isPending}
            onCheckedChange={(on) => action.mutate({ type: "settings", settings: { agentsImprove: on } })}
          />
          <span className="ac-hintline">
            <label htmlFor="skills-agents-improve">{t("skills.agentsImprove")}</label>
            <InfoHint name={t("common.about", { label: t("skills.agentsImprove") })}>
              {t("skills.agentsImproveHelp")}
            </InfoHint>
          </span>
        </span>
      )}
      {skills.isLoading && <LoadingList count={3} avatar={false} />}
      {noSkills && (
        <EmptyState
          size="panel"
          agent={look}
          title={t("skills.emptyTitle")}
          actions={
            <Button variant="primary" icon="plus" onClick={() => setInstalling(true)}>
              {t("skills.install")}
            </Button>
          }
        >
          {t("skills.emptyText")}
        </EmptyState>
      )}
      {list.length > 0 && (
        <List aria-label={t("skills.title")}>
          {list.slice(0, INLINE).map((s) => (
            <SkillRow key={s.id} skill={s} users={usage.get(s.id)?.length ?? 0} onOpen={() => setOpen(s.id)} />
          ))}
        </List>
      )}
      {list.length > INLINE && (
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t("skills.seeAll", { count: list.length })}
          </Button>
        </div>
      )}
      <Dialog open={all} onOpenChange={setAll} title={t("skills.title")} closeLabel={t("common.close")}>
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("skills.search")}
          searchPlaceholder={t("skills.search")}
          isEmpty={searchSkills(list, q).length === 0}
          emptyText={t("skills.noResults", { q })}
        >
          {searchSkills(list, q).map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              users={usage.get(s.id)?.length ?? 0}
              onOpen={() => {
                setAll(false);
                setOpen(s.id);
              }}
            />
          ))}
        </DialogSearchList>
      </Dialog>
      <InstallSkillDialog
        open={installing}
        onOpenChange={(o) => {
          setInstalling(o);
          if (!o) setReturned(undefined);
        }}
        onInstalled={(id) => setOpen(id)}
        initialUrl={returned}
        connected={returned !== undefined && connected === "github"}
        forAgentId={returned !== undefined ? returnedFor : undefined}
      />
      {open && <SkillSheet id={open} users={usage.get(open) ?? []} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/**
 * An agent's skills (its page, Criar agente): the library as pills, with a search past INLINE. The search matches
 * names only, since a pill shows nothing else, and only hides pills: a skill switched on stays on while hidden.
 */
export function SkillPicker({
  skills,
  selected,
  onChange,
  idPrefix,
}: {
  skills: Skill[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const searchable = skills.length > INLINE;
  const shown = searchable ? searchSkills(skills, q, { nameOnly: true }) : skills;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };
  return (
    <div className="skill-picker">
      {searchable && (
        <SearchField
          size="sm"
          aria-label={t("skills.search")}
          placeholder={t("skills.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
        />
      )}
      {shown.length > 0 ? (
        <div className="newag__pills">
          {shown.map((s) => (
            <CheckboxPill
              key={s.id}
              id={`${idPrefix}-${s.id}`}
              checked={selected.has(s.id)}
              onCheckedChange={(on) => toggle(s.id, on)}
            >
              {s.name}
            </CheckboxPill>
          ))}
        </div>
      ) : (
        <span className="small muted">{t("skills.noResults", { q })}</span>
      )}
    </div>
  );
}

type InstallTab = "github" | "zip" | "write";

/**
 * Where connecting GitHub from Instalar skill comes back to: Skills, with the link to read again. A link too long
 * for the connect flow's `returnTo` (500 characters, a desktop window's `desktop:` before it) comes back to Skills.
 */
const returnHere = (orgId: string, url: string, forAgentId?: string) => {
  const skills = `/org/${orgId}/settings/skills`;
  const back = `${skills}?install=${encodeURIComponent(url)}${forAgentId ? `&agent=${encodeURIComponent(forAgentId)}` : ""}`;
  return back.length <= 490 ? back : skills;
};

/**
 * Instalar skill: a GitHub link, a .zip or written here. A link holding several skills (or a repository picked from
 * the connected GitHub) lists them to pick. A private repository is read on the server through the workspace's
 * GitHub, and the dialog says which connection read it. When none can, it says the repository looks private or
 * missing and offers to connect GitHub (or to ask whoever manages connectors). Once GitHub is connected it reads the
 * link again while the connect flow goes on to what GitHub does and who uses it, as from Conectores (`initialUrl`
 * and `connected` when signing in on GitHub left the page). `forAgentId`: opened from that agent's card, a box (on by
 * default) turns what installs on for it, and only from the card's own link (`initialUrl`): a link typed over it or a
 * repository picked instead goes on for nobody. A pick named like an installed or a removed skill says it replaces it.
 */
export function InstallSkillDialog({
  open,
  onOpenChange,
  onInstalled,
  initialUrl,
  connected = false,
  forAgentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (id: string) => void;
  initialUrl?: string;
  connected?: boolean;
  forAgentId?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id, { silent: true });
  const repos = useGitHubRepos(org.id, open);
  const catalog = useCatalog();
  const connections = useConnections(org.id, open && connected);
  const dir = useDirectory(org.id);
  // Only a live agent the server would turn it on for: not one archived or gone since its card, nor the right hand.
  const forAgent = forAgentId ? dir.agentById.get(forAgentId) : undefined;
  const forName = forAgent && !isRightHand(forAgent) ? forAgent.name : undefined;
  /** "Fica ligada para Ada": on by default, shown (and sent) only while the link is the card's own. */
  const [turnOn, setTurnOn] = useState(true);
  const installStep = useStepText(action.isPending, [
    t("skills.installStep.fetching"),
    t("skills.installStep.reading"),
    t("skills.installStep.saving"),
  ]);
  const [tab, setTab] = useState<InstallTab>("github");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  const unsaved = useEdited(open, form);
  const [error, setError] = useState<string | null>(null);
  /** A link the workspace's GitHub couldn't read either, and whether GitHub is connected. */
  const [hidden, setHidden] = useState<ReturnType<typeof hiddenRepoOf>>(null);
  /** The skills a link holds when it holds several, those that can't be installed, and the ones picked. */
  const [choices, setChoices] = useState<SkillChoice[] | null>(null);
  const [skipped, setSkipped] = useState<SkillSkipped[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [via, setVia] = useState<SkillVia | null>(null);
  /** The connected GitHub's repositories in place of the tabs, to read one. */
  const [browsing, setBrowsing] = useState(false);
  /** Connecting GitHub, over the dialog. */
  const [flow, setFlow] = useState<FlowState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const github = catalog.data?.connectors.find((c) => c.id === "github");
  const githubOk = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url.trim());
  const writeOk = form.name.trim() && form.description.trim() && form.body.trim();
  const done = (skill: unknown) => {
    const s = skill as SkillDetail;
    toast.show(t("skills.installed", { name: s.name }));
    onOpenChange(false);
    onInstalled(s.id);
  };
  const pick = (paths: string[], on: boolean) => setPicked(pickSkills(picked, paths, on));
  const cardLink = forAgentId && forName ? initialUrl?.trim() : undefined;
  const forCard = cardLink !== undefined && url.trim() === cardLink;
  /** The agent what installs from `link` goes on for, when the box shows it and is checked. */
  const sendFor = (link: string) =>
    turnOn && cardLink !== undefined && link.trim() === cardLink ? forAgentId : undefined;
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
          else setError(errorText(t, e));
        },
      },
    );
  };
  // Opening starts afresh, on the link it couldn't read when back from connecting GitHub on its site, read once more
  // to pick (once per opening: development runs effects twice).
  const readAgain = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening only
  useEffect(() => {
    if (!open) {
      readAgain.current = undefined;
      return;
    }
    setUrl(initialUrl ?? "");
    setFile(null);
    setForm({ name: "", description: "", body: "" });
    setError(null);
    setHidden(null);
    setChoices(null);
    setBrowsing(false);
    setTurnOn(true);
    if (initialUrl && readAgain.current !== initialUrl) {
      readAgain.current = initialUrl;
      read(initialUrl, true);
    }
  }, [open]);
  // Signed in on GitHub: its confirmation, as Conectores shows after signing in.
  const resumed = useRef(false);
  useEffect(() => {
    if (!open || !connected || resumed.current || !connections.data || !catalog.data) return;
    resumed.current = true;
    const connection = connections.data.find((c) => c.connector === "github" && !c.revokedAt);
    if (!connection || !can(org, "manage_connectors")) return;
    const item = fromConnection(connection, catalog.data.connectors);
    setFlow({ step: "done", item });
  }, [open, connected, connections.data, catalog.data, org]);
  const submit = async () => {
    setError(null);
    const onError = (e: Error) => setError(errorText(t, e));
    if (tab === "github") {
      if (!githubOk) return setError(t("skills.githubInvalid"));
      if (!choices) return read(url.trim());
      if (picked.size === 0) return setError(t("skills.pickMissing"));
      action.mutate(
        {
          type: "importPicked",
          url: url.trim(),
          paths: choices.map((c) => c.path).filter((p) => picked.has(p)),
          forAgentId: sendFor(url),
        },
        {
          onSuccess: (installed) => {
            const list = installed as SkillDetail[];
            if (list.length === 1) return done(list[0]);
            toast.show(t("skills.installedMany", { count: list.length }));
            onOpenChange(false);
          },
          onError,
        },
      );
    } else if (tab === "zip") {
      if (!file) return setError(t("skills.zipMissing"));
      const zipBase64 = await fileToBase64(file);
      action.mutate({ type: "import", input: { zipBase64 } }, { onSuccess: done, onError });
    } else {
      if (!writeOk) return setError(t("skills.writeMissing"));
      action.mutate(
        {
          type: "create",
          input: { name: form.name.trim(), description: form.description.trim(), body: form.body },
        },
        { onSuccess: done, onError },
      );
    }
  };
  const mayConnect = can(org, "manage_connectors") && Boolean(github);
  const said = hidden ? hiddenRepoText(t, hidden, mayConnect) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("skills.install")}
      closeLabel={t("common.close")}
      unsaved={unsaved}
    >
      {browsing ? (
        <ConnectedRepos
          onBack={() => setBrowsing(false)}
          onPick={(fullName) => {
            const link = githubRepoLink(fullName);
            setBrowsing(false);
            setUrl(link);
            setChoices(null);
            read(link, true);
          }}
        />
      ) : (
        <form
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Locked when={action.isPending}>
            <DialogBody>
              <Tabs
                value={tab}
                onValueChange={(v) => {
                  setTab(v);
                  setError(null);
                  setHidden(null);
                }}
                label={t("skills.installHow")}
                items={[
                  { value: "github", label: t("skills.tab.github") },
                  { value: "zip", label: t("skills.tab.zip") },
                  { value: "write", label: t("skills.tab.write") },
                ]}
              >
                <TabPanel value="github">
                  <Field
                    label={t("skills.githubUrl")}
                    id="skill-url"
                    hint={{ name: t("common.about", { label: t("skills.githubUrl") }), text: t("skills.githubHelp") }}
                  >
                    <Input
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setChoices(null);
                        setHidden(null);
                      }}
                      placeholder="https://github.com/…"
                      inputMode="url"
                    />
                  </Field>
                  {repos.data?.connected && !choices && (
                    <div className="row">
                      <Button size="sm" onClick={() => setBrowsing(true)}>
                        <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
                        {t("skills.fromConnected")}
                      </Button>
                    </div>
                  )}
                  {said && (
                    <div className="skill-hidden">
                      <Alert tone="neutral">{said.text}</Alert>
                      {said.connect && github && (
                        <div className="row">
                          <Button size="sm" variant="primary" onClick={() => setFlow({ step: 0, def: github })}>
                            <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
                            {t("skills.hidden.connectButton")}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {choices && via && <ViaLine>{skillViaText(t, via, url)}</ViaLine>}
                  {choices && (
                    <fieldset className="skill-picks">
                      <legend className="small muted">
                        {t("skills.pickLead", { count: choices.length + skipped.length })}
                      </legend>
                      <label htmlFor="skill-pick-all" className="scope-row">
                        <Checkbox
                          id="skill-pick-all"
                          checked={picked.size === 0 ? false : picked.size === choices.length ? true : "indeterminate"}
                          onCheckedChange={(on) =>
                            pick(
                              choices.map((c) => c.path),
                              on,
                            )
                          }
                        />
                        <span className="scope-row__text">{t("skills.pickAll")}</span>
                      </label>
                      {choices.map((c, i) => (
                        <label key={c.path} htmlFor={`skill-pick-${i}`} className="scope-row">
                          <Checkbox
                            id={`skill-pick-${i}`}
                            checked={picked.has(c.path)}
                            onCheckedChange={(on) => pick([c.path], on)}
                          />
                          <span className="scope-row__text">
                            <span className="skill-pick__name">{c.name}</span>
                            {c.replaces && (
                              <span className="small muted skill-pick__about">
                                {t(c.replaces === "removed" ? "skills.pickReplacesRemoved" : "skills.pickReplaces", {
                                  name: c.name,
                                })}
                              </span>
                            )}
                            <span className="small muted skill-pick__about">{c.description}</span>
                          </span>
                        </label>
                      ))}
                      {skipped.map((s, i) => (
                        <label key={s.path} htmlFor={`skill-skip-${i}`} className="scope-row">
                          <Checkbox id={`skill-skip-${i}`} checked={false} disabled />
                          <span className="scope-row__text">
                            <span className="skill-pick__name">{s.path}</span>
                            <span className="small muted skill-pick__about">{skippedSkillText(t, s)}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {forCard && (
                    <label htmlFor="skill-for-agent" className="scope-row">
                      <Checkbox
                        id="skill-for-agent"
                        checked={turnOn}
                        onCheckedChange={(on) => setTurnOn(on === true)}
                      />
                      <span className="scope-row__text">
                        {t("skills.forAgent", { agent: forName, count: Math.max(picked.size, 1) })}
                      </span>
                    </label>
                  )}
                </TabPanel>
                <TabPanel value="zip">
                  <span className="small muted">{t("skills.zipHelp")}</span>
                  {/* Our button over a hidden file input: never the native control look. */}
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".zip,application/zip"
                    className="ac-visually-hidden"
                    aria-label={t("skills.zipPick")}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <Button type="button" icon="attach" onClick={() => fileInput.current?.click()}>
                      {t("skills.zipPick")}
                    </Button>
                    <span className="small muted">{file ? file.name : t("skills.zipNone")}</span>
                  </div>
                </TabPanel>
                <TabPanel value="write">
                  <Field label={t("skills.name")} id="skill-name">
                    <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </Field>
                  <Field
                    label={t("skills.description")}
                    id="skill-desc"
                    hint={{
                      name: t("common.about", { label: t("skills.description") }),
                      text: t("skills.descriptionHelp"),
                    }}
                  >
                    <Input
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={t("skills.body")}
                    id="skill-body"
                    hint={{ name: t("common.about", { label: t("skills.body") }), text: t("skills.bodyHelp") }}
                  >
                    <Textarea
                      rows={10}
                      value={form.body}
                      onChange={(e) => setForm({ ...form, body: e.target.value })}
                    />
                  </Field>
                </TabPanel>
              </Tabs>
              {error && <Alert>{error}</Alert>}
            </DialogBody>
          </Locked>
          <DialogFooter note={installStep}>
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={action.isPending} loading={action.isPending}>
              {t("skills.installSubmit")}
            </Button>
          </DialogFooter>
        </form>
      )}
      <ConnectFlow
        flow={flow}
        returnTo={returnHere(org.id, url.trim(), sendFor(url))}
        onChange={(next) => {
          // Connected without leaving the page (a token): the link again, to pick, behind the steps that follow.
          if (flow?.step === 0) read(url.trim(), true);
          setFlow(next);
        }}
        onClose={() => setFlow(null)}
      />
    </Dialog>
  );
}

/**
 * Instalar skill › Escolher do GitHub conectado: the repositories the workspace's GitHub reaches, by account, with a
 * search. Picking one reads it; Voltar goes back to the tabs.
 */
function ConnectedRepos({ onPick, onBack }: { onPick: (fullName: string) => void; onBack: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const listing = useGitHubRepos(org.id);
  const [q, setQ] = useState("");
  const accounts = searchRepos(listing.data, q);
  return (
    <>
      {listing.isLoading ? (
        <div className="ac-dialog__body">
          <LoadingLine width={220} />
        </div>
      ) : listing.isError ? (
        <p className="ac-dialog__empty">{t("repos.unavailable")}</p>
      ) : (
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("repos.search")}
          searchPlaceholder={t("repos.search")}
          listLabel={t("skills.connectedRepos")}
          isEmpty={accounts.length === 0}
          emptyText={q.trim() ? t("repos.noMatch", { q: q.trim() }) : t("repos.none")}
        >
          {accounts.map((a) => (
            <section key={a.login} className="skill-repos" aria-label={a.login}>
              <p className="ac-eyebrow">{a.login}</p>
              {a.repositories.map((r) => (
                <ListRow
                  key={r.fullName}
                  lead={<Icon name={r.private ? "lock" : "globe"} size={16} />}
                  title={r.fullName}
                  meta={r.private ? t("repos.private") : t("repos.public")}
                  onClick={() => onPick(r.fullName)}
                />
              ))}
            </section>
          ))}
          {listing.data?.truncated && <p className="small muted">{t("repos.truncated")}</p>}
        </DialogSearchList>
      )}
      <DialogFooter>
        <Button onClick={onBack}>{t("common.back")}</Button>
      </DialogFooter>
    </>
  );
}

/** A line diff of two texts: what it is for (when it changed) over its SKILL.md; one line when nothing differs. */
function TextDiff({ before, after }: { before: SkillText; after: SkillText }) {
  const { t } = useTranslation();
  const labels = { addedLabel: t("proposals.added"), removedLabel: t("proposals.removed") };
  const description = before.description !== after.description;
  if (!description && before.body === after.body) return <p className="small muted">{t("skills.diff.same")}</p>;
  return (
    <>
      {description && (
        <Diff
          {...labels}
          aria-label={t("skills.description")}
          lines={diffLines([before.description], [after.description])}
        />
      )}
      {before.body !== after.body && (
        <Diff
          {...labels}
          code
          aria-label={t("skills.body")}
          lines={diffLines(before.body.split("\n"), after.body.split("\n"))}
        />
      )}
    </>
  );
}

/**
 * What the waiting update changes: the ways to read it (`skillPendingViews`) as tabs, then each file that runs, new
 * or changed, with its diff (or why it isn't shown).
 */
function PendingDiff({ skill: s }: { skill: SkillDetail }) {
  const { t } = useTranslation();
  const views = skillPendingViews(s);
  const [tab, setTab] = useState<SkillPendingView["id"]>(views[0]?.id ?? "link");
  if (!s.pending) return <p className="small muted">{t("skills.diff.unavailable")}</p>;
  const labels = { addedLabel: t("proposals.added"), removedLabel: t("proposals.removed") };
  return (
    <div className="skill-diff">
      {views.length > 1 ? (
        <Tabs
          variant="segmented"
          value={tab}
          onValueChange={setTab}
          label={t("skills.diff.label")}
          items={views.map((v) => ({ value: v.id, label: t(`skills.diff.${v.id}`) }))}
        >
          {views.map((v) => (
            <TabPanel key={v.id} value={v.id}>
              <TextDiff before={v.before} after={v.after} />
            </TabPanel>
          ))}
        </Tabs>
      ) : (
        views[0] && <TextDiff before={views[0].before} after={views[0].after} />
      )}
      {s.pending.files.length > 0 && (
        <>
          <h4 className="ac-eyebrow">{t("skills.diff.files")}</h4>
          {s.pending.files.map((f) => (
            <div key={f.path} className="skill-diff__file">
              <span className="skill-file">
                <code>{f.path}</code>
                <Chip icon="code">
                  {t(f.before === null && !f.large ? "skills.diff.newFile" : "skills.diff.changedFile")}
                </Chip>
              </span>
              {f.large || f.after === null ? (
                <p className="small muted">{t("skills.diff.large")}</p>
              ) : (
                <Diff
                  {...labels}
                  code
                  aria-label={f.path}
                  lines={diffLines(f.before?.split("\n") ?? [], f.after.split("\n"))}
                />
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * A skill from a link, as it updates from it: "Atualizar sozinha"; an update waiting because it changes files that
 * run or would replace what agents changed, with what changed on each side, who changed it and when, and the choice
 * (Usar a versão do link, Manter a dos agentes), each with Desfazer; why its last update failed; Desfazer for the last.
 */
function SourceUpdate({ skill: s }: { skill: SkillDetail }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id);
  const agents = useAgents(org.id);
  if (s.source !== "url" || !s.sourceUrl) return null;
  const words = skillUpdateWords(t, i18n.language, s);
  const waiting = words.waiting;
  const nameOf = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? t("channel.unknownAgent");
  const by = changedByText(t, i18n.language, changesSinceLink(s), nameOf);
  const reopened = () => toast.show(t("skills.pending.reopened", { name: s.name }));
  const reopen = () => action.mutate({ type: "reopenUpdate", id: s.id }, { onSuccess: reopened });
  // A choice undone: its update waits again.
  const undoChoice = () => action.mutate({ type: "undoUpdate", id: s.id }, { onSuccess: reopened });
  const undo = () =>
    s.lastUpdate?.waited
      ? undoChoice()
      : action.mutate(
          { type: "undoUpdate", id: s.id },
          {
            onSuccess: (r) =>
              toast.show(
                t("skills.undone", { name: s.name, version: s.lastUpdate?.fromVersion ?? (r as SkillDetail).version }),
              ),
          },
        );
  const apply = () =>
    action.mutate(
      { type: "approveUpdate", id: s.id },
      {
        onSuccess: (r) =>
          (r as SkillSourceUpdate).status === "waiting"
            ? toast.show(t("skills.pending.changedAgain", { name: s.name }), "info")
            : toast.show(t(waiting?.applied ?? "skills.pending.applied", { name: s.name }), "success", {
                label: t("skills.undo"),
                run: undoChoice,
              }),
      },
    );
  const keep = () =>
    action.mutate(
      { type: "dismissUpdate", id: s.id },
      {
        onSuccess: () =>
          toast.show(t(waiting?.kept ?? "skills.pending.dismissed", { name: s.name }), "success", {
            label: t("skills.undo"),
            run: reopen,
          }),
      },
    );
  return (
    <>
      {waiting && (
        <section className="skill-wait" aria-label={t("skills.waitingChip")}>
          <span className="skill-wait__top ac-iconline">
            <Icon name="alert" size={16} />
            <span>{waiting.title}</span>
          </span>
          <ul className="waitcard__lines">
            <li className="ac-iconline">
              <Icon name="link" size={14} />
              <span>{waiting.since}</span>
            </li>
            {by && (
              <li className="ac-iconline">
                <Icon name="agent" size={14} />
                <span>{by}</span>
              </li>
            )}
          </ul>
          <p>{waiting.lead}</p>
          <PendingDiff skill={s} />
          <span className="skill-wait__acts">
            <Button
              size="sm"
              variant="primary"
              disabled={action.isPending}
              loading={action.isPending && action.variables?.type === "approveUpdate"}
              onClick={apply}
            >
              {waiting.apply}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              loading={action.isPending && action.variables?.type === "dismissUpdate"}
              onClick={keep}
            >
              {waiting.keep}
            </Button>
          </span>
        </section>
      )}
      {words.kept && (
        <p className="small muted skill-line">
          <span>{words.kept}</span>
          <Button size="sm" variant="ghost" icon="undo" disabled={action.isPending} onClick={reopen}>
            {t("skills.undo")}
          </Button>
        </p>
      )}
      {s.updateError && <Alert>{skillUpdateErrorText(t, s.updateError)}</Alert>}
      {words.last && (
        <p className="small muted skill-line">
          <span>{words.last.line}</span>
          <Button size="sm" variant="ghost" icon="undo" disabled={action.isPending} onClick={undo}>
            {words.last.undo}
          </Button>
        </p>
      )}
      <span className="row" style={{ gap: 10, alignItems: "center" }}>
        <Switch
          id={`skill-auto-${s.id}`}
          checked={s.autoUpdate ?? false}
          disabled={action.isPending}
          onCheckedChange={(on) => action.mutate({ type: "update", id: s.id, patch: { autoUpdate: on } })}
        />
        <span className="ac-hintline">
          <label htmlFor={`skill-auto-${s.id}`}>{t("skills.autoUpdate")}</label>
          <InfoHint name={t("common.about", { label: t("skills.autoUpdate") })}>{t("skills.autoUpdateHelp")}</InfoHint>
        </span>
      </span>
    </>
  );
}

/** One change an agent made: who and when, its diff opened in place, Desfazer on the newest while it is the skill's. */
function ChangeRow({
  skill,
  change: c,
  agent,
  undoable,
}: {
  skill: SkillDetail;
  change: SkillAgentChange;
  agent: string;
  undoable: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id);
  const [open, setOpen] = useState(false);
  const line = t("skills.agentChange", { agent, when: relativeTime(t, i18n.language, c.at) });
  return (
    <li className="skill-history__row">
      <span className="skill-line">
        <span className="small">
          {line}
          {c.undone && <> · {t("skills.history.undone")}</>}
        </span>
        <Button size="sm" variant="ghost" icon="eye" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? "skills.history.hide" : "skills.history.show")}
        </Button>
        {undoable && (
          <Button
            size="sm"
            variant="ghost"
            icon="undo"
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                { type: "undoUpdate", id: skill.id },
                {
                  onSuccess: () =>
                    toast.show(
                      t("skills.undone", { name: skill.name, version: skill.lastUpdate?.fromVersion ?? skill.version }),
                    ),
                },
              )
            }
          >
            {t("skills.undoAgentChange")}
          </Button>
        )}
      </span>
      {open && (
        <Diff
          addedLabel={t("proposals.added")}
          removedLabel={t("proposals.removed")}
          code
          aria-label={line}
          lines={diffLines(c.before.split("\n"), c.after.split("\n"))}
        />
      )}
    </li>
  );
}

/**
 * A person's skill as agents improve it: its own "Agentes melhoram esta skill sozinhos" (the workspace's until set),
 * and what the agents changed, newest first, each with its diff, Desfazer on the newest while it is still the skill's.
 */
function AgentImprove({ skill: s }: { skill: SkillDetail }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useSkillAction(org.id);
  const settings = useSkillSettings(org.id);
  const agents = useAgents(org.id);
  if (s.origin === "agent") return null;
  const changes = s.changes ?? [];
  const nameOf = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? t("channel.unknownAgent");
  return (
    <>
      <span className="row" style={{ gap: 10, alignItems: "center" }}>
        <Switch
          id={`skill-improve-${s.id}`}
          checked={s.agentsImprove ?? settings.data?.agentsImprove ?? true}
          disabled={action.isPending}
          onCheckedChange={(on) => action.mutate({ type: "update", id: s.id, patch: { agentsImprove: on } })}
        />
        <label htmlFor={`skill-improve-${s.id}`}>{t("skills.agentsImproveThis")}</label>
      </span>
      <section className="skill-history" aria-label={t("skills.history.title")}>
        <h3 className="ac-eyebrow">{t("skills.history.title")}</h3>
        {changes.length === 0 ? (
          <p className="small muted">{t("skills.history.empty")}</p>
        ) : (
          <ul className="skill-history__list">
            {changes.map((c, i) => (
              <ChangeRow
                key={c.id}
                skill={s}
                change={c}
                agent={nameOf(c.agentId)}
                undoable={i === 0 && !c.undone && !!s.lastUpdate?.agentId}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Skill detail: rendered SKILL.md, its files (text opens in a viewer; scripts need a sandbox), actions. */
export function SkillSheet({
  id,
  users,
  onClose,
}: {
  id: string;
  /** Agents that use it (named in the removal confirmation). */
  users: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const skill = useSkill(org.id, id);
  const action = useSkillAction(org.id);
  // Its refusals are said here, a repository none of the workspace's GitHub reads as Instalar skill says it.
  const refresh = useSkillAction(org.id, { silent: true });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const s = skill.data;
  const via = s ? skillSourceViaText(t, s) : null;
  return (
    <DetailsDialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("common.close")}
      title={s?.name ?? (skill.isError ? t("skills.title") : t("common.loading"))}
      icon={<Icon name="document" />}
      subtitle={
        s
          ? [
              t(`skills.source.${sourceKey(s)}`),
              t("skills.version", { version: s.version }),
              t("skills.updated", { when: relativeTime(t, i18n.language, s.updatedAt) }),
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      actions={
        s && (
          <>
            {s.source === "url" && s.sourceUrl && (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.isPending || refresh.isPending}
                loading={refresh.isPending}
                onClick={() =>
                  refresh.mutate(
                    { type: "updateFromSource", id: s.id },
                    {
                      onSuccess: (r) =>
                        toast.show(t(SKILL_UPDATE_TOAST[(r as SkillSourceUpdate).status], { name: s.name })),
                      onError: (e) => toast.show(skillRefusalText(t, e, can(org, "manage_connectors")), "error"),
                    },
                  )
                }
              >
                {t("skills.refresh")}
              </Button>
            )}
            {!editing && (
              <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>
                {t("skills.edit")}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="ac-btn--danger" onClick={() => setRemoving(true)}>
              {t("skills.remove")}
            </Button>
          </>
        )
      }
    >
      {skill.isError && !s && (
        <div className="skill-line">
          <Alert>{t("common.loadFailed")}</Alert>
          <Button size="sm" onClick={() => skill.refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {s && (
        <div className="skill-sheet">
          <div className="skill-sheet__main">
            <p className="muted">{s.description}</p>
            {via && <ViaLine>{via}</ViaLine>}
            <SourceUpdate skill={s} />
            <AgentImprove skill={s} />
            {editing ? <EditSkill skill={s} onDone={() => setEditing(false)} /> : <Markdown source={s.body} />}
          </div>
          <nav className="skill-sheet__files" aria-label={t("skills.files")}>
            <h3 className="ac-eyebrow">{t("skills.files")}</h3>
            <ul>
              {s.files.slice(0, SKILL_FILES_SHOWN).map((f) => (
                <li key={f.path}>
                  <FileEntry file={f} />
                </li>
              ))}
              {s.files.length > SKILL_FILES_SHOWN && (
                <li className="small muted">{t("skills.moreFiles", { count: s.files.length - SKILL_FILES_SHOWN })}</li>
              )}
            </ul>
          </nav>
        </div>
      )}
      {s && (
        <Dialog
          open={removing}
          onOpenChange={setRemoving}
          title={t("skills.removeTitle", { name: s.name })}
          description={skillRemovalText(t, users)}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              disabled={action.isPending}
              loading={action.isPending && action.variables?.type === "remove"}
              onClick={() =>
                action.mutate(
                  { type: "remove", id: s.id },
                  {
                    onSuccess: () => {
                      toast.show(t("skills.removed", { name: s.name }));
                      onClose();
                    },
                  },
                )
              }
            >
              {t("skills.remove")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </DetailsDialog>
  );
}

/** A file of the skill. Scripts run on the agent's PC. `ignored`: past what a skill keeps, or kept by an older import. */
function FileEntry({ file }: { file: SkillFile }) {
  const { t } = useTranslation();
  return (
    <span className="skill-file" data-status={file.status}>
      <code>{file.path}</code>
      {file.status === "script" ? (
        <Chip icon="code">{t("skills.runsOnPc")}</Chip>
      ) : file.status === "ignored" ? (
        <>
          <Chip icon="block">{t("skills.needsSandbox")}</Chip>
          <span className="small muted">
            {t("skills.reinstall")} {t("skills.assetLimit", { max: SKILL_ASSET_MB })}
          </span>
        </>
      ) : (
        <span className="small muted">{file.mime}</span>
      )}
    </span>
  );
}

function EditSkill({ skill, onDone }: { skill: SkillDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id);
  const [form, setForm] = useState({
    description: skill.description,
    body: skill.body,
    defaultForNewAgents: skill.defaultForNewAgents,
  });
  useUnsavedInDialog(useEdited(true, form));
  return (
    <form
      className="stack-4"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        action.mutate(
          { type: "update", id: skill.id, patch: form },
          {
            onSuccess: () => {
              toast.show(t("skills.saved", { name: skill.name }));
              onDone();
            },
          },
        );
      }}
    >
      <Locked when={action.isPending}>
        {skill.source === "url" && <Alert tone="neutral">{t("skills.editLinkNote")}</Alert>}
        <Field label={t("skills.description")} id="edit-skill-desc">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field
          label={t("skills.body")}
          id="edit-skill-body"
          hint={{ name: t("common.about", { label: t("skills.body") }), text: t("skills.newVersion") }}
        >
          <Textarea rows={14} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </Field>
        <span className="row" style={{ gap: 10, alignItems: "center" }}>
          <Switch
            id="edit-skill-default"
            checked={form.defaultForNewAgents}
            onCheckedChange={(on) => setForm({ ...form, defaultForNewAgents: on })}
          />
          <label htmlFor="edit-skill-default">{t("skills.defaultForNew")}</label>
        </span>
      </Locked>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!form.description.trim() || action.isPending}
          loading={action.isPending}
        >
          {t("skills.save")}
        </Button>
      </div>
    </form>
  );
}
