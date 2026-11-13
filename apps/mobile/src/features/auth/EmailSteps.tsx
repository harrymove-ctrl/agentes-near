import { type InvitationPreview, useAuthConfig } from "@agenteschat/client";
import { INVITATION_MAIL_HEADER, INVITATION_MAIL_PARAM, INVITATION_TOKEN_HEADER } from "@agenteschat/client/lib/guards";
import { humanCheckHeaders, withHumanCheck } from "@agenteschat/client/lib/human-check";
import { nameIsPassword, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, View } from "react-native";
import { firstName } from "@/features/shared/logic";
import { authClient } from "@/lib/auth";
import { writeValue } from "@/lib/storage";
import { useSession } from "@/providers/session";
import { Button, haptics, Locked } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { LAST_EMAIL, NameHint, Quiet } from "./AuthFlow";
import { rememberConfirmationSent } from "./confirmation";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, refusalOf, refusalText, signUpClosed } from "./human-check";
import { forgetInvite, rememberInvite } from "./invite";
import {
  ErrorLine,
  InviteCrew,
  InviteTerms,
  LockedEmail,
  OrgLine,
  useAgentsLine,
  useLeaveInvite,
} from "./invite-parts";
import { EMAIL_ACTIONS, type EmailStep, emailBack, emailStart } from "./invite-steps";

/**
 * An email invitation, signed out (ADR 0090 §6): only what its address is missing, on the invitation's own screens,
 * the address locked. A new one gives a name, then a password; one with a password types it ("Esqueci a senha" is the
 * app's reset, and the invitation waits for the sign-in after it); one that signs in only with a provider gets that
 * provider. Then `join` accepts with the proof of its email, so the workspace opens with no other screen between.
 */
