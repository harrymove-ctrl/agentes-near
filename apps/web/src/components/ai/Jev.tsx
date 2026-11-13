import type { AiRouting, JevKey } from "@agenteschat/client";
import {
  useAiStatus,
  useCheckJevKey,
  useJevKey,
  useModelLabel,
  useRemoveJevKey,
  useSaveJevKey,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatDecimal, formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { routingLineOf } from "@agenteschat/client/lib/routing";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  type ChipTone,
  Dialog,
  DialogFooter,
  Icon,
  type IconName,
  InfoHint,
  Input,
  List,
  Locked,
  ProviderLogo,
  SettingNote,
} from "@agenteschat/ui";
import { useRouterState } from "@tanstack/react-router";
import { Fragment, type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpLink } from "@/components/HelpLink";
import { useOrg } from "@/components/org-context";
import { OpenPage, Step, StepTitle } from "./AddAccountFlow";

/*
 * Who picks the agents for a message nobody mentioned (ADR 0074), and Jev on a self-hosted server (ADR 0073):
 * Settings › AI accounts says who picks now, and the installation's owner sets up Jev's key under it. The setup
 * asks for the same key once, with the same steps.
 */

/** TypeSafe's console: where an account is made and credit is added, and where its keys are made. */
const TYPESAFE_CONSOLE = "https://console.typesafe.ai";
const TYPESAFE_KEYS = `${TYPESAFE_CONSOLE}/keys`;
/** What Jev costs (US$): per million tokens it reads, and about one pick of who answers. */
const JEV_PRICE = 0.042;
const JEV_CALL = 0.0001;
/** Save is on from this length: TypeSafe publishes no format for its keys, and the server checks each with it. */
export const JEV_KEY_MIN = 8;

/**
 * Why Jev helps: three reasons, each a quiet icon, the reason in bold and a few words. Where the server's router is off
 * (`routing` "off"), nothing picks who answers, so that reason is left out.
 */
export function JevWhy({ routing }: { routing?: AiRouting["by"] }) {
  const { t } = useTranslation();
  const reasons: [IconName, "route" | "memory" | "screen"][] = [
    ["agent", "route"],
    ["bulb", "memory"],
    ["eye", "screen"],
  ];
  return (
    <ul className="jev-why">
      {reasons
        .filter(([, why]) => why !== "route" || routing !== "off")
        .map(([icon, why]) => (
          <li key={why} className="ac-iconline">
            <Icon name={icon} size={16} />
            <span>
              <b>{t(`jev.why.${why}`)}</b> <span className="muted">{t(`jev.why.${why}Text`)}</span>
            </span>
          </li>
        ))}
    </ul>
  );
}

/**
 * The steps to Jev's key: a TypeSafe account with credit, a key, and the key pasted here. `replace` leaves the first
 * out (an account exists). `onSave` and `onCancel` give the field its own buttons (Settings); the setup's big button
 * saves instead.
 */
export function JevSteps({
  replace,
  value,
  onChange,
  error,
  saved,
  onSave,
  saving,
  onCancel,
}: {
  replace?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Under the field, in place of where the key is kept: why it wasn't saved. */
  error?: string | null;
  /** Saved, with a line to say so (a key whose account has no credit yet). */
  saved?: string | null;
  onSave?: () => void;
  saving?: boolean;
  onCancel?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const field = `${id}-key`;
  const below = `${id}-below`;
  const key = value.trim();
  // The way on is the first button until a key is typed.
  const first = key === "";
  const n = replace ? 0 : 1;
  return (
    <div className="agp-addacct jev-steps">
      {!replace && (
        <Step
          n={1}
          side={
            <OpenPage href={TYPESAFE_CONSOLE} primary={first}>
              {t("jev.steps.openSite")}
            </OpenPage>
          }
        >
          <StepTitle
            title={t("jev.steps.account")}
            hint={t("jev.steps.accountHint", {
              price: formatDecimal(i18n.language, JEV_PRICE),
              call: formatDecimal(i18n.language, JEV_CALL),
            })}
          />
        </Step>
      )}
      <Step
        n={n + 1}
        side={
          <OpenPage href={TYPESAFE_KEYS} primary={replace && first}>
            {t("jev.steps.openKeys")}
          </OpenPage>
        }
      >
        <StepTitle title={t("jev.steps.key")} />
      </Step>
      <Step n={n + 2}>
        <StepTitle title={t("jev.steps.paste")} htmlFor={field} />
        <span className="agp-addacct__paste">
          <Locked when={Boolean(saving)}>
            <Input
              id={field}
              type="password"
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("jev.steps.placeholder")}
              // Settings opens the steps in place of the button pressed: the field takes the focus.
              autoFocus={Boolean(onCancel)}
              invalid={Boolean(error)}
              aria-describedby={below}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !onSave) return;
                e.preventDefault();
                if (key.length >= JEV_KEY_MIN && !saving) onSave();
              }}
            />
          </Locked>
          {onSave && (
            <Button variant="primary" disabled={key.length < JEV_KEY_MIN} loading={saving} onClick={onSave}>
              {t("settings.saveKey")}
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
        </span>
        <p id={below} className={error ? "jev-steps__below ac-field__error" : "jev-steps__below ac-field__example"}>
          {error ?? t("jev.steps.sealed")}
        </p>
        {saved && (
          <SettingNote icon="check" live>
            {saved}
          </SettingNote>
        )}
      </Step>
    </div>
  );
}

