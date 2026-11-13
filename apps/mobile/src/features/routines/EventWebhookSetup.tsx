import {
  useCatalog,
  useGitHubRepos,
  useWebhookSetup,
  useWebhookSetupAction,
  type WebhookProvider,
  type WebhookSetup,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { githubHookLink, SENTRY_NEW_INTEGRATION, webhookTestState } from "@agenteschat/client/lib/routine-webhooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { fieldText, GroupedField, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { openPage } from "../ai/parts";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { CommandBlock } from "../settings/parts";
import { useColors, useOrgId } from "../shared/hooks";

/** Repositories offered to pick before typing one: the ones pushed to last. */
const QUICK_REPOS = 5;

/**
 * The web's webhook setup of a GitHub or Sentry event routine, for the phone: whether the service already sends its
 * events, and for who sets webhooks up, the webhook made on the spot, what to paste where, GitHub's in one tap when
 * the workspace's GitHub may add it, and Testar, which waits for the first call.
 */
export function EventWebhookSetup({ provider }: { provider: WebhookProvider }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [polling, setPolling] = useState(false);
  const query = useWebhookSetup(orgId, provider, polling);
  const action = useWebhookSetupAction(orgId, provider);
  const setup = query.data;
  const name = provider === "github" ? "GitHub" : "Sentry";
  const def = useCatalog().data?.connectors.find((d) => d.id === provider) ?? null;
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
  const test = () => {
    setNow(Date.now());
    setSince(Date.now());
  };
  const status =
    state === "working"
      ? t("routines.setup.working", { provider: name })
      : state === "waiting"
        ? t(`routines.setup.waiting.${provider}`)
        : state === "refused"
          ? t(`routines.setup.refused.${provider}`)
          : state === "timeout"
            ? t("routines.setup.timeout")
            : setup && !setup.canManage
              ? t("routines.setup.adminOnly", { provider: name })
              : null;
  const steps = setup?.canManage && (state !== "working" || more);
  return (
    <>
      <GroupedHeader>{t("routines.setup.title", { provider: name })}</GroupedHeader>
      <GroupedList>
        <View style={styles.status}>
          <ConnectorIcon def={def} label={name} size={28} />
          <View style={styles.grow}>
            {!setup ? (
              <ActivityIndicator color={c.muted} />
            ) : (
              <Text
                variant="footnote"
                tone={state === "working" ? "ok" : state === "refused" || state === "timeout" ? "danger" : "muted"}
                accessibilityLiveRegion="polite"
              >
                {status ?? t("routines.setup.title", { provider: name })}
              </Text>
            )}
          </View>
          {state === "waiting" ? <ActivityIndicator color={c.muted} /> : null}
        </View>
      </GroupedList>
      {action.isError ? <GroupedFooter>{errorText(t, action.error)}</GroupedFooter> : null}
      {setup && steps ? (
        provider === "github" ? (
          <GitHubSteps setup={setup} onAdded={test} />
        ) : (
          <SentrySteps setup={setup} />
        )
      ) : null}
      {setup?.canManage ? (
        <>
          <View style={styles.gap} />
          <GroupedList>
            {state === "working" && provider === "github" && !more ? (
              <GroupedRow icon="plus" label={t("routines.setup.github.another")} onPress={() => setMore(true)} />
            ) : (
              <GroupedRow
                icon="send"
                label={t(state === "timeout" || state === "refused" ? "routines.setup.retest" : "routines.setup.test")}
                disabled={!setup.url || state === "waiting"}
                onPress={test}
              />
            )}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

function GitHubSteps({ setup, onAdded }: { setup: WebhookSetup; onAdded: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const repos = useGitHubRepos(orgId);
  const action = useWebhookSetupAction(orgId, "github");
  const [repo, setRepo] = useState("");
  const link = githubHookLink(repo);
  const quick = (repos.data?.accounts ?? [])
    .flatMap((a) => a.repositories)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, QUICK_REPOS);
  const add = () =>
    action.mutate(
      { type: "repo", repo },
      {
        onSuccess: () => {
          toast({ title: t("routines.setup.github.added", { repo }), icon: "check" });
          onAdded();
        },
      },
    );
  return (
    <>
      <GroupedHeader>{t("routines.setup.github.repo")}</GroupedHeader>
      <GroupedList>
        <GroupedField label={t("routines.setup.github.repo")}>
          <TextInput
            value={repo}
            onChangeText={(v) => setRepo(v.trim())}
            editable={!action.isPending}
            placeholder={t("routines.setup.github.repoPlaceholder")}
            placeholderTextColor={c.faint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("routines.setup.github.repo")}
            style={[fieldText("callout"), { color: c.ink }]}
          />
        </GroupedField>
        {quick.map((r) => (
          <GroupedRow
            key={r.fullName}
            label={r.fullName}
            checked={repo === r.fullName}
            disabled={action.isPending}
            onPress={() => setRepo(r.fullName)}
          />
        ))}
      </GroupedList>
      <View style={styles.gap} />
      <GroupedList>
        {setup.oneClick ? (
          <GroupedRow
            icon="bolt"
            label={t("routines.setup.github.oneClick")}
            disabled={!link || action.isPending}
            onPress={add}
          />
        ) : null}
        <GroupedRow
          icon="link"
          label={t("routines.setup.github.openLink")}
          disabled={!link}
          onPress={() => link && openPage(link)}
        />
      </GroupedList>
      <GroupedFooter>
        {action.isError
          ? errorText(t, action.error)
          : setup.oneClick
            ? t("routines.setup.github.byHand")
            : t("routines.setup.github.open")}
      </GroupedFooter>
      <GroupedHeader>{t("routines.setup.github.url")}</GroupedHeader>
      {setup.url ? <CommandBlock command={setup.url} copiedTitle={t("routines.setup.copied")} /> : null}
      <GroupedFooter>{t("routines.setup.github.type")}</GroupedFooter>
      <GroupedHeader>{t("routines.setup.github.secret")}</GroupedHeader>
      {setup.secret ? <CommandBlock command={setup.secret} copiedTitle={t("routines.setup.copied")} /> : null}
      <GroupedFooter>{t("routines.setup.github.events")}</GroupedFooter>
    </>
  );
}

function SentrySteps({ setup }: { setup: WebhookSetup }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const action = useWebhookSetupAction(orgId, "sentry");
  const [secret, setSecret] = useState("");
  const save = () =>
    action.mutate(
      { type: "secret", secret },
      {
        onSuccess: () => {
          setSecret("");
          toast({ title: t("routines.setup.sentry.saved"), icon: "check" });
        },
      },
    );
  return (
    <>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          icon="link"
          label={t("routines.setup.sentry.openLink")}
          onPress={() => openPage(SENTRY_NEW_INTEGRATION)}
        />
      </GroupedList>
      <GroupedFooter>{t("routines.setup.sentry.open")}</GroupedFooter>
      <GroupedHeader>{t("routines.setup.sentry.url")}</GroupedHeader>
      {setup.url ? <CommandBlock command={setup.url} copiedTitle={t("routines.setup.copied")} /> : null}
      <GroupedFooter>{t("routines.setup.sentry.events")}</GroupedFooter>
      <GroupedHeader>{t("routines.setup.sentry.secret")}</GroupedHeader>
      <GroupedList>
        <View style={styles.input}>
          <TextInput
            value={secret}
            onChangeText={setSecret}
            editable={!action.isPending}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t(
              setup.secretSet ? "routines.setup.sentry.secretSaved" : "routines.setup.sentry.secretPlaceholder",
            )}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("routines.setup.sentry.secret")}
            style={[fieldText("callout"), { color: c.ink }]}
          />
        </View>
        <GroupedRow
          icon="check"
          label={t("routines.setup.sentry.save")}
          disabled={!secret.trim() || action.isPending}
          onPress={save}
        />
      </GroupedList>
      {action.isError ? <GroupedFooter>{errorText(t, action.error)}</GroupedFooter> : null}
    </>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  grow: { flex: 1, minWidth: 0 },
  input: { paddingHorizontal: 14, paddingVertical: 12 },
  gap: { height: 10 },
});
