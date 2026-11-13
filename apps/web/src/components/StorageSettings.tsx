import type { S3Input, StorageConfig, StoragePlatform, StorageTestResult } from "@agenteschat/client";
import {
  useSaveStorage,
  useStartMigration,
  useStorage,
  useStorageMigration,
  useTestStorage,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { storageUsageLine } from "@agenteschat/client/lib/storage";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
  List,
  Locked,
  Meter,
  RadioCard,
  RadioGroup,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { StorageMeter } from "@/components/Limits";
import { LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useRevealsFiles } from "@/components/ThisMac";
import { useComputerEdition } from "@/components/WorkspaceComputer";
import { thisMac } from "@/lib/desktop";
import { softBreaks } from "@/lib/soft-breaks";
import { useToast } from "@/lib/toast";

type Choice = "agentes" | "s3";

interface Form {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

const emptyForm: Form = {
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  pathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
};

const formFrom = (c: StorageConfig | undefined): Form =>
  c?.s3
    ? {
        ...emptyForm,
        endpoint: c.s3.endpoint,
        region: c.s3.region,
        bucket: c.s3.bucket,
        prefix: c.s3.prefix ?? "",
        pathStyle: c.s3.pathStyle,
      }
    : emptyForm;

/** What the backend gets; blank keys mean "keep the saved ones". */
export function toS3Input(f: Form): S3Input {
  const input: S3Input = {
    endpoint: f.endpoint.trim(),
    region: f.region.trim(),
    bucket: f.bucket.trim(),
    prefix: f.prefix.trim() || null,
    pathStyle: f.pathStyle,
  };
  if (f.accessKeyId.trim()) input.accessKeyId = f.accessKeyId.trim();
  if (f.secretAccessKey.trim()) input.secretAccessKey = f.secretAccessKey.trim();
  return input;
}

const STEP_ICON: Record<"ok" | "failed" | "skipped", IconName> = { ok: "check", failed: "close", skipped: "info" };

/** Where this server keeps files, as its admins read it: the folder by its path when the server says it. */
function PlatformLine({ platform }: { platform: StoragePlatform }) {
  const { t } = useTranslation();
  if (platform.kind !== "disk" || !platform.folder) return <>{t(`storage.serverText.${platform.kind}`)}</>;
  return <Trans i18nKey="storage.serverText.folder" components={{ folder: <PathCode path={platform.folder} /> }} />;
}

/** A path in code style that wraps after its separators, never inside a folder's name unless it must. */
function PathCode({ path }: { path: string }) {
  return <code style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{softBreaks(path)}</code>;
}

/**
 * Settings → Armazenamento (admins only): where files stay unless the workspace brings its own S3-compatible
 * bucket. On the Cloud that is our storage; on a server people run, the server itself, said by where it keeps them.
 * The option in use also says what the files there take.
 */
export function StorageSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "configure");
  const storage = useStorage(org.id, admin);
  const limits = useWorkspaceLimits(org.id, admin);
  // Under a storage limit the meter above says what the files here take, against the limit: the option doesn't say it
  // again (nor before the limits answer, so the line never shows and goes).
  const metered = limits.data ? limits.data.storage.limitBytes !== null : limits.isPending;
  const edition = useComputerEdition(org.id);
  const reveals = useRevealsFiles();
  const [choice, setChoice] = useState<Choice>("agentes");
  useEffect(() => {
    if (storage.data) setChoice(storage.data.kind);
  }, [storage.data]);
  if (!admin) return null;
  const config = edition ? storage.data : undefined;
  const cloud = edition === "cloud";
  const place = t(cloud ? "storage.place.agentes" : "storage.place.server");
  return (
    // The page's title names the card: a title of its own would say it twice.
    <Card aria-label={t("storage.title")}>
      <StorageMeter />
      {(storage.isLoading || (storage.data && !edition)) && <LoadingCards count={2} />}
      {config && (
        <>
          <RadioGroup
            value={choice}
            onValueChange={(v) => setChoice(v as Choice)}
            aria-label={t("storage.options")}
            className="stack-4"
            style={{ gap: 8 }}
          >
            {(["agentes", "s3"] as const).map((k) => (
              <RadioCard
                key={k}
                value={k}
                id={`storage-${k}`}
                checked={choice === k}
                title={t(k === "s3" ? "storage.s3" : cloud ? "storage.agentes" : "storage.server")}
                description={
                  k === "s3" ? (
                    t("storage.s3Text")
                  ) : cloud ? (
                    t("storage.agentesText")
                  ) : (
                    <PlatformLine platform={config.platform} />
                  )
                }
                aside={
                  // The radio says which is in use until another is picked: then this says it.
                  config.kind === k && choice !== k ? <Chip icon="check">{t("storage.current")}</Chip> : undefined
                }
                detail={
                  config.kind === k && !(k === "agentes" && metered)
                    ? storageUsageLine(t, i18n.language, config)
                    : undefined
                }
              />
            ))}
          </RadioGroup>
          {/* Under the options, not in one: each option is a label, which can't hold a button. */}
          {!cloud && reveals && config.platform.folder && (
            <div className="row">
              <Button size="sm" variant="ghost" onClick={() => void thisMac.revealFiles().catch(() => {})}>
                {t("storage.showFolder")}
              </Button>
            </div>
          )}
          {config.kind === "s3" && <InUse config={config} place={place} />}
          {choice === "s3" && <BucketForm config={config} />}
        </>
      )}
    </Card>
  );
}

