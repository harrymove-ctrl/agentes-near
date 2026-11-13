import {
  ApiError,
  type AskToJoinResult,
  type InvitationPreview,
  invitationQuery,
  keys,
  useApi,
  useAuthConfig,
  useMe,
} from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { errorCode, invitedErrorText } from "@agenteschat/client/lib/errors";
import { type HumanCheck, withHumanCheck } from "@agenteschat/client/lib/human-check";
import {
  ANSWER_POLL_MS,
  askView,
  CODE_LENGTH,
  JOIN_NAME_MAX,
  JOIN_NOTE_MAX,
  sendsEmail,
  typedCode,
} from "@agenteschat/client/lib/join-requests";
import { emailTypoFix, isEmail } from "@agenteschat/client/lib/text";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { useNow } from "@/features/shared/hooks";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { Button, haptics, Icon, InfoHint, Locked, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { AskWaiting } from "./AskWaiting";
import { arriveIn } from "./arrive";
import { EmailSteps } from "./EmailSteps";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, failureText } from "./human-check";
import { InviteGone, InviteLoadFailed, InviteLoading } from "./InviteGone";
import { forgetInvite, keepAsk, rememberInvite, waitingAsk } from "./invite";
import { AgentsThere, DidYouMean, LeaveButton, Said, useLeaveInvite } from "./invite-parts";
import type { Asked } from "./invite-steps";
import { LinkSteps } from "./LinkSteps";

/**
 * An invitation's link opened in the app. A request this phone made through it still waits: its screen, which needs
 * nothing from the server to show (`AskWaiting`, ADR 0090 §3), and it goes on through the signing in that ends it, so
 * the invitation's other screens never flash on the way in.
 */
export function InviteScreen({ token, mail }: { token: string; mail?: string }) {
  const [asked, setAsked] = useState<Asked | null>(() => {
    const waiting = waitingAsk();
    return waiting?.token === token ? waiting : null;
  });
  if (asked) return <AskWaiting asked={asked} />;
  return (
    <Invitation
      token={token}
      mail={mail}
      onAsked={(next) => {
        keepAsk(next);
        setAsked(next);
      }}
    />
  );
}

/**
 * What the link says, read from the server. A workspace's invitation link only lets people ask to join (`AskToJoin`,
 * `LinkSteps`). An email invitation: paused, deleting or full says so before anyone makes an account (ADR 0090 §6);
 * signed out, it asks only what's missing (`EmailSteps`); signed in, one tap to join, as the invited address. One
 * that no longer opens says what happened to it (`InviteGone`).
 */
