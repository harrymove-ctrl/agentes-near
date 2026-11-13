import type { GitHubRepositories } from "@agenteschat/client";
import {
  useAgentMergeRepos,
  useGitHubApp,
  useGitHubRepos,
  useInstallGitHubApp,
  useSetAgentMergeRepos,
} from "@agenteschat/client";
import { can as orgCan } from "@agenteschat/client/lib/permissions";
import {
  applyPick,
  covers,
  isAccount,
  makeFirst,
  mergeChoices,
  type RepoChoice,
  repoExists,
  repoListOf,
  repoName,
  toggleRepo,
} from "@agenteschat/client/lib/repos";
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogFooter,
  DialogSearchList,
  Icon,
  type IconName,
  Locked,
  Menu,
  MenuItem,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { navigateAway } from "@/lib/navigate";
import { ChangedTag, useAgentEdit, WasLine } from "./context";

/*
 * Which GitHub repositories the agent may use:
 * under the GitHub row of Ferramentas e acesso, the chips and "Mudar"; the
 * choice happens in a dialog. Changes go to the page's draft (save bar).
 */

const entryIcon = (entry: string, first: boolean): IconName => (first ? "pin" : isAccount(entry) ? "members" : "repo");

/** One repository of the list: a chip; for editors a menu (start here, remove). */
function RepoEntry({
  entry,
  first,
  gone,
  editable,
  onFirst,
  onRemove,
}: {
  entry: string;
  first: boolean;
  gone: boolean;
  editable: boolean;
  onFirst: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const name = repoName(t, entry);
  const text = gone ? t("repos.gone", { repo: name }) : name;
  if (!editable) {
    return (
      <Chip icon={gone ? "alert" : entryIcon(entry, first)} tone={gone ? "waiting" : "neutral"}>
        {text}
      </Chip>
    );
  }
  return (
    <Menu
      label={t("repos.options", { repo: name })}
      trigger={
        <button
          type="button"
          className={gone ? "ac-chip ac-chip--waiting agp-chipbtn" : "ac-chip agp-chipbtn"}
          title={gone ? t("repos.goneHelp") : first ? t("repos.startsHere") : undefined}
          aria-label={`${text} · ${t("repos.options", { repo: name })}`}
        >
          <Icon name={gone ? "alert" : entryIcon(entry, first)} size={14} />
          {text}
        </button>
      }
    >
      {!first && !gone && (
        <MenuItem icon="pin" description={t("repos.makeFirstHelp")} onSelect={onFirst}>
          {t("repos.makeFirst")}
        </MenuItem>
      )}
      <MenuItem icon="close" onSelect={onRemove}>
        {t("repos.remove")}
      </MenuItem>
    </Menu>
  );
}

/** Under the GitHub row: "Em quais repositórios", the chips, "Mudar". */
export function ReposBlock() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { g, draft, set, can, changeOf, errors, pickRepos } = useAgentEdit();
  const listing = useGitHubRepos(org.id);
  const r = draft.repos;
  if (!r) return <LoadingLine width={180} />;
  const editable = can("repos");
  const exists = (e: string) => repoExists(listing.data, e);
  const start = r.list.find(exists);
  return (
    <div className="agp-repos">
      <span className="agp-repos__label">
        {t("repos.label")}
        {changeOf("repos") && <ChangedTag changeKey="repos" />}
      </span>
      <span className="agp-chips">
        {r.mode === "all" ? (
          <>
            <Chip icon="globe">{t("repos.all")}</Chip>
            <span className="small muted">{t("repos.allHelp", g)}</span>
          </>
        ) : r.list.length === 0 ? (
          <span className="small muted">{t("repos.noneChosen")}</span>
        ) : (
          r.list.map((e, i) => (
            <RepoEntry
              key={e}
              entry={e}
              first={i === 0}
              gone={!exists(e)}
              editable={editable}
              onFirst={() => set("repos", { mode: "some", list: makeFirst(r.list, e) })}
              onRemove={() => set("repos", { mode: "some", list: r.list.filter((x) => x !== e) })}
            />
          ))
        )}
        {editable && (
          <Button size="sm" variant="ghost" icon="edit" onClick={() => pickRepos()}>
            {r.mode === "all" ? t("repos.choose") : t("repos.change")}
          </Button>
        )}
      </span>
      {r.mode === "some" && r.list.length > 1 && start && (
        <span className="small muted agp-repos__start">
          <Icon name="pin" size={14} />
          {t("repos.startsAt", { repo: repoName(t, start) })}
        </span>
      )}
      {errors.repos && (
        <span className="newag__err" role="alert">
          <Icon name="info" size={14} />
          {errors.repos}
        </span>
      )}
      <WasLine changeKey="repos" />
    </div>
  );
}

