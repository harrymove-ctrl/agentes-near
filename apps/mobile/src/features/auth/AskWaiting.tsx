import { invitationQuery, keys, useApi } from "@agenteschat/client";
import { ANSWER_POLL_MS } from "@agenteschat/client/lib/join-requests";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { signInOneTime } from "@/lib/auth";
import { writeValue } from "@/lib/storage";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { Button, CARD_PAD, Card, haptics, Icon, LineIcon, PixelOrbit, Text, useTheme } from "@/ui";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { rememberSignIn } from "@/ui/auth/SocialButtons";
import { router } from "@/ui/navigation";
import { LAST_EMAIL } from "./AuthFlow";
import { arriveIn } from "./arrive";
import { forgetAsk, rememberInvite } from "./invite";
import { InviteCrew, Said, useLeaveInvite } from "./invite-parts";
import { type Answer, type Asked, claimAnswer, claimFailedForNow } from "./invite-steps";

/** How long "Aprovado" shows before the workspace opens: long enough to read it. */
const ENTER_MOMENT_MS = 1200;
/** How long the one-time sign-in's session gets to arrive before the screen falls back to signing in by hand. */
const SIGN_IN_WAIT_MS = 15_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Asked: the screen waits for an admin, checking while it's in front with the key the ask answered (ADR 0090 §3).
 * Approved, it signs in with the answer's one-time sign-in and opens the workspace, nothing typed again; turned down,
 * the admin's note; ended (run out, its link turned off, approved for an account that was already there, a key the
 * server no longer knows), signing in as always. A check that fails for a moment (no connection, a deploy) never ends
 * it: the key stays and the next check tries again. Everything it says comes from `asked`, so closing the app and
 * opening it, offline even, lands here.
 */
