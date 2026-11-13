import type { AppAccess, AppConsent } from "@agenteschat/client";
import { useAppConsent, useDecideAppConsent } from "@agenteschat/client";
import {
  appName,
  type ConsentError,
  consentErrorOf,
  defaultWorkspace,
  requestedAccess,
} from "@agenteschat/client/lib/apps";
import { workspaceLabel, workspaceNotes } from "@agenteschat/client/lib/deletion";
import { signInPath } from "@agenteschat/client/lib/guards";
import { visibleText } from "@agenteschat/client/lib/text";
import { isAppLocale } from "@agenteschat/i18n/locale";
import { Alert, Button, Card, EmptyState, Field, Icon, Locked, OptionList, Select } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AppMark } from "@/components/AiApps";
import { CenteredLayout } from "@/components/AuthLayout";
import { LoadingLine } from "@/components/Loading";
import { DEFAULT_LOCALE, type LocaleCode, locales, TYPED_VALUES, usePageT } from "@/i18n";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import "@/components/ai-apps.css";

/** How long "Pronto" shows before the browser goes back to the app. */
export const LEAVE_MS = 1_100;

/** The states that take the whole card; a paused or lost workspace is said under the picker instead. */
type PageError = Exclude<ConsentError, "workspace_paused" | "not_member">;
const isPageError = (e: ConsentError): e is PageError => e !== "workspace_paused" && e !== "not_member";

type Outcome = { kind: "allowed"; app: string; to: string } | { kind: "denied"; to: string } | null;

/**
 * `/autorizar?req=` (ADR 0119): an AI app asks to act as this person. The page says who asks (from the address it
 * returns to, never what it says of itself unless verified), where the browser goes back, the workspace and the
 * access, what it can and can never do, and Permitir or Cancelar. Either way the browser goes back to the app once:
 * an app's own scheme (`cursor://`) leaves this page open on its last state. `?erro=` is the server's refusal before
 * there was a request to show. The language switch here is for this page only.
 */
export function AuthorizePage({ requestId, error }: { requestId: string; error: PageError | null }) {
  const { i18n } = useTranslation();
  const [lang, setLang] = useState<LocaleCode>(isAppLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE);
  const t = usePageT(lang);
  return (
    <CenteredLayout narrow>
      <div lang={lang} className="consent-page">
        {error || !requestId ? (
          <ConsentErrorCard t={t} error={error ?? "expirado"} />
        ) : (
          <Consent t={t} requestId={requestId} />
        )}
        <div className="consent__lang">
          <Select
            size="sm"
            aria-label={t("shell.language")}
            value={lang}
            onValueChange={(v) => setLang(v as LocaleCode)}
            options={locales.map((l) => ({ value: l.code, label: l.label }))}
          />
        </div>
      </div>
    </CenteredLayout>
  );
}

/** The page's end states: the card's own content, never a dashed box inside it. */
const STATE = "consent__state";

function ConsentErrorCard({ t, error, onRetry }: { t: TFunction; error: PageError; onRetry?: () => void }) {
  return (
    <Card padded as="div" className="consent">
      <EmptyState
        className={STATE}
        icon={error === "expirado" ? "waiting" : error === "muitas_tentativas" ? "clock" : "block"}
        title={t(`apps.consent.error.${error}`)}
        actions={
          error === "indisponivel" && onRetry ? (
            <Button onClick={onRetry}>{t("common.retry")}</Button>
          ) : (
            // A stale link or a refused app: a way into agentes.chat itself.
            <Link to="/" className="ac-link small">
              {t("apps.consent.goHome")}
            </Link>
          )
        }
      >
        {t(`apps.consent.error.${error}Text`)}
      </EmptyState>
    </Card>
  );
}