export function EmailSteps({
  token,
  mail,
  preview,
  onSigningIn,
  join,
}: {
  token: string;
  mail?: string;
  preview: InvitationPreview;
  /** A sign-in starts here: the parent keeps these screens up while the session arrives, until `join` ends. */
  onSigningIn: () => void;
  join: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const leave = useLeaveInvite();
  const config = useAuthConfig().data;
  const invited = preview.email;
  const org = preview.orgName;
  const by = preview.invitedBy ? firstName(preview.invitedBy) : null;
  const account = preview.account;
  const start = emailStart(account);
  const [step, setStep] = useState<EmailStep>(start);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  const running = useRef(false);
  // A provider's sheet was started here: its session, whenever it comes, ends in `join`.
  const viaProvider = useRef(false);
  const human = useHumanCheck(EMAIL_ACTIONS[step] ?? null);
  const apple = useSocialProviders(["apple"]);
  const linked = useSocialProviders(account?.providers ?? []);
  const canReset = config?.passwordReset === true;
  const crew = useAgentsLine("invite.crew", preview.agents ?? [], preview.moreAgents ?? 0);
  const callbackURL = `/invite/${token}${mail ? `?${INVITATION_MAIL_PARAM}=${mail}` : ""}`;

  const go = (next: EmailStep) => {
    setError(null);
    setWrong(false);
    setSecret(false);
    setStep(next);
  };
  const onBack = () => {
    const to = emailBack(step, start);
    if (to) go(to);
    else leave();
  };

  /** One press at a time; the screens stay until the request ends. */
  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (e instanceof CheckCancelled) return;
      const network = e instanceof TypeError && /network|fetch/i.test(e.message);
      setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));
    } finally {
      running.current = false;
      setPending(false);
    }
  };

  /**
   * These screens accept by themselves: a remembered copy of the invitation (a provider's sheet closed, a reset)
   * would race them for the same acceptance in the root layout.
   */
  const startSignIn = () => {
    viaProvider.current = false;
    forgetInvite();
    onSigningIn();
  };
  const startProvider = () => {
    viaProvider.current = true;
    forgetInvite();
    onSigningIn();
  };

  /** Better Auth's refusal → the sentence to show (never the server's raw text). */
  const refusal = (refused: { status: number; code?: string }) =>
    refused.status ? refusalText(t, refused) : t("mobile.auth.errors.network");

  const signedIn = async () => {
    rememberSignIn("email");
    void writeValue(LAST_EMAIL, invited);
    await session.refresh().catch(() => {});
    await join();
  };

  // A new address made here: with the token and its email's proof, no "confirm your email" goes and accepting
  // confirms it (ADR 0090 §6). Opened from a copied link there's no proof, and the message goes as for anyone.
  const signUp = () =>
    run(async () => {
      startSignIn();
      const proved = mail ? { [INVITATION_TOKEN_HEADER]: token, [INVITATION_MAIL_HEADER]: mail } : {};
      const refused = await withHumanCheck(human.check, async (check) =>
        refusalOf(
          await authClient().signUp.email({
            name: name.trim(),
            email: invited,
            password,
            fetchOptions: { headers: { ...humanCheckHeaders(check), ...proved } },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        // Checked by code: the bot check refuses with a 403 too, and that isn't sign-up being closed.
        setError(signUpClosed(refused) ? t("auth.flow.closedLead") : refusal(refused));
        return;
      }
      haptics.success();
      // A server that sends email sent this address a link to confirm it: the first run says where it went.
      if (canReset && !mail) rememberConfirmationSent(invited);
      await signedIn();
    });

  const signIn = () =>
    run(async () => {
      startSignIn();
      const refused = await withHumanCheck(human.check, async (check) =>
        refusalOf(
          await authClient().signIn.email({
            email: invited,
            password,
            fetchOptions: { headers: humanCheckHeaders(check) },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        if (refused.status === 401) {
          setWrong(true);
          // The wrong password goes, so the next try starts on an empty field.
          setPassword("");
        } else setError(refusal(refused));
        return;
      }
      haptics.success();
      await signedIn();
    });

  const sendReset = () =>
    run(async () => {
      // The reset's link lands on the sign-in: the invitation waits there, and is accepted once the person is in.
      rememberInvite(token, "email", mail);
      const refused = await withHumanCheck(human.check, async (check) =>
        refusalOf(
          await authClient().requestPasswordReset({
            email: invited,
            redirectTo: "/reset-password",
            fetchOptions: { headers: humanCheckHeaders(check) },
          }),
        ),
      );
      if (refused) return setError(refusal(refused));
      haptics.success();
      go("sent");
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as a provider's session arrives
  useEffect(() => {
    if (!session.signedIn || !viaProvider.current) return;
    viaProvider.current = false;
    void run(join);
  }, [session.signedIn]);

  const ready =
    step === "name"
      ? name.trim() !== ""
      : step === "newPassword"
        ? passwordState(password) === "ok"
        : step === "password"
          ? password.length > 0
          : step === "forgot";

  const submit = () => {
    if (!ready || pending) return;
    if (step === "name") go("newPassword");
    else if (step === "newPassword" && nameIsPassword(name, password)) {
      setPassword("");
      go("name");
      setError(t("auth.flow.nameIsPassword"));
    } else if (step === "newPassword") void signUp();
    else if (step === "password") void signIn();
    else if (step === "forgot") void sendReset();
  };

  const first = firstName(name);
  // A personal workspace's words (ADR 0159): never its name ("Personal"), who invited instead.
  const calledYou = by
    ? t(modeKey(preview, "invite.calledYou"), { name: by, org })
    : t(modeKey(preview, "invite.calledYouNoName"), { org });
  const providerNames = linked.map((p) => t(`auth.provider.${p}`)).join(" · ");
  const mailApp = webmailOf(invited);
  const bubble: Record<EmailStep, [string, string?]> = {
    name: [
      by ? t(modeKey(preview, "invite.hello"), { name: by, org }) : t(modeKey(preview, "invite.helloNoName"), { org }),
      t(modeKey(preview, "invite.nameLead")),
    ],
    newPassword: [
      first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword"),
      t(modeKey(preview, "invite.newPasswordLead"), { org }),
    ],
    password: wrong ? [t("auth.flow.wrong")] : [calledYou, t("mobile.invite.join.passwordLead")],
    social:
      linked.length > 0
        ? [calledYou, t("invite.socialLead", { providers: providerNames })]
        : [t("auth.flow.noPassword"), t("auth.flow.noPasswordLead")],
    forgot: [t("auth.flow.forgot"), t("auth.flow.forgotLead")],
    sent: [t("auth.flow.sent", { email: invited }), t("auth.flow.sentLead")],
  };
  const [title, lead] = bubble[step];
  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : step === "sent" ? "happy" : undefined;
  const enterLabel = t(modeKey(preview, "invite.enter"), { org });
  const passwordField = (fresh: boolean) => (
    <Locked when={pending} keepKeyboard>
      <PasswordField
        value={password}
        onChangeText={(value) => {
          setPassword(value);
          setWrong(false);
        }}
        fresh={fresh}
        onSecretChange={setSecret}
        onShow={() => {
          setWink(true);
          setTimeout(() => setWink(false), 900);
        }}
        onSubmitEditing={submit}
        label={fresh ? t("invite.createPassword") : t("auth.password")}
      />
    </Locked>
  );
  const enterButton = (
    <Button variant="primary" wide label={enterLabel} loading={pending} disabled={!ready || pending} onPress={submit} />
  );

  let body: ReactNode = null;
  switch (step) {
    case "name":
      body = (
        <>
          <LockedEmail email={invited} />
          <OrgLine
            agent={preview.agents?.[0]}
            strong={
              isPersonal(preview)
                ? preview.invitedBy
                  ? t("invite.personalName", { name: preview.invitedBy })
                  : t("invite.personalNameNoName")
                : preview.invitedBy
                  ? t("invite.from", { name: preview.invitedBy })
                  : org
            }
            text={crew ?? undefined}
          />
          <AuthField
            value={name}
            onChangeText={setName}
            placeholder={t("auth.flow.namePlaceholder")}
            accessibilityLabel={t("auth.yourName")}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="go"
            enablesReturnKeyAutomatically
            onSubmitEditing={submit}
            autoFocus
          />
          {error ? <ErrorLine error={error} /> : <NameHint name={name} />}
          <Button variant="primary" wide label={t("auth.flow.continue")} disabled={!ready} onPress={submit} />
          {apple.length > 0 ? (
            <View onTouchStart={startProvider}>
              <SocialButtons providers={apple} divider={false} onError={setError} callbackURL={callbackURL} />
            </View>
          ) : null}
        </>
      );
      break;
    case "newPassword":
      body = (
        <>
          <LockedEmail email={invited} />
          {passwordField(true)}
          <ErrorLine error={error} />
          {enterButton}
        </>
      );
      break;
    case "password":
      body = (
        <>
          <LockedEmail email={invited} />
          {passwordField(false)}
          <ErrorLine error={error} />
          {enterButton}
          {canReset ? (
            <Locked when={pending} keepKeyboard>
              <Quiet label={t("auth.forgotPassword")} onPress={() => go("forgot")} />
            </Locked>
          ) : null}
        </>
      );
      break;
    case "social":
      body = (
        <>
          <LockedEmail email={invited} />
          <ErrorLine error={error} />
          {linked.length > 0 ? (
            <View onTouchStart={startProvider}>
              <SocialButtons providers={linked} divider={false} onError={setError} callbackURL={callbackURL} />
            </View>
          ) : null}
          {canReset ? <Quiet label={t("auth.flow.createPassword")} onPress={() => go("forgot")} /> : null}
        </>
      );
      break;
    case "forgot":
      body = (
        <>
          <LockedEmail email={invited} />
          <ErrorLine error={error} />
          <Button variant="primary" wide label={t("auth.flow.sendLink")} loading={pending} onPress={submit} />
        </>
      );
      break;
    case "sent":
      body = (
        <>
          {mailApp ? (
            <Button
              variant="primary"
              wide
              icon="mail"
              label={t("auth.flow.openMail", { app: mailApp.name })}
              onPress={() => void Linking.openURL(mailApp.url)}
            />
          ) : null}
          <Button variant="secondary" wide label={t("auth.flow.backToSignIn")} onPress={() => go(start)} />
        </>
      );
      break;
  }

  return (
    <AuthScaffold
      title={title}
      subtitle={lead}
      stepKey={step}
      onBack={onBack}
      agentMode={pending ? "run" : "idle"}
      expression={expression}
      overlay={human.view}
      footer={step === "name" || step === "newPassword" ? <InviteTerms /> : null}
      // The team you're invited to, on the sky, before any field; later steps keep the app's agent.
      hero={
        step === start && (preview.agents?.length ?? 0) > 0 ? <InviteCrew agents={preview.agents ?? []} /> : undefined
      }
    >
      {body}
    </AuthScaffold>
  );
}
