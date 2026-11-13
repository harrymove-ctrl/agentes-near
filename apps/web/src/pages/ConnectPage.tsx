import type { Machine } from "@agenteschat/client";
import { ApiError, useConfirmDevice, useDenyDevice, useMachineDevice, useMe } from "@agenteschat/client";
import { workspaceLabel, workspaceNotes } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { computerKind, formatUserCode, locationText } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { Alert, Button, Card, ComputerPortrait, EmptyState, Field, Input, Locked, Select } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CenteredLayout } from "@/components/AuthLayout";
import { LoadingLine } from "@/components/Loading";
import { osOf } from "@/components/machine-bits";

/** A code the server no longer knows: expired, used, denied or never made. */
export const isGoneCode = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 404 || error.status === 410 || /expired|not_found|invalid/.test(error.code));

type Outcome =
  | { kind: "confirmed"; machine: Machine; orgId: string; orgName: string; reconnected: boolean }
  | { kind: "denied" }
  | null;

/**
 * `/conectar?code=` (ADR 0036 §5): a computer made a code; the person,
 * signed in, compares it, picks the organization and the computer's name,
 * and connects it, or says it wasn't them. One question on screen. A
 * computer coming back as the machine it was (`reconnect`, shown only to
 * people who may manage it) asks only "Reconectar o {nome}?": same
 * organization, name and permissions, and its agents use it again.
 */