function InUse({ config, place }: { config: StorageConfig; place: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveStorage(org.id);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="stack-4" style={{ gap: 12 }}>
      <Alert tone="neutral">{t("storage.switchedNotice")}</Alert>
      {config.s3 && (
        <p className="small muted">{t("storage.inUse", { bucket: config.s3.bucket, endpoint: config.s3.endpoint })}</p>
      )}
      <CopyFiles config={config} place={place} />
      <div className="row">
        <Button variant="ghost" onClick={() => setConfirm(true)}>
          {t("storage.back", { place })}
        </Button>
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("storage.backTitle", { place })}
        description={t("storage.backText", { place })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { kind: "agentes" },
                {
                  onSuccess: () => {
                    setConfirm(false);
                    toast.show(t("storage.backDone", { place }));
                  },
                },
              )
            }
          >
            {t("storage.back", { place })}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function CopyFiles({ config, place }: { config: StorageConfig; place: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const start = useStartMigration(org.id);
  const status = useStorageMigration(org.id, true);
  const m = status.data ?? config.migration;
  if (!m) {
    return (
      <div className="row" style={{ alignItems: "center", gap: 12 }}>
        <span className="small muted" style={{ flex: "1 1 240px" }}>
          {t("storage.copyText", { place })}
        </span>
        <Button disabled={start.isPending} loading={start.isPending} onClick={() => start.mutate()}>
          {t("storage.copy")}
        </Button>
      </div>
    );
  }
  return (
    <div className="stack-4" style={{ gap: 8 }}>
      <Meter value={m.copied} max={m.total} label={t("storage.copyProgress")} />
      <p className="small" role="status">
        {m.status === "done"
          ? t("storage.copyDone", { total: m.total })
          : m.status === "failed"
            ? t("storage.copyFailed", { copied: m.copied, total: m.total })
            : t("storage.copying", { copied: m.copied, total: m.total })}
      </p>
      {m.status === "failed" && (
        <>
          {m.error && <Alert>{m.error}</Alert>}
          <div className="row">
            <Button disabled={start.isPending} loading={start.isPending} onClick={() => start.mutate()}>
              {t("storage.resume")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function BucketForm({ config }: { config: StorageConfig }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const test = useTestStorage(org.id);
  const save = useSaveStorage(org.id);
  const [form, setForm] = useState<Form>(() => formFrom(config));
  const [touched, setTouched] = useState(false);
  // The settings the last test ran with, and its result.
  const [tested, setTested] = useState<{ sig: string; result: StorageTestResult } | null>(null);
  const saved = config.s3;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const input = toS3Input(form);
  const sig = JSON.stringify(input);
  const missing = (v: string) => touched && !v.trim();
  const keysMissing = !saved && (!input.accessKeyId || !input.secretAccessKey);
  const complete = input.endpoint && input.region && input.bucket && !keysMissing;
  const current = tested?.sig === sig ? tested.result : null;
  const stale = tested !== null && tested.sig !== sig;
  const runTest = () => {
    setTouched(true);
    if (!complete) return;
    test.mutate(input, { onSuccess: (result) => setTested({ sig, result }) });
  };
  return (
    <form
      className="stack-4"
      style={{ gap: 12 }}
      aria-label={t("storage.s3")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!current?.ok) return;
        save.mutate(
          { kind: "s3", s3: input },
          {
            onSuccess: () => {
              setForm((f) => ({ ...f, accessKeyId: "", secretAccessKey: "" }));
              setTested(null);
              setTouched(false);
              toast.show(t("storage.activated"));
            },
          },
        );
      }}
    >
      <Locked when={test.isPending || save.isPending}>
        <div className="grid-fields grid-fields--wide">
          <Field
            label={t("storage.endpoint")}
            id="st-endpoint"
            example={t("storage.endpointHelp")}
            error={missing(form.endpoint) ? t("storage.required") : undefined}
          >
            <Input
              value={form.endpoint}
              onChange={(e) => set("endpoint", e.target.value)}
              placeholder="https://"
              autoComplete="off"
            />
          </Field>
          <Field
            label={t("storage.region")}
            id="st-region"
            error={missing(form.region) ? t("storage.required") : undefined}
          >
            <Input value={form.region} onChange={(e) => set("region", e.target.value)} autoComplete="off" />
          </Field>
          <Field
            label={t("storage.bucket")}
            id="st-bucket"
            error={missing(form.bucket) ? t("storage.required") : undefined}
          >
            <Input value={form.bucket} onChange={(e) => set("bucket", e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t("storage.prefix")} id="st-prefix" example={t("storage.prefixHelp")}>
            <Input value={form.prefix} onChange={(e) => set("prefix", e.target.value)} autoComplete="off" />
          </Field>
          <Field
            label={t("storage.accessKey")}
            id="st-access"
            example={saved ? t("storage.savedHint", { hint: saved.accessKeyIdHint }) : undefined}
            error={touched && keysMissing && !input.accessKeyId ? t("storage.keysRequired") : undefined}
          >
            <Input
              type="password"
              value={form.accessKeyId}
              onChange={(e) => set("accessKeyId", e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label={t("storage.secret")}
            id="st-secret"
            example={saved ? t("storage.savedHint", { hint: saved.secretHint }) : undefined}
            error={touched && keysMissing && !input.secretAccessKey ? t("storage.keysRequired") : undefined}
          >
            <Input
              type="password"
              value={form.secretAccessKey}
              onChange={(e) => set("secretAccessKey", e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <Checkbox
            id="st-path"
            checked={form.pathStyle}
            onCheckedChange={(v) => set("pathStyle", v)}
            aria-describedby="st-path-hint"
          />
          <span className="ac-hintline">
            <label htmlFor="st-path">{t("storage.pathStyle")}</label>
            <InfoHint id="st-path-hint" name={t("common.about", { label: t("storage.pathStyle") })}>
              {t("storage.pathStyleHelp")}
            </InfoHint>
          </span>
        </div>
      </Locked>
      {current && <TestSteps result={current} />}
      {stale && <p className="small muted">{t("storage.retestNeeded")}</p>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" disabled={test.isPending} loading={test.isPending} onClick={runTest}>
          {test.isPending ? t("storage.testing") : t("storage.test")}
        </Button>
        <Button type="submit" variant="primary" disabled={!current?.ok || save.isPending} loading={save.isPending}>
          {config.kind === "s3" ? t("storage.saveBucket") : t("storage.activate")}
        </Button>
      </div>
    </form>
  );
}

function TestSteps({ result }: { result: StorageTestResult }) {
  const { t } = useTranslation();
  return (
    <section className="stack-4" style={{ gap: 8 }} aria-label={t("storage.steps")}>
      <List>
        {result.steps.map((s) => {
          const state = s.ok ? "ok" : s.error ? "failed" : "skipped";
          return (
            <div key={s.step} className="ac-list__row" data-step={s.step}>
              <span className="row" style={{ gap: 8, flex: 1, alignItems: "flex-start" }}>
                <Icon name={STEP_ICON[state]} aria-hidden="true" />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>{t(`storage.step.${s.step}`)}</span>
                  {s.error && <span className="small muted">{s.error}</span>}
                </span>
              </span>
              <Chip icon={STEP_ICON[state]}>
                {t(
                  state === "ok" ? "storage.stepOk" : state === "failed" ? "storage.stepFailed" : "storage.stepSkipped",
                )}
              </Chip>
            </div>
          );
        })}
      </List>
      {result.ok ? <Alert tone="neutral">{t("storage.testPassed")}</Alert> : <Alert>{t("storage.testFailed")}</Alert>}
    </section>
  );
}
