import {
  APP_OAUTH_RETURN,
  type GitHubAppInstallation,
  useCompleteGitHubApp,
  useConnections,
  useGitHubApp,
  useInstallGitHubApp,
  useRemoveGitHubApp,
} from "@agenteschat/client";
import { GITHUB_APP_AUTH } from "@agenteschat/client/lib/connected";
import { knownErrorText, oauthReturnText } from "@agenteschat/client/lib/errors";
import {
  githubAppPanel,
  installationReach,
  missingEventsText,
  removedText,
  removeInstallationText,
} from "@agenteschat/client/lib/github-app";
import { can } from "@agenteschat/client/lib/permissions";
import * as WebBrowser from "expo-web-browser";
import { useTranslation } from "react-i18next";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { openPage } from "../ai/parts";
import { chooseAction, confirmAction } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { APP_RETURN_URL, authAnswerOf, doneFinishing, markFinishing, stateOf } from "./logic";

/**
 * Installing the agentes.chat GitHub app from the phone (ADR 0156): GitHub's page in the browser, back to the app with
 * what GitHub sent, finished with the app's own session. `run` says whether it installed, and why not when that was a
 * failure (`error` null: the page was closed, or the account's owner was asked to install, which a toast says).
 */
export function useInstallGitHubAppHere() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const install = useInstallGitHubApp(orgId);
  const complete = useCompleteGitHubApp(orgId);
  const run = async (): Promise<{ installed: boolean; error: string | null }> => {
    let state: string | null = null;
    try {
      const url = await install.mutateAsync(APP_OAUTH_RETURN);
      state = stateOf(url);
      if (state) markFinishing(state);
      const result = await WebBrowser.openAuthSessionAsync(url, APP_RETURN_URL);
      if (result.type !== "success") return { installed: false, error: null };
      const answer = authAnswerOf(result.url);
      if (answer?.kind === "error") {
        if (answer.error !== "requested") return { installed: false, error: oauthReturnText(t, answer.error) };
        toast({ title: oauthReturnText(t, answer.error), icon: "info" });
        return { installed: false, error: null };
      }
      if (!answer?.installationId) return { installed: false, error: t("oauthReturn.failed") };
      await complete.mutateAsync({ state: answer.state, code: answer.code, installationId: answer.installationId });
      successHaptic();
      toast({ title: t("githubApp.installed") });
      return { installed: true, error: null };
    } catch (error) {
      return { installed: false, error: knownErrorText(t, error) ?? t("oauthReturn.failed") };
    } finally {
      if (state) doneFinishing(state);
    }
  };
  return { run, busy: install.isPending || complete.isPending };
}

/**
 * The GitHub connection's screen, as the web's Repositórios do GitHub: the accounts the app is installed on (each
 * opens Gerenciar no GitHub and Remover), installing on another account, an account for GitHub through the app
 * alone; and, for the server's owner only, this server's app, made in the browser (GitHub's manifest flow needs its
 * session).
 */