export function AskWaiting({ asked }: { asked: Asked }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const gate = useOrgGate();
  const leave = useLeaveInvite();
  const focused = useIsFocused();
  const started = useRef(false);
  const opened = useRef(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  // The one-time sign-in went through: the session arrives a moment later.
  const [signedIn, setSignedIn] = useState(false);
  const { token, org } = asked;
  // The team the request goes to, on the sky (the invitation's preview: its first agents); the screen never waits on
  // it, they rise in when it comes.
  const preview = useQuery({ ...invitationQuery(api, token), retry: false });
  const agents = preview.data?.agents ?? [];
  // A personal workspace's words once its invitation is read (ADR 0159): never its name ("Personal").
  const words = preview.data ?? null;
  const crew = (happy: boolean) => (agents.length > 0 ? <InviteCrew agents={agents} happy={happy} /> : undefined);
  const claim = useQuery({
    // The key stays out of the query's key, and its answer out of the cache once read: one signs in, for now.
    queryKey: [...keys.invitation(token), "claim"],
    // null ends the wait: a key that matches nothing (404) or a check the server refused. A failure for a moment
    // leaves the screen waiting for the next check, however long it lasts: ending would lose the key.
    queryFn: async () => {
      try {
        return await api.invites.claim(token, asked.key);
      } catch (error) {
        if (claimFailedForNow(error)) throw error;
        return null;
      }
    },
    enabled: answer === null && focused,
    refetchInterval: ANSWER_POLL_MS,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const got = claim.data;

  /** Approved: "Aprovado" for a moment while the one-time sign-in goes through, then the session. */
  const enter = async (orgId: string, signIn: string) => {
    if (started.current) return;
    started.current = true;
    const [ok] = await Promise.all([signInOneTime(signIn), pause(ENTER_MOMENT_MS)]);
    if (!ok) return setAnswer({ state: "signIn", orgId });
    rememberSignIn("email");
    void writeValue(LAST_EMAIL, asked.email);
    setSignedIn(true);
    await session.refresh().catch(() => {});
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer once; signing in starts on the first
  useEffect(() => {
    if (answer !== null || got === undefined) return;
    const next = claimAnswer(got);
    if (!next) return;
    // Whatever it says, it's the last word: the checks stop, and opening the app no longer returns here.
    forgetAsk();
    setAnswer(next);
    if (got?.status === "in") {
      haptics.success();
      void enter(got.orgId, got.signIn);
    } else if (next.state === "denied") haptics.warning();
  }, [got]);

  const orgId = answer?.state === "in" ? answer.orgId : null;
  const arrived = signedIn && session.signedIn;

  // The session arrived: into the workspace, its account's only one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the session arrives
  useEffect(() => {
    if (!arrived || !orgId || opened.current) return;
    opened.current = true;
    void qc.invalidateQueries({ queryKey: keys.me }).then(() => {
      gate.choose(orgId);
      void arriveIn(api, orgId);
    });
  }, [arrived, orgId]);

  // Never a screen that waits forever: the account exists, and its password is the one just chosen.
  useEffect(() => {
    if (!signedIn || arrived || !orgId) return;
    const timer = setTimeout(() => setAnswer({ state: "signIn", orgId }), SIGN_IN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [signedIn, arrived, orgId]);

  /** Signing in as always, with the address it asked with: to the answer, or for an ended request back to its link. */
  const signInByHand = (ended: boolean) => {
    if (ended) rememberInvite(token, "link");
    router.replace({ pathname: "/sign-in", params: { email: asked.email } });
  };

  if (answer?.state === "in")
    return (
      <AuthScaffold
        title={t(modeKey(words, "invite.ask.approvedIn"), { org })}
        stepKey="in"
        expression="happy"
        hero={crew(true)}
      >
        <WaitCard title={t(modeKey(words, "invite.entering"), { org })} sub={t("invite.enteringReady")} />
      </AuthScaffold>
    );
  if (answer?.state === "signIn")
    return (
      <AuthScaffold title={t("invite.ask.signInTitle")} subtitle={t("invite.ask.signInLead")} stepKey="signIn">
        <Button variant="primary" wide label={t("auth.signIn")} onPress={() => signInByHand(false)} />
      </AuthScaffold>
    );
  if (answer?.state === "denied")
    return (
      <AuthScaffold
        title={t("invite.ask.deniedTitle")}
        subtitle={t(modeKey(words, "invite.ask.deniedText"), { org })}
        stepKey="denied"
        expression="closed"
        onBack={leave}
      >
        {answer.reason ? <Said reason={answer.reason} /> : null}
      </AuthScaffold>
    );
  if (answer?.state === "ended")
    return (
      <AuthScaffold
        title={t("invite.ask.endedTitle")}
        subtitle={t("invite.ask.endedLead")}
        stepKey="ended"
        onBack={leave}
      >
        <Button variant="primary" wide label={t("auth.signIn")} onPress={() => signInByHand(true)} />
      </AuthScaffold>
    );
  return (
    <AuthScaffold
      title={t(modeKey(words, "invite.ask.waitTitle"), { org })}
      subtitle={t("mobile.invite.join.waitLeadOpen")}
      stepKey="wait"
      expression="happy"
      onBack={leave}
      hero={crew(false)}
    >
      <WaitCard
        title={t(modeKey(words, "invite.ask.waitCard"), { org })}
        sub={asked.name ? t("invite.ask.waitBy", { name: asked.name, email: asked.email }) : asked.email}
      />
      <LockLine text={t("invite.ask.waitLock")} />
    </AuthScaffold>
  );
}

/** Something under way: the pixel orbit beside what for and whose, on a card. */
function WaitCard({ title, sub }: { title: string; sub: string }) {
  return (
    <Card>
      <View style={styles.wait}>
        <LineIcon variant="subhead" size={16}>
          <PixelOrbit color="sky" size={16} />
        </LineIcon>
        <View style={styles.grow}>
          <Text variant="subhead" style={styles.strong}>
            {title}
          </Text>
          <Text variant="footnote" tone="muted">
            {sub}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/** What happens to the account, promised under the wait. */
function LockLine({ text }: { text: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.lock}>
      <View style={styles.lockIcon}>
        <Icon name="lock" size={15} color={c.muted} />
      </View>
      <Text variant="footnote" tone="muted" style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The orbit on the title's line, never centered between the title and the line under it.
  wait: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: CARD_PAD },
  grow: { flex: 1, minWidth: 0 },
  strong: { fontWeight: "600" },
  lock: { flexDirection: "row", gap: 8, marginTop: 4 },
  lockIcon: { marginTop: 2 },
});