/**
 * Settings › AI accounts, after Provider keys: who picks the agents for a message nobody mentioned, for admins, and
 * under it Jev's key for the installation's owner on a self-hosted server (the API answers null to everyone else).
 */
export function WhoPicksSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_credentials");
  const jev = useJevKey();
  // The server's owner gets Jev's card where they aren't an admin too, and its reasons follow who picks.
  const status = useAiStatus(org.id, admin || Boolean(jev.data));
  const modelLabel = useModelLabel();
  const line = admin ? routingLineOf(status.data, modelLabel) : null;
  if (!line && !jev.data) return null;
  return (
    <Card aria-labelledby="sec-routing" className="who-card">
      <CardHeader
        id="sec-routing"
        icon="agent"
        title={t("routing.title")}
        action={<HelpLink slug="who-answers">{t("routing.how")}</HelpLink>}
      />
      {line && <p className="who-line">{t(line.key, line.params)}</p>}
      {line && status.data?.reflection === false && <p className="who-line">{t("routing.reflectionOff")}</p>}
      {jev.data && <JevCard routing={status.data?.routing?.by} />}
    </Card>
  );
}

const CHIP: Record<
  JevKey["state"],
  { icon?: IconName; tone?: ChipTone; word: "off" | "on" | "invalid" | "no_credit" }
> = {
  off: { word: "off" },
  ok: { icon: "check", tone: "done", word: "on" },
  invalid: { icon: "alert", tone: "waiting", word: "invalid" },
  no_credit: { icon: "alert", tone: "waiting", word: "no_credit" },
};