export function GitHubAppGroup({ onConnectAccount }: { onConnectAccount: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const orgId = useOrgId();
  const toast = useToast();
  const admin = can(org, "manage_connectors");
  const info = useGitHubApp(orgId);
  const connections = useConnections(orgId);
  const remove = useRemoveGitHubApp(orgId);
  const installer = useInstallGitHubAppHere();
  const github = connections.data?.find((c) => c.connector === "github" && !c.revokedAt);
  const panel = githubAppPanel(info.data, admin, github);
  const setup = info.data?.setup;
  if (!panel && !setup) return null;

  const install = async () => {
    const { error } = await installer.run();
    if (!error) return;
    errorHaptic();
    toast({ title: error, icon: "x" });
  };
  const drop = (i: GitHubAppInstallation) => {
    const alone = github?.authType === GITHUB_APP_AUTH && panel?.installations.length === 1;
    confirmAction({
      title: t("githubApp.removeTitle", { account: i.accountLogin }),
      text: removeInstallationText(t, i.accountLogin, alone),
      action: t("githubApp.remove"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        remove.mutate(i.id, {
          onSuccess: ({ uninstalled }) => {
            successHaptic();
            const said = removedText(t, i.accountLogin, uninstalled);
            if (uninstalled || !i.manageUrl) return toast({ title: said });
            // GitHub didn't confirm it: the installation's page there is the way out.
            const page = i.manageUrl;
            confirmAction({
              title: said,
              action: t("githubApp.manage"),
              cancel: t("common.close"),
              destructive: false,
              onConfirm: () => openPage(page),
            });
          },
          onError: (error) => {
            errorHaptic();
            toast({ title: knownErrorText(t, error) ?? t("mobile.app.failed"), icon: "x" });
          },
        }),
    });
  };
  const actions = (i: GitHubAppInstallation) =>
    chooseAction(
      i.accountLogin,
      [
        ...(i.manageUrl ? [{ label: t("githubApp.manage"), onPress: () => openPage(i.manageUrl ?? "") }] : []),
        { label: t("githubApp.remove"), destructive: true, onPress: () => drop(i) },
      ],
      t("common.cancel"),
    );
  const state = setup ? (setup.state === "ok" ? "on" : setup.state) : null;
  const eventsUrl = setup?.events?.url;
  // What the owner still ticks on GitHub for agents to hear it comes first: it is the one thing to do here.
  const serverNote = !setup
    ? null
    : (missingEventsText(t, setup) ??
      (setup.canCreate
        ? t("githubApp.server.without")
        : setup.source === "env"
          ? t("githubApp.server.line.env")
          : setup.state === "invalid"
            ? t("githubApp.server.line.invalid")
            : t("githubApp.server.lead")));

  return (
    <>
      {panel ? (
        <>
          <GroupedHeader>{t("githubApp.title")}</GroupedHeader>
          {panel.installations.length > 0 || panel.install || panel.connectAccount ? (
            <GroupedList>
              {panel.installations.map((i) => (
                <GroupedRow
                  key={i.id}
                  label={i.accountLogin}
                  value={installationReach(t, i)}
                  more={admin}
                  onPress={admin ? () => actions(i) : undefined}
                />
              ))}
              {panel.install ? (
                <GroupedRow
                  icon="plus"
                  label={t(panel.install === "first" ? "githubApp.install" : "githubApp.installMore")}
                  disabled={installer.busy}
                  onPress={() => void install()}
                />
              ) : null}
              {panel.connectAccount ? (
                <GroupedRow icon="plus" label={t("githubApp.connectAccount")} onPress={onConnectAccount} />
              ) : null}
            </GroupedList>
          ) : null}
          {/* Nothing installed: who agents are today, or who makes the app, in place of what it does. */}
          <GroupedFooter>
            {panel.installations.length > 0
              ? t("githubApp.text", { org: org?.name ?? "" })
              : panel.ownerHint
                ? t("githubApp.ownerHint")
                : panel.usingAccount
                  ? t("githubApp.usingAccount", { account: panel.usingAccount })
                  : t("githubApp.text", { org: org?.name ?? "" })}
          </GroupedFooter>
        </>
      ) : null}
      {setup && state ? (
        <>
          <GroupedHeader>{t("githubApp.server.title")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={setup.slug ?? t("githubApp.server.title")}
              value={t(`githubApp.server.state.${state}`)}
              chevron={Boolean(setup.htmlUrl)}
              onPress={setup.htmlUrl ? () => openPage(setup.htmlUrl ?? "") : undefined}
            />
            {setup.canCreate ? (
              <GroupedRow
                icon="globe"
                label={t("mobile.connectors.githubApp.createInBrowser")}
                onPress={() => openPage(`${serverUrl()}/org/${orgId}/settings/connectors`)}
              />
            ) : null}
            {eventsUrl ? (
              <GroupedRow icon="globe" label={t("githubApp.server.events")} onPress={() => openPage(eventsUrl)} />
            ) : null}
          </GroupedList>
          {serverNote ? <GroupedFooter>{serverNote}</GroupedFooter> : null}
        </>
      ) : null}
    </>
  );
}