export function ConnectPage({ code }: { code: string }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const device = useMachineDevice(code);
  const confirm = useConfirmDevice();
  const deny = useDenyDevice();
  const orgs = (me.data?.organizations ?? []).filter((o) => can(o, "pair_computers"));
  const [orgId, setOrgId] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = device.data;
  const reconnect =
    request?.reconnect && orgs.some((o) => o.id === request.reconnect?.orgId) ? request.reconnect : null;

  useEffect(() => {
    if (request) setName((n) => n || request.name);
  }, [request]);
  const reconnectOrg = reconnect?.orgId;
  useEffect(() => {
    if (reconnectOrg) setOrgId(reconnectOrg);
  }, [reconnectOrg]);
  useEffect(() => {
    if (!orgId && orgs[0]) setOrgId(orgs[0].id);
  }, [orgId, orgs]);
  // The code lives 10 minutes: the page says so when it runs out.
  useEffect(() => {
    if (!request || outcome) return;
    const left = Date.parse(request.expiresAt) - Date.now();
    if (Number.isNaN(left)) return;
    if (left <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), Math.min(left, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [request, outcome]);

  const fail = (err: unknown) => {
    if (isGoneCode(err)) setExpired(true);
    else setError(errorText(t, err));
  };

  if (!code) {
    return (
      <CenteredLayout narrow>
        <Card padded as="div">
          <EmptyState icon="computer" title={t("connect.title")}>
            {t("connect.missing")}
          </EmptyState>
        </Card>
      </CenteredLayout>
    );
  }

  if (outcome?.kind === "confirmed") {
    return (
      <CenteredLayout narrow>
        <Card padded as="div" className="connect-page">
          <EmptyState
            sky
            title={outcome.reconnected ? t("connect.reconnectDoneTitle") : t("connect.doneTitle")}
            actions={
              <Button asChild variant="primary">
                <Link
                  to="/org/$orgId/settings/devices/$deviceId"
                  params={{ orgId: outcome.orgId, deviceId: outcome.machine.id }}
                >
                  {t("connect.openComputer")}
                </Link>
              </Button>
            }
          >
            {t("connect.done")}
          </EmptyState>
          <p className="small muted" role="status" style={{ margin: 0, textAlign: "center" }}>
            {outcome.reconnected
              ? t("connect.reconnectDoneText", { name: outcome.machine.name, org: outcome.orgName })
              : t("connect.doneText", { name: outcome.machine.name, org: outcome.orgName })}
          </p>
        </Card>
      </CenteredLayout>
    );
  }

  if (outcome?.kind === "denied") {
    return (
      <CenteredLayout narrow>
        <Card padded as="div" className="connect-page">
          <EmptyState
            icon="block"
            title={t("connect.deniedTitle")}
            actions={
              <Button asChild>
                <Link to="/">{t("connect.home")}</Link>
              </Button>
            }
          >
            {t("connect.denied")}
          </EmptyState>
        </Card>
      </CenteredLayout>
    );
  }

  if (expired || (device.isError && isGoneCode(device.error))) {
    return (
      <CenteredLayout narrow>
        <Card padded as="div" className="connect-page">
          <EmptyState icon="waiting" title={t("connect.expiredTitle")}>
            {t("connect.expired")}
          </EmptyState>
        </Card>
      </CenteredLayout>
    );
  }

  if (device.isError) {
    return (
      <CenteredLayout narrow>
        <Card padded as="div" className="connect-page">
          <Alert>{errorText(t, device.error)}</Alert>
          <Button onClick={() => void device.refetch()}>{t("common.retry")}</Button>
        </Card>
      </CenteredLayout>
    );
  }

  if (device.isPending || me.isPending || !request) {
    return (
      <CenteredLayout narrow>
        <Card padded as="div" aria-busy="true">
          <span className="small muted">{t("connect.loading")}</span>
          <LoadingLine width={240} />
        </Card>
      </CenteredLayout>
    );
  }

  const place = locationText(request.approxLocation);
  const org = orgs.find((o) => o.id === orgId);
  const notes = workspaceNotes(t, i18n.language, me.data?.organizations ?? []);
  const busy = confirm.isPending || deny.isPending;
  return (
    <CenteredLayout narrow>
      <Card padded as="div" className="connect-page">
        <form
          className="stack-4"
          style={{ gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!org || busy) return;
            setError(null);
            const clean = reconnect ? "" : name.trim();
            confirm.mutate(
              { orgId: org.id, userCode: code, ...(clean ? { name: clean } : {}) },
              {
                onSuccess: (machine) =>
                  setOutcome({
                    kind: "confirmed",
                    machine,
                    orgId: org.id,
                    orgName: org.name,
                    reconnected: !!reconnect && machine.id === reconnect.machineId,
                  }),
                onError: fail,
              },
            );
          }}
        >
          <div className="stack-4" style={{ gap: 4 }}>
            <h1 className="page-title" style={{ margin: 0 }}>
              {reconnect ? t("connect.reconnectTitle", { name: reconnect.name }) : t("connect.title")}
            </h1>
            <span className="small muted">{reconnect ? t("connect.reconnectLead") : t("connect.lead")}</span>
          </div>
          <p className="connect-page__code" role="img" aria-label={`${t("connect.code")}: ${code}`}>
            {formatUserCode(code)}
          </p>
          <div className="connect-page__computer">
            <ComputerPortrait kind={computerKind(request.os)} state="online" />
            <span className="list-col" style={{ minWidth: 0 }}>
              <span className="machine-row__name">{request.name}</span>
              <span className="small muted">
                {t(`machines.os.${osOf(request.os)}`)} · {request.hostname}
              </span>
              {place && <span className="small muted">{t("connect.near", { place })}</span>}
              <span className="small muted">
                {t("connect.asked", { when: relativeTime(t, i18n.language, request.createdAt) })}
              </span>
            </span>
          </div>
          <Alert tone="neutral">{t("connect.warning")}</Alert>
          {reconnect ? (
            <p className="small muted" style={{ margin: 0 }}>
              {t("connect.reconnectIn", { org: reconnect.orgName })}
            </p>
          ) : orgs.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              {t("connect.noOrgs")}
            </p>
          ) : (
            <Locked when={busy}>
              <Field
                label={t("connect.org")}
                id="connect-org"
                hint={{ name: t("common.about", { label: t("connect.org") }), text: t("connect.orgHelp") }}
              >
                <Select
                  value={orgId}
                  onValueChange={setOrgId}
                  options={orgs.map((o) => ({ value: o.id, label: workspaceLabel(o.name, notes.get(o.id)) }))}
                />
              </Field>
              <Field
                label={t("machines.name")}
                id="connect-name"
                hint={{ name: t("common.about", { label: t("machines.name") }), text: t("machines.nameHelp") }}
              >
                <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </Field>
            </Locked>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="connect-page__actions">
            <Button
              type="button"
              variant="ghost"
              loading={deny.isPending}
              disabled={busy}
              onClick={() => {
                setError(null);
                deny.mutate(code, { onSuccess: () => setOutcome({ kind: "denied" }), onError: fail });
              }}
            >
              {t("connect.deny")}
            </Button>
            {orgs.length > 0 && (
              <Button type="submit" variant="primary" loading={confirm.isPending} disabled={busy || !org}>
                {reconnect ? t("connect.reconnectConfirm") : t("connect.confirm")}
              </Button>
            )}
          </div>
        </form>
      </Card>
    </CenteredLayout>
  );
}