/**
 * "Pode fazer merge sem perguntar", under the repositories: where the agent merges with no approval card, for its
 * owner or an admin to choose. Saved at once, outside the page's save bar, like "Aprovado sempre": it is a permission
 * on its own, with its own line in the audit.
 */
export function MergeReposBlock() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, can } = useAgentEdit();
  const merge = useAgentMergeRepos(org.id, agent.id);
  const [picking, setPicking] = useState(false);
  const list = merge.data ?? [];
  const editable = can("repos");
  if (!merge.data || (list.length === 0 && !editable)) return null;
  return (
    <div className="agp-repos">
      <span className="agp-repos__label">{t("repos.merge.label")}</span>
      <span className="agp-chips">
        {list.length === 0 ? (
          <span className="small muted">{t("repos.merge.none")}</span>
        ) : (
          list.map((repo) => (
            <Chip key={repo} icon="repo">
              {repo}
            </Chip>
          ))
        )}
        {editable && (
          <Button size="sm" variant="ghost" icon="edit" onClick={() => setPicking(true)}>
            {list.length === 0 ? t("repos.choose") : t("repos.change")}
          </Button>
        )}
      </span>
      <span className="small muted">{t("repos.merge.help")}</span>
      {picking && <MergeRepoDialog chosen={list} onClose={() => setPicking(false)} />}
    </div>
  );
}