function Invitation({ token, mail, onAsked }: { token: string; mail?: string; onAsked: (asked: Asked) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const gate = useOrgGate();
  const me = useMe();
  const { colors: c } = useTheme();
  const preview = useQuery(invitationQuery(api, token));
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // The steps signed in from here: they stay up while the session arrives and `me` reloads, until joining ends.
  const [signingIn, setSigningIn] = useState(false);

  if (preview.isPending || (session.signedIn && me.isPending && !signingIn)) return <InviteLoading />;
  const invitation = preview.data;
  if (invitation === undefined)
    return <InviteLoadFailed retrying={preview.isFetching} retry={() => void preview.refetch()} />;
  if (invitation === null) return <InviteGone token={token} />;
  if (invitation.kind === "link") return <LinkInvitation token={token} preview={invitation} onAsked={onAsked} />;
  // Paused, or being deleted: it takes nobody, as a closed link says.
  if (invitation.closed) {
    return (
      <AuthScaffold title={t("invite.ask.closedTitle")} subtitle={t("invite.ask.closedText")} expression="closed">
        <LeaveButton />
      </AuthScaffold>
    );
  }

  const org = invitation.orgName;
  if (invitation.full) {
    return (
      <AuthScaffold title={t(modeKey(invitation, "invite.fullTitle"), { org })} subtitle={t("invite.fullLead")}>
        <Text variant="small" tone="muted" style={CENTER}>
          {t("invite.fullFine")}
        </Text>
        <LeaveButton />
      </AuthScaffold>
    );
  }

  const join = async () => {
    setJoining(true);
    setError(null);
    try {
      const { orgId } = await api.orgs.acceptInvitation(token, mail);
      forgetInvite();
      await qc.invalidateQueries({ queryKey: keys.me });
      gate.choose(orgId);
      void arriveIn(api, orgId);
    } catch (e) {
      const wrong = e instanceof ApiError && e.status === 403;
      setError(
        invitedErrorText(t, e) ??
          (wrong ? t("mobile.invite.wrongAccount", { email: invitation.email }) : t("mobile.invite.failed")),
      );
      // Signed in now, the account stays: what's below says why, and trying again only accepts.
      setSigningIn(false);
      // One that stopped working meanwhile then says what happened to it.
      void qc.invalidateQueries({ queryKey: keys.invitation(token) });
    } finally {
      setJoining(false);
    }
  };

  if (!session.signedIn || signingIn) {
    return (
      <EmailSteps token={token} mail={mail} preview={invitation} onSigningIn={() => setSigningIn(true)} join={join} />
    );
  }

  const by = invitation.invitedBy ? invitation.invitedBy.split(/\s+/)[0] : null;
  // A personal workspace's name ("Personal") says nothing to who is invited: who invited does (ADR 0159).
  const personal = isPersonal(invitation);
  const title = personal
    ? by
      ? t("invite.calledYouPersonal", { name: by })
      : t("invite.calledYouNoNamePersonal")
    : by
      ? t("mobile.invite.invitedBy", { name: by, org })
      : t("mobile.invite.invited", { org });
  const role = t(`roles.${invitation.role}Lower`);
  const user = me.data?.user;
  const matches = user ? user.email.toLowerCase() === invitation.email.toLowerCase() : false;

  return (
    <AuthScaffold title={title} subtitle={t("mobile.invite.joinAs", { role })}>
      <AgentsThere agents={invitation.agents ?? []} more={invitation.moreAgents ?? 0} />
      <View style={[styles.locked, { backgroundColor: c.sunken }]}>
        <InfoHint name={t("common.about", { label: t("auth.email") })} text={t("invite.emailHelp")}>
          <Text variant="body" numberOfLines={1}>
            {invitation.email}
          </Text>
        </InfoHint>
      </View>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}
      {matches ? (
        <Button
          variant="primary"
          wide
          label={personal ? t("invite.enterPersonal") : t("mobile.invite.accept", { org })}
          disabled={joining}
          onPress={() => void join()}
        />
      ) : (
        <>
          <Text variant="small" tone="muted" style={CENTER}>
            {t("mobile.invite.wrongAccount", { email: invitation.email })}
          </Text>
          <Button
            variant="secondary"
            wide
            label={t("mobile.invite.otherAccount")}
            // Signed out, this same screen goes on to the invited address's own step.
            onPress={() => void signOut()}
          />
        </>
      )}
    </AuthScaffold>
  );
}

/**
 * Which way a link asks: one question per screen when signed out where email goes out (`LinkSteps`, ADR 0090 §1);
 * the account's own form when signed in, the typed form of ADR 0068 where no email goes out, and a link that no longer
 * works (`AskToJoin`).
 */
function LinkInvitation({
  token,
  preview,
  onAsked,
}: {
  token: string;
  preview: InvitationPreview;
  onAsked: (asked: Asked) => void;
}) {
  const session = useSession();
  const emails = sendsEmail(useAuthConfig().data);
  if (session.signedIn || preview.closed || !emails) return <AskToJoin token={token} preview={preview} />;
  return <LinkSteps token={token} preview={preview} onAsked={onAsked} />;
}

/**
 * A workspace's invitation link (ADR 0068) outside `LinkSteps`: an admin of the workspace approves each person.
 * Signed in their account asks, and the screen checks for the answer while it is open; where no email goes out they
 * type a name and an email, and no account is made. The same states as the web's page (`askView`).
 */