function Consent({ t, requestId }: { t: TFunction; requestId: string }) {
  const consent = useAppConsent(requestId);
  const decide = useDecideAppConsent(requestId);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [failed, setFailed] = useState<ConsentError | null>(null);
  const left = useRef(false);
  // Once, whatever renders after: an app's own scheme leaves this page loaded, and a second go would open it again.
  useEffect(() => {
    if (!outcome || left.current) return;
    const timer = setTimeout(
      () => {
        left.current = true;
        window.location.assign(outcome.to);
      },
      outcome.kind === "allowed" ? LEAVE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [outcome]);

  if (outcome?.kind === "allowed") {
    return (
      <Card padded as="div" className="consent">
        <EmptyState className={`${STATE} ${STATE}--ok`} icon="check" title={t("apps.consent.doneTitle")}>
          <span role="status">{t("apps.consent.done", { app: outcome.app })}</span>
        </EmptyState>
      </Card>
    );
  }
  if (outcome?.kind === "denied") {
    return (
      <Card padded as="div" className="consent">
        <EmptyState className={STATE} icon="block" title={t("apps.consent.cancelledTitle")}>
          {t("apps.consent.cancelled")}
        </EmptyState>
      </Card>
    );
  }
  const loadError = consent.isError ? consentErrorOf(consent.error) : null;
  if (loadError) {
    return (
      <ConsentErrorCard
        t={t}
        error={isPageError(loadError) ? loadError : "indisponivel"}
        onRetry={() => void consent.refetch()}
      />
    );
  }
  if (failed && isPageError(failed)) return <ConsentErrorCard t={t} error={failed} onRetry={() => setFailed(null)} />;
  if (!consent.data) {
    return (
      <Card padded as="div" className="consent" aria-busy="true">
        <span className="small muted">{t("apps.consent.loading")}</span>
        <LoadingLine width={260} />
        <LoadingLine width={200} />
      </Card>
    );
  }
  if (consent.data.workspaces.length === 0) {
    return (
      <Card padded as="div" className="consent">
        <EmptyState
          className={STATE}
          icon="home"
          title={t("apps.consent.error.noWorkspace")}
          actions={
            <Button asChild variant="primary">
              <Link to="/onboarding">{t("apps.consent.error.createWorkspace")}</Link>
            </Button>
          }
        >
          {t("apps.consent.error.noWorkspaceText")}
        </EmptyState>
      </Card>
    );
  }
  return (
    <ConsentForm
      t={t}
      consent={consent.data}
      busy={decide.isPending}
      inlineError={failed === "workspace_paused" || failed === "not_member" ? failed : null}
      onDecide={(input, app) =>
        decide.mutate(input, {
          onSuccess: ({ redirectTo }) =>
            setOutcome(
              input.decision === "allow"
                ? { kind: "allowed", app, to: redirectTo }
                : { kind: "denied", to: redirectTo },
            ),
          onError: (err) => setFailed(consentErrorOf(err)),
        })
      }
      onPick={() => setFailed(null)}
    />
  );
}

/** What the app calls itself, for "Pode voltar ao {app}" and "via {app}": Cursor and a program are named so. */
const shownName = (t: TFunction, c: AppConsent["request"]["client"]) =>
  c.displayKind === "app_scheme" ? "Cursor" : c.name || c.host || t("apps.consent.thisComputer");

function ConsentForm({
  t,
  consent,
  busy,
  inlineError,
  onDecide,
  onPick,
}: {
  t: TFunction;
  consent: AppConsent;
  busy: boolean;
  inlineError: "workspace_paused" | "not_member" | null;
  onDecide: (input: { decision: "allow" | "deny"; orgId?: string; access?: AppAccess }, app: string) => void;
  onPick: () => void;
}) {
  const auth = useAuth();
  const { i18n } = useTranslation();
  const qc = useQueryClient();
  const client = consent.request.client;
  const [orgId, setOrgId] = useState(() => defaultWorkspace(consent));
  const [access, setAccess] = useState<AppAccess>(() => requestedAccess(consent));
  const name = appName(client.name);
  const app = shownName(t, client);
  const bold =
    client.displayKind === "verified"
      ? name.short
      : client.displayKind === "https"
        ? (client.host ?? "")
        : client.displayKind === "loopback"
          ? t("apps.consent.thisComputer")
          : "Cursor";
  const canWrite = consent.request.access.requested.includes("write");
  const canManage = consent.request.access.requested.includes("manage");
  const only = consent.workspaces.length === 1 ? consent.workspaces[0] : null;
  // Every workspace paused (on hold until billing is paid, say): Permitir can't be pressed, so the page says why.
  const nonePickable = !defaultWorkspace(consent);
  const notes = workspaceNotes(t, i18n.language, consent.workspaces);
  // One being deleted is paused too, and its note says the rest.
  const named = (w: AppConsent["workspaces"][number]) =>
    workspaceLabel(w.paused && !w.deletion ? t("apps.consent.paused", { name: w.name }) : w.name, notes.get(w.id));
  return (
    <Card padded as="div" className="consent">
      <form
        className="consent"
        onSubmit={(e) => {
          e.preventDefault();
          if (orgId && !busy) onDecide({ decision: "allow", orgId, access }, app);
        }}
      >
        <Locked when={busy}>
          <div className="consent__app">
            <AppMark app={{ ...client, name: app }} size="tile" />
            <span className="list-col">
              <h1
                className="consent__title"
                title={client.displayKind === "verified" ? (name.full ?? undefined) : undefined}
              >
                <Trans
                  t={t}
                  i18nKey={`apps.consent.title.${client.displayKind}`}
                  values={{ name: bold }}
                  components={{ b: <b /> }}
                  {...TYPED_VALUES}
                />
              </h1>
              {secondLine(t, client, name) && (
                <span className="small muted" title={name.full ?? undefined}>
                  {secondLine(t, client, name)}
                </span>
              )}
            </span>
          </div>
          {client.reservedNameWarning && (
            // A program on this computer has no address above to check: the title says only "neste computador".
            <Alert>
              {t(
                client.displayKind === "loopback" ? "apps.consent.reservedNameLoopback" : "apps.consent.reservedName",
                {
                  name: name.short,
                },
              )}
            </Alert>
          )}
          <p className="consent__account small muted">
            <span>{t("apps.consent.signedInAs", consent.account)}</span>
            <button
              type="button"
              className="ac-link"
              onClick={async () => {
                await auth.signOut();
                storage.set(STORAGE_KEYS.signedOut, "1");
                qc.clear();
                window.location.assign(signInPath(window.location.pathname + window.location.search));
              }}
            >
              {t("apps.consent.switchAccount")}
            </button>
          </p>
          {only ? (
            <div className="apps-field" style={{ gap: 2 }}>
              <span className="newag__label">{t("apps.consent.workspace")}</span>
              <span>{named(only)}</span>
            </div>
          ) : (
            <Field label={t("apps.consent.workspace")} id="consent-org">
              <Select
                value={orgId}
                onValueChange={(v) => {
                  setOrgId(v);
                  onPick();
                }}
                options={consent.workspaces.map((w) => ({
                  value: w.id,
                  label: named(w),
                  disabled: w.paused,
                }))}
                // Every one paused: none can be picked, and the box says which there is instead of nothing.
                placeholder={nonePickable && consent.workspaces[0] ? named(consent.workspaces[0]) : undefined}
              />
            </Field>
          )}
          {inlineError && <Alert>{t(`apps.consent.error.${inlineError}`)}</Alert>}
          {!inlineError && nonePickable && (
            <Alert>
              {t(only ? "apps.consent.error.onlyPaused" : "apps.consent.error.allPaused")}{" "}
              <Link
                to="/org/$orgId"
                params={{ orgId: only?.id ?? consent.workspaces[0]?.id ?? "" }}
                className="ac-link"
              >
                {t("apps.consent.error.openWorkspace")}
              </Link>
            </Alert>
          )}
          <div className="apps-field" style={{ gap: 6 }}>
            <span className="newag__label" id="consent-access">
              {t("apps.consent.access")}
            </span>
            <OptionList
              aria-labelledby="consent-access"
              value={access}
              onValueChange={setAccess}
              options={[
                ...(canManage
                  ? [
                      {
                        value: "manage" as const,
                        title: t("apps.consent.manage"),
                        description: t("apps.consent.manageHelp"),
                      },
                    ]
                  : []),
                ...(canWrite
                  ? [
                      {
                        value: "write" as const,
                        title: t("apps.consent.write"),
                        description: t("apps.consent.writeHelp"),
                      },
                    ]
                  : []),
                { value: "read" as const, title: t("apps.consent.read"), description: t("apps.consent.readHelp") },
              ]}
            />
          </div>
          <div className="consent__lists">
            <div className="apps-field" style={{ gap: 8 }}>
              <span className="newag__label">{t("apps.consent.can")}</span>
              <ul className="consent__list consent__list--can small">
                <li className="ac-iconline">
                  <Icon name="check" size={16} />
                  <span>{t("apps.consent.canSee")}</span>
                </li>
                {access !== "read" && (
                  <li className="ac-iconline">
                    <Icon name="check" size={16} />
                    <span>{t("apps.consent.canSend", { app })}</span>
                  </li>
                )}
                {access === "manage" && (
                  <li className="ac-iconline">
                    <Icon name="check" size={16} />
                    <span>{t("apps.consent.canManage")}</span>
                  </li>
                )}
                <li className="ac-iconline">
                  <Icon name="check" size={16} />
                  <span>{t("apps.consent.canRead")}</span>
                </li>
              </ul>
            </div>
            <div className="apps-field" style={{ gap: 8 }}>
              <span className="newag__label">{t("apps.consent.never")}</span>
              <ul className="consent__list consent__list--never small">
                {(["neverApprove", "neverSettings", "neverHidden"] as const).map((key) => (
                  <li key={key} className="ac-iconline">
                    <Icon name="dash" size={16} />
                    <span>{t(`apps.consent.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {client.displayKind === "loopback" && <Alert tone="neutral">{t("apps.consent.loopbackWarning")}</Alert>}
          <div className="apps-field" style={{ gap: 4 }}>
            <span className="small">{t("apps.consent.startedNow")}</span>
            {/* Cursor's raw scheme: the line under the title already says where in friendly words. */}
            {client.displayKind !== "app_scheme" && (
              <span className="consent__returns small muted">
                {t("apps.consent.returnsTo", { place: visibleText(client.returnsTo) })}
              </span>
            )}
          </div>
          <div className="consent__actions">
            <Button type="button" disabled={busy} onClick={() => onDecide({ decision: "deny" }, app)}>
              {t("apps.consent.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !orgId}>
              {t("apps.consent.allow")}
            </Button>
          </div>
        </Locked>
        <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
          {t("apps.consent.footer")}
        </p>
      </form>
    </Card>
  );
}

/** The line under the title: where a verified app proved itself, or what an unverified one says it is. */
function secondLine(t: TFunction, client: AppConsent["request"]["client"], name: { short: string }) {
  if (client.displayKind === "verified")
    return client.host ? t("apps.consent.second.verified", { host: client.host }) : null;
  if (client.displayKind === "app_scheme") return t("apps.consent.second.app_scheme");
  return name.short ? t(`apps.consent.second.${client.displayKind}`, { name: name.short }) : null;
}
