import type { Agent, AgentAudience } from "@agenteschat/client";
import type { AccessResource, Level, LevelState } from "@agenteschat/client/lib/access-levels";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { RepoChoice } from "@agenteschat/client/lib/repos";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, CardHeader, Icon, type IconName } from "@agenteschat/ui";
import { createContext, type ReactNode, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useAdminsLock } from "@/hooks/usePersonalView";
import type { AgentSection, AgentTab, Edits, Field, Look, Saved, Viewer } from "@/lib/agent-edit";

/** One unsaved change, as the save bar and the cards say it. */
export interface Change {
  key: string;
  field: Field;
  label: string;
  was: string;
  now: string;
  tab: AgentTab;
  sec?: AgentSection;
}

/** The draft: what is saved, with the person's edits on top. */
export interface Draft {
  name: string;
  /** The @ it will have: typed, or the one the new name gives. */
  handle: string;
  role: string;
  look: Look;
  instructions: string;
  model: string;
  key: string | undefined;
  /** The budget as typed ("" = the workspace default). */
  budget: string;
  owner: string;
  audience: AgentAudience;
  levels: Record<string, LevelState>;
  repos: RepoChoice | undefined;
  skills: string[] | undefined;
  channels: string[] | undefined;
  /** `NO_GROUP` or a group id; undefined until the groups load. */
  group: string | undefined;
}

export interface AgentEdit {
  agent: Agent;
  viewer: Viewer;
  /** Grammar of the saved name ("a Ada"). */
  g: ReturnType<typeof agentGrammar>;
  saved: Saved;
  draft: Draft;
  edits: Edits;
  set: <F extends Exclude<keyof Edits, "levels">>(field: F, value: Edits[F]) => void;
  setLevel: (resourceId: string, level: Level) => void;
  revert: (key: string) => void;
  changes: Change[];
  /** The change for a key (a field, or `levels:{id}`). */
  changeOf: (key: string) => Change | undefined;
  can: (field: Field) => boolean;
  errors: { name?: string; handle?: string; budget?: string; audience?: string; repos?: string };
  /** The access tree's resources (empty while loading or unavailable). */
  resources: AccessResource[];
  accessState: "loading" | "ready" | "unavailable";
  goTo: (tab: AgentTab, sec?: AgentSection) => void;
  /** Opens the repositories picker (on Ferramentas e acesso), with `add` already checked ("Liberar"). */
  pickRepos: (add?: string) => void;
  /** "João" (the saved owner's first name), or null. */
  ownerFirst: string | null;
  /** Opens a dialog of How it works (who thinks, where it works, the browser); each saves at once. */
  openWork: (dialog: "brain" | "computer" | "browser") => void;
  /** Which of those dialogs is open (the fact sheet marks its row). */
  workOpen: "brain" | "computer" | "browser" | null;
  /** Saves every unsaved change, as the save bar does: false when something failed or was refused. */
  save: () => Promise<boolean>;
  saving: boolean;
}

const Ctx = createContext<AgentEdit | null>(null);

export const AgentEditProvider = ({ value, children }: { value: AgentEdit; children: ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
);

export function useAgentEdit() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAgentEdit outside the agent page");
  return v;
}

/** "Alterado" and "Desfazer" for a changed card or row. */
export function ChangedTag({ changeKey }: { changeKey: string }) {
  const { t } = useTranslation();
  const { changeOf, revert } = useAgentEdit();
  const c = changeOf(changeKey);
  if (!c) return null;
  return (
    <span className="agp-changed">
      <span className="agp-tag">
        <Icon name="edit" size={14} />
        {t("agentPage.changed")}
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon="undo"
        className="agp-undo"
        aria-label={t("agentPage.undoLabel", { what: c.label })}
        onClick={() => revert(changeKey)}
      >
        {t("agentPage.undo")}
      </Button>
    </span>
  );
}

/** "Antes: <s>old value</s>" under a changed field. */
export function WasLine({ changeKey }: { changeKey: string }) {
  const { t } = useTranslation();
  const c = useAgentEdit().changeOf(changeKey);
  if (!c?.was) return null;
  return (
    <span className="agp-was">
      <Icon name="undo" size={14} />
      {t("agentPage.before")} <s>{c.was}</s>
    </span>
  );
}

/** "Só admins mudam" (or "Admins e João mudam") where the viewer can't edit. */
export function LockNote({ field }: { field: Field }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const adminsOnly = useAdminsLock();
  const { viewer, ownerFirst } = useAgentEdit();
  const ownerToo =
    field === "look" ||
    field === "levels" ||
    field === "repos" ||
    field === "audience" ||
    field === "channels" ||
    field === "machine" ||
    field === "brain";
  return (
    <span className="agp-lock">
      <Icon name="lock" size={14} />
      {ownerToo && ownerFirst && viewer === "member"
        ? t(modeKey(org, "agentPage.lock.adminsAndOwner"), { name: ownerFirst })
        : adminsOnly}
    </span>
  );
}

/** A card's head: icon, title (with an optional ⓘ hint), and on the right the changed tag, a lock note or an action. */
export function CardHead({
  icon,
  title,
  id,
  changeKeys = [],
  lock,
  action,
  subtitle,
  hint,
}: {
  icon: IconName;
  title: ReactNode;
  id?: string;
  changeKeys?: string[];
  /** Shown when nothing changed and the viewer can't edit. */
  lock?: Field;
  action?: ReactNode;
  subtitle?: ReactNode;
  hint?: { name: string; text: ReactNode };
}) {
  const { changeOf, can } = useAgentEdit();
  const changed = changeKeys.find((k) => changeOf(k));
  return (
    <CardHeader
      id={id}
      icon={icon}
      title={title}
      subtitle={subtitle}
      hint={hint}
      action={changed ? <ChangedTag changeKey={changed} /> : lock && !can(lock) ? <LockNote field={lock} /> : action}
    />
  );
}
