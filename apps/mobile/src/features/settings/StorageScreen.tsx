import type { StorageConfig, StorageTestResult } from "@agenteschat/client";
import {
  useSaveStorage,
  useStartMigration,
  useStorage,
  useStorageMigration,
  useTestStorage,
} from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { storageUsageLine } from "@agenteschat/client/lib/storage";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  Locked,
  Text,
  useToast,
} from "@/ui";
import { Note } from "../ai/parts";
import { useColors, useEdition } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { platformText, type S3Form, s3FormOf, s3Missing, storageKey, toS3Input } from "./logic";
import { confirmAction, Gap, Meter, SettingsPage } from "./parts";

type Choice = "agentes" | "s3";

const STEP_ICON: Record<"ok" | "failed" | "skipped", IconName> = { ok: "check", failed: "x", skipped: "info" };

/**
 * Armazenamento (admins), as the web's: where the workspace's files stay. Our storage on the Cloud, this server where
 * people run it (said by where it keeps them), or the workspace's own S3-compatible bucket, tested before it is
 * turned on; once on it, the files kept before can be copied there, or it goes back. The option in use says what the
 * files there take.
 */
export function StorageScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const admin = can(org, "configure");
  const storage = useStorage(orgId, admin);
  const edition = useEdition();
  const [choice, setChoice] = useState<Choice>("agentes");
  useEffect(() => {
    if (storage.data) setChoice(storage.data.kind);
  }, [storage.data]);
  // No edition's words before the server says which this is.
  const config = edition ? storage.data : undefined;
  const cloud = edition === "cloud";
  const place = t(cloud ? "storage.place.agentes" : "storage.place.server");
  const usage = config ? storageUsageLine(t, i18n.language, config) : null;
  const inUse = { value: t("storage.current"), belowText: usage ?? undefined };
  return (
    <SettingsPage title={t("storage.title")} frozen={settingsFrozen(org, "storage")}>
      <GroupedFooter>{t("settings.sectionText.storage")}</GroupedFooter>
      {!admin ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : null}
      {admin && (storage.isLoading || (storage.data && !edition)) ? (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      ) : null}
      {admin && storage.isError && !storage.data ? (
        <View style={styles.note}>
          <Note icon="x">{t("common.loadFailed")}</Note>
        </View>
      ) : null}
      {config && edition ? (
        <>
          <GroupedHeader>{t("storage.options")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={t(storageKey("agentes", edition))}
              sub={cloud ? t("storage.agentesText") : platformText(t, config.platform)}
              subLines={3}
              {...(config.kind === "agentes" ? inUse : {})}
              checked={choice === "agentes"}
              onPress={() => setChoice("agentes")}
            />
            <GroupedRow
              label={t("storage.s3")}
              sub={t("storage.s3Text")}
              subLines={2}
              {...(config.kind === "s3" ? inUse : {})}
              checked={choice === "s3"}
              onPress={() => setChoice("s3")}
            />
          </GroupedList>
          {config.kind === "s3" ? <InUse config={config} place={place} /> : null}
          {choice === "s3" ? <BucketForm config={config} /> : null}
        </>
      ) : null}
    </SettingsPage>
  );
}

