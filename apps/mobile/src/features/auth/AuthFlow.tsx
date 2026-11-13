import { invitationQuery, type SignInOptions, useApi, useAuthConfig } from "@agenteschat/client";
import { type HumanAction, humanCheckHeaders, withHumanCheck } from "@agenteschat/client/lib/human-check";
import {
  emailTypoFix,
  isEmail,
  looksLikePassword,
  nameIsPassword,
  passwordState,
  webmailOf,
} from "@agenteschat/client/lib/text";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, type TextInput, View } from "react-native";
import { PixelOrbit } from "@/agent/PixelOrbit";
import { useLaunched } from "@/features/launch/launched";
import { authClient } from "@/lib/auth";
import { setServer, useServerToReturn } from "@/lib/server";
import { readValueSync, writeValue } from "@/lib/storage";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { AuthFootLine } from "@/ui/auth/ServerLine";
import { Shake } from "@/ui/auth/Shake";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Locked } from "@/ui/Locked";
import { router } from "@/ui/navigation";
import { Text } from "@/ui/Text";
import { rememberConfirmationSent } from "./confirmation";
import { useHumanCheck } from "./HumanCheck";
import {
  CheckCancelled,
  earlyAccessRequests,
  lookUpFailureText,
  lookUpStep,
  refusalOf,
  refusalText,
  signUpClosed,
} from "./human-check";
import { pendingInvite } from "./invite";
import { signInPurpose } from "./links";

/**
 * Sign in and sign up in one flow (like the web's `AuthPage`): the e-mail
 * first, then the one next step the server says it needs (the password, the provider the account signs
 * in with, or the name and a new password). "Esqueci a senha" happens in place. The keyboard stays up from the
 * first step to the last and its return key is the action; the e-mail being answered for is the subtitle of the
 * steps after it, and the back circle is the one way back to it. The agent reacts: eyes shut while a hidden
 * password is typed, a wink when it's shown, a frown and a shake of the field when it's wrong. On success the
 * session gate moves to the app.
 */
/** The e-mail this phone last signed in with: the next sign-in starts with it (kept on signing out). */
export const LAST_EMAIL = "last-email";

/** How often the e-mail's lookup tries again while there is no connection. */
const OFFLINE_RETRY_MS = 5000;
/** The no-connection line: the orbit on the first line of its words. */
const OFFLINE_LINE = { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 } as const;

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
  | "sent";

/** Where the back button goes from each step (`null`: leave the screen, if there is somewhere to go). */
const BACK: Record<Step, Step | null> = {
  email: null,
  password: "email",
  social: "email",
  noPassword: "email",
  name: "email",
  newPassword: "name",
  closed: "email",
  expired: "email",
  forgot: "password",
  sent: "password",
};

/**
 * The steps that send something a bot could flood, and what their bot check is for (ADR 0075). The name step
 * leads to the new password's, so its token is ready by the sign-up.
 */
const STEP_ACTIONS: Partial<Record<Step, HumanAction>> = {
  email: "email-lookup",
  password: "sign-in",
  name: "sign-up",
  newPassword: "sign-up",
  forgot: "password-reset",
};

