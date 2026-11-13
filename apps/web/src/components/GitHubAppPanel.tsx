import type { GitHubAppInstallation } from "@agenteschat/client";
import {
  useConnections,
  useGitHubApp,
  useInstallGitHubApp,
  useRemoveGitHubApp,
  useRemoveGitHubAppSettings,
  useStartGitHubAppManifest,
} from "@agenteschat/client";
import { GITHUB_APP_AUTH } from "@agenteschat/client/lib/connected";
import {
  githubAppPanel,
  installationReach,
  missingEventsText,
  removedText,
  removeInstallationText,
} from "@agenteschat/client/lib/github-app";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogFooter,
  Icon,
  InfoHint,
  List,
  SettingNote,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KEY_STATE_CHIP } from "@/components/GifKeyCard";
import { useOrg } from "@/components/org-context";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/** Where GitHub sends the person back: the install's and the manifest's returns land on Conectores. */
const connectorsPath = (orgId: string) => `/org/${orgId}/settings/connectors`;

/**
 * Settings → Conectores: the GitHub accounts where the organization installed the agentes.chat app (ADR 0033, 0156).
 * Where it is installed, agents act on GitHub as the app. Each account opens its page on GitHub (Gerenciar no GitHub,
 * where its repositories are picked), and Remover uninstalls it there too. Only installations made from here count
 * for this organization. Hidden when the server has no app and nothing is installed, except for the admins whose
 * server owner can make one.
 */