/** On the workspace's own bucket: which one, copying the files kept before, and the way back. */
function InUse({ config, place }: { config: StorageConfig; place: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const save = useSaveStorage(orgId);
  const back = () =>
    confirmAction({
      title: t("storage.backTitle", { place }),
      text: t("storage.backText", { place }),
      action: t("storage.back", { place }),
      cancel: t("common.cancel"),
      destructive: false,
      onConfirm: () =>
        save.mutate(
          { kind: "agentes" },
          {
            onSuccess: () => {
              successHaptic();
              toast({ title: t("storage.backDone", { place }), icon: "check" });
            },
            onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
          },
        ),
    });
  return (
    <>
      <GroupedFooter>
        {[
          t("storage.switchedNotice"),
          config.s3 ? t("storage.inUse", { bucket: config.s3.bucket, endpoint: config.s3.endpoint }) : null,
        ]
          .filter(Boolean)
          .join(" ")}
      </GroupedFooter>
      <CopyFiles config={config} place={place} />
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="undo"
          label={t("storage.back", { place })}
          labelLines={2}
          disabled={save.isPending}
          onPress={back}
        />
      </GroupedList>
    </>
  );
}

/** "Copiar arquivos existentes" to the bucket, then how far the copy is (it is asked again while it runs). */
function CopyFiles({ config, place }: { config: StorageConfig; place: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const start = useStartMigration(orgId);
  const status = useStorageMigration(orgId, true);
  const m = status.data ?? config.migration;
  const run = () => start.mutate(undefined, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) });
  if (!m) {
    return (
      <>
        <Gap />
        <GroupedList>
          <GroupedRow icon="copy" label={t("storage.copy")} disabled={start.isPending} onPress={run} />
        </GroupedList>
        <GroupedFooter>{t("storage.copyText", { place })}</GroupedFooter>
      </>
    );
  }
  return (
    <>
      <GroupedHeader>{t("storage.copyProgress")}</GroupedHeader>
      <GroupedList>
        <View style={styles.progress}>
          <Meter value={m.copied} max={m.total} label={t("storage.copyProgress")} />
          <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite">
            {m.status === "done"
              ? t("storage.copyDone", { total: m.total })
              : m.status === "failed"
                ? t("storage.copyFailed", { copied: m.copied, total: m.total })
                : t("storage.copying", { copied: m.copied, total: m.total })}
          </Text>
        </View>
        {m.status === "failed" ? (
          <GroupedRow icon="play" label={t("storage.resume")} disabled={start.isPending} onPress={run} />
        ) : null}
      </GroupedList>
      {m.status === "failed" && m.error ? <GroupedFooter>{m.error}</GroupedFooter> : null}
    </>
  );
}

/**
 * The bucket: endpoint, region, bucket, prefix, the keys (blank keeps the saved ones) and the path style; "Testar
 * conexão" writes, reads, lists and deletes a file there, and only a passing test turns it on.
 */
