import {
  ApiError,
  invitationQuery,
  type SignInOptions,
  type SignInProvider,
  useApi,
  useAuthConfig,
} from "@agenteschat/client";
import {
  ACCOUNT_NOT_LINKED,
  authErrorText,
  EARLY_ACCESS_OTHER_EMAIL,
  errorText,
  signInRefusalText,
} from "@agenteschat/client/lib/errors";
import { signInFor } from "@agenteschat/client/lib/guards";
import { type HumanAction, isHumanCheckRefusal, withHumanCheck } from "@agenteschat/client/lib/human-check";
import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";
import {
  emailTypoFix,
  isEmail,
  looksLikePassword,
  nameIsPassword,
  passwordState,
  webmailOf,
} from "@agenteschat/client/lib/text";
import { Button, Icon, Input, Locked } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { prepareBurst } from "@/components/Sky";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/components/SocialButtons";
import {
  browserSignInUrl,
  challengeOf,
  desktopPicksServer,
  inDesktopApp,
  newVerifier,
  SIGNED_IN_PATH,
  thisMac,
} from "@/lib/desktop";
import { useHumanCheck } from "@/lib/human-check";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";

/**
 * Sign in and sign up in one flow: the e-mail
 * first, then the one next step the server says it needs (the password, the
 * provider the account signs in with, or the name and a new password).
 * "Esqueci a senha" happens in place. The agent reacts to what you do.
 * In the Mac app, Google/GitHub/Apple open in the browser and the window
 * waits for the sign-in to come back ("browser", ADR 0036). On the server the
 * app runs on this computer, its owner has no password: "Continue on this Mac"
 * asks the app, which signs them in (ADR 0060 §6).
 */
type Step =
  | "email"
  | "password"
  | "social"
  | "noPassword"
  | "name"
  | "newPassword"
  | "closed"
  | "expired"
  | "forgot"
  /** "Forgot password" on a server that sends no email: the way back in, said (ADR 0158). */
  | "forgotHere"
  | "sent"
  | "browser"
  | "ownerWaits";

/** The steps that send something a bot could flood, and what their bot check is for (ADR 0075). */
const STEP_ACTIONS: Partial<Record<Step, HumanAction>> = {
  email: "email-lookup",
  password: "sign-in",
  newPassword: "sign-up",
  forgot: "password-reset",
};

/** How often the Mac app's window asks whether the browser finished, and for how long. */
const REDEEM_EVERY_MS = 2000;
const REDEEM_FOR_MS = 10 * 60_000;

/** Help under a new password, live: what's missing, or "Senha ok." */
export function passwordHelp(t: TFunction, password: string) {
  const state = passwordState(password);
  if (state === "empty") return { text: t("auth.passwordHelp"), invalid: false };
  if (state === "ok") return { text: t("auth.passwordOk"), invalid: false };
  if (state === "long") return { text: t("auth.passwordTooLong"), invalid: true };
  return { text: t("auth.passwordMissing", { count: 8 - password.length }), invalid: true };
}

/** A new password's help: one pixel per character up to the 8 needed, then "Senha ok." */
export function PasswordHelp({ password }: { password: string }) {
  const { t } = useTranslation();
  const help = passwordHelp(t, password);
  const ok = passwordState(password) === "ok";
  return (
    <span className={help.invalid ? "auth__help auth__help--bad" : ok ? "auth__help auth__help--ok" : "auth__help"}>
      <span className="auth__meter" aria-hidden="true" data-done={ok || undefined}>
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: eight fixed cells
          <i key={i} data-on={i < password.length || undefined} />
        ))}
      </span>
      {help.text}
    </span>
  );
}

/** Under a name step's field: a soft line, never a block, when what's typed there looks like a password. */
export function NameHint({ name }: { name: string }) {
  const { t } = useTranslation();
  if (!looksLikePassword(name)) return null;
  return (
    <span className="auth__help" role="status">
      {t("auth.flow.nameLooksLikePassword")}
    </span>
  );
}

