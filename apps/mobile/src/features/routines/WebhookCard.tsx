import {
  ROUTINE_HOOK_METHODS,
  type Routine,
  type RoutineHookCall,
  type RoutineRun,
  useRoutineAction,
  useRoutineHook,
  useRoutineHookAction,
} from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { whenAt } from "@agenteschat/client/lib/format";
import { runMessageLink } from "@agenteschat/client/lib/routine-view";
import { hookCurl, isRefusedHookCall } from "@agenteschat/client/lib/routines";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { CommandBlock, confirmAction } from "../settings/parts";
import { useColors, useOrgId } from "../shared/hooks";
import { useFailed } from "./hooks";

/** The changes that break the services calling the address, each asked first: what stops working. */
const QUESTIONS = {
  address: {
    title: "routines.webhook.replaceTitle",
    text: "routines.webhook.replaceBody",
    action: "routines.webhook.replace",
  },
  secret: {
    title: "routines.webhook.newSecretTitle",
    text: "routines.webhook.newSecretBody",
    action: "routines.webhook.newSecret",
  },
  unsign: {
    title: "routines.webhook.removeSecretTitle",
    text: "routines.webhook.removeSecretBody",
    action: "routines.webhook.removeSecret",
  },
} as const;

/**
 * A webhook routine's address (ADR 0106), the web's panel for the phone, for who manages it: the address to copy and
 * a new one (the old stops at once), the signing secret (shown once, replaced or turned off), an example call,
 * Testar, and the latest calls, each opening the agent's message of the run it went into.
 */
export function WebhookCard({ routine: r, runs }: { routine: Routine; runs: RoutineRun[] }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const hook = useRoutineHook(orgId, r.id);
  const action = useRoutineHookAction(orgId, r.id);
  const save = useRoutineAction(orgId);
  const [secret, setSecret] = useState<string | null>(null);
  const data = hook.data;
  if (!data) {
    return (
      <GroupedList>
        <View style={styles.block}>
          {hook.isError ? (
            <Text variant="footnote" tone="muted">
              {t("mobile.app.failed")}
            </Text>
          ) : (
            <ActivityIndicator color={c.muted} />
          )}
        </View>
      </GroupedList>
    );
  }
  const run = (what: "address" | "secret" | "unsign" | "test") =>
    action.mutate(what, {
      onSuccess: (done) => {
        if (what === "test") toast({ title: t("routines.webhook.tested"), icon: "send" });
        else if (what === "address") toast({ title: t("routines.webhook.replaced"), icon: "check" });
        else setSecret(done.secret ?? null);
      },
      onError: failed,
    });
  // The methods the address answers: at least one stays on.
  const toggleMethod = (m: (typeof ROUTINE_HOOK_METHODS)[number]) => {
    const on = !data.methods.includes(m);
    const next = ROUTINE_HOOK_METHODS.filter((x) => (x === m ? on : data.methods.includes(x)));
    if (next.length === 0) return;
    save.mutate(
      { type: "update", id: r.id, patch: { trigger: { type: "webhook", methods: next } } },
      { onError: failed },
    );
  };
  const ask = (what: keyof typeof QUESTIONS) =>
    confirmAction({
      title: t(QUESTIONS[what].title),
      text: t(QUESTIONS[what].text),
      action: t(QUESTIONS[what].action),
      cancel: t("mobile.common.cancel"),
      onConfirm: () => run(what),
    });
  return (
    <>
      <GroupedHeader>{t("routines.webhook.address")}</GroupedHeader>
      <CommandBlock command={data.url} copiedTitle={t("routines.webhook.copied")} />
      <GroupedFooter>{t("routines.webhook.addressHelp")}</GroupedFooter>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          icon="undo"
          label={t("routines.webhook.replace")}
          disabled={action.isPending}
          onPress={() => ask("address")}
        />
      </GroupedList>

      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("routines.webhook.signature") }),
          text: t("routines.webhook.signedHelp"),
        }}
      >
        {t("routines.webhook.signature")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="lock"
          label={t(data.signed ? "routines.webhook.newSecret" : "routines.webhook.addSecret")}
          disabled={action.isPending}
          onPress={() => (data.signed ? ask("secret") : run("secret"))}
        />
        {data.signed ? (
          <GroupedRow
            icon="x"
            label={t("routines.webhook.removeSecret")}
            disabled={action.isPending}
            onPress={() => ask("unsign")}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{t(data.signed ? "routines.webhook.signedOn" : "routines.webhook.signedOff")}</GroupedFooter>
      {secret && data.signed ? (
        <>
          <GroupedFooter>{t("routines.webhook.secretOnce")}</GroupedFooter>
          <CommandBlock command={secret} copiedTitle={t("routines.webhook.secretCopied")} />
        </>
      ) : null}

      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("routines.webhook.methods") }),
          text: t("routines.webhook.methodsHelp"),
        }}
      >
        {t("routines.webhook.methods")}
      </GroupedHeader>
      <GroupedList>
        {ROUTINE_HOOK_METHODS.map((m) => (
          <GroupedRow
            key={m}
            label={m}
            checked={data.methods.includes(m)}
            disabled={save.isPending || (data.methods.length === 1 && data.methods.includes(m))}
            onPress={() => toggleMethod(m)}
          />
        ))}
      </GroupedList>

      <GroupedHeader>{t("routines.webhook.example")}</GroupedHeader>
      <CommandBlock
        command={hookCurl(
          data.url,
          data.signed ? (secret ?? t("routines.webhook.secretPlaceholder")) : null,
          data.methods,
        )}
        copiedTitle={t("routines.webhook.exampleCopied")}
      />
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          icon="send"
          label={t("routines.webhook.test")}
          disabled={action.isPending}
          onPress={() => run("test")}
        />
      </GroupedList>

      <GroupedHeader>{t("routines.webhook.calls")}</GroupedHeader>
      <GroupedList>
        {data.calls.length === 0 ? (
          <View style={styles.block}>
            <Text variant="footnote" tone="muted">
              {t("routines.webhook.noCalls")}
            </Text>
          </View>
        ) : (
          data.calls.map((call) => (
            <CallRow key={call.id} call={call} run={runs.find((x) => x.id === call.runId)} locale={i18n.language} />
          ))
        )}
      </GroupedList>
    </>
  );
}

/** One call: how it ended, its size, Teste, when; it opens the agent's message of its run when there is one. */
function CallRow({ call, run, locale }: { call: RoutineHookCall; run: RoutineRun | undefined; locale: string }) {
  const { t } = useTranslation();
  const link = run ? runMessageLink(run) : null;
  const href = link ? chatHref(link.channelId, link.threadId) : null;
  const sub = [
    ...(call.bytes > 0 ? [formatBytes(locale, call.bytes)] : []),
    ...(call.test ? [t("routines.webhook.callTest")] : []),
    ...(href ? [t("routines.openInChat")] : []),
  ].join(" · ");
  return (
    <GroupedRow
      icon={isRefusedHookCall(call.outcome) ? "x" : "check"}
      label={t(`routines.webhook.outcome.${call.outcome}`)}
      {...(sub ? { sub } : {})}
      value={whenAt(t, locale, call.at)}
      chevron={Boolean(href)}
      {...(href ? { onPress: () => router.push(href) } : {})}
    />
  );
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 14, paddingVertical: 12 },
  gap: { height: 10 },
});
