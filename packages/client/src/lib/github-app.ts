import type { TFunction } from "i18next";
import type { Connection, GitHubAppInfo, GitHubAppInstallation, GitHubAppSetup } from "../api/types";
import { GITHUB_APP_AUTH } from "./connected";
import { joinNames, namesText } from "./format";

/**
 * The GitHub repositories panel (ADR 0156), the same on the web and the phone: what it shows for the organization's
 * installations of the agentes.chat app, from `GET …/github-app` and the organization's GitHub connection.
 */

export interface GitHubAppPanel {
  installations: GitHubAppInstallation[];
  /** The install button an admin gets: the first account, or another one. */
  install: "first" | "more" | null;
  /** The account agents act as today, when nothing is installed yet and the app can be. */
  usingAccount: string | null;
  /** GitHub is the app alone: an admin may connect an account too (what GitHub Projects need). */
  connectAccount: boolean;
  /** No app on this server: its owner makes one (a hint for the admins who aren't the owner). */
  ownerHint: boolean;
}

/** What the panel shows, or null when there is nothing: no app here, none installed, nobody to point to. */
export function githubAppPanel(
  info: GitHubAppInfo | undefined,
  admin: boolean,
  github: Pick<Connection, "authType" | "accountLabel"> | null | undefined,
): GitHubAppPanel | null {
  if (!info) return null;
  const installations = info.installations;
  const ownerHint = admin && !info.installable && !info.setup && info.ownerCreates === true;
  if (!info.installable && installations.length === 0 && !ownerHint) return null;
  const appOnly = github?.authType === GITHUB_APP_AUTH;
  return {
    installations,
    install: admin && info.installable ? (installations.length > 0 ? "more" : "first") : null,
    usingAccount:
      info.installable && installations.length === 0 && github && !appOnly ? (github.accountLabel ?? null) : null,
    connectAccount: admin && appOnly,
    ownerHint,
  };
}

/**
 * The accounts GitHub through the app alone is installed on, as its row says them ("Pelo app agentes.chat em acme e
 * octo-labs"): the server keeps them comma-joined (GitHub logins hold no commas), the first two said, then how many more.
 */
export const appAccountsText = (t: TFunction, accounts: string) =>
  t("githubApp.viaApp", { accounts: namesText(t, accounts.split(", "), 2) });

/** GitHub's own names for the events, as the app's Permissions & events page lists them. */
const GITHUB_EVENT_LABELS: Record<string, string> = {
  issues: "Issues",
  issue_comment: "Issue comment",
  pull_request: "Pull request",
  pull_request_review: "Pull request review",
  pull_request_review_comment: "Pull request review comment",
  pull_request_review_thread: "Pull request review thread",
  discussion: "Discussion",
  discussion_comment: "Discussion comment",
};

/** What the server's owner ticks on the app for agents to hear GitHub (`setup.events`); null when nothing is missing. */
export const missingEventsText = (t: TFunction, setup: Pick<GitHubAppSetup, "events"> | null | undefined) =>
  setup?.events?.missing.length
    ? t("githubApp.server.line.events", {
        events: joinNames(
          setup.events.missing.map((e) => GITHUB_EVENT_LABELS[e] ?? e),
          t,
        ),
      })
    : null;

/** An installation's state: suspended on GitHub, or which of its account's repositories it reaches. */
export const installationReach = (t: TFunction, i: Pick<GitHubAppInstallation, "suspended" | "repositorySelection">) =>
  i.suspended
    ? t("githubApp.suspended")
    : i.repositorySelection === "all"
      ? t("githubApp.allRepos")
      : t("githubApp.someRepos");

/**
 * Before removing an installation: it is uninstalled on GitHub too, and when the app is the organization's only
 * GitHub (`alone`: its last installation, no account connected), GitHub goes with it.
 */
export function removeInstallationText(t: TFunction, account: string, alone: boolean) {
  const text = t("githubApp.removeText", { account });
  return alone ? t("common.joinSentences", { a: text, b: t("githubApp.removeLast") }) : text;
}

/** After removing one: uninstalled on GitHub too, or GitHub didn't confirm it (the way out is its page there). */
export const removedText = (t: TFunction, account: string, uninstalled: boolean) =>
  t(uninstalled ? "githubApp.removed" : "githubApp.notUninstalled", { account });

/**
 * What disconnecting GitHub does to the app (null: nothing to add): the app alone is uninstalled from its accounts;
 * an account's connection goes and agents stay on GitHub through the app.
 */
export function githubDisconnectNote(
  t: TFunction,
  item: { def: { id: string } | null; viaGithubApp?: boolean },
  installations: readonly Pick<GitHubAppInstallation, "accountLogin">[],
) {
  if (item.def?.id !== "github" || installations.length === 0) return null;
  const accounts = joinNames(
    installations.map((i) => i.accountLogin),
    t,
  );
  return t(item.viaGithubApp ? "githubApp.disconnectApp" : "githubApp.disconnectKeepsApp", { accounts });
}
