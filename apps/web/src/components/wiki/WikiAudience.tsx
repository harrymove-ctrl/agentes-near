import type { WikiFolderAudience, WikiPage } from "@agenteschat/client";
import { useRoles, useSetWikiFolderAudience, useWikiAction, useWikiFolderAudience } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { wikiAudienceOf } from "@agenteschat/client/lib/who-sees";
import {
  OPEN_WIKI_ACCESS,
  type WikiAccess,
  type WikiAccessDraft,
  type WikiLevel,
  wikiAccessDraft,
  wikiAccessLimited,
  wikiAccessOf,
  wikiBaseLevels,
  wikiRowCap,
} from "@agenteschat/client/lib/wiki";
import { AccessDialog, type AccessLevel, type AccessSubject, Avatar, Button, Icon, RoleMark } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WhoSeesDialog } from "@/components/WhoSees";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * "Acesso" to a wiki page or folder (ADR 0023 addenda), in the shared `AccessDialog`: a level for everyone and one per
 * role, person and agent. Administrators always read and edit; the server refuses a choice that leaves out whoever makes it. A
 * page's dialog can also set the page's folder.
 */
export function WikiAudienceDialog({
  page,
  folder,
  onClose,
}: {
  page?: WikiPage;
  folder?: string;
  onClose: () => void;
}) {
  const { org } = useOrg();
  const [onFolder, setOnFolder] = useState(folder ?? null);
  // "" is the wiki's root: every page and folder.
  const info = useWikiFolderAudience(org.id, onFolder ?? "", onFolder !== null);
  if (onFolder !== null) {
    if (!info.data) return null;
    return (
      <FolderForm key={onFolder} folder={onFolder} own={info.data.own} above={info.data.above} onClose={onClose} />
    );
  }
  if (!page) return null;
  return <PageForm page={page} onFolder={setOnFolder} onClose={onClose} />;
}

/**
 * "Quem vê" on a page: the same three options as a task, for anyone who edits it. Roles already on it stay on a list.
 * Who also manages roles has the whole dialog a click away (roles, agents and who edits).
 */