/** Jev's key: why it helps and the steps while there's none; the key's last 4, this month's use and its state once set. */
function JevCard({ routing }: { routing?: AiRouting["by"] }) {
  const { t, i18n } = useTranslation();
  // Read here rather than handed down: a save or a removal shows its key at once, so focus lands on what stays.
  const view = useJevKey().data;
  const save = useSaveJevKey();
  const check = useCheckJevKey();
  const remove = useRemoveJevKey();
  const [steps, setSteps] = useState<null | "set" | "replace">(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const box = useRef<HTMLElement>(null);
  // The steps open in place of the button pressed and close into the card as it is now: focus goes back to its way in
  // ("Configurar o Jev", "Trocar a chave"), or to the card, never to the page.
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (opener.current ?? box.current)?.focus();
  });
  const hash = useRouterState({ select: (s) => s.location.hash });
  // `?open=jev` (the desktop app's row) lands here: brought into view and focused.
  useEffect(() => {
    if (hash !== "jev") return;
    box.current?.scrollIntoView?.({ block: "start" });
    box.current?.focus({ preventScroll: true });
  }, [hash]);
  if (!view) return null;
  const env = view.source === "env";
  const chip = CHIP[view.state];
  const close = () => {
    setSteps(null);
    setDraft("");
    setError(null);
    refocus.current = true;
  };
  const submit = () => save.mutate(draft.trim(), { onSuccess: close, onError: (e) => setError(errorText(t, e)) });
  const stepsOf = (replace: boolean) => (
    <JevSteps
      replace={replace}
      value={draft}
      onChange={(v) => {
        setDraft(v);
        setError(null);
      }}
      error={error}
      onSave={submit}
      saving={save.isPending}
      onCancel={close}
    />
  );
  const site =
    view.state === "invalid" ? (
      <OpenPage href={TYPESAFE_KEYS}>{t("jev.steps.openKeys")}</OpenPage>
    ) : view.state === "no_credit" ? (
      <OpenPage href={TYPESAFE_CONSOLE}>{t("jev.steps.openSite")}</OpenPage>
    ) : null;
  const ghost = (
    label: string,
    onClick: () => void,
    extra?: { danger?: boolean; loading?: boolean; ref?: Ref<HTMLButtonElement> },
  ) => (
    <Button
      ref={extra?.ref}
      size="sm"
      variant="ghost"
      className={extra?.danger ? "ac-btn--danger" : undefined}
      loading={extra?.loading}
      disabled={extra?.loading}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  // What the owner can do: only the console where the key comes from `.env`.
  const actions: ReactNode = env ? (
    site
  ) : view.state === "invalid" ? (
    <>
      {site}
      {ghost(t("settings.rotate"), () => setSteps("replace"), { ref: opener })}
    </>
  ) : view.state === "no_credit" ? (
    <>
      {site}
      {ghost(t("jev.checkAgain"), () => check.mutate(), { loading: check.isPending })}
    </>
  ) : (
    <>
      {ghost(t("settings.rotate"), () => setSteps("replace"), { ref: opener })}
      {ghost(t("settings.remove"), () => setRemoving(true), { danger: true })}
    </>
  );
  const note = env
    ? view.state === "invalid"
      ? t("jev.line.envInvalid")
      : t("jev.line.env")
    : view.state === "invalid" || view.state === "no_credit"
      ? t(`jev.line.${view.state}`)
      : null;
  const facts = [
    view.hint && t("settings.keyEndsIn", { hint: view.hint }),
    view.month.decisions > 0 &&
      t("jev.month", { count: view.month.decisions, cost: formatUsd(i18n.language, view.month.costUsd) }),
  ].filter(Boolean);

  return (
    <section id="jev" ref={box} tabIndex={-1} className="jev" aria-labelledby="jev-title">
      <List>
        <div className="ac-list__row jev__head ac-mediarow ac-mediarow--row">
          <span className="ac-mediarow__face">
            <ProviderLogo id="typesafe" size="sm" />
          </span>
          <span className="ac-mediarow__head">
            <span className="ac-hintline">
              <h3 id="jev-title" className="jev__title">
                {t("jev.title")}
              </h3>
              <InfoHint name={t("common.about", { label: t("jev.title") })}>{t("jev.about")}</InfoHint>
            </span>
          </span>
          <span className="ac-mediarow__end">
            <Chip icon={chip.icon} tone={chip.tone}>
              {t(`jev.state.${chip.word}`)}
            </Chip>
          </span>
          <span className="ac-mediarow__body small muted">{t("jev.lead")}</span>
        </div>
        {view.source === null ? (
          <div className="ac-list__row jev__body">
            <JevWhy routing={routing} />
            {steps ? (
              stepsOf(false)
            ) : (
              <Button ref={opener} size="sm" variant="primary" onClick={() => setSteps("set")}>
                {t("jev.setUp")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="ac-list__row jev__key">
              <span className="list-col">
                <span className="ai-accounts__name">{t("jev.keyName")}</span>
                <span className="small muted">
                  {facts.map((fact, i) => (
                    <Fragment key={String(fact)}>
                      {i > 0 && " · "}
                      <span className="jev__fact">{fact}</span>
                    </Fragment>
                  ))}
                </span>
                {note && <SettingNote icon={view.state === "ok" ? "info" : "alert"}>{note}</SettingNote>}
              </span>
              {actions && <span className="ac-acts ac-captail">{actions}</span>}
            </div>
            {steps === "replace" && <div className="ac-list__row jev__body">{stepsOf(true)}</div>}
          </>
        )}
      </List>
      <p className="jev__foot">
        <HelpLink slug="jev">{t("jev.how")}</HelpLink>
      </p>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("jev.remove.title")}
        description={t("jev.remove.text")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setRemoving(false);
                  close();
                },
              })
            }
          >
            {t("settings.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