/** `access`: an early-access link's token, for the sign-up it opens (as the web's `/signup?access=`). */
export function AuthFlow({
  start,
  email: initialEmail,
  access,
}: {
  start: "in" | "up";
  email?: string;
  access?: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAuthConfig();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail ?? readValueSync(LAST_EMAIL) ?? "");
  // The e-mail takes the keyboard once the launch splash has left, not under it.
  const launched = useLaunched();
  // Under an invitation's screen (a request still waiting, reopened) it stays out of the way.
  const focused = useIsFocused();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const newPasswordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [offline, setOffline] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  const human = useHumanCheck(STEP_ACTIONS[step] ?? null);
  const linkedProviders = useSocialProviders(options?.providers);
  const allProviders = useSocialProviders();
  const canReset = config.data?.passwordReset === true;
  const requests = earlyAccessRequests(access);
  // Where this sign-in leads, in place of the general line: the invitation opened before it (its workspace, by its
  // token), as the web's sign-in says it.
  const [waiting] = useState(pendingInvite);
  const invitation = useQuery({ ...invitationQuery(api, waiting?.token ?? ""), enabled: waiting !== null });
  const goal = signInPurpose(invitation.data);
  const purpose = goal ? t(goal.key, { org: goal.org }) : null;
  const termsUrl = config.data?.termsUrl;
  const privacyUrl = config.data?.privacyUrl;

  const go = (next: Step) => {
    setError(null);
    setWrong(false);
    setSecret(false);
    setStep(next);
  };

  /** Who is this e-mail: the next step follows from the server's answer. */
  const lookUp = async (value = email) => {
    if (!isEmail(value)) return;
    setPending(true);
    setError(null);
    try {
      const found = await withHumanCheck(human.check, (token) =>
        api.account.signInOptions(requests.lookUp(value.trim()), token),
      );
      setOffline(false);
      setOptions(found);
      setPassword("");
      // No password and no provider this server signs in with (the owner's account made by the desktop
      // app): the web's "noPassword" step says where to add one, instead of an empty provider list.
      const on = config.data?.socialProviders as Partial<Record<string, boolean>> | undefined;
      const usable = found.providers.some((p) => on?.[p] === true);
      go(lookUpStep(found, usable));
    } catch (e) {
      // No connection: the e-mail stays, a quiet line says so, and the lookup tries again by itself (below).
      if (e instanceof TypeError && /network|fetch/i.test(e.message)) setOffline(true);
      else if (!(e instanceof CheckCancelled)) setError(lookUpFailureText(t, e));
    } finally {
      setPending(false);
    }
  };

  // Offline on the e-mail: one try every few seconds until the server answers, then on to the next step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookUp` reads the e-mail as typed at each try
  useEffect(() => {
    if (!offline || step !== "email") return;
    const id = setInterval(() => void lookUp(), OFFLINE_RETRY_MS);
    return () => clearInterval(id);
  }, [offline, step, email]);

  // Came with the e-mail ("Criar conta" from somewhere that knew it): straight to the next step, once the server
  // has said whether a bot check guards it.
  const lookedUp = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the e-mail it came with
  useEffect(() => {
    if (lookedUp.current || config.isPending) return;
    lookedUp.current = true;
    if (initialEmail && isEmail(initialEmail)) void lookUp(initialEmail);
  }, [config.isPending]);

  // Mounted under the launch splash: the keyboard comes up once the splash leaves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the splash leaves or the screen comes back
  useEffect(() => {
    if (launched && focused && step === "email" && !initialEmail) emailField.current?.focus();
  }, [launched, focused]);

  /** A provider refused: its words, and the address an unconfirmed account's refusal was for, in the field. */
  const socialRefused = (text: string, address?: string) => {
    setError(text);
    if (address && text === t("auth.unconfirmed")) setEmail(address);
  };

  /** Better Auth's refusal → the sentence to show (never the server's raw text). */
  const failed = (refusal: { status: number; code?: string }) =>
    setError(refusal.status ? refusalText(t, refusal) : t("mobile.auth.errors.network"));

  /**
   * What a throw means: only a request that never got an answer (fetch's "Network request failed") is
   * "Sem conexão"; anything else in the app (the Keychain, a bug) reads as the generic failure. A bot check
   * closed with Cancel says nothing: the button is there to press again.
   */
  const thrown = (error: unknown) => {
    if (error instanceof CheckCancelled) return;
    const network = error instanceof TypeError && /network|fetch/i.test(error.message);
    if (!network) console.warn("[auth]", error);
    setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));
  };

  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      const refused = await withHumanCheck(human.check, async (token) =>
        refusalOf(
          await authClient().signIn.email({
            email: email.trim(),
            password,
            fetchOptions: { headers: humanCheckHeaders(token) },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        if (refused.status === 401) {
          setWrong(true);
          // The wrong password goes, so the next try starts on an empty field.
          setPassword("");
        } else failed(refused);
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, email.trim());
    } catch (error) {
      thrown(error);
    } finally {
      setPending(false);
    }
  };

  const signUp = async () => {
    setPending(true);
    setError(null);
    try {
      const refused = await withHumanCheck(human.check, async (token) =>
        refusalOf(
          await authClient().signUp.email({
            name: name.trim(),
            email: email.trim(),
            password,
            fetchOptions: { headers: { ...humanCheckHeaders(token), ...requests.headers } },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        // Checked by code: the bot check refuses with a 403 too, and that isn't sign-up being closed.
        if (signUpClosed(refused)) go("closed");
        else failed(refused);
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, email.trim());
      // A server that sends email sent this address a link to confirm it: the first run says where it went.
      if (canReset) rememberConfirmationSent(email);
    } catch (error) {
      thrown(error);
    } finally {
      setPending(false);
    }
  };

  const sendReset = async () => {
    setPending(true);
    setError(null);
    try {
      // The answer is the same whether or not the account exists. Relative: the server resolves it
      // against its own address, so the link opens its web page whatever address the app reached it at.
      const refused = await withHumanCheck(human.check, async (token) =>
        refusalOf(
          await authClient().requestPasswordReset({
            email: email.trim(),
            redirectTo: "/reset-password",
            fetchOptions: { headers: humanCheckHeaders(token) },
          }),
        ),
      );
      if (refused) return failed(refused);
      haptics.success();
      go("sent");
    } catch (error) {
      thrown(error);
    } finally {
      setPending(false);
    }
  };

  const ready =
    step === "email" || step === "forgot"
      ? isEmail(email)
      : step === "password"
        ? password.length > 0
        : step === "name"
          ? name.trim().length > 0 && passwordState(password) === "ok"
          : step === "newPassword"
            ? passwordState(password) === "ok"
            : false;

  const submit = () => {
    if (!ready || pending) return;
    if (step === "email") void lookUp();
    else if (step === "password") void signIn();
    else if (step === "name" && nameIsPassword(name, password)) {
      // The name field got the password: no account with a password for a name.
      setPassword("");
      setError(t("auth.flow.nameIsPassword"));
    } else if (step === "name") void signUp();
    else if (step === "newPassword" && nameIsPassword(name, password)) {
      // The name step got the password: no account with a password for a name.
      setPassword("");
      go("name");
      setError(t("auth.flow.nameIsPassword"));
    } else if (step === "newPassword") void signUp();
    else if (step === "forgot") void sendReset();
  };

  const showWink = () => {
    setWink(true);
    setTimeout(() => setWink(false), 900);
  };

  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : step === "sent" ? "happy" : undefined;

  const first = name.trim().split(/\s+/)[0] ?? "";
  const providerNames = linkedProviders.map((p) => t(`auth.provider.${p}`)).join(" · ");
  // Steps without a subtitle: their field and buttons say it (the new password's meter gives the minimum).
  const who = email.trim();
  const bubble: Record<Step, [string, string?]> = {
    email:
      start === "up"
        ? [t("auth.flow.emailUp")]
        : [t("mobile.auth.flow.email"), purpose ?? t("mobile.auth.flow.emailLead")],
    password: wrong ? [t("auth.flow.wrong"), who] : [t("auth.flow.password"), purpose ?? who],
    social: [t("auth.flow.social", { providers: providerNames }), t("auth.flow.socialLead")],
    noPassword: [t("auth.flow.noPassword"), t("auth.flow.noPasswordLead")],
    // New here: the name and the password on one screen, like the invitation's "Só falta você".
    name: [t("mobile.auth.flow.signUp"), who],
    newPassword: [first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword"), who],
    closed: [t("auth.flow.closed"), t("auth.flow.closedLead")],
    expired: [
      t("auth.flow.expired"),
      config.data?.supportEmail
        ? t("auth.flow.expiredLead", { email: config.data.supportEmail })
        : t("auth.flow.expiredLeadAsk"),
    ],
    forgot: [t("auth.flow.forgot"), t("auth.flow.forgotLead")],
    sent: [t("auth.flow.sent", { email: email.trim() }), t("auth.flow.sentLead")],
  };
  const [title, lead] = bubble[step];
  // The e-mail as the subtitle: in ink, one line (a 40-character address is cut in the middle, never wrapped).
  const strongLead = lead === who && who !== "";

  const backTo = step === "forgot" && !options?.password ? "email" : BACK[step];
  // A server added while signed in to another (ADR 0154): its first step goes back there, nothing lost, when this
  // screen has nothing of its own to go back to.
  const returnTo = useServerToReturn();
  const onBack = backTo
    ? () => go(backTo)
    : router.canGoBack()
      ? () => router.back()
      : returnTo
        ? () => void setServer(returnTo)
        : undefined;

  const fix = step === "email" || step === "forgot" ? emailTypoFix(email) : null;
  const mail = webmailOf(email);

  const terms =
    (step === "email" || step === "name" || step === "newPassword") && termsUrl && privacyUrl ? (
      <Terms termsUrl={termsUrl} privacyUrl={privacyUrl} />
    ) : null;

  // The e-mail step has none: the keyboard's blue key ("continuar") is its action, and Apple, Google and GitHub take
  // the place where the thumb is.
  const submitLabel: Partial<Record<Step, string>> = {
    password: t("auth.signIn"),
    name: t("auth.createAccount"),
    newPassword: t("auth.createAccount"),
    forgot: t("auth.flow.sendLink"),
  };

  return (
    <AuthScaffold
      title={title}
      subtitle={lead}
      stepKey={step}
      onBack={onBack}
      agentMode={pending ? "run" : "idle"}
      expression={expression}
      overlay={human.view}
      subtitleStrong={strongLead}
      footer={
        step === "email" ? (
          <>
            {terms}
            <AuthFootLine />
          </>
        ) : (
          terms
        )
      }
    >
      {step === "email" || step === "forgot" ? (
        <Locked when={pending} keepKeyboard style={{ gap: 8 }}>
          <AuthField
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              setError(null);
            }}
            placeholder={t("auth.flow.emailPlaceholder")}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="username"
            // The keyboard's blue key is the action ("continuar" / "enviar"); it stays gray until something is typed.
            returnKeyType={step === "email" ? "go" : "send"}
            enablesReturnKeyAutomatically
            onSubmitEditing={submit}
            accessibilityLabel={t("auth.email")}
            ref={emailField}
            autoFocus={!initialEmail && launched && focused}
          />
          {fix ? (
            <Pressable
              onPress={() => setEmail(fix)}
              accessibilityRole="button"
              hitSlop={12}
              style={({ pressed }) => ({ alignSelf: "center", opacity: pressed ? 0.6 : 1 })}
            >
              <Text variant="subhead" style={{ fontWeight: "600" }}>
                {t("auth.flow.didYouMean", { email: fix })}
              </Text>
            </Pressable>
          ) : null}
        </Locked>
      ) : null}

      {step === "password" || step === "newPassword" ? (
        <Locked when={pending} keepKeyboard>
          {/* Wrong: the title changes, the field shakes, the haptic warns, all in the same instant. */}
          <Shake when={wrong}>
            <PasswordField
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setWrong(false);
              }}
              fresh={step === "newPassword"}
              onSecretChange={setSecret}
              onShow={showWink}
              onSubmitEditing={submit}
              label={step === "newPassword" ? t("invite.createPassword") : t("auth.password")}
            />
          </Shake>
        </Locked>
      ) : null}

      {step === "name" ? (
        <Locked when={pending} keepKeyboard>
          <View style={{ gap: 8 }}>
            <AuthField
              value={name}
              onChangeText={(value) => {
                setName(value);
                setError(null);
              }}
              placeholder={t("auth.flow.namePlaceholder")}
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              // Return hands the keyboard to the password, never closing it.
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => newPasswordField.current?.focus()}
              accessibilityLabel={t("auth.yourName")}
              autoFocus
            />
            {!error ? <NameHint name={name} /> : null}
            <Shake when={wrong}>
              <PasswordField
                ref={newPasswordField}
                value={password}
                onChangeText={(value) => {
                  setPassword(value);
                  setError(null);
                }}
                fresh
                autoFocus={false}
                onSecretChange={setSecret}
                onShow={showWink}
                onSubmitEditing={submit}
                label={t("invite.createPassword")}
              />
            </Shake>
          </View>
        </Locked>
      ) : null}

      {offline && step === "email" ? (
        <View style={OFFLINE_LINE} accessibilityLiveRegion="polite">
          <PixelOrbit color="sky" size={16} />
          <Text variant="subhead" tone="muted" style={{ flexShrink: 1 }}>
            {t("mobile.auth.errors.offlineRetry")}
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text tone="danger" variant="small" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}

      {/* A provider refused an unconfirmed account: a new password by email, never a new confirmation (ADR 0006). */}
      {canReset && error === t("auth.unconfirmed") && isEmail(email) ? (
        <Quiet label={t("auth.unconfirmedReset")} onPress={() => go("forgot")} />
      ) : null}

      {submitLabel[step] ? (
        <Button variant="primary" wide label={submitLabel[step]} loading={pending} disabled={!ready} onPress={submit} />
      ) : null}

      {step === "email" ? (
        <Locked when={pending} keepKeyboard style={{ paddingTop: 8 }}>
          <SocialButtons providers={allProviders} onError={socialRefused} earlyAccess={access} />
        </Locked>
      ) : null}

      {step === "password" && canReset ? (
        <Locked when={pending} keepKeyboard>
          <Quiet label={t("auth.forgotPassword")} onPress={() => go("forgot")} />
        </Locked>
      ) : null}

      {step === "social" ? (
        <>
          <SocialButtons providers={linkedProviders} divider={false} onError={setError} />
          {canReset ? <Quiet label={t("auth.flow.createPassword")} onPress={() => go("forgot")} /> : null}
        </>
      ) : null}

      {step === "closed" || step === "expired" || step === "noPassword" ? (
        <Button variant="secondary" wide label={t("auth.flow.otherEmail")} onPress={() => go("email")} />
      ) : null}

      {step === "noPassword" && canReset ? (
        <Quiet label={t("auth.flow.createPassword")} onPress={() => go("forgot")} />
      ) : null}

      {step === "forgot" ? (
        <Quiet label={t("auth.flow.back")} onPress={() => go(options?.password ? "password" : "email")} />
      ) : null}

      {step === "sent" ? (
        <>
          {mail ? (
            <Button
              variant="primary"
              wide
              icon="mail"
              label={t("auth.flow.openMail", { app: mail.name })}
              onPress={() => void Linking.openURL(mail.url)}
            />
          ) : null}
          <Button
            variant="secondary"
            wide
            label={t("auth.flow.backToSignIn")}
            onPress={() => go(options?.password ? "password" : "email")}
          />
        </>
      ) : null}
    </AuthScaffold>
  );
}