function BucketForm({ config }: { config: StorageConfig }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId } = useOrg();
  const test = useTestStorage(orgId);
  const save = useSaveStorage(orgId);
  const [form, setForm] = useState<S3Form>(() => s3FormOf(config));
  const [touched, setTouched] = useState(false);
  // The settings the last test ran with, and its result.
  const [tested, setTested] = useState<{ sig: string; result: StorageTestResult } | null>(null);
  const saved = config.s3;
  const set = <K extends keyof S3Form>(k: K, v: S3Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const input = toS3Input(form);
  const sig = JSON.stringify(input);
  const missing = s3Missing(form, Boolean(saved));
  const current = tested?.sig === sig ? tested.result : null;
  const stale = tested !== null && tested.sig !== sig;
  const failed = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  const runTest = () => {
    setTouched(true);
    if (!missing.complete) return;
    test.mutate(input, { onSuccess: (result) => setTested({ sig, result }), onError: failed });
  };
  const activate = () => {
    if (!current?.ok) return;
    save.mutate(
      { kind: "s3", s3: input },
      {
        onSuccess: () => {
          setForm((f) => ({ ...f, accessKeyId: "", secretAccessKey: "" }));
          setTested(null);
          setTouched(false);
          successHaptic();
          toast({ title: t("storage.activated"), icon: "check" });
        },
        onError: failed,
      },
    );
  };
  const field = [fieldText("callout"), styles.input, { color: c.ink }];
  const text = (k: "endpoint" | "region" | "bucket" | "prefix" | "accessKeyId" | "secretAccessKey", label: string) => ({
    value: form[k],
    onChangeText: (v: string) => set(k, v),
    autoCapitalize: "none" as const,
    autoCorrect: false,
    autoComplete: "off" as const,
    spellCheck: false,
    placeholderTextColor: c.faint,
    accessibilityLabel: label,
    style: field,
  });
  const locked = test.isPending || save.isPending;
  return (
    <>
      <Locked when={locked}>
        <GroupedHeader>{t("storage.s3")}</GroupedHeader>
        <GroupedList>
          <GroupedField label={t("storage.endpoint")}>
            <TextInput {...text("endpoint", t("storage.endpoint"))} placeholder="https://" keyboardType="url" />
          </GroupedField>
          <GroupedField label={t("storage.region")}>
            <TextInput {...text("region", t("storage.region"))} />
          </GroupedField>
          <GroupedField label={t("storage.bucket")}>
            <TextInput {...text("bucket", t("storage.bucket"))} />
          </GroupedField>
          <GroupedField label={t("storage.prefix")}>
            <TextInput {...text("prefix", t("storage.prefix"))} />
          </GroupedField>
        </GroupedList>
        {touched && missing.fields ? (
          <Text variant="footnote" tone="danger" style={styles.error}>
            {t("storage.required")}
          </Text>
        ) : (
          <GroupedFooter>
            {t("common.joinSentences", { a: t("storage.endpointHelp"), b: t("storage.prefixHelp") })}
          </GroupedFooter>
        )}
        <Gap />
        <GroupedList>
          <GroupedField label={t("storage.accessKey")}>
            <TextInput {...text("accessKeyId", t("storage.accessKey"))} secureTextEntry />
          </GroupedField>
          <GroupedField label={t("storage.secret")}>
            <TextInput {...text("secretAccessKey", t("storage.secret"))} secureTextEntry />
          </GroupedField>
        </GroupedList>
        {touched && missing.keys ? (
          <Text variant="footnote" tone="danger" style={styles.error}>
            {t("storage.keysRequired")}
          </Text>
        ) : saved ? (
          <GroupedFooter>
            {[
              `${t("storage.accessKey")}: ${t("storage.savedHint", { hint: saved.accessKeyIdHint })}`,
              `${t("storage.secret")}: ${t("storage.savedHint", { hint: saved.secretHint })}`,
            ].join("\n")}
          </GroupedFooter>
        ) : null}
        <Gap />
        <GroupedList>
          <GroupedRow
            label={t("storage.pathStyle")}
            hint={{ name: t("common.about", { label: t("storage.pathStyle") }), text: t("storage.pathStyleHelp") }}
            toggle={form.pathStyle}
            onPress={() => set("pathStyle", !form.pathStyle)}
          />
        </GroupedList>
      </Locked>
      {current ? <TestSteps result={current} /> : null}
      {stale ? <GroupedFooter>{t("storage.retestNeeded")}</GroupedFooter> : null}
      <View style={styles.buttons}>
        <Button
          variant="secondary"
          wide
          label={test.isPending ? t("storage.testing") : t("storage.test")}
          loading={test.isPending}
          disabled={save.isPending}
          onPress={runTest}
        />
        <Button
          variant="primary"
          wide
          label={config.kind === "s3" ? t("storage.saveBucket") : t("storage.activate")}
          loading={save.isPending}
          disabled={!current?.ok || test.isPending}
          onPress={activate}
        />
      </View>
    </>
  );
}

/** The test's four steps (write, read, list, delete), each worked, failed (with why) or not tested. */
function TestSteps({ result }: { result: StorageTestResult }) {
  const { t } = useTranslation();
  return (
    <>
      <GroupedHeader>{t("storage.steps")}</GroupedHeader>
      <GroupedList>
        {result.steps.map((s) => {
          const state = s.ok ? "ok" : s.error ? "failed" : "skipped";
          return (
            <GroupedRow
              key={s.step}
              icon={STEP_ICON[state]}
              label={t(`storage.step.${s.step}`)}
              {...(s.error ? { sub: s.error } : {})}
              subLines={3}
              value={t(
                state === "ok" ? "storage.stepOk" : state === "failed" ? "storage.stepFailed" : "storage.stepSkipped",
              )}
            />
          );
        })}
      </GroupedList>
      <GroupedFooter>{result.ok ? t("storage.testPassed") : t("storage.testFailed")}</GroupedFooter>
    </>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  progress: { gap: 8, paddingHorizontal: 14, paddingVertical: 14 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
  buttons: { gap: 10, paddingTop: 20 },
});
