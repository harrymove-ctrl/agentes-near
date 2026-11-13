import type { VaultImportResult, VaultScope } from "@agenteschat/client";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, Dialog, DialogBody, DialogFooter, Icon, Locked, Segmented, SettingNote } from "@agenteschat/ui";
import { type DragEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useVaultImport } from "./data";
import { CSV_MAX_BYTES } from "./lib";
import "./vault.css";

/*
 * "Import" (ADR 0144): a passwords file exported by a browser or a password manager, read here in the browser, counted
 * by the server first (nothing written), then imported into Personal or Team. The file's text lives in this dialog
 * only, and goes when it closes.
 */

type Stage = "pick" | "review" | "done";

const hasFiles = (dt: DataTransfer | null) => Boolean(dt && Array.from(dt.types).includes("Files"));

/** The counts of a dry run or an import: new, updated, left out (and why). */
function ImportCounts({ result }: { result: VaultImportResult }) {
  const { t } = useTranslation();
  const skipped = result.skipped.reduce((n, s) => n + s.count, 0);
  const stats: [number, string][] = [
    [result.added, t("vault.import.added", { count: result.added })],
    [result.updated, t("vault.import.updated", { count: result.updated })],
    [skipped, t("vault.import.skipped", { count: skipped })],
  ];
  return (
    <>
      <div className="vlt-stats">
        {stats.map(([n, label]) => (
          <div key={label} className="vlt-stats__item">
            <b className="ac-num">{n}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {result.skipped.some((s) => s.count > 0) && (
        <ul className="vlt-skipped">
          {result.skipped
            .filter((s) => s.count > 0)
            .map((s) => (
              <li key={s.reason} className="ac-iconline">
                <Icon name="close" size={14} />
                <span>{t(`vault.import.reason.${s.reason}`, { count: s.count })}</span>
              </li>
            ))}
        </ul>
      )}
    </>
  );
}

export function VaultImportDialog({
  canManageTeam,
  scope: startScope,
  onClose,
}: {
  canManageTeam: boolean;
  scope: VaultScope;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const importer = useVaultImport(org.id);
  const input = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("pick");
  const [over, setOver] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [scope, setScope] = useState<VaultScope>(canManageTeam ? startScope : "personal");
  const [preview, setPreview] = useState<VaultImportResult | null>(null);
  const [result, setResult] = useState<VaultImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const count = async (text: string, as: VaultScope) => {
    const r = await importer.run({ csv: text, scope: as, dryRun: true });
    if (!r) return;
    setPreview(r);
    setStage("review");
  };
  const read = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > CSV_MAX_BYTES) return setError(t("vault.import.tooLarge"));
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return setError(t("vault.import.notCsv"));
    let text: string;
    try {
      text = await file.text();
    } catch {
      return setError(t("vault.import.unreadable"));
    }
    setCsv(text);
    setFileName(file.name);
    await count(text, scope);
  };
  const pickScope = (next: VaultScope) => {
    setScope(next);
    // What counts as already saved depends on where they go: count again.
    if (csv) void count(csv, next);
  };
  const confirm = async () => {
    if (!csv) return;
    const r = await importer.run({ csv, scope, dryRun: false });
    if (!r) return;
    setResult(r);
    // Imported: the file's text has nothing left to do here.
    setCsv(null);
    setStage("done");
  };
  const total = preview ? preview.added + preview.updated : 0;
  const stop = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return false;
    e.preventDefault();
    e.stopPropagation();
    return !importer.busy;
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.import.title")}
      description={stage === "pick" ? t("vault.import.text") : undefined}
      closeLabel={t("common.close")}
      width={560}
    >
      <Locked when={importer.busy}>
        <DialogBody className="vlt-import">
          {stage === "pick" && (
            <>
              <div className="vlt-drop" data-over={over || undefined}>
                <button
                  type="button"
                  className="vlt-drop__area"
                  onClick={() => input.current?.click()}
                  onDragEnter={(e) => stop(e) && setOver(true)}
                  onDragOver={(e) => {
                    if (stop(e)) e.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={(e) => {
                    if (!stop(e)) return;
                    setOver(false);
                    void read(e.dataTransfer.files[0]);
                  }}
                >
                  <span className="vlt-drop__icon">
                    <Icon name="upload" size={20} />
                  </span>
                  <b>{importer.busy ? t("vault.import.reading") : t("vault.import.dropTitle")}</b>
                  <span>{t("vault.import.dropText")}</span>
                </button>
                <input
                  ref={input}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  aria-label={t("vault.import.choose")}
                  onChange={(e) => {
                    void read(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              {error && (
                <p className="ac-field__error" role="alert">
                  {error}
                </p>
              )}
              <SettingNote icon="info">{t("vault.import.where")}</SettingNote>
            </>
          )}
          {stage === "review" && preview && (
            <>
              <p className="vlt-import__file ac-iconline">
                <Icon name="file" size={16} />
                <span>
                  <b>{fileName}</b> · {t(`vault.import.format.${preview.format}`)}
                </span>
              </p>
              <ImportCounts result={preview} />
              {/* Where they go: a choice for who manages the Vault, a plain line for everyone else (always theirs). */}
              {!canManageTeam && <SettingNote icon="lock">{t("vault.import.asPersonal")}</SettingNote>}
              {canManageTeam && (
                <div className="ac-field">
                  <span className="ac-field__label">{t("vault.import.as")}</span>
                  <Segmented<VaultScope>
                    label={t("vault.import.as")}
                    value={scope}
                    onValueChange={pickScope}
                    options={[
                      { value: "personal", label: t("vault.scope.personal") },
                      { value: "team", label: t(modeKey(org, "vault.scope.team")) },
                    ]}
                  />
                  <span className="ac-field__example">
                    {scope === "team" ? t("vault.import.asTeam") : t("vault.import.asPersonal")}
                  </span>
                </div>
              )}
              <SettingNote icon="alert">{t("vault.import.deleteFile")}</SettingNote>
            </>
          )}
          {stage === "done" && result && (
            <>
              <p className="vlt-import__done ac-iconline">
                <Icon name="check" size={18} />
                <b>{t("vault.import.done", { count: result.added + result.updated })}</b>
              </p>
              <ImportCounts result={result} />
              <SettingNote icon="alert">{t("vault.import.deleteFile")}</SettingNote>
            </>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter>
        {stage === "done" ? (
          <Button variant="primary" onClick={onClose}>
            {t("vault.import.close")}
          </Button>
        ) : (
          <>
            {stage === "review" && (
              <Locked when={importer.busy}>
                <Button
                  variant="ghost"
                  className="vlt-foot__start"
                  onClick={() => {
                    setStage("pick");
                    setCsv(null);
                    setPreview(null);
                  }}
                >
                  {t("vault.import.another")}
                </Button>
              </Locked>
            )}
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            {stage === "review" && (
              <Button
                variant="primary"
                disabled={total === 0 || importer.busy}
                loading={importer.busy}
                onClick={() => void confirm()}
              >
                {t("vault.import.confirm", { count: total })}
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
