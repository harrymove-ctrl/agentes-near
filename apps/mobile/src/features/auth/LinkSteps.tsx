import { ApiError, type AskToJoinResult, type InvitationPreview, keys, useApi } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { errorCode, invitedErrorText } from "@agenteschat/client/lib/errors";
import { withHumanCheck } from "@agenteschat/client/lib/human-check";
import { CODE_LENGTH, JOIN_NAME_MAX, JOIN_NOTE_MAX, typedCode } from "@agenteschat/client/lib/join-requests";
import { emailTypoFix, isEmail, nameIsPassword, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { type ComponentRef, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Linking, type TextInput, View } from "react-native";
import { useNow } from "@/features/shared/hooks";
import { firstName } from "@/features/shared/logic";
import { serverUrl } from "@/lib/server";
import { Button, haptics, LineIcon, Locked, Text } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { router } from "@/ui/navigation";
import { useTheme } from "@/ui/theme";
import { NameHint, Quiet } from "./AuthFlow";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, failureText } from "./human-check";
import { rememberInvite } from "./invite";
import { DidYouMean, ErrorLine, InviteCrew, InviteTerms, LeaveButton, useLeaveInvite } from "./invite-parts";
import { type Asked, type AskStep, askAction, askBack, askProgress } from "./invite-steps";

/**
 * Asking through a link, signed out, where email goes out (ADR 0090 §1): three screens. The email, with who called
 * you as the title; the code from it, alone; then you (name, a password and an optional word for whoever approves)
 * under one button, "Pedir para entrar". No account exists until an admin approves; the ask answers the key that
 * signs in then, and the phone keeps it (`onAsked`). An answer with no key (an ask the server keeps no password for)
 * says only where the answer goes.
 */