function AskToJoin({ token, preview }: { token: string; preview: InvitationPreview }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const gate = useOrgGate();
  const me = useMe();
  const config = useAuthConfig();
  const user = session.signedIn ? (me.data?.user ?? null) : null;
  const [sent, setSent] = useState<AskToJoinResult | null>(null);
  const view = askView(preview, sent !== null);
  useQuery({
    queryKey: keys.invitation(token),
    queryFn: () => api.orgs.previewInvitation(token),
    retry: false,
    refetchInterval: user && (view.state === "sent" || view.state === "approvedEmail") ? ANSWER_POLL_MS : false,
  });
  // Let in by an approval: the account's workspaces are fetched again at once, since the root shows the first run to
  // an account with none, and leaving by Back (not "Open {org}") would otherwise lead there.
  const joined = view.state === "in" && !view.already;
  useEffect(() => {
    if (joined) void qc.invalidateQueries({ queryKey: keys.me });
  }, [joined, qc]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // The code that proved the account's address (for 30 minutes).
  const [proof, setProof] = useState<string | null>(null);
  const leave = useLeaveInvite();
  const emailField = useRef<ComponentRef<typeof AuthField>>(null);
  const noteField = useRef<ComponentRef<typeof AuthField>>(null);

  const org = preview.orgName;
  const address = sent?.email ?? preview.you?.email ?? user?.email ?? "";
  const emailsGoOut = sent?.emailed ?? sendsEmail(config.data);
  // On a server that sends email, an account whose address isn't confirmed proves it first (ADR 0072).
  const proofNeeded = emailsGoOut && user !== null && !user.emailVerified;
  const proven = proof !== null;
  const human = useHumanCheck(view.state === "form" && proofNeeded ? "ask-code" : null);
  const fix = user ? null : emailTypoFix(email);
  const ready = (user !== null || (name.trim() !== "" && isEmail(email))) && (!proofNeeded || proven);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.invitation(token) });
  const onProven = (code: string) => {
    setProof(code);
    noteField.current?.focus();
  };

  const ask = async () => {
    if (!ready || asking) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.invites.ask(token, {
        ...(user ? {} : { name: name.trim(), email: email.trim() }),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(proofNeeded && proof ? { code: proof } : {}),
      });
      haptics.success();
      setSent(result);
      if (user) await refresh();
    } catch (e) {
      haptics.warning();
      // The proof ran out (30 minutes) or was used: Verify again.
      if (errorCode(e)?.startsWith("join.code_")) setProof(null);
      setError((e instanceof ApiError ? invitedErrorText(t, e) : null) ?? failureText(t, e));
      // A link turned off, or an answer already given, then shows as its own state.
      void refresh();
    } finally {
      setAsking(false);
    }
  };

  let title: string;
  let subtitle: string | undefined;
  let expression: "happy" | "closed" | undefined;
  let body: ReactNode = null;
  switch (view.state) {
    case "closed":
      title = t("invite.ask.closedTitle");
      subtitle = t("invite.ask.closedText");
      expression = "closed";
      body = <LeaveButton />;
      break;
    case "in": {
      const orgId = view.orgId;
      title = view.already
        ? t(modeKey(preview, "invite.ask.memberTitle"), { org })
        : t(modeKey(preview, "invite.ask.inTitle"), { org });
      expression = "happy";
      body = orgId ? (
        <Button
          variant="primary"
          wide
          label={t(modeKey(preview, "invite.ask.open"), { org })}
          onPress={() =>
            void qc.invalidateQueries({ queryKey: keys.me }).then(() => {
              gate.choose(orgId);
              void arriveIn(api, orgId);
            })
          }
        />
      ) : null;
      break;
    }
    case "approvedEmail":
      title = t("invite.ask.approvedTitle");
      subtitle = emailsGoOut ? t("invite.ask.approvedEmail", { email: address }) : t("invite.ask.approvedNoEmail");
      expression = "happy";
      break;
    case "denied":
      title = t("invite.ask.deniedTitle");
      expression = "closed";
      if (view.reason)
        body = (
          <>
            <Said reason={view.reason} />
            <Text variant="callout" tone="muted" style={CENTER}>
              {t(modeKey(preview, "invite.ask.deniedText"), { org })}
            </Text>
          </>
        );
      else subtitle = t(modeKey(preview, "invite.ask.deniedText"), { org });
      break;
    case "sent":
      title = t("invite.ask.sentTitle");
      subtitle = user?.emailVerified
        ? t("invite.ask.sentAccount", { org })
        : emailsGoOut
          ? t("invite.ask.sentEmail", { org, email: address })
          : t("invite.ask.sentNoEmail", { org });
      expression = "happy";
      break;
    case "form":
      title = t(modeKey(preview, "invite.ask.title"), { org });
      subtitle = preview.invitedBy
        ? t("invite.ask.lead", { name: preview.invitedBy.split(/\s+/)[0], org })
        : t("invite.ask.leadNoName", { org });
      body = (
        <>
          <AgentsThere agents={preview.agents ?? []} more={preview.moreAgents ?? 0} />
          {user && !proofNeeded ? (
            <View style={styles.as}>
              <Text variant="subhead" tone="muted">
                {t("invite.ask.as", { email: user.email })}
              </Text>
              <NotYou />
            </View>
          ) : null}
          {user ? null : (
            <Locked when={asking}>
              <AuthField
                value={name}
                onChangeText={setName}
                placeholder={t("invite.ask.name")}
                accessibilityLabel={t("invite.ask.name")}
                maxLength={JOIN_NAME_MAX}
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                returnKeyType="next"
                onSubmitEditing={() => emailField.current?.focus()}
              />
            </Locked>
          )}
          {user && proofNeeded ? (
            // The account's own address, read-only, takes the place of "You'll ask as".
            <EmailProof token={token} email={user.email} proven={proven} onProven={onProven} check={human.check}>
              <View style={styles.as}>
                <NotYou />
              </View>
            </EmailProof>
          ) : user ? null : (
            <Locked when={asking} style={styles.field}>
              <AuthField
                ref={emailField}
                value={email}
                onChangeText={setEmail}
                placeholder={t("invite.ask.email")}
                accessibilityLabel={t("invite.ask.email")}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="done"
              />
              {fix ? <DidYouMean fix={fix} onFix={setEmail} /> : null}
            </Locked>
          )}
          <Locked when={asking} style={styles.field}>
            <Text variant="subhead" tone="muted">
              {t("invite.ask.note")}
            </Text>
            <AuthField
              ref={noteField}
              value={note}
              onChangeText={setNote}
              placeholder={t("invite.ask.noteHelp")}
              accessibilityLabel={t("invite.ask.note")}
              maxLength={JOIN_NOTE_MAX}
              multiline
              textAlignVertical="top"
              minHeight={84}
            />
          </Locked>
          {error ? (
            <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
              {error}
            </Text>
          ) : null}
          <Button
            variant="primary"
            wide
            label={t("invite.ask.send")}
            loading={asking}
            disabled={!ready}
            onPress={() => void ask()}
          />
          {user ? null : (
            <AuthLink
              lead={t("invite.ask.haveAccount")}
              label={t("auth.signIn")}
              onPress={() => {
                rememberInvite(token, "link");
                // The address typed here goes along, so the sign-in starts at the password.
                router.push({ pathname: "/sign-in", params: isEmail(email) ? { email: email.trim() } : {} });
              }}
            />
          )}
        </>
      );
      break;
  }

  return (
    <AuthScaffold
      title={title}
      subtitle={subtitle}
      stepKey={view.state}
      onBack={leave}
      agentMode={asking ? "run" : "idle"}
      expression={expression}
      overlay={human.view}
    >
      {body}
    </AuthScaffold>
  );
}