/** Under a name step's field: a soft line, never a block, when what's typed there looks like a password. */
export function NameHint({ name }: { name: string }) {
  const { t } = useTranslation();
  if (!looksLikePassword(name)) return null;
  return (
    <Text variant="small" tone="muted" accessibilityLiveRegion="polite" style={CENTER}>
      {t("auth.flow.nameLooksLikePassword")}
    </Text>
  );
}

/** A quiet text link under the main answer ("Esqueci a senha"). */
export function Quiet({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={{ alignItems: "center", marginTop: 4 }}>
      <AuthLink label={label} onPress={onPress} />
    </View>
  );
}

/** "Ao continuar, você aceita os Termos e a Política de privacidade." */
export function Terms({ termsUrl, privacyUrl }: { termsUrl: string; privacyUrl: string }) {
  const { t } = useTranslation();
  const link = (label: string, url: string): ReactNode => (
    <Text
      variant="caption"
      tone="muted"
      style={{ textDecorationLine: "underline" }}
      // In a sheet over the app (Safari's view), not out to Safari: the sign-up stays where it was.
      onPress={() => void openBrowserAsync(url).catch(() => Linking.openURL(url))}
    >
      {label}
    </Text>
  );
  return (
    <Text variant="caption" tone="muted" style={{ textAlign: "center" }}>
      {t("auth.termsBefore")}
      {link(t("auth.terms"), termsUrl)}
      {t("auth.termsMiddle")}
      {link(t("auth.privacy"), privacyUrl)}
      {t("auth.termsAfter")}
    </Text>
  );
}