export function LinkSteps({
  token,
  preview,
  onAsked,
}: {
  token: string;
  preview: InvitationPreview;
  onAsked: (asked: Asked) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const leave = useLeaveInvite();
  const [step, setStep] = useState<AskStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  // A code proves one address: another address starts over.
  const [proof, setProof] = useState<{ email: string; code: string } | null>(null);
  const [sent, setSent] = useState<{ to: string; resendAt: number } | null>(null);
  // Past the address's hourly or daily cap, each press is a sure 429 that still spends the link's shared budget.
  const [capped, setCapped] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  // Asked, and the server answered no key to wait with.
  const [answered, setAnswered] = useState<AskToJoinResult | null>(null);
  const human = useHumanCheck(askAction(step));
  const codeField = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const noteField = useRef<ComponentRef<typeof TextInput>>(null);
  const typed = email.trim();
  const key = typed.toLowerCase();
  const org = preview.orgName;
  const by = preview.invitedBy ? firstName(preview.invitedBy) : null;
  const resendAt = sent?.to === key ? sent.resendAt : 0;
  // A repaint every second while the code's countdown runs; the time itself is read just below.
  useNow(step === "code" && resendAt > Date.now() ? 1000 : 60_000);
  const left = Math.max(0, resendAt - Date.now());

  const go = (next: AskStep) => {
    setError(null);
    setWrong(false);
    setSecret(false);
    setStep(next);
  };
  const onBack = () => {
    const to = askBack(step);
    if (to) go(to);
    else leave();
  };

  /** A code to the address: true once one is out, or one from a moment ago still stands. */
  const sendCode = async () => {
    const to = key;
    setSending(true);
    setError(null);
    try {
      const result = await withHumanCheck(human.check, (humanCheck) =>
        api.invites.sendCode(token, { email: typed }, humanCheck),
      );
      setSent({ to, resendAt: Date.now() + result.resendIn * 1000 });
      return true;
    } catch (e) {
      if (e instanceof CheckCancelled) return false;
      // A code went out a moment ago (another try, another device): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "join.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) {
        setSent({ to, resendAt: Date.now() + retryIn * 1000 });
        return true;
      }
      if (errorCode(e) === "join.code_limit") setCapped(to);
      haptics.warning();
      setError(failureText(t, e));
      return false;
    } finally {
      setSending(false);
    }
  };

  /** The email's Continue: a code to it, unless it's proven already or one went out a moment ago. */
  const toCode = async () => {
    if (proof?.email === key) return go("you");
    if (sent?.to === key && Date.now() < sent.resendAt) return go("code");
    if (await sendCode()) {
      setCode("");
      go("code");
    }
  };

  const resend = async () => {
    if (await sendCode()) {
      setCode("");
      codeField.current?.focus();
    }
  };

  const checkCode = async (value: string) => {
    setChecking(true);
    try {
      await api.invites.checkCode(token, { email: typed, code: value });
      haptics.success();
      AccessibilityInfo.announceForAccessibility(t("invite.ask.verified"));
      setProof({ email: key, code: value });
      go("you");
    } catch (e) {
      haptics.warning();
      setCode("");
      setWrong(true);
      setError(failureText(t, e));
      codeField.current?.focus();
    } finally {
      setChecking(false);
    }
  };
  const typedIn = (value: string) => {
    if (checking) return;
    const digits = typedCode(value);
    setCode(digits);
    setError(null);
    setWrong(false);
    if (digits.length === CODE_LENGTH) void checkCode(digits);
  };

  /** The ask, with the word for whoever approves or without. */
  const ask = async () => {
    if (!proof) return go("email");
    if (asking) return;
    const words = note.trim();
    setAsking(true);
    setError(null);
    try {
      const result = await api.invites.ask(token, {
        name: name.trim(),
        email: typed,
        ...(words ? { note: words } : {}),
        code: proof.code,
        password,
      });
      haptics.success();
      if (result.key) {
        onAsked({ token, key: result.key, name: name.trim(), email: result.email || key, org, server: serverUrl() });
      } else {
        setAsking(false);
        setAnswered(result);
      }
    } catch (e) {
      setAsking(false);
      haptics.warning();
      // The proof ran out (30 minutes) or was used: a new code, from the email.
      if (errorCode(e)?.startsWith("join.code_")) {
        setProof(null);
        setSent(null);
        setWrong(false);
        setStep("email");
      }
      setError((e instanceof ApiError ? invitedErrorText(t, e) : null) ?? failureText(t, e));
      // A link turned off meanwhile then shows as its own state.
      void qc.invalidateQueries({ queryKey: keys.invitation(token) });
    }
  };

  const nameOk = name.trim() !== "";
  const passwordOk = passwordState(password) === "ok";
  const ready = step === "email" ? isEmail(email) && capped !== key : step === "you" ? nameOk && passwordOk : false;

  const submit = () => {
    if (!ready || sending || asking) return;
    if (step === "email") void toCode();
    else if (step === "you" && nameIsPassword(name, password)) {
      setPassword("");
      setError(t("auth.flow.nameIsPassword"));
    } else if (step === "you") void ask();
  };

  if (answered)
    return (
      <AuthScaffold
        title={t("invite.ask.sentTitle")}
        subtitle={
          answered.emailed ? t("invite.ask.sentEmail", { org, email: answered.email }) : t("invite.ask.sentNoEmail")
        }
        stepKey="sent"
        expression="happy"
      >
        <LeaveButton />
      </AuthScaffold>
    );

  const fix = step === "email" ? emailTypoFix(email) : null;
  const mail = webmailOf(typed);
  const bubble: Record<AskStep, [string, string | undefined]> = {
    // A personal workspace's words (ADR 0159): never its name ("Personal"), who invited instead.
    email: isPersonal(preview)
      ? [by ? t("invite.calledYouPersonal", { name: by }) : t("invite.ask.helloPersonal"), t("invite.ask.leadNoName")]
      : [
          by ? t("mobile.invite.ask.called", { name: by, org }) : t("mobile.invite.ask.calledNoName", { org }),
          t("mobile.invite.ask.approves", { org }),
        ],
    code: [t("invite.ask.codeTitle", { email: typed }), t("invite.ask.codeLead")],
    // The subtitle's place holds the confirmed e-mail line, drawn below with its check.
    you: [t("mobile.invite.ask.youTitle"), undefined],
  };
  const [title, lead] = bubble[step];
  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : step === "you" ? "happy" : undefined;
  const { n, total } = askProgress(step);
  const progress = t("mobile.invite.ask.stepOf", { n, total, name: t(`mobile.invite.ask.step.${step}`) });

  const locked = sending || asking;
  let body: ReactNode = null;
  switch (step) {
    case "email":
      body = (
        <>
          <Locked when={locked} keepKeyboard style={{ gap: 8 }}>
            <AuthField
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                setError(null);
              }}
              placeholder={t("auth.flow.emailPlaceholder")}
              accessibilityLabel={t("invite.ask.email")}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              // The keyboard's blue key is the action: "continuar", gray until something is typed.
              returnKeyType="go"
              enablesReturnKeyAutomatically
              onSubmitEditing={submit}
              autoFocus
            />
            {fix ? <DidYouMean fix={fix} onFix={setEmail} /> : null}
          </Locked>
          <ErrorLine error={error ?? (capped === key ? t("errors.code.limit") : null)} />
          <Button
            variant="primary"
            wide
            label={t("auth.flow.continue")}
            loading={sending}
            disabled={!ready || sending}
            onPress={submit}
          />
          <Locked when={locked} keepKeyboard>
            <Quiet
              label={t("mobile.invite.ask.haveAccount")}
              onPress={() => {
                rememberInvite(token, "link");
                // The address typed here goes along, so the sign-in starts at the password.
                router.push({ pathname: "/sign-in", params: isEmail(email) ? { email: typed } : {} });
              }}
            />
          </Locked>
        </>
      );
      break;
    case "code":
      body = (
        <>
          <Locked when={checking} keepKeyboard>
            <AuthField
              ref={codeField}
              code
              value={code}
              onChangeText={typedIn}
              placeholder={t("invite.ask.code")}
              accessibilityLabel={t("invite.ask.code")}
              accessibilityState={{ busy: checking }}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (code.length === CODE_LENGTH && !checking) void checkCode(code);
              }}
              autoFocus
            />
          </Locked>
          <ErrorLine error={error} />
          {mail ? (
            <Button
              variant="secondary"
              wide
              label={t("auth.flow.openMail", { app: mail.name })}
              onPress={() => void Linking.openURL(mail.url)}
            />
          ) : null}
          {left > 0 ? (
            <Text
              variant="subhead"
              tone="muted"
              accessibilityLabel={t("invite.ask.resendIn", { count: Math.ceil(left / 1000) })}
              style={[CENTER, { fontVariant: ["tabular-nums"] }]}
            >
              {formatTimeLeft(left)}
            </Text>
          ) : capped === key || sending ? null : (
            <Quiet label={t("invite.ask.resendCode")} onPress={() => void resend()} />
          )}
        </>
      );
      break;
    case "you":
      body = (
        <>
          {/* The e-mail is settled: one quiet line with a check, where a subtitle would be. */}
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: -16 }}
            accessibilityLabel={`${t("invite.ask.verified")}: ${typed}`}
          >
            <LineIcon name="check" size={16} color={colors.ok} variant="subhead" />
            <Text variant="subhead" tone="ok" style={{ fontWeight: "600" }}>
              {t("mobile.invite.ask.emailConfirmed")}
            </Text>
          </View>
          <Locked when={locked} keepKeyboard style={{ gap: 8 }}>
            <AuthField
              value={name}
              onChangeText={setName}
              placeholder={t("auth.flow.namePlaceholder")}
              accessibilityLabel={t("invite.ask.name")}
              maxLength={JOIN_NAME_MAX}
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              // Return moves to the next field; the keyboard stays and the screen doesn't move.
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => passwordField.current?.focus()}
              autoFocus
            />
            <NameHint name={name} />
            <PasswordField
              ref={passwordField}
              value={password}
              onChangeText={setPassword}
              fresh
              autoFocus={false}
              keepFocus
              onSecretChange={setSecret}
              onShow={() => {
                setWink(true);
                setTimeout(() => setWink(false), 900);
              }}
              onSubmitEditing={() => noteField.current?.focus()}
              label={t("invite.createPassword")}
            />
            <AuthField
              ref={noteField}
              value={note}
              onChangeText={setNote}
              placeholder={t("mobile.invite.ask.notePlaceholder")}
              accessibilityLabel={t("invite.ask.noteField")}
              maxLength={JOIN_NOTE_MAX}
              returnKeyType="send"
              onSubmitEditing={submit}
            />
          </Locked>
          <ErrorLine error={error} />
          <Button
            variant="primary"
            wide
            label={t("invite.ask.send")}
            loading={asking}
            disabled={!ready || asking}
            onPress={submit}
          />
        </>
      );
      break;
  }

  return (
    <AuthScaffold
      title={title}
      subtitle={lead}
      progress={progress}
      stepKey={step}
      onBack={onBack}
      sky={step === "you" ? "low" : "normal"}
      toolbar={step === "you"}
      agentMode={sending || asking || checking ? "run" : "idle"}
      expression={expression}
      overlay={human.view}
      footer={step === "email" || step === "you" ? <InviteTerms /> : null}
      // The team you're asking to join, on the sky, on the first step; the code and "you" keep the app's agent.
      hero={
        step === "email" && (preview.agents?.length ?? 0) > 0 ? <InviteCrew agents={preview.agents ?? []} /> : undefined
      }
    >
      {body}
    </AuthScaffold>
  );
}
