import {
  useCatalog,
  useGitHubRepos,
  useWebhookSetup,
  useWebhookSetupAction,
  type WebhookProvider,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { githubHookLink, SENTRY_NEW_INTEGRATION, webhookTestState } from "@agenteschat/client/lib/routine-webhooks";
import { Button, Field, Icon, Input, SearchSelect, Spinner } from "@agenteschat/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * What a GitHub or Sentry event routine needs to run, in place: whether the service's webhook already sends its
 * events, and for who sets webhooks up, the webhook made on the spot, the address and secret to paste and where,
 * GitHub's in one click when the workspace's GitHub may add it, and Testar, which waits for the first call.
 */
export function EventWebhookSetup({ provider }: { provider: WebhookProvider }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // Asked again every few seconds while Testar waits (or a call came with another secret, to be fixed and resent).
  const [polling, setPolling] = useState(false);
  const query = useWebhookSetup(org.id, provider, polling);
  const action = useWebhookSetupAction(org.id, provider);
  const setup = query.data;
  const name = provider === "github" ? "GitHub" : "Sentry";
  const def = useCatalog().data?.connectors.find((d) => d.id === provider) ?? null;
  // The form makes the webhook as soon as the event is picked: the address is ready to paste.
  const make = setup?.canManage && setup.id === null && !action.isPending && !action.isError;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per provider without a webhook
  useEffect(() => {
    if (make) action.mutate({ type: "ensure" });
  }, [make, provider]);
  const state = webhookTestState(setup, since, now);
  const testing = since !== null && (state === "waiting" || state === "refused");
  useEffect(() => {
    setPolling(testing);
    if (!testing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [testing]);
  const [more, setMore] = useState(false);

  const head = (
    <span className="routine-setup__head">
      <ConnectorIcon def={def} label={name} />
      <span className="ac-field__label">{t("routines.setup.title", { provider: name })}</span>
    </span>
  );
  if (!setup) return <div className="routine-setup">{head}</div>;
  const status =
    state === "working" ? (
      <p className="routine-setup__status small ac-iconline" data-tone="ok" role="status">
        <Icon name="check" size={14} />
        <span>{t("routines.setup.working", { provider: name })}</span>
      </p>
    ) : state === "waiting" ? (
      <p className="routine-setup__status small ac-iconline" role="status">
        <Spinner size={14} />
        <span>{t(`routines.setup.waiting.${provider}`)}</span>
      </p>
    ) : state === "refused" ? (
      <p className="routine-setup__status small ac-iconline" data-tone="warn" role="alert">
        <Icon name="alert" size={14} />
        <span>{t(`routines.setup.refused.${provider}`)}</span>
      </p>
    ) : state === "timeout" ? (
      <p className="routine-setup__status small ac-iconline" data-tone="warn" role="alert">
        <Icon name="alert" size={14} />
        <span>{t("routines.setup.timeout")}</span>
      </p>
    ) : null;
  if (!setup.canManage) {
    return (
      <div className="routine-setup">
        {head}
        {status ?? <p className="small muted">{t("routines.setup.adminOnly", { provider: name })}</p>}
      </div>
    );
  }
  const test = () => {
    setNow(Date.now());
    setSince(Date.now());
  };
  const steps =
    state === "working" && !more ? null : provider === "github" ? (
      <GitHubSteps url={setup.url} secret={setup.secret} oneClick={setup.oneClick} onAdded={test} />
    ) : (
      <SentrySteps url={setup.url} secretSet={setup.secretSet} />
    );
  return (
    <div className="routine-setup">
      {head}
      {status}
      {action.isError && (
        <p className="routine-setup__status small ac-iconline" data-tone="warn" role="alert">
          <Icon name="alert" size={14} />
          <span>{errorText(t, action.error)}</span>
          <button type="button" className="ac-link" onClick={() => action.reset()}>
            {t("common.retry")}
          </button>
        </p>
      )}
      {steps}
      <div className="routine-hook__actions">
        {state === "working" && provider === "github" && !more ? (
          <Button type="button" size="sm" variant="ghost" icon="plus" onClick={() => setMore(true)}>
            {t("routines.setup.github.another")}
          </Button>
        ) : (
          <Button type="button" size="sm" icon="send" disabled={!setup.url || state === "waiting"} onClick={test}>
            {t(state === "timeout" || state === "refused" ? "routines.setup.retest" : "routines.setup.test")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** GitHub: add it in one click where the workspace's GitHub may, else the repository's settings with what to paste. */
function GitHubSteps(props: { url: string | null; secret: string | null; oneClick: boolean; onAdded: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const repos = useGitHubRepos(org.id);
  const action = useWebhookSetupAction(org.id, "github");
  const [repo, setRepo] = useState("");
  const options = useMemo(
    () =>
      (repos.data?.accounts ?? []).flatMap((a) =>
        a.repositories.map((r) => ({ value: r.fullName, label: r.name, group: a.login })),
      ),
    [repos.data],
  );
  const link = githubHookLink(repo);
  const add = () =>
    action.mutate(
      { type: "repo", repo },
      {
        onSuccess: () => {
          toast.show(t("routines.setup.github.added", { repo }));
          props.onAdded();
        },
      },
    );
  return (
    <ol className="routine-setup__steps">
      <li>
        <Field label={t("routines.setup.github.repo")} id="routine-setup-repo">
          {options.length > 0 ? (
            <SearchSelect
              value={repo}
              onValueChange={setRepo}
              options={options}
              disabled={action.isPending}
              placeholder={t("repos.search")}
              labels={{
                search: t("repos.search"),
                searchPlaceholder: t("repos.search"),
                noResults: t("repos.none"),
                list: t("routines.setup.github.repo"),
              }}
            />
          ) : (
            <Input
              value={repo}
              disabled={action.isPending}
              onChange={(e) => setRepo(e.target.value.trim())}
              placeholder={t("routines.setup.github.repoPlaceholder")}
            />
          )}
        </Field>
        {props.oneClick && (
          <div className="routine-hook__actions">
            <Button type="button" size="sm" variant="primary" disabled={!link} loading={action.isPending} onClick={add}>
              {t("routines.setup.github.oneClick")}
            </Button>
          </div>
        )}
        {action.isError && (
          <p className="routine-setup__status small ac-iconline" data-tone="warn" role="alert">
            <Icon name="alert" size={14} />
            <span>{errorText(t, action.error)}</span>
          </p>
        )}
      </li>
      <li>
        <p className="small">
          {props.oneClick ? t("routines.setup.github.byHand") : t("routines.setup.github.open")}{" "}
          {link ? (
            <a className="ac-link" href={link} target="_blank" rel="noreferrer">
              {t("routines.setup.github.openLink")}
            </a>
          ) : null}
        </p>
      </li>
      <li>
        <span className="small">{t("routines.setup.github.url")}</span>
        {props.url && <CommandBlock command={props.url} copied={t("routines.setup.copied")} />}
      </li>
      <li>
        <span className="small">{t("routines.setup.github.type")}</span>
      </li>
      <li>
        <span className="small">{t("routines.setup.github.secret")}</span>
        {props.secret && <CommandBlock command={props.secret} copied={t("routines.setup.copied")} />}
      </li>
      <li>
        <span className="small">{t("routines.setup.github.events")}</span>
      </li>
    </ol>
  );
}

/** Sentry: an internal integration with this address, then its Client Secret pasted back here. */
function SentrySteps({ url, secretSet }: { url: string | null; secretSet: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useWebhookSetupAction(org.id, "sentry");
  const [secret, setSecret] = useState("");
  const save = () =>
    action.mutate(
      { type: "secret", secret },
      {
        onSuccess: () => {
          setSecret("");
          toast.show(t("routines.setup.sentry.saved"));
        },
      },
    );
  return (
    <ol className="routine-setup__steps">
      <li>
        <p className="small">
          {t("routines.setup.sentry.open")}{" "}
          <a className="ac-link" href={SENTRY_NEW_INTEGRATION} target="_blank" rel="noreferrer">
            {t("routines.setup.sentry.openLink")}
          </a>
        </p>
      </li>
      <li>
        <span className="small">{t("routines.setup.sentry.url")}</span>
        {url && <CommandBlock command={url} copied={t("routines.setup.copied")} />}
      </li>
      <li>
        <span className="small">{t("routines.setup.sentry.events")}</span>
      </li>
      <li>
        <Field
          label={t("routines.setup.sentry.secret")}
          id="routine-setup-sentry-secret"
          error={action.isError ? errorText(t, action.error) : undefined}
        >
          <Input
            value={secret}
            type="password"
            disabled={action.isPending}
            autoComplete="off"
            onChange={(e) => setSecret(e.target.value)}
            placeholder={t(secretSet ? "routines.setup.sentry.secretSaved" : "routines.setup.sentry.secretPlaceholder")}
          />
        </Field>
        <div className="routine-hook__actions">
          <Button type="button" size="sm" disabled={!secret.trim()} loading={action.isPending} onClick={save}>
            {t("routines.setup.sentry.save")}
          </Button>
        </div>
      </li>
    </ol>
  );
}