function MergeRepoDialog({ chosen, onClose }: { chosen: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g, saved } = useAgentEdit();
  const listing = useGitHubRepos(org.id);
  const save = useSetAgentMergeRepos(org.id, agent.id);
  const [pick, setPick] = useState(chosen);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = mergeChoices(listing.data, saved.repos ? repoListOf(saved.repos) : []).filter(
    (name) => !query || name.toLowerCase().includes(query),
  );
  const id = (s: string) => `merge-repo-${s.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("repos.merge.dialogTitle", g)}
      description={t("repos.merge.dialogDesc")}
      closeLabel={t("common.close")}
      className="agp-repodialog"
    >
      {listing.isLoading ? (
        <div className="ac-dialog__body">
          <LoadingLine width={220} />
        </div>
      ) : listing.isError ? (
        <p className="ac-dialog__empty">{t("repos.unavailable")}</p>
      ) : (
        <Locked when={save.isPending}>
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            searchLabel={t("repos.search")}
            searchPlaceholder={t("repos.search")}
            listLabel={t("repos.merge.label")}
            isEmpty={shown.length === 0}
            emptyText={query ? t("repos.noMatch", { q }) : t("repos.none")}
          >
            {shown.map((name) => (
              <label key={name} htmlFor={id(name)} className="scope-row">
                <Checkbox
                  id={id(name)}
                  checked={pick.includes(name)}
                  onCheckedChange={(on) => setPick((p) => (on ? [...p, name] : p.filter((r) => r !== name)))}
                />
                <Icon name="repo" size={16} />
                <span className="scope-row__text">
                  <b>{name}</b>
                </span>
              </label>
            ))}
          </DialogSearchList>
        </Locked>
      )}
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(pick, { onSuccess: onClose })}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The rows of the picker for one account: "Toda a conta X" (no search), then its repositories.
 * With "Todos os repositórios" on (`all`) every row shows checked and dimmed: what "todos" covers.
 */
function AccountRows({
  account,
  query,
  list,
  all,
  onToggle,
}: {
  account: GitHubRepositories["accounts"][number];
  query: string;
  list: string[];
  all: boolean;
  onToggle: (entry: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const whole = `${account.login}/*`;
  const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  const wholeOn = list.some((e) => same(e, whole));
  const startsHere = (entry: string) =>
    !all && same(list[0], entry) ? (
      <Chip icon="pin" className="agp-repodialog__first">
        {t("repos.startsHere")}
      </Chip>
    ) : null;
  const repos = account.repositories.filter((r) => !query || r.fullName.toLowerCase().includes(query));
  if (repos.length === 0 && query) return null;
  const id = (s: string) => `repo-${s.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <section className="agp-repogroup" aria-label={account.login}>
      <p className="ac-eyebrow">{account.login}</p>
      {!query && (
        <label htmlFor={id(whole)} className="scope-row" data-off={all || undefined}>
          <Checkbox
            id={id(whole)}
            checked={all || wholeOn}
            disabled={all}
            onCheckedChange={(on) => onToggle(whole, on)}
          />
          <Icon name="members" size={16} />
          <span className="scope-row__text">
            <b>{t("repos.wholeAccount", { owner: account.login })}</b>
            <span className="small muted">{t("repos.wholeAccountHelp", { count: account.repositories.length })}</span>
          </span>
          {startsHere(whole)}
        </label>
      )}
      {repos.map((r) => (
        <label key={r.fullName} htmlFor={id(r.fullName)} className="scope-row" data-off={all || wholeOn || undefined}>
          <Checkbox
            id={id(r.fullName)}
            checked={all || covers(list, r.fullName)}
            disabled={all || wholeOn}
            onCheckedChange={(on) => onToggle(r.fullName, on)}
          />
          <Icon name={r.private ? "lock" : "globe"} size={16} />
          <span className="scope-row__text">
            <b>{r.fullName}</b>
            <span className="small muted">{r.private ? t("repos.private") : t("repos.public")}</span>
          </span>
          {startsHere(r.fullName)}
        </label>
      ))}
    </section>
  );
}

/**
 * "Repositórios da Ada": "Todos os repositórios" on top of
 * the list, which is always there (with Todos on, all of it checked and dimmed); search; the
 * organization's repositories by account. The button says what it will do ("Usar 2
 * repositórios") and puts the choice in the draft. `add` ("Liberar") starts with it checked.
 */
export function RepoDialog({
  add,
  onClose,
  onUse,
}: {
  add?: string;
  onClose: () => void;
  onUse: (next: RepoChoice) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g, draft } = useAgentEdit();
  const listing = useGitHubRepos(org.id);
  const app = useGitHubApp(org.id);
  const install = useInstallGitHubApp(org.id);
  const current = draft.repos ?? { mode: "all", list: [] };
  const [pick, setPick] = useState<RepoChoice>(() =>
    add && !covers(current.list, add) ? { mode: "some", list: [...current.list, add] } : current,
  );
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const accounts = listing.data?.accounts ?? [];
  const matches = accounts.some((a) => a.repositories.some((r) => !query || r.fullName.toLowerCase().includes(query)));
  const canInstall = orgCan(org, "manage_connectors") && app.data?.installable === true;
  const exists = (e: string) => repoExists(listing.data, e);
  const all = pick.mode === "all";
  const total = accounts.reduce((n, a) => n + a.repositories.length, 0);
  const chosen = pick.list.filter(exists);
  const first = chosen[0];
  const note = all
    ? listing.data && total > 0
      ? t("repos.allFoot", { count: total })
      : undefined
    : first
      ? t("repos.startsAt", { repo: repoName(t, first) })
      : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("repos.dialogTitle", g)}
      description={t("repos.dialogDesc", g)}
      closeLabel={t("common.close")}
      className="agp-repodialog"
    >
      <div className="ac-dialog__tools">
        <label htmlFor="repos-all" className="agp-repodialog__all">
          <Checkbox
            id="repos-all"
            checked={all}
            onCheckedChange={(on) => setPick((p) => ({ ...p, mode: on ? "all" : "some" }))}
          />
          <span className="scope-row__text">
            <b>{t("repos.all")}</b>
            <span className="small muted">{t("repos.allRowHelp", { org: org.name })}</span>
          </span>
        </label>
      </div>
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
          listLabel={t("repos.label")}
          isEmpty={!matches}
          emptyText={
            <span className="agp-repodialog__empty">
              <b>{query ? t("repos.noMatch", { q }) : t("repos.none")}</b>
              <span className="small muted">{t("repos.noMatchHelp")}</span>
              {canInstall && (
                <Button
                  size="sm"
                  icon="plus"
                  loading={install.isPending}
                  onClick={() =>
                    install.mutate(`/org/${org.id}/agents/${agent.id}?tab=access`, {
                      onSuccess: (url) => navigateAway(url),
                    })
                  }
                >
                  {t("repos.installOther")}
                </Button>
              )}
            </span>
          }
        >
          {accounts.map((a) => (
            <AccountRows
              key={a.login}
              account={a}
              query={query}
              list={pick.list}
              all={all}
              onToggle={(entry, on) => setPick((p) => ({ mode: "some", list: toggleRepo(p.list, entry, on) }))}
            />
          ))}
          {listing.data?.truncated && <p className="small muted">{t("repos.truncated")}</p>}
        </DialogSearchList>
      )}
      <DialogFooter bar note={note}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!all && chosen.length === 0}
          onClick={() => onUse(applyPick(current.list, pick, exists))}
        >
          {all
            ? t("repos.useAll")
            : chosen.length === 0
              ? t("repos.pickOne")
              : t("repos.useCount", { count: chosen.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "· 2 repositórios" / "· todos os repositórios" after GitHub's level in Visão geral. */
export function useRepoSuffix() {
  const { t } = useTranslation();
  const { saved } = useAgentEdit();
  const r = saved.repos;
  if (!r) return "";
  return ` · ${r.mode === "all" ? t("repos.allLower") : t("repos.count", { count: r.list.length })}`;
}