export function AuthPage({
  start,
  redirect,
  email: initialEmail,
  access,
  refused,
}: {
  start: "in" | "up";
  redirect?: string;
  email?: string;
  /** An early-access link's token (`/signup?access=`): it opens sign-up for the address it was sent to. */
  access?: string;
  /**
   * The code of a provider sign-in that didn't finish or the server refused (`/login?error=`), said in the person's
   * words. An unconfirmed password account's comes with its address in `email`, to make a new password from here.
   */
  refused?: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useAuthConfig();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const canReset = config.data?.passwordReset === true;
  const refusal = refused ? signInRefusalText(t, refused, canReset) : null;
  const [error, setError] = useState<string | null>(refusal);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [passFocus, setPassFocus] = useState(false);
  const [wink, setWink] = useState(false);
  const [demoSigningIn, setDemoSigningIn] = useState<string | null>(null);
  const zenPersonas = useQuery<{
    enabled: boolean;
    workspace: string;
    personas: Array<{
      id: string;
      name: string;
      email: string;
      roleBadge: string;
      epicFocus: string;
      handle: string;
    }>;
  }>({
    queryKey: ["zen-personas"],
    queryFn: async () => {
      const res = await fetch("/api/zen/personas", { credentials: "include" });
      if (!res.ok) return { enabled: false, workspace: "", personas: [] };
      return res.json();
    },
  });

  const signInZenPersona = async (personaEmail: string) => {
    setDemoSigningIn(personaEmail);
    setError(null);
    try {
      const res = await fetch("/api/auth/zen-demo-login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: personaEmail }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(payload?.message ?? `Demo sign-in failed (${res.status})`);
        return;
      }
      qc.clear();
      window.location.assign(redirect ?? "/");
    } catch (e) {
      fail(e);
    } finally {
      setDemoSigningIn(null);
    }
  };
  const header = useRef<HTMLElement>(null);
  const human = useHumanCheck(config.data?.ownerClaim ? null : (STEP_ACTIONS[step] ?? null));
  const linkedProviders = useSocialProviders(options?.providers);
  const allProviders = useSocialProviders();
  const termsUrl = config.data?.termsUrl;
  const privacyUrl = config.data?.privacyUrl;
  const desktop = inDesktopApp();
  // Where this sign-in leads, in place of the general line, read from the address alone: only what the page before
  // already showed (an invitation's workspace, by its token; the ready email's Connect your AI or Create an agent).
  const goal = signInFor(redirect);
  const invite = goal && "invite" in goal ? goal.invite : "";
  const invitation = useQuery({ ...invitationQuery(api, invite), enabled: invite !== "" });
  const joining = invitation.data && !invitation.data.closed ? invitation.data : null;
  const purpose =
    goal && "connect" in goal
      ? t("auth.flow.toConnectAi")
      : goal && "create" in goal
        ? t("auth.flow.toCreateAgent")
        : goal && "authorize" in goal
          ? t("auth.flow.toAuthorizeApp")
          : joining
            ? t(joining.kind === "link" ? "auth.flow.toAsk" : "auth.flow.toJoin", { org: joining.orgName })
            : null;
  const [browser, setBrowser] = useState<{
    provider: SignInProvider;
    verifier: string;
    requestId: string;
    code: string;
  } | null>(null);
  // This server runs inside the app here: the app signs its owner in.
  const [local, setLocal] = useState(false);
  // In the app, until it said whether this is its own server: the provider buttons wait, never shown then taken away.
  const [placeKnown, setPlaceKnown] = useState(!desktop);
  const [ownerPending, setOwnerPending] = useState(false);
  // The server the app runs on this computer: its owner signs in with Continue on this Mac, and a provider's sign-in
  // needs an address registered with that provider, which a computer's own server doesn't have.
  const offeredProviders = local || !placeKnown ? [] : allProviders;
  useEffect(() => {
    if (!desktop) return;
    void thisMac
      .status()
      .then((s) => setLocal(s.local === true))
      .catch(() => {})
      .finally(() => setPlaceKnown(true));
  }, [desktop]);
  const continueHere = async () => {
    setOwnerPending(true);
    setError(null);
    try {
      // The app moves this window to the sign-in it made; nothing to do here after.
      await thisMac.signIn();
    } catch {
      setError(t("common.unknownError"));
      setOwnerPending(false);
    }
  };
  // The owner's session ended (it expired, or this window never had one) on the server the app runs here: the app
  // signs them in again at once, as Continue on this Mac does. Not after Sign out by hand, nor when the page came for
  // something else (an invitation, a provider's refusal, an address to sign in with): the screen waits then.
  const ownerAgain = local && start === "in" && !refused && !goal && !initialEmail;
  const ownerTried = useRef(false);
  useEffect(() => {
    if (!ownerAgain || ownerTried.current || storage.get(STORAGE_KEYS.signedOut) === "1") return;
    ownerTried.current = true;
    setOwnerPending(true);
    // Refused (too soon after another, the server not up yet): the screen stays, its button one click away.
    void thisMac.signIn().catch(() => setOwnerPending(false));
  }, [ownerAgain]);

  const go = (next: Step) => {
    setError(null);
    setWrong(false);
    setShow(false);
    setStep(next);
  };

  // A provider's refusal still in view says nothing against the address in the field. An unconfirmed account's has its
  // address, and on a server that emails, a new password is a click away. Never a new confirmation: that would keep
  // the password of whoever made the account (ADR 0006).
  const providerRefused = refusal !== null && error === refusal;
  const offerReset = providerRefused && refused === ACCOUNT_NOT_LINKED && canReset && isEmail(email);

  const fail = (e: unknown) =>
    setError(e instanceof ApiError && e.status === 429 ? t("auth.tooManyTries") : errorText(t, e));

  /** Who is this e-mail: the next step follows from the server's answer. */
  const lookUp = async (value = email) => {
    setPending(true);
    setError(null);
    try {
      const found = await withHumanCheck(human.check, (token) =>
        api.account.signInOptions({ email: value.trim(), ...(access ? { access } : {}) }, token),
      );
      setOptions(found);
      setPassword("");
      if (found.account) go(found.password ? "password" : found.providers.length > 0 ? "social" : "noPassword");
      else go(found.canSignUp ? "name" : found.accessExpired ? "expired" : "closed");
    } catch (e) {
      fail(e);
    } finally {
      setPending(false);
    }
  };

  // Came with the e-mail (an invitation's "Entrar"): straight to the next step. Back from a refused provider, the
  // refusal stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the e-mail in the link
  useEffect(() => {
    if (initialEmail && isEmail(initialEmail) && !refused) void lookUp(initialEmail);
  }, []);

  // `to` is a path with its query (an email's `?open=`, `?connect=ai`): an href, not a route. One under /api/ (an
  // OAuth callback that waited for this sign-in) is the server's: a full load.
  const enter = async (to: string) => {
    prepareBurst(header.current ?? document.body)();
    qc.clear();
    if (to.startsWith("/api/")) return window.location.assign(to);
    await navigate({ href: to });
  };

  const signIn = async () => {
    setPending(true);
    setError(null);
    const result = await withHumanCheck(human.check, (token) => auth.signIn({ email: email.trim(), password }, token));
    setPending(false);
    if (!result.ok) {
      setWrong(result.status === 401);
      // Checked by code: a refused origin is a 403 too, and its own words tell an admin what to fix.
      setError(result.status === 401 ? null : authErrorText(t, result));
      return;
    }
    rememberSignIn("email");
    await enter(redirect ?? "/");
  };

  const signUp = async () => {
    setPending(true);
    setError(null);
    const result = await withHumanCheck(human.check, (token) =>
      auth.signUp({ name: name.trim(), email: email.trim(), password, ...(access ? { access } : {}) }, token),
    );
    setPending(false);
    if (!result.ok) {
      // The bot check's 403 and an early-access link for another address say so by their codes: only another 403
      // means sign-up is closed.
      if (result.status === 403 && !isHumanCheckRefusal(result.code) && result.code !== EARLY_ACCESS_OTHER_EMAIL)
        return go("closed");
      setError(authErrorText(t, result));
      return;
    }
    rememberSignIn("email");
    // A server that sends email sent this address a link to confirm it: the onboarding says where it went.
    if (canReset) sessionStore.set(STORAGE_KEYS.confirmationSent, email.trim().toLowerCase());
    await enter(redirect ?? "/onboarding");
  };

  const sendReset = async () => {
    setPending(true);
    setError(null);
    const result = await withHumanCheck(human.check, (token) =>
      auth.requestPasswordReset({ email: email.trim(), redirectTo: `${window.location.origin}/reset-password` }, token),
    );
    setPending(false);
    if (!result.ok) {
      setError(authErrorText(t, result));
      return;
    }
    go("sent");
  };

  const ready =
    step === "email" || step === "forgot"
      ? isEmail(email)
      : step === "password"
        ? password.length > 0
        : step === "name"
          ? name.trim().length > 0
          : step === "newPassword"
            ? passwordState(password) === "ok"
            : false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || pending) return;
    if (step === "email") void lookUp();
    else if (step === "password") void signIn();
    else if (step === "name") go("newPassword");
    else if (step === "newPassword" && nameIsPassword(name, password)) {
      // The name step got the password: no account with a password for a name.
      setPassword("");
      go("name");
      setError(t("auth.flow.nameIsPassword"));
    } else if (step === "newPassword") void signUp();
    else if (step === "forgot") void sendReset();
  };

  /** The Mac app: the provider in the browser; this window keeps the verifier, shows the code and waits. */
  const signInInBrowser = async (provider: SignInProvider) => {
    const verifier = newVerifier();
    const challenge = await challengeOf(verifier);
    const opened = await auth.desktopOpen(challenge).catch(() => null);
    if (!opened) return;
    setBrowser({ provider, verifier, requestId: opened.requestId, code: opened.code });
    go("browser");
    window.location.assign(browserSignInUrl(provider, opened.requestId, access));
  };
  const reopenBrowser = () => {
    if (browser) window.location.assign(browserSignInUrl(browser.provider, browser.requestId, access));
  };

  // Asks every 2 s and whenever the window comes back to the front; a full load after, so everything starts signed in.
  useEffect(() => {
    if (step !== "browser" || !browser) return;
    let stopped = false;
    const check = async () => {
      if (stopped || !(await auth.desktopRedeem(browser.verifier).catch(() => false)) || stopped) return;
      // The code is matched in the browser, so once the session arrives the window just loads signed in.
      stopped = true;
      window.location.assign(`${SIGNED_IN_PATH}?${new URLSearchParams({ to: redirect ?? "/" })}`);
    };
    const timer = setInterval(() => void check(), REDEEM_EVERY_MS);
    const giveUp = setTimeout(() => clearInterval(timer), REDEEM_FOR_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(giveUp);
      window.removeEventListener("focus", onFocus);
    };
  }, [step, browser, auth, redirect]);

  const capsKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  const toggleShow = () => {
    setShow((s) => !s);
    if (!show) {
      setWink(true);
      setTimeout(() => setWink(false), 900);
    }
  };

  // The agent: eyes shut while you type a hidden password, a wink when you show it, a frown when it's wrong.
  const secret = (step === "password" || step === "newPassword") && passFocus && !show;
  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : step === "sent" ? "happy" : undefined;

  const first = name.trim().split(/\s+/)[0] ?? "";
  const providerNames = linkedProviders.map((p) => t(`auth.provider.${p}`)).join(" · ");
  // A step with nothing to add under its question has no lead: the field and its help line say the rest.
  const bubble: Record<Step, [string, string?]> = {
    email: start === "up" ? [t("auth.flow.emailUp")] : [t("auth.flow.email"), purpose ?? t("auth.flow.emailLead")],
    password: wrong ? [t("auth.flow.wrong")] : [t("auth.flow.password"), purpose ?? t("auth.flow.passwordLead")],
    social: [t("auth.flow.social", { providers: providerNames }), t("auth.flow.socialLead")],
    noPassword: [t("auth.flow.noPassword"), local ? t("auth.desktopOwner.text") : t("auth.flow.noPasswordLead")],
    name: [t("auth.flow.name"), t("auth.flow.nameLead")],
    newPassword: [first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword")],
    closed: [t("auth.flow.closed"), t("auth.flow.closedLead")],
    expired: [
      t("auth.flow.expired"),
      config.data?.supportEmail
        ? t("auth.flow.expiredLead", { email: config.data.supportEmail })
        : t("auth.flow.expiredLeadAsk"),
    ],
    forgot: [t("auth.flow.forgot"), t("auth.flow.forgotLead")],
    forgotHere: local
      ? [t("auth.forgotHere.ownerTitle"), t("auth.forgotHere.ownerLead")]
      : [t("auth.forgotHere.title"), t("auth.forgotHere.lead")],
    sent: [t("auth.flow.sent", { email: email.trim() }), t("auth.flow.sentLead")],
    browser: [
      t("auth.desktop.browser"),
      t("auth.desktop.browserLead", { provider: browser ? t(`auth.provider.${browser.provider}`) : "" }),
    ],
    ownerWaits: [t("auth.flow.ownerWaits"), t("auth.flow.ownerWaitsLead")],
  };
  // No account yet, and only the installer's owner link makes the first one: nothing to sign in to here.
  const shown: Step = config.data?.ownerClaim ? "ownerWaits" : step;
  const [title, lead] = bubble[shown];

  const fix = step === "email" || step === "forgot" ? emailTypoFix(email) : null;
  const help = passwordHelp(t, password);
  const mail = webmailOf(email);
  const who = step !== "email" && step !== "forgot" && step !== "sent" && (
    <span className="auth__who">
      <Icon name="mail" size={14} />
      <span className="auth__who-email">{email.trim()}</span>
      <button type="button" className="auth__who-change" onClick={() => go("email")}>
        {t("auth.flow.change")}
      </button>
    </span>
  );

  // In the desktop app, which server this signs in to, on every step, with Change (the app's window of servers): the
  // app keeps several, and the same screen on another one looks the same (ADR 0158).
  const here = window.location.origin;
  const serverLine = desktopPicksServer() && placeKnown && (
    <span className="auth__who auth__server">
      <Icon name={local ? "computer" : here === CLOUD_SERVER ? "cloud" : "globe"} size={14} />
      <span className="auth__who-email">
        {local ? (
          <Trans i18nKey="auth.server.intoHere" components={{ b: <b /> }} />
        ) : (
          <Trans
            i18nKey="auth.server.into"
            values={{ server: here === CLOUD_SERVER ? "agentes.chat" : serverHost(here) }}
            components={{ b: <b /> }}
          />
        )}
      </span>
      <button type="button" className="auth__who-change" onClick={() => void thisMac.otherServer().catch(() => {})}>
        {t("auth.flow.change")}
      </button>
    </span>
  );

  const passwordInput = (fresh: boolean) => (
    <div className="auth__pass">
      <Input
        className="auth__big"
        type={show ? "text" : "password"}
        aria-label={fresh ? t("invite.createPassword") : t("auth.password")}
        autoComplete={fresh ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setWrong(false);
        }}
        onKeyDown={capsKey}
        onKeyUp={capsKey}
        onFocus={() => setPassFocus(true)}
        onBlur={() => setPassFocus(false)}
        invalid={wrong || (fresh && help.invalid)}
        autoFocus
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        iconOnly
        icon={show ? "eyeOff" : "eye"}
        aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
        aria-pressed={show}
        className="auth__eye"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleShow}
      />
    </div>
  );

  const capsNote = caps && passFocus && (
    <span className="auth__caps">
      <Icon name="arrowUp" size={14} />
      {t("auth.capsLock")}
    </span>
  );

  const submitLabel: Partial<Record<Step, string>> = {
    email: t("auth.flow.continue"),
    password: t("auth.signIn"),
    name: t("auth.flow.continue"),
    newPassword: t("auth.createAccount"),
    forgot: t("auth.flow.sendLink"),
  };

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        {serverLine}
        <header className="auth__ask" ref={header} data-burst>
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={pending || step === "browser" ? "writing" : undefined}
            expression={expression}
          />
          <div className="auth__bubble" key={`${shown}-${wrong}`} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            {lead && <p className="auth__lead">{lead}</p>}
          </div>
        </header>

        {shown !== "ownerWaits" && (
          <div className="auth__step" key={shown}>
            <Locked when={pending || ownerPending}>
              {who}

              {local && (step === "email" || step === "noPassword") && (
                <>
                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    block
                    loading={ownerPending}
                    onClick={() => void continueHere()}
                  >
                    {t("auth.desktopOwner.continue")}
                  </Button>
                  {step === "email" && (
                    <>
                      <p className="auth__fine">{t("auth.desktopOwner.text")}</p>
                      <div className="auth__or">{t("common.or")}</div>
                    </>
                  )}
                </>
              )}

              {step === "email" && zenPersonas.data?.enabled && zenPersonas.data.personas.length > 0 && (
                <div
                  data-testid="zen-persona-card"
                  style={{
                    border: "1px solid var(--ac-line)",
                    borderRadius: 12,
                    padding: "12px 14px",
                    marginBottom: 12,
                    background: "var(--ac-surface)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <Icon name="shield" size={16} />
                      <span>Ergo (Codename ZEN) · Instant PoC Sign-In</span>
                    </div>
                    <a
                      href="/updates"
                      style={{ fontSize: 12, fontWeight: 550, color: "var(--ac-ink)", textDecoration: "underline" }}
                    >
                      Updates v0.3.0
                    </a>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ac-ink-soft)" }}>
                    Jump straight into <strong>{zenPersonas.data.workspace}</strong> (100% local PGlite + ML-DSA-65
                    provenance) to review Epics E1..E16 and Tech Lead decisions D1..D9:
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {zenPersonas.data.personas.map((p) => (
                      <Button
                        key={p.id}
                        type="button"
                        size="md"
                        variant={p.handle === "harry" ? "primary" : "default"}
                        block
                        data-testid={`zen-login-${p.handle}`}
                        loading={demoSigningIn === p.email}
                        disabled={demoSigningIn !== null}
                        onClick={() => void signInZenPersona(p.email)}
                      >
                        {p.name} · {p.roleBadge}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {(step === "email" || step === "forgot") && (
                <div className="auth__field">
                  <Input
                    className="auth__big"
                    type="email"
                    inputMode="email"
                    aria-label={t("auth.email")}
                    autoComplete="email"
                    placeholder={t("auth.flow.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    invalid={error !== null && !providerRefused}
                    autoFocus
                  />
                  {fix && (
                    <button type="button" className="auth__fix" onClick={() => setEmail(fix)}>
                      {t("auth.flow.didYouMean", { email: fix })}
                    </button>
                  )}
                </div>
              )}

              {step === "password" && (
                <div className="auth__field">
                  {passwordInput(false)}
                  {capsNote}
                </div>
              )}

              {step === "name" && (
                <div className="auth__field">
                  <Input
                    className="auth__big"
                    aria-label={t("auth.yourName")}
                    autoComplete="name"
                    spellCheck={false}
                    placeholder={t("auth.flow.namePlaceholder")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                  {!error && <NameHint name={name} />}
                </div>
              )}

              {step === "newPassword" && (
                <div className="auth__field">
                  {passwordInput(true)}
                  <PasswordHelp password={password} />
                  {capsNote}
                </div>
              )}

              {submitLabel[step] && human.slot}

              {error && (
                <p className="auth__error ac-iconline" role="alert">
                  <Icon name="alert" size={14} />
                  {offerReset ? (
                    <span>
                      {error}
                      <br />
                      <button type="button" className="ac-link" onClick={() => go("forgot")}>
                        {t("auth.unconfirmedReset")}
                      </button>
                    </span>
                  ) : (
                    error
                  )}
                </p>
              )}

              {submitLabel[step] && (
                <Button
                  type="submit"
                  variant={local && step === "email" ? "default" : "primary"}
                  size="lg"
                  block
                  kbd={["↵"]}
                  loading={pending}
                  disabled={!ready}
                >
                  {submitLabel[step]}
                </Button>
              )}

              {step === "email" && offeredProviders.length > 0 && (
                <>
                  <div className="auth__or">{t("common.or")}</div>
                  <SocialButtons
                    callbackURL={redirect ?? "/"}
                    providers={offeredProviders}
                    onSocial={desktop ? (p) => void signInInBrowser(p) : undefined}
                    earlyAccess={access}
                  />
                </>
              )}

              {step === "password" && (
                <button type="button" className="auth__quiet" onClick={() => go(canReset ? "forgot" : "forgotHere")}>
                  {t("auth.forgotPassword")}
                </button>
              )}

              {step === "social" && (
                <>
                  <SocialButtons
                    callbackURL={redirect ?? "/"}
                    providers={linkedProviders}
                    onSocial={desktop ? (p) => void signInInBrowser(p) : undefined}
                  />
                  <button type="button" className="auth__quiet" onClick={() => go(canReset ? "forgot" : "forgotHere")}>
                    {t("auth.flow.createPassword")}
                  </button>
                </>
              )}

              {step === "browser" && (
                <>
                  {browser && (
                    <div className="auth__code">
                      <span className="auth__codeValue">{browser.code}</span>
                      <p className="auth__fine">{t("auth.desktop.codeHint")}</p>
                    </div>
                  )}
                  <Button type="button" size="lg" block onClick={reopenBrowser}>
                    {t("auth.desktop.reopen")}
                  </Button>
                  <button type="button" className="auth__quiet" onClick={() => go("email")}>
                    {t("auth.desktop.otherWay")}
                  </button>
                </>
              )}

              {(step === "closed" || step === "expired" || step === "noPassword") && (
                <Button type="button" size="lg" block onClick={() => go("email")}>
                  {t("auth.flow.otherEmail")}
                </Button>
              )}

              {step === "forgotHere" &&
                (local ? (
                  <>
                    <Button
                      type="button"
                      variant="primary"
                      size="lg"
                      block
                      loading={ownerPending}
                      onClick={() => {
                        // Once signed in, the account menu opens "Create a new password" (`newPasswordAsk`).
                        sessionStore.set(STORAGE_KEYS.newPasswordAsk, "1");
                        void continueHere();
                      }}
                    >
                      {t("auth.desktopOwner.continue")}
                    </Button>
                    <p className="auth__fine">{t("auth.forgotHere.notOwner")}</p>
                    <button type="button" className="auth__quiet" onClick={() => go("password")}>
                      {t("auth.flow.back")}
                    </button>
                  </>
                ) : (
                  <Button type="button" size="lg" block onClick={() => go(options?.password ? "password" : "email")}>
                    {t("auth.forgotHere.back")}
                  </Button>
                ))}

              {step === "forgot" && (
                <button
                  type="button"
                  className="auth__quiet"
                  onClick={() => go(options?.password ? "password" : "email")}
                >
                  {t("auth.flow.back")}
                </button>
              )}

              {step === "sent" && (
                <>
                  {mail && (
                    <Button asChild variant="primary" size="lg" block>
                      <a href={mail.url} target="_blank" rel="noopener noreferrer">
                        {t("auth.flow.openMail", { app: mail.name })}
                      </a>
                    </Button>
                  )}
                  <Button type="button" size="lg" block onClick={() => go("password")}>
                    {t("auth.flow.backToSignIn")}
                  </Button>
                </>
              )}

              {(step === "email" || step === "newPassword") && termsUrl && privacyUrl && (
                <p className="auth__fine">
                  {t("auth.termsBefore")}
                  <a href={termsUrl}>{t("auth.terms")}</a>
                  {t("auth.termsMiddle")}
                  <a href={privacyUrl}>{t("auth.privacy")}</a>
                  {t("auth.termsAfter")}
                </p>
              )}
            </Locked>
          </div>
        )}
      </form>
    </AuthShell>
  );
}