/** "Not you? Sign out", for the account the page asks as. */
function NotYou() {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={() => void signOut()}
      accessibilityRole="link"
      hitSlop={12}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <Text variant="subhead" style={styles.link}>
        {t("invite.ask.notYou")}
      </Text>
    </Pressable>
  );
}

/** What the slot inside the email's right edge shows: every one is laid out, so the slot never changes width. */
const SLOTS = ["verify", "wait", "resend", "verified"] as const;
type Slot = (typeof SLOTS)[number];

/**
 * The signed-in account's address, read-only, with Verify inside its right edge (ADR 0072): a code goes to it, and
 * typed back here it proves it. Verify, the countdown, Resend and Verified share one slot as wide as the longest, so
 * the address never moves. `children` go under the email.
 */
function EmailProof({
  token,
  email,
  proven,
  onProven,
  check,
  children,
}: {
  token: string;
  email: string;
  proven: boolean;
  onProven: (code: string) => void;
  check: HumanCheck | null;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { colors: c } = useTheme();
  const key = email.trim().toLowerCase();
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<{ email: string; text: string } | null>(null);
  // Past the address's hourly or daily cap, each press is a sure 429 that still spends the link's shared budget.
  const [capped, setCapped] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [slotWidth, setSlotWidth] = useState(0);
  const codeField = useRef<ComponentRef<typeof AuthField>>(null);
  const out = sent?.email === key;
  const left = out && sent ? Math.max(0, sent.resendAt - Date.now()) : 0;
  // A repaint every second while the countdown runs; the time itself is read just above.
  useNow(left > 0 && !proven ? 1000 : 60_000);
  const said = error?.email === key ? error.text : null;
  const showCode = out && !proven;
  const slot: Slot = proven ? "verified" : !out ? "verify" : left > 0 ? "wait" : "resend";

  // Each code that goes out takes the focus once.
  useEffect(() => {
    if (sent) codeField.current?.focus();
  }, [sent]);

  const codeOut = (to: string, resendIn: number) => {
    setSent({ email: to, resendAt: Date.now() + resendIn * 1000 });
    setCode("");
    setError(null);
  };
  const send = async () => {
    const to = key;
    setSending(true);
    try {
      const r = await withHumanCheck(check, (humanCheck) => api.invites.sendCode(token, {}, humanCheck));
      codeOut(to, r.resendIn);
    } catch (e) {
      if (e instanceof CheckCancelled) return;
      // A code went out a moment ago (another try, another device): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "join.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(to, retryIn);
      else setError({ email: to, text: failureText(t, e) });
      if (errorCode(e) === "join.code_limit") setCapped(to);
    } finally {
      setSending(false);
    }
  };
  const checkCode = async (typed: string) => {
    const to = key;
    setChecking(true);
    try {
      await api.invites.checkCode(token, { code: typed });
      setError(null);
      haptics.success();
      AccessibilityInfo.announceForAccessibility(t("invite.ask.verified"));
      onProven(typed);
    } catch (e) {
      haptics.warning();
      setCode("");
      setError({ email: to, text: failureText(t, e) });
      codeField.current?.focus();
    } finally {
      setChecking(false);
    }
  };
  const typed = (value: string) => {
    if (checking) return;
    const digits = typedCode(value);
    setCode(digits);
    if (digits.length === CODE_LENGTH) void checkCode(digits);
  };

  const errorLine = (text: string) => (
    <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
      {text}
    </Text>
  );
  return (
    <>
      <View style={styles.field}>
        <View style={styles.inside}>
          <AuthField
            value={email}
            editable={false}
            placeholder={t("invite.ask.email")}
            accessibilityLabel={t("invite.ask.email")}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="done"
            paddingRight={slotWidth + 12}
          />
          <View style={styles.slot} onLayout={(e) => setSlotWidth(Math.ceil(e.nativeEvent.layout.width))}>
            {SLOTS.map((s) => {
              const shown = s === slot;
              const press = s === "verify" || s === "resend";
              const off = capped === key;
              return (
                <Pressable
                  key={s}
                  onPress={() => void send()}
                  disabled={!shown || !press || off || sending}
                  hitSlop={6}
                  accessibilityRole={press ? "button" : "text"}
                  accessibilityLabel={
                    s === "wait"
                      ? t("invite.ask.resendIn", { count: Math.ceil(left / 1000) })
                      : s === "verified"
                        ? t("invite.ask.verified")
                        : undefined
                  }
                  accessibilityState={press ? { disabled: off || sending, busy: sending } : undefined}
                  accessibilityElementsHidden={!shown}
                  importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
                  style={({ pressed }) => [
                    styles.slotItem,
                    shown ? null : styles.slotHidden,
                    pressed && press ? styles.pressed : null,
                  ]}
                >
                  {s === "verified" ? (
                    <Icon name="check" size={20} color={c.ok} />
                  ) : s === "wait" ? (
                    <Text variant="subhead" tone="muted" style={styles.tabular}>
                      {formatTimeLeft(left)}
                    </Text>
                  ) : (
                    <>
                      {/* Sending, the label keeps its width under the spinner. */}
                      <Text
                        variant="subhead"
                        tone={off ? "faint" : "ink"}
                        style={[styles.link, shown && sending ? styles.ghost : null]}
                      >
                        {t(s === "verify" ? "invite.ask.verify" : "invite.ask.resend")}
                      </Text>
                      {shown && sending ? <ActivityIndicator color={c.muted} style={StyleSheet.absoluteFill} /> : null}
                    </>
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
        {said && !showCode ? errorLine(said) : null}
        {children}
      </View>
      {showCode ? (
        <Locked when={checking} style={styles.field}>
          <AuthField
            ref={codeField}
            code
            value={code}
            onChangeText={typed}
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
          />
          {said ? errorLine(said) : null}
        </Locked>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  locked: { gap: 2, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
  field: { gap: 6 },
  as: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 6, rowGap: 2 },
  link: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  // Verify's slot sits inside the email's right edge, as the password's eye does.
  inside: { justifyContent: "center" },
  slot: { position: "absolute", right: 4, alignItems: "center" },
  slotItem: { minHeight: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  // Laid out for its width, with no height: the slot is as wide as its longest label.
  slotHidden: { height: 0, minHeight: 0, opacity: 0, overflow: "hidden" },
  ghost: { opacity: 0 },
  tabular: { fontVariant: ["tabular-nums"] },
});
