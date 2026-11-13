import { LICENSE_URL, PUBLIC_SOURCE_URL } from "@agenteschat/client/lib/about";
import { DOCS_SITE } from "@agenteschat/i18n/docs";
import { Button, Chip, InfoHint, Switch } from "@agenteschat/ui";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useHost } from "../../app";
import { AUTO_UPDATE_PREF, autoUpdateOn, noteLines } from "../../control/version";
import { type UpdateCheck, useLocalServer, usePref } from "../../hooks";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { clock } from "../../ui/time";

/**
 * Updates (ADR 0036 §9): one click downloads the signed update, with its progress and Cancel, installs it and
 * reopens the app. When that can't happen (a release without the updater bundle, a failed or stalled download, a
 * Linux package) the download and, on a Mac, the manual steps come back.
 */
export function Updates({ update }: { update: UpdateCheck }) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const { latest, available, required } = update.state;
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ got: number; total: number | null } | null>(null);
  const [manual, setManual] = useState(false);
  const local = useLocalServer();
  const [autoPref, setAutoPref] = usePref<boolean | null>(AUTO_UPDATE_PREF, null);
  useEffect(() => host.onUpdateProgress((got, total) => setProgress({ got, total })), [host]);

  const install = async () => {
    setInstalling(true);
    setProgress(null);
    try {
      // true: the app is about to reopen as the new version; the card stays until then.
      if (await host.installUpdate()) return;
      setManual(true);
    } catch (e) {
      // Cancel: nothing was installed, and Update and reopen is back.
      if (e !== "cancelled") {
        toast(t("desktop.prefs.updates.installFailed"), "alert");
        setManual(true);
      }
    }
    setInstalling(false);
  };
  const percent = progress?.total ? Math.min(100, Math.floor((progress.got / progress.total) * 100)) : 0;
  // Whole: it installs now (seconds), and there is nothing left to cancel.
  const whole = percent === 100;

  const checkNow = async () => {
    const result = await update.check();
    if (!result) toast(t("desktop.prefs.updates.checkFailed"), "alert");
    else if (!result.available) toast(t("desktop.prefs.updates.latestAlready"));
  };

  return (
    <>
      <PrefHead title={t("desktop.prefs.updates.title")} />
      <PrefCard>
        <div className="dk-ver">
          <span className="dk-ver__big ac-num">{update.version ?? "…"}</span>
          <span className="dk-ver__text">
            <span className="ac-hintline">
              {required ? (
                <Chip icon="alert" tone="waiting">
                  {t("desktop.prefs.updates.required")}
                </Chip>
              ) : available && latest ? (
                <Chip icon="download" tone="waiting">
                  {t("desktop.prefs.updates.newer", { version: latest.version })}
                </Chip>
              ) : (
                <Chip icon="check" tone="done">
                  {t("desktop.prefs.updates.upToDate")}
                </Chip>
              )}
              {local.run && (
                <InfoHint name={t("common.about", { label: t("desktop.prefs.updates.title") })}>
                  {t("desktop.server.updatesWithApp")}
                </InfoHint>
              )}
            </span>
            <small className="dk-help">
              {update.checkedAt
                ? t("desktop.prefs.updates.lastCheck", {
                    time: clock(new Date(update.checkedAt).toISOString(), i18n.language),
                  })
                : t("desktop.prefs.updates.neverChecked")}
            </small>
          </span>
          <Button size="sm" loading={update.checking} onClick={() => void checkNow()}>
            {t("desktop.prefs.updates.checkNow")}
          </Button>
        </div>
      </PrefCard>
      <PrefCard>
        <PrefRow
          htmlFor="auto-update"
          title={t("desktop.prefs.updates.autoInstall")}
          hint={hintFor(t, t("desktop.prefs.updates.autoInstall"), t("desktop.prefs.updates.autoInstallDesc"))}
          end={
            <Switch
              id="auto-update"
              aria-describedby="auto-update-hint"
              checked={autoUpdateOn(autoPref, local.run)}
              onCheckedChange={setAutoPref}
            />
          }
        />
      </PrefCard>

      {available && latest && (
        <>
          {!manual && (
            <PrefCard padded>
              {installing ? (
                <div className="dk-upd" aria-live="polite">
                  <div className="dk-upd__line">
                    <span className="dk-upd__label">
                      {whole ? t("desktop.prefs.updates.installing") : t("desktop.prefs.updates.downloading")}
                    </span>
                    {!whole && (
                      <Button className="dk-upd__cancel" onClick={() => void host.cancelUpdate().catch(() => {})}>
                        {t("desktop.common.cancel")}
                      </Button>
                    )}
                  </div>
                  <div
                    className="dk-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress?.total ? percent : undefined}
                    aria-label={t("desktop.prefs.updates.downloading")}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </div>
              ) : (
                <div className="dk-ver__acts">
                  <Button variant="primary" icon="download" onClick={() => void install()}>
                    {t("desktop.prefs.updates.install")}
                  </Button>
                </div>
              )}
            </PrefCard>
          )}
          {manual && (
            <>
              <CardTitle>{t("desktop.prefs.updates.howTitle")}</CardTitle>
              <PrefCard padded>
                {host.platform === "mac" ? (
                  <ol className="dk-steps-list">
                    <li>{t("desktop.prefs.updates.step1")}</li>
                    <li>{t("desktop.prefs.updates.step2")}</li>
                    <li>{t("desktop.prefs.updates.step3")}</li>
                  </ol>
                ) : (
                  <p className="dk-help">{t("desktop.prefs.updates.installerNote")}</p>
                )}
                <div className="dk-ver__acts">
                  <Button variant="primary" icon="download" onClick={() => void host.openExternal(latest.url)}>
                    {t("desktop.prefs.updates.download", { version: latest.version })}
                  </Button>
                  <span className="dk-help">{t("desktop.prefs.updates.keepNote")}</span>
                </div>
              </PrefCard>
            </>
          )}
          {noteLines(latest.notes).length > 0 && (
            <>
              <CardTitle>{t("desktop.prefs.updates.whatsNew", { version: latest.version })}</CardTitle>
              <PrefCard padded>
                <ul className="dk-changes">
                  {noteLines(latest.notes).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </PrefCard>
            </>
          )}
        </>
      )}
      <About />
    </>
  );
}

/** An outside page, opened in the browser. */
function Out({ href, children }: { href: string; children?: ReactNode }) {
  const host = useHost();
  return (
    <button type="button" className="ac-link dk-link" onClick={() => void host.openExternal(href).catch(() => {})}>
      {children}
    </button>
  );
}

/**
 * AGPL-3.0's Appropriate Legal Notices and the attribution the section 7(b) term in NOTICE requires, with
 * no setting that hides them.
 */
function About() {
  const { t } = useTranslation();
  return (
    <>
      <CardTitle>{t("settings.section.about")}</CardTitle>
      <PrefCard padded>
        <p className="dk-help">
          <Trans i18nKey="settings.about.basedOn" components={{ site: <Out href={DOCS_SITE} /> }} />
        </p>
        <p className="dk-help">
          <Trans i18nKey="settings.about.license" components={{ license: <Out href={LICENSE_URL} /> }} />
        </p>
        <p className="dk-help">
          <Out href={PUBLIC_SOURCE_URL}>{t("settings.about.source")}</Out>
        </p>
        <p className="dk-help">{t("settings.about.copyright")}</p>
      </PrefCard>
    </>
  );
}
