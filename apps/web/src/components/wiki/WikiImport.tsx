import { keys, useWikiTree, type WikiImportNote } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { Button, Checkbox, Dialog, DialogBody, DialogFooter, Icon, Input, Segmented } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WikiSky } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import {
  filesFromDrop,
  filesFromList,
  fmtBytes,
  hasFiles,
  homeOf,
  importVault,
  readVault,
  sendVaultNotes,
  type VaultFailure,
  type VaultFile,
  type VaultReport,
} from "@/lib/obsidian";
import { useToast } from "@/lib/toast";
import { ObsidianMark } from "./ObsidianMark";
import "./vault.css";

/** Picking a vault: a .zip or .md files, or a whole folder. Both inputs stay hidden. */
export function VaultInputs({
  onFiles,
  zipRef,
  dirRef,
}: {
  onFiles: (files: Promise<VaultFile[]>, name?: string) => void;
  zipRef: React.RefObject<HTMLInputElement | null>;
  dirRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <input
        ref={zipRef}
        type="file"
        accept=".zip,.md,.markdown"
        multiple
        hidden
        aria-label={t("wiki.import.pickZip")}
        onChange={(e) => {
          const list = e.target.files;
          if (list?.length) onFiles(filesFromList(list));
          e.target.value = "";
        }}
      />
      <input
        ref={dirRef}
        type="file"
        multiple
        hidden
        aria-label={t("wiki.import.pickFolder")}
        // biome-ignore lint/suspicious/noExplicitAny: non-standard attribute React doesn't type
        {...({ webkitdirectory: "" } as any)}
        onChange={(e) => {
          const list = e.target.files;
          const first = list?.[0] as (File & { webkitRelativePath?: string }) | undefined;
          if (list?.length) onFiles(filesFromList(list), first?.webkitRelativePath?.split("/")[0]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** The dashed area: drop a vault here, or click to pick a .zip. */
export function VaultDropZone({
  onFiles,
  compact = false,
  children,
}: {
  onFiles: (files: Promise<VaultFile[]>, name?: string) => void;
  compact?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const zip = useRef<HTMLInputElement>(null);
  const dir = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const stop = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  return (
    <div className="vault-drop" data-over={over || undefined} data-compact={compact || undefined}>
      <button
        type="button"
        className="vault-drop__area"
        onClick={() => zip.current?.click()}
        onDragEnter={(e) => stop(e) && setOver(true)}
        onDragOver={(e) => {
          if (stop(e) && e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!stop(e)) return;
          setOver(false);
          onFiles(filesFromDrop(e.dataTransfer));
        }}
      >
        {!compact && (
          <span className="vault-drop__icon">
            <ObsidianMark size={30} />
          </span>
        )}
        {compact && <Icon name="upload" />}
        <b>{t("wiki.import.dropTitle")}</b>
        <span>{t("wiki.import.dropText")}</span>
      </button>
      {!compact && (
        <div className="vault-drop__alts">
          <Button size="sm" icon="upload" onClick={() => zip.current?.click()}>
            {t("wiki.import.pickZip")}
          </Button>
          <Button size="sm" icon="drive" onClick={() => dir.current?.click()}>
            {t("wiki.import.pickFolder")}
          </Button>
        </div>
      )}
      {compact && (
        <Button size="sm" variant="ghost" icon="drive" onClick={() => dir.current?.click()}>
          {t("onboarding.import.pickFolder")}
        </Button>
      )}
      {children}
      <VaultInputs onFiles={onFiles} zipRef={zip} dirRef={dir} />
    </div>
  );
}

/** "14 notas · 4 pastas · 18 links · 3 anexos" with tabular figures (`ac-num`). */
export function VaultStats({ report }: { report: VaultReport }) {
  const { t } = useTranslation();
  const stats: [number, string][] = [
    [report.notes.length, t("wiki.import.stat.notes", { count: report.notes.length })],
    [
      report.folders.filter((f) => f.name).length,
      t("wiki.import.stat.folders", { count: report.folders.filter((f) => f.name).length }),
    ],
    [report.links, t("wiki.import.stat.links", { count: report.links })],
    [report.embeddedCount, t("wiki.import.stat.attachments", { count: report.embeddedCount })],
  ];
  return (
    <div className="vault-stats">
      {stats.map(([n, label]) => (
        <div key={label} className="vault-stats__item">
          <b className="ac-num">{n}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

type Line = { icon: "check" | "alert" | "close"; tone: "ok" | "warn" | "muted"; title: string; text?: string };

/** "How it lands here": what is kept, what needs a look, what stays out. */
export function vaultMapping(t: TFunction, locale: string, r: VaultReport): Line[] {
  const lines: Line[] = [
    { icon: "check", tone: "ok", title: t("wiki.import.map.links"), text: t("wiki.import.map.linksText") },
  ];
  if (r.tags.length)
    lines.push({
      icon: "check",
      tone: "ok",
      title: t("wiki.import.map.tags", { count: r.tags.length }),
      text: `${r.tags
        .slice(0, 8)
        .map((x) => `#${x}`)
        .join(" ")}${r.tags.length > 8 ? " …" : ""}`,
    });
  if (r.embeddedCount)
    lines.push({
      icon: "check",
      tone: "ok",
      title: t("wiki.import.map.attachments", { count: r.embeddedCount }),
      text: t("wiki.import.map.attachmentsText", { size: fmtBytes(r.embeddedBytes, locale) }),
    });
  if (r.callouts)
    lines.push({ icon: "check", tone: "ok", title: t("wiki.import.map.callouts", { count: r.callouts }) });
  if (r.broken.length)
    lines.push({
      icon: "alert",
      tone: "warn",
      title: t("wiki.import.map.broken", { count: r.broken.length }),
      text: `${r.broken.slice(0, 4).join(", ")}${r.broken.length > 4 ? "…" : ""}`,
    });
  if (r.dataview)
    lines.push({
      icon: "alert",
      tone: "warn",
      title: t("wiki.import.map.dataview", { count: r.dataview }),
      text: t("wiki.import.map.dataviewText"),
    });
  if (r.canvases.length)
    lines.push({ icon: "close", tone: "muted", title: t("wiki.import.map.canvas", { count: r.canvases.length }) });
  if (r.skipped.config)
    lines.push({
      icon: "close",
      tone: "muted",
      title: t("wiki.import.map.config"),
      text: t("wiki.import.map.configText", { count: r.skipped.config }),
    });
  return lines;
}

export function VaultLines({ lines }: { lines: Line[] }) {
  return (
    <ul className="vault-lines">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list per report
        <li key={i} className="ac-iconline" data-tone={l.tone}>
          <Icon name={l.icon} size={16} />
          <span>
            <b>{l.title}</b>
            {l.text && <small>{l.text}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The end of an import: what came in, what didn't and why, and what "Tentar de novo" sends. */
type ImportDone = {
  total: number;
  count: number;
  uploaded: number;
  slug?: string;
  title?: string;
  failures: VaultFailure[];
  skipped: string[];
  retry: WikiImportNote[];
  importId: string;
  name: string;
  folder?: string;
  onConflict: "keep_both" | "skip";
};

const titlesOf = (titles: string[]) => `${titles.slice(0, 6).join(", ")}${titles.length > 6 ? " …" : ""}`;

/** Why notes didn't come in, one line per reason, with their titles. */
function failureLines(t: TFunction, locale: string, done: ImportDone): Line[] {
  const lines: Line[] = [];
  const by = (reason: VaultFailure["reason"]) => done.failures.filter((f) => f.reason === reason);
  const batch = by("batch");
  if (batch.length)
    lines.push({
      icon: "alert",
      tone: "warn",
      title: t("wiki.import.why.batch", { count: batch.length, error: errorText(t, batch[0]?.error, locale) }),
      text: titlesOf(batch.map((f) => f.title)),
    });
  const stopped = by("stopped");
  if (stopped.length)
    lines.push({
      icon: "alert",
      tone: "warn",
      title: t("wiki.import.why.stopped", { count: stopped.length }),
      text: titlesOf(stopped.map((f) => f.title)),
    });
  const tooLong = by("too_long");
  if (tooLong.length)
    lines.push({
      icon: "close",
      tone: "muted",
      title: t("wiki.import.why.tooLong", { count: tooLong.length }),
      text: titlesOf(tooLong.map((f) => f.title)),
    });
  const untitled = by("title");
  if (untitled.length)
    lines.push({
      icon: "close",
      tone: "muted",
      title: t("wiki.import.why.title", { count: untitled.length }),
      text: titlesOf(untitled.map((f) => f.title)),
    });
  if (done.skipped.length)
    lines.push({
      icon: "close",
      tone: "muted",
      title: t("wiki.import.why.skipped", { count: done.skipped.length }),
      text: titlesOf(done.skipped),
    });
  return lines;
}

/** Reads a vault and keeps the progress (the dialog and the onboarding card). */
export function useVaultReader(existing: { title: string }[]) {
  const { t } = useTranslation();
  const toast = useToast();
  const [state, setState] = useState<{ step: "idle" | "reading" | "ready"; done: number; total: number; path: string }>(
    {
      step: "idle",
      done: 0,
      total: 0,
      path: "",
    },
  );
  const [report, setReport] = useState<VaultReport | null>(null);
  const read = async (files: Promise<VaultFile[]>, name?: string) => {
    setState({ step: "reading", done: 0, total: 0, path: "" });
    try {
      const started = Date.now();
      const r = await readVault(await files, {
        existing,
        name,
        onProgress: (done, total, path) => setState({ step: "reading", done, total, path }),
      });
      // A beat on screen, so a small vault doesn't flash by.
      await new Promise((ok) => setTimeout(ok, Math.max(0, 600 - (Date.now() - started))));
      setReport(r);
      setState((s) => ({ ...s, step: "ready" }));
      return r;
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast.show(t(`wiki.import.error.${code === "empty" || code === "too_big" ? code : "unreadable"}`), "error");
      setState({ step: "idle", done: 0, total: 0, path: "" });
      return null;
    }
  };
  const reset = () => {
    setReport(null);
    setState({ step: "idle", done: 0, total: 0, path: "" });
  };
  return { state, report, read, reset };
}

export function VaultReading({
  done,
  total,
  path,
  label,
}: {
  done: number;
  total: number;
  path: string;
  label: string;
}) {
  return (
    <div className="vault-reading" role="status">
      <b className="ac-num">{done}</b>
      <span className="muted">{label}</span>
      <span className="vault-reading__bar" aria-hidden="true">
        <i style={{ width: `${total ? (done / total) * 100 : 6}%` }} />
      </span>
      <small>{path}</small>
    </div>
  );
}

/**
 * "Importar do Obsidian": pick or drop a vault, review what it holds and how
 * it lands, then import (attachments to the Drive, notes as pages).
 * `files` starts it already reading (a vault dropped on the page).
 */
export function WikiImportDialog({
  files,
  name,
  onClose,
}: {
  files?: Promise<VaultFile[]> | null;
  name?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const tree = useWikiTree(org.id);
  const reader = useVaultReader(tree.data ?? []);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [dest, setDest] = useState<"merge" | "folder">("merge");
  const [into, setInto] = useState("Obsidian");
  const [conflict, setConflict] = useState<"keep_both" | "skip">("keep_both");
  const [importing, setImporting] = useState<{ step: "files" | "pages"; done: number; total: number } | null>(null);
  const [done, setDone] = useState<ImportDone | null>(null);
  const stop = useRef(false);
  const [stopping, setStopping] = useState(false);

  const read = async (f: Promise<VaultFile[]>, n?: string) => {
    const r = await reader.read(f, n);
    if (r) setPick(new Set(r.folders.map((x) => x.name)));
  };
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the vault it opened with
  useEffect(() => {
    if (files && !started.current) {
      started.current = true;
      void read(files, name);
    }
  }, [files]);

  const report = reader.report;
  const chosen = report ? report.notes.filter((n) => pick.has(n.folder.split("/")[0] ?? "")).length : 0;

  const run = async () => {
    if (!report) return;
    stop.current = false;
    setImporting({ step: "files", done: 0, total: 0 });
    try {
      const result = await importVault(api, org.id, report, {
        folders: pick,
        into: dest === "folder" ? into : "",
        onConflict: conflict,
        stopped: () => stop.current,
        onProgress: (step, d, total) => setImporting({ step, done: d, total }),
      });
      const home = homeOf(result.created);
      setDone({
        total: result.total,
        count: result.created.length,
        uploaded: result.uploaded,
        slug: home?.slug,
        title: home?.title,
        failures: result.failures,
        skipped: result.skipped,
        retry: result.retry,
        importId: result.importId,
        name: report.name,
        folder: dest === "folder" ? into.trim() || undefined : undefined,
        onConflict: conflict,
      });
    } catch (e) {
      toast.show(errorText(t, e, i18n.language), "error");
    } finally {
      void qc.invalidateQueries({ queryKey: keys.wiki(org.id) });
      setImporting(null);
      setStopping(false);
    }
  };

  /**
   * "Tentar de novo": only the batches that failed, with the same import id, so a note of a batch that went in after
   * all comes back as in, not doubled.
   */
  const retry = async () => {
    if (!done || done.retry.length === 0) return;
    stop.current = false;
    setImporting({ step: "pages", done: 0, total: done.retry.length });
    try {
      const again = await sendVaultNotes(
        api,
        org.id,
        {
          name: done.name,
          folder: done.folder,
          onConflict: done.onConflict,
          importId: done.importId,
          notes: done.retry,
        },
        (d, total) => setImporting({ step: "pages", done: d, total }),
        () => stop.current,
      );
      setDone({
        ...done,
        count: done.count + again.created.length,
        skipped: [...done.skipped, ...again.skipped],
        failures: [...done.failures.filter((f) => f.reason !== "batch" && f.reason !== "stopped"), ...again.failures],
        retry: again.retry,
      });
    } finally {
      void qc.invalidateQueries({ queryKey: keys.wiki(org.id) });
      setImporting(null);
      setStopping(false);
    }
  };

  const agents = dir.agents.slice(0, 2);
  const missing = done ? done.failures.length + done.skipped.length : 0;
  const title = done
    ? missing
      ? t("wiki.import.partialTitle")
      : t("wiki.import.doneTitle")
    : report && reader.state.step === "ready"
      ? report.name
      : t("wiki.import.title");
  const description = done
    ? undefined
    : importing
      ? t("wiki.import.importingText")
      : reader.state.step === "reading"
        ? t("wiki.import.readingText")
        : report
          ? t("wiki.import.reviewText")
          : t("wiki.import.text");

  let body: ReactNode;
  let footer: ReactNode;
  if (done && missing > 0) {
    body = (
      <>
        <div className="vault-done vault-done--partial">
          <b>
            {t("wiki.import.partial", {
              count: done.total,
              done: done.count,
              failed: done.total - done.count,
            })}
          </b>
          {done.count > 0 && <span>{t("wiki.import.partialText")}</span>}
        </div>
        <section className="vault-block" aria-label={t("wiki.import.whyTitle")}>
          <header>
            <b>{t("wiki.import.whyTitle")}</b>
          </header>
          <VaultLines lines={failureLines(t, i18n.language, done)} />
        </section>
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>{t("common.close")}</Button>
        {done.retry.length > 0 && (
          <Button variant="primary" icon="refresh" onClick={() => void retry()}>
            {t("wiki.import.retry", { count: done.retry.length })}
          </Button>
        )}
        {done.retry.length === 0 && done.slug && (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: done.slug ?? "" } });
            }}
          >
            {t("wiki.import.open", { title: done.title })}
          </Button>
        )}
      </>
    );
  } else if (done) {
    body = (
      <div className="vault-done">
        <WikiSky variant="glow" />
        <div className="vault-done__crew">
          {agents.map((a) => (
            <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="lg" />
          ))}
        </div>
        <b>{t("wiki.import.pages", { count: done.count })}</b>
        <span>
          {agents.length
            ? t("wiki.import.agentsRead", {
                names: joinNames(
                  agents.map((a) => a.name),
                  t,
                ),
                count: agents.length,
              })
            : t("wiki.import.newMarked")}
        </span>
        {done.uploaded > 0 && (
          <span className="small muted">{t("wiki.import.uploaded", { count: done.uploaded })}</span>
        )}
      </div>
    );
    footer = (
      <>
        <Button onClick={onClose}>{t("common.close")}</Button>
        {done.slug && (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: done.slug ?? "" } });
            }}
          >
            {t("wiki.import.open", { title: done.title })}
          </Button>
        )}
      </>
    );
  } else if (importing) {
    body = (
      <VaultReading
        done={importing.done}
        total={importing.total}
        path=""
        label={
          importing.step === "files"
            ? t("wiki.import.sendingFiles")
            : t("wiki.import.sendingNotes", { count: importing.total })
        }
      />
    );
    footer =
      importing.step === "pages" ? (
        <Button
          disabled={stopping}
          onClick={() => {
            stop.current = true;
            setStopping(true);
          }}
        >
          {stopping ? t("wiki.import.stopping") : t("wiki.import.stop")}
        </Button>
      ) : null;
  } else if (reader.state.step === "reading") {
    body = <VaultReading {...reader.state} label={t("wiki.import.notesRead")} />;
    footer = null;
  } else if (report) {
    body = (
      <>
        <VaultStats report={report} />
        <section className="vault-block" aria-label={t("wiki.import.what")}>
          <header>
            <b>{t("wiki.import.what")}</b>
            <span className="muted small">
              {t("wiki.import.chosen", { count: chosen, total: report.notes.length })}
            </span>
          </header>
          {report.folders.map((f) => (
            <div key={f.name || "/"} className="vault-row">
              <Checkbox
                checked={pick.has(f.name)}
                aria-label={f.name || t("wiki.import.rootNotes")}
                onCheckedChange={(on) => {
                  const next = new Set(pick);
                  if (on) next.add(f.name);
                  else next.delete(f.name);
                  setPick(next);
                }}
              />
              <Icon name="drive" size={16} />
              <span className="vault-row__name">{f.name || t("wiki.import.rootNotes")}</span>
              <span className="muted small">{t("wiki.import.stat.notes", { count: f.count })}</span>
            </div>
          ))}
        </section>
        <section className="vault-block" aria-label={t("wiki.import.where")}>
          <header>
            <b>{t("wiki.import.where")}</b>
          </header>
          <div className="vault-row">
            <Segmented
              block
              label={t("wiki.import.where")}
              value={dest}
              onValueChange={setDest}
              options={[
                { value: "merge", label: t("wiki.import.merge") },
                { value: "folder", label: t("wiki.import.ownFolder") },
              ]}
            />
            {dest === "folder" && (
              <Input
                aria-label={t("wiki.import.folderName")}
                value={into}
                onChange={(e) => setInto(e.target.value)}
                style={{ maxWidth: 200 }}
              />
            )}
          </div>
          {report.conflicts.length > 0 && dest === "merge" && (
            <div className="vault-row vault-row--wrap">
              <Icon name="alert" size={16} />
              <span className="vault-row__name">
                {t("wiki.import.conflicts", { count: report.conflicts.length })}
                <small>{report.conflicts.slice(0, 6).join(", ")}</small>
              </span>
              <Segmented
                size="sm"
                label={t("wiki.import.conflictsLabel")}
                value={conflict}
                onValueChange={setConflict}
                options={[
                  { value: "keep_both", label: t("wiki.import.keepBoth") },
                  { value: "skip", label: t("wiki.import.skip") },
                ]}
              />
            </div>
          )}
        </section>
        <section className="vault-block" aria-label={t("wiki.import.how")}>
          <header>
            <b>{t("wiki.import.how")}</b>
          </header>
          <VaultLines lines={vaultMapping(t, i18n.language, report)} />
        </section>
      </>
    );
    footer = (
      <>
        <span className="small muted vault-foot-hint">{t("wiki.import.versionHint")}</span>
        <Button onClick={reader.reset}>{t("wiki.import.another")}</Button>
        <Button variant="primary" disabled={chosen === 0} onClick={() => void run()}>
          {t("wiki.import.go", { count: chosen })}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <VaultDropZone onFiles={(f, n) => void read(f, n)} />
        <p className="vault-notice ac-iconline">
          <Icon name="info" size={16} />
          <span>{t("wiki.import.howTo")}</span>
        </p>
      </>
    );
    footer = <span className="small muted vault-foot-hint">{t("wiki.import.nothingYet")}</span>;
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !importing && onClose()}
      title={title}
      description={description}
      closeLabel={t("common.close")}
      width={680}
    >
      <DialogBody>
        <div className="vault-dialog">{body}</div>
      </DialogBody>
      {footer && <DialogFooter>{footer}</DialogFooter>}
    </Dialog>
  );
}

/** The whole wiki while a vault is dragged over it. */
export function VaultDropOverlay() {
  const { t } = useTranslation();
  return (
    <div className="wiki-dropzone" aria-hidden="true">
      <div className="wiki-dropzone__in">
        <span className="wiki-dropzone__icon">
          <ObsidianMark size={38} />
        </span>
        <b>{t("wiki.import.overlayTitle")}</b>
        <span>{t("wiki.import.overlayText")}</span>
      </div>
    </div>
  );
}

/** Drag a vault anywhere on the wiki: a counter, since children fire enter/leave too. */
export function useVaultDrop(onFiles: (files: Promise<VaultFile[]>) => void, enabled: boolean) {
  const [depth, setDepth] = useState(0);
  const props = enabled
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setDepth((d) => d + 1);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (e: DragEvent) => {
          if (!hasFiles(e.dataTransfer)) return;
          setDepth((d) => Math.max(0, d - 1));
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setDepth(0);
          onFiles(filesFromDrop(e.dataTransfer));
        },
      }
    : {};
  return { over: enabled && depth > 0, props };
}