export function GitHubAppPanel({ onConnectAccount }: { onConnectAccount: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  const info = useGitHubApp(org.id);
  const connections = useConnections(org.id);
  const install = useInstallGitHubApp(org.id);
  const [removing, setRemoving] = useState<GitHubAppInstallation | null>(null);
  const github = connections.data?.find((c) => c.connector === "github" && !c.revokedAt);
  const panel = githubAppPanel(info.data, admin, github);
  if (!panel) return null;
  const alone = github?.authType === GITHUB_APP_AUTH && panel.installations.length === 1;
  return (
    <section className="gh-app" aria-labelledby="sec-github-app">
      <div className="gh-app__head">
        <div className="ac-hintline">
          <h3 id="sec-github-app" className="ac-card__title">
            {t("githubApp.title")}
          </h3>
          <InfoHint name={t("common.about", { label: t("githubApp.title") })}>
            {t("githubApp.text", { org: org.name })}
          </InfoHint>
        </div>
        {panel.install && (
          <Button
            size="sm"
            icon="plus"
            loading={install.isPending}
            disabled={install.isPending}
            onClick={() => install.mutate(connectorsPath(org.id), { onSuccess: (url) => navigateAway(url) })}
          >
            {t(panel.install === "first" ? "githubApp.install" : "githubApp.installMore")}
          </Button>
        )}
      </div>
      {panel.installations.length > 0 ? (
        <List aria-label={t("githubApp.title")}>
          {panel.installations.map((i) => (
            <div key={i.id} className="ac-list__row">
              <span className="list-col">
                <span className="list-title">
                  <span>{i.accountLogin}</span>
                  <Chip icon={i.suspended ? "waiting" : "check"} tone={i.suspended ? "waiting" : "done"}>
                    {installationReach(t, i)}
                  </Chip>
                </span>
              </span>
              {admin && (
                <span className="ac-acts">
                  {i.manageUrl && (
                    <Button asChild size="sm">
                      <a
                        href={i.manageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t("githubApp.manageName", { account: i.accountLogin })}
                      >
                        <Icon name="external" size={14} />
                        {t("githubApp.manage")}
                      </a>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("githubApp.removeName", { account: i.accountLogin })}
                    onClick={() => setRemoving(i)}
                  >
                    {t("githubApp.remove")}
                  </Button>
                </span>
              )}
            </div>
          ))}
        </List>
      ) : (
        <p className="small muted">
          {panel.ownerHint
            ? t("githubApp.ownerHint")
            : panel.usingAccount
              ? t("githubApp.usingAccount", { account: panel.usingAccount })
              : t("githubApp.none")}
        </p>
      )}
      {panel.connectAccount && (
        <span className="ac-acts">
          <Button size="sm" variant="ghost" icon="plus" onClick={onConnectAccount}>
            {t("githubApp.connectAccount")}
          </Button>
        </span>
      )}
      <RemoveInstallationDialog installation={removing} alone={alone} onClose={() => setRemoving(null)} />
    </section>
  );
}

/** "Remover o app de acme?": it is uninstalled on GitHub too, and the last one of the app alone takes GitHub away. */
function RemoveInstallationDialog({
  installation,
  alone,
  onClose,
}: {
  installation: GitHubAppInstallation | null;
  alone: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const remove = useRemoveGitHubApp(org.id);
  const account = installation?.accountLogin ?? "";
  return (
    <Dialog
      open={installation !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("githubApp.removeTitle", { account })}
      description={installation ? removeInstallationText(t, account, alone) : undefined}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          loading={remove.isPending}
          onClick={() => {
            if (!installation) return;
            const manageUrl = installation.manageUrl;
            remove.mutate(installation.id, {
              onSuccess: ({ uninstalled }) => {
                // GitHub didn't confirm it: the installation's page there is the way out.
                if (uninstalled || !manageUrl) toast.show(removedText(t, account, uninstalled));
                else
                  toast.show(removedText(t, account, false), "warning", {
                    label: t("githubApp.openPage"),
                    run: () => window.open(manageUrl, "_blank", "noopener,noreferrer"),
                  });
                onClose();
              },
            });
          }}
        >
          {t("githubApp.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Settings → Conectores, for the server's pinned owner only (the API answers `setup: null` to everyone else and on
 * agentes.chat): this server's GitHub App. None yet: Criar o app no GitHub sends GitHub the manifest, which makes the
 * app under their account and comes back here. Made here: its name, its page and Remover o app. From `GITHUB_APP_*`:
 * read-only, and it says where it is set.
 */
export function GitHubAppServerCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const setup = useGitHubApp(org.id).data?.setup;
  const start = useStartGitHubAppManifest();
  const remove = useRemoveGitHubAppSettings();
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  if (!setup) return null;
  const chip = KEY_STATE_CHIP[setup.state];
  const note =
    setup.source === "env"
      ? t("githubApp.server.line.env")
      : setup.state === "invalid"
        ? t("githubApp.server.line.invalid")
        : null;
  const events = missingEventsText(t, setup);
  return (
    <Card aria-labelledby="sec-github-app-server">
      <CardHeader
        id="sec-github-app-server"
        mark="github"
        title={t("githubApp.server.title")}
        subtitle={t("githubApp.server.lead")}
        action={
          <Chip icon={chip.icon} tone={chip.tone}>
            {t(`githubApp.server.state.${chip.word}`)}
          </Chip>
        }
      />
      <List>
        {setup.canCreate ? (
          <div className="ac-list__row jev__body">
            <span className="small muted">{t("githubApp.server.without")}</span>
            <Button
              size="sm"
              variant="primary"
              loading={start.isPending}
              disabled={start.isPending}
              onClick={() => start.mutate(connectorsPath(org.id), { onSuccess: (url) => navigateAway(url) })}
            >
              {t("githubApp.server.create")}
            </Button>
          </div>
        ) : (
          <div className="ac-list__row jev__key">
            <span className="list-col">
              <span className="ai-accounts__name">{setup.slug ?? t("githubApp.server.title")}</span>
              {setup.htmlUrl && (
                <a className="ac-link small" href={setup.htmlUrl} target="_blank" rel="noopener noreferrer">
                  {t("githubApp.server.open")}
                </a>
              )}
              {note && <SettingNote icon={setup.state === "ok" ? "info" : "alert"}>{note}</SettingNote>}
              {events && <SettingNote icon="alert">{events}</SettingNote>}
            </span>
            {(setup.events || setup.source === "settings") && (
              <span className="ac-acts">
                {setup.events && (
                  <Button asChild size="sm">
                    <a href={setup.events.url} target="_blank" rel="noopener noreferrer">
                      <Icon name="external" size={14} />
                      {t("githubApp.server.events")}
                    </a>
                  </Button>
                )}
                {setup.source === "settings" && (
                  <Button size="sm" variant="ghost" className="ac-btn--danger" onClick={() => setRemoving(true)}>
                    {t("githubApp.server.remove")}
                  </Button>
                )}
              </span>
            )}
          </div>
        )}
      </List>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("githubApp.server.removeTitle")}
        description={t("githubApp.server.removeText")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setRemoving(false);
                  toast.show(t("githubApp.server.removed"));
                },
              })
            }
          >
            {t("githubApp.server.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