export function WikiWhoSeesDialog({ page, onClose }: { page: WikiPage; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useWikiAction(org.id);
  const [advanced, setAdvanced] = useState(false);
  const roleIds = page.audience?.roleIds ?? [];
  if (advanced) return <WikiAudienceDialog page={page} onClose={onClose} />;
  const value = page.audience
    ? { mode: "people" as const, userIds: page.audience.userIds }
    : { mode: "everyone" as const };
  return (
    <WhoSeesDialog
      title={t("whoSees.pageTitle")}
      value={value}
      peopleNote={roleIds.length > 0 ? t("whoSees.rolesToo") : undefined}
      saving={action.isPending}
      extra={
        can(org, "manage_roles") ? (
          <Button variant="ghost" onClick={() => setAdvanced(true)}>
            {t("whoSees.moreOptions")}
          </Button>
        ) : null
      }
      onClose={onClose}
      onSave={(next, kind) =>
        action.mutate(
          { type: "who", slug: page.slug, audience: wikiAudienceOf(next, roleIds, kind) },
          { onSuccess: onClose, onError: (e) => toast.show(errorText(t, e, i18n.language), "error") },
        )
      }
    />
  );
}

function PageForm({
  page,
  onFolder,
  onClose,
}: {
  page: WikiPage;
  onFolder: (folder: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useWikiAction(org.id);
  return (
    <AudienceForm
      title={t("wiki.audienceTitle", { title: page.title })}
      description={t("wiki.audienceText")}
      initial={{
        audience: page.audience ?? null,
        agentIds: page.agentIds ?? null,
        editors: page.editors ?? null,
        agentEditorIds: page.agentEditorIds ?? null,
      }}
      above={page.folderAudience ?? null}
      saving={action.isPending}
      extra={
        page.folder ? (
          <Button onClick={() => onFolder(page.folder)}>{t("wiki.audienceUseFolder", { folder: page.folder })}</Button>
        ) : null
      }
      onClose={onClose}
      onSave={(access) =>
        action.mutate(
          { type: "audience", slug: page.slug, access },
          {
            onSuccess: () => {
              toast.show(wikiAccessLimited(access) ? t("wiki.audienceSaved") : t("wiki.audienceOpened"));
              onClose();
            },
            onError: (e) => toast.show(errorText(t, e), "error"),
          },
        )
      }
    />
  );
}

function FolderForm({
  folder,
  own,
  above,
  onClose,
}: {
  folder: string;
  own: WikiFolderAudience | null;
  above: WikiFolderAudience | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSetWikiFolderAudience(org.id);
  return (
    <AudienceForm
      title={folder ? t("wiki.audienceFolderTitle", { folder }) : t("wiki.audienceRootTitle")}
      description={folder ? t("wiki.audienceFolderText") : t("wiki.audienceRootText")}
      initial={own ?? above ?? OPEN_WIKI_ACCESS}
      above={above}
      saving={save.isPending}
      onClose={onClose}
      onSave={(access) =>
        save.mutate(
          { folder, access },
          {
            onSuccess: () => {
              toast.show(wikiAccessLimited(access) ? t("wiki.audienceFolderSaved") : t("wiki.audienceFolderOpened"));
              onClose();
            },
            onError: (e) => toast.show(errorText(t, e), "error"),
          },
        )
      }
    />
  );
}

type Group = "roles" | "users" | "agentRows";

function AudienceForm({
  title,
  description,
  initial,
  above,
  saving,
  extra,
  onSave,
  onClose,
}: {
  title: string;
  description: string;
  initial: WikiAccess;
  /** The limited folder this sits in: here it can only be narrower. */
  above: WikiFolderAudience | null;
  saving: boolean;
  extra?: ReactNode;
  onSave: (access: WikiAccess) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const dir = useDirectory(org.id);
  const [draft, setDraft] = useState<WikiAccessDraft>(() => wikiAccessDraft(initial));
  const cap = wikiAccessDraft(above ?? OPEN_WIKI_ACCESS);
  const names = {
    none: t("wiki.audienceLevelNone"),
    view: t("wiki.audienceLevelView"),
    edit: t("wiki.audienceLevelEdit"),
  };
  const level = (value: WikiLevel): AccessLevel<WikiLevel> => ({ value, label: names[value] });
  const groupOf = (id: string): Group => (id[0] === "r" ? "roles" : id[0] === "u" ? "users" : "agentRows");
  const baseOf = (group: Group) => (group === "agentRows" ? draft.agents : draft.people);
  const capOf = (group: Group, id: string) =>
    group === "users"
      ? ("edit" as const)
      : group === "roles"
        ? wikiRowCap(cap.people, cap.roles[id])
        : wikiRowCap(cap.agents, cap.agentRows[id]);
  const subjects: AccessSubject[] = [
    ...sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).map((r) => ({
      id: `r:${r.id}`,
      name: r.name,
      detail: t("wiki.audienceRoleDetail"),
      group: t("wiki.audienceRoles"),
      lead: <RoleMark color={r.color} icon={r.icon} size={24} />,
    })),
    ...dir.members.map((m) => ({
      id: `u:${m.userId}`,
      name: m.name,
      detail: m.email,
      group: t("wiki.audiencePeople"),
      lead: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
    })),
    ...dir.agents.map((a) => ({
      id: `a:${a.id}`,
      name: a.name,
      detail: t("wiki.audienceAgentDetail"),
      group: t("wiki.audienceAgents"),
      lead: <AgentAvatar agent={a} size="sm" name={a.name} />,
    })),
  ];
  const parts = (s: AccessSubject) => ({ group: groupOf(s.id), id: s.id.slice(2) });
  const levelsFor = (s: AccessSubject) => {
    const { group, id } = parts(s);
    const most = capOf(group, id);
    if (most === "none") return [];
    if (baseOf(group) === "view") return most === "edit" ? [level("edit")] : [];
    return most === "edit" ? [level("view"), level("edit")] : [level("view")];
  };
  const levelOf = (s: AccessSubject) => {
    const { group, id } = parts(s);
    const value = draft[group][id] ?? "none";
    // With everyone editing, a row says nothing: it comes back when "everyone" is lowered.
    if (value === "none" || baseOf(group) === "edit" || (baseOf(group) === "view" && value !== "edit")) {
      return undefined;
    }
    return value;
  };
  return (
    <AccessDialog<WikiLevel>
      title={title}
      description={description}
      note={
        above
          ? above.folder
            ? t("wiki.audienceInFolder", { folder: above.folder })
            : t("wiki.audienceInRoot")
          : undefined
      }
      base={[
        {
          id: "everyone",
          name: t("wiki.audienceEveryone"),
          detail: t("wiki.audienceEveryoneText"),
          lead: <Icon name="audienceEveryone" size={20} />,
          level: draft.people,
          levels: [...wikiBaseLevels(cap.people)].reverse().map(level),
          onChange: (people) => setDraft((d) => ({ ...d, people })),
        },
        {
          id: "agents",
          name: t("wiki.audienceAgentsAll"),
          detail: t("wiki.audienceAgentsAllText"),
          lead: <Icon name="agent" size={20} />,
          level: draft.agents,
          levels: [...wikiBaseLevels(cap.agents)].reverse().map(level),
          onChange: (agents) => setDraft((d) => ({ ...d, agents })),
        },
      ]}
      subjects={subjects}
      levelOf={levelOf}
      levelsFor={levelsFor}
      onLevelChange={(s, value) => {
        const { group, id } = parts(s);
        // Adding someone while everyone edits means limiting it: "everyone" drops, in plain sight, until Salvar.
        const base = group === "agentRows" ? "agents" : "people";
        setDraft((d) => ({
          ...d,
          [group]: { ...d[group], [id]: value ?? "none" },
          ...(value && d[base] === "edit" ? { [base]: "none" } : {}),
        }));
      }}
      labels={{
        add: t("wiki.audienceAdd"),
        addList: t("wiki.audienceAdd"),
        addSearch: t("wiki.audienceAddSearch"),
        noResults: t("wiki.audienceNoMatch"),
        removeOf: (name) => t("common.removeName", { name }),
        levelOf: (name) => t("wiki.audienceLevel", { name }),
        close: t("common.close"),
        cancel: t("common.cancel"),
        save: t("common.save"),
      }}
      footerStart={extra}
      saving={saving}
      onSave={() => onSave(wikiAccessOf(draft))}
      onClose={onClose}
    />
  );
}
