import type { AccountLoginStart, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAccountLogin, useAiAccounts, useApi } from "@agenteschat/client";
import { accountTitle, reusableAccount, signInOf } from "@agenteschat/client/lib/ai-accounts";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import {
  beginLogin,
  freeDuplicate,
  isSignInCode,
  loginRead,
  loginReadPasses,
  otherThanHint,
} from "@agenteschat/client/lib/machines";
import { GEMINI_ENTERPRISE_PROVIDER, planKeyFits, signInKey } from "@agenteschat/client/lib/plans";
import { accountCodeAad } from "@agenteschat/client/lib/secret-box";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { sealSecret } from "@/lib/secret-box";
import { Button, InkOrbit, Text, useTheme } from "@/ui";
import { useAiOrg } from "./org";
import { Note, OpenPage, openPage, PasteField, Step, StepsCard, StepText, Waiting } from "./parts";

/*
 * "Adicionar conta" as on the web (ADR 0041 §2, ADR 0059): the computer starts the provider's own sign-in and its
 * page opens here, in the in-app browser: the account chosen there is the one connected. Claude: the code Claude
 * shows goes to the computer by itself as soon as it lands in the field ("Colar", a paste or typed) when it is this
 * sign-in's; anything else waits for "Enviar", with a line under it. Either way it is sealed on the phone to the
 * computer's key (ADR 0027). ChatGPT: device code sign-in allowed in its settings first, then
 * the device page and the one-time code to type there. Cursor: its sign-in page, and the computer finishes by itself;
 * or, chosen under it, a Cursor API key, sent like a plan's key. A coding plan: its own key page, then the key, sealed the
 * same way; it never reaches our server. Every start is a tap; leaving stops the sign-in on the computer. Reads that
 * fail while the server restarts or the computer reconnects say Reconectando, and the same sign-in goes on
 * (`loginRead`).
 */

/** Where ChatGPT allows signing in with a code (Settings › Security): Codex's device sign-in needs it. */
const CHATGPT_SECURITY = "https://chatgpt.com/#settings/Security";

export interface AddAccountProps {
  machineId: string;
  kind: MachineAccountKind;
  computer: string;
  /** A coding plan's key account on Claude Code, or a Gemini Enterprise sign-in (`signInProviderOf`). */
  provider?: string;
  /** Sign in again to this account (signed out): same account, same agents. */
  again?: string;
  /**
   * The person already chose another account: no offer to sign in again to one they have there (`reusableAccount`),
   * which every other new sign-in makes first.
   */
  fresh?: boolean;
  /**
   * Claude's login hint, never asked: the email of the account signing in again, or of the one other agents use. A
   * sign-in that comes back as another account says so instead of thinking with it.
   */
  email?: string | null;
  /** The computer is one the person connected: its own browser may open the page itself. */
  local?: boolean;
  /** False while the computer isn't ready: nothing starts there yet, but the fields and the makers' pages work. */
  ready?: boolean;
  /** It just got ready and the page is still asking about it: what starts there waits, with the spinner. */
  loading?: boolean;
  onAdded: (account: MachineAccount) => void;
  /**
   * Where an agent is in view: the sign-in came back as an account the person already connected there, signed in and
   * thinking for no agent, and it thinks for that agent instead ("Usar x").
   */
  onUse?: (account: MachineAccount) => void;
  /**
   * Whether a sign-in begun here may still finish on the computer: a place that hides this block while its computer
   * is offline keeps it meanwhile, so the same sign-in goes on once it's back.
   */
  onSigningIn?: (on: boolean) => void;
}

export function AddAccount(props: AddAccountProps) {
  const { t } = useTranslation();
  const { orgId } = useAiOrg();
  const { colors: c } = useTheme();
  // "Tentar de novo" starts over with a new sign-in.
  const [attempt, setAttempt] = useState(0);
  // A new sign-in where the person already has that plan's account on that computer, as on the web: Entrar de novo
  // on it first (already chosen when it's signed out), Outra conta beside it. Decided once, so the account signing in
  // doesn't change it.
  const offers = !props.again && !props.email && !props.fresh;
  const ai = useAiAccounts(orgId, offers);
  const [reuse, setReuse] = useState<MachineAccount | null>();
  const [pick, setPick] = useState<"again" | "new">();
  useEffect(() => {
    if (reuse !== undefined || (offers && ai.isPending)) return;
    const found = offers
      ? reusableAccount(ai.data?.accounts, { machineId: props.machineId, kind: props.kind, provider: props.provider })
      : undefined;
    setReuse(found ?? null);
  }, [reuse, offers, ai.isPending, ai.data, props.machineId, props.kind, props.provider]);
  if (reuse === undefined) return <ActivityIndicator color={c.muted} />;
  const chosen = reuse ? (pick ?? (signInOf(reuse) === "signed_out" ? "again" : undefined)) : "new";
  const label = reuse ? accountTitle(reuse) : "";
  const another = (
    <Button size="sm" variant="secondary" label={t("connectAi.another")} onPress={() => setPick("new")} />
  );
  if (reuse && chosen === undefined)
    return (
      <View style={styles.reuse}>
        <Note icon="swap">{t("connectAi.reuse.active", { label })}</Note>
        <View style={styles.reuseActs}>
          <Button
            size="sm"
            variant="primary"
            label={t("aiAccounts.page.signInAgain")}
            onPress={() => setPick("again")}
          />
          {another}
        </View>
      </View>
    );
  return (
    <>
      {reuse && chosen === "again" && pick === undefined ? (
        <View style={styles.reuse}>
          <Note icon="swap">{t("connectAi.reuse.signedOut", { label })}</Note>
          <View style={styles.reuseActs}>{another}</View>
        </View>
      ) : null}
      <AddAccountFlow
        key={`${attempt}:${chosen}`}
        {...props}
        {...(reuse && chosen === "again" ? { again: reuse.id, email: reuse.email } : {})}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </>
  );
}

function AddAccountFlow({
  machineId,
  kind,
  computer,
  provider: planId,
  again,
  email: hint,
  local,
  ready = true,
  loading = false,
  onAdded,
  onUse,
  onSigningIn,
  onRetry,
}: AddAccountProps & { onRetry: () => void }) {
  const { t } = useTranslation();
  const { orgId } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const { colors: c } = useTheme();
  // Cursor: its sign-in, or (chosen under it) its API key, which goes like a coding plan's key.
  const [cursorKey, setCursorKey] = useState(false);
  const { plan, provider: keyProvider } = signInKey(planId, kind, cursorKey);
  // Gemini: a personal Google account, or (chosen under it, or the account's own) Gemini Enterprise.
  const [enterprise, setEnterprise] = useState(planId === GEMINI_ENTERPRISE_PROVIDER);
  const provider = keyProvider ?? (kind === "antigravity" && enterprise ? GEMINI_ENTERPRISE_PROVIDER : undefined);
  const [login, setLogin] = useState<AccountLoginStart | null>(null);
  const [starting, setStarting] = useState(false);
  // Why the sign-in didn't start, in the person's language.
  const [startFailed, setStartFailed] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // The code or key didn't go: the computer away for now (`loginReadPasses`), or refused.
  const [sendFailed, setSendFailed] = useState<"away" | "refused" | null>(null);
  const [copied, setCopied] = useState(false);
  // Signed in, but not as the account it was for (the hint): theirs to use or not.
  const [other, setOther] = useState<MachineAccount | null>(null);
  // The sign-in still running and the computer it started on, stopped when this block goes away.
  const running = useRef<{ machineId: string; loginId: string } | null>(null);
  const gone = useRef(false);
  const reported = useRef(false);
  const status = useAccountLogin(orgId, machineId, login?.loginId ?? null);
  const result = status.data;
  const read = loginRead(status);

  const begin = async (): Promise<AccountLoginStart | null> => {
    setStarting(true);
    setStartFailed(null);
    try {
      const l = await beginLogin((input) => api.machines.beginAccountLogin(orgId, machineId, kind, input), kind, {
        again,
        provider,
        hint,
      });
      if (gone.current) {
        void api.machines.cancelAccountLogin(orgId, machineId, l.loginId).catch(() => undefined);
        return null;
      }
      running.current = { machineId, loginId: l.loginId };
      setLogin(l);
      return l;
    } catch (error) {
      if (!gone.current)
        setStartFailed(knownErrorText(t, error) ?? t("agentPage.work.brain.add.startFailed", { computer }));
      return null;
    } finally {
      if (!gone.current) setStarting(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: one sign-in per mount ("Tentar de novo" remounts)
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      const run = running.current;
      running.current = null;
      if (run) void api.machines.cancelAccountLogin(orgId, run.machineId, run.loginId).catch(() => undefined);
    };
  }, []);

  const begun = login !== null;
  useEffect(() => {
    onSigningIn?.(begun);
    return () => onSigningIn?.(false);
  }, [begun, onSigningIn]);

  useEffect(() => {
    if (!result || result.state === "waiting") return;
    // Ended on the computer: nothing left to stop.
    running.current = null;
    if (result.state === "done" && result.account && !reported.current) {
      reported.current = true;
      if (otherThanHint(hint, result.account)) setOther(result.account);
      else onAdded(result.account);
    }
  }, [result, hint, onAdded]);

  const noAnswer = startFailed !== null || read === "noAnswer";
  const ended =
    other !== null || noAnswer || read === "failed" || result?.state === "failed" || result?.state === "expired";
  // The code or the key on its way to the computer, then the computer signing in with it: a line stands in for the
  // field and Enviar until the sign-in ends.
  const busy = (sending || sent) && !ended;
  const busyText = plan
    ? sent
      ? t("aiAccounts.add.keySent", { computer })
      : t("aiAccounts.add.keySending", { computer })
    : sent
      ? t("agentPage.work.brain.add.sent", { computer })
      : t("agentPage.work.brain.add.sending", { computer });
  // VoiceOver has no live regions: the line is said as it comes and as it changes.
  useEffect(() => {
    if (busy && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(busyText);
  }, [busy, busyText]);
  // For the agent in view: the account that came back, one the person already connected there and free.
  const reuse = plan || !onUse ? null : freeDuplicate(result);

  /** The code (Claude) or the plan's key, sealed here to the computer's key for this sign-in. */
  const send = async (value = code) => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setSendFailed(null);
    try {
      const l = login ?? (plan ? await begin() : null);
      if (!l?.publicKey) throw new Error("no key");
      const sealed = await sealSecret(l.publicKey, text, accountCodeAad(l.loginId, orgId));
      await api.machines.sendAccountCode(orgId, machineId, l.loginId, sealed);
      setSent(true);
      setCode("");
      void qc.invalidateQueries({ queryKey: keys.accountLogin(orgId, machineId, l.loginId) });
    } catch (error) {
      // Never sent again by itself: a call that got no answer may have reached the computer.
      setSendFailed(loginReadPasses(error) ? "away" : "refused");
    } finally {
      setSending(false);
    }
  };

  /**
   * What the field holds now, however it got there: a code of this sign-in goes to the computer by itself, once the
   * computer is ready. Before that it waits in the field for Enviar.
   */
  const take = (text: string) => {
    setCode(text);
    setSendFailed(null);
    if (!plan && login && ready && !loading && isSignInCode(text, login.url)) void send(text);
  };

  const copy = async () => {
    if (!login?.userCode) return;
    await Clipboard.setStringAsync(login.userCode).catch(() => undefined);
    setCopied(true);
  };

  const waiting = (
    <Waiting
      label={
        read === "reconnecting" ? t("agentPage.work.brain.add.reconnecting") : t("agentPage.work.brain.add.waiting")
      }
    />
  );
  const busyLine = (
    <View style={styles.busy}>
      <Note icon={<InkOrbit size={15} />} live>
        {busyText}
      </Note>
    </View>
  );
  const pasteRow = (label: string, placeholder: string | undefined, secret: boolean, valid: boolean) => (
    <>
      <PasteField
        value={code}
        onChangeText={take}
        onPasted={take}
        label={label}
        placeholder={placeholder}
        secret={secret}
        returnKeyType="send"
        onSubmit={() => {
          if (valid && ready && !loading) void send();
        }}
      />
      {code.trim() || !ready ? (
        <View style={styles.send}>
          <Button
            variant="primary"
            wide
            label={t("agentPage.work.brain.add.send", { computer })}
            disabled={!valid || !ready || loading}
            onPress={() => void send()}
          />
        </View>
      ) : null}
      {sendFailed ? (
        <Note icon="x" live>
          {sendFailed === "away"
            ? t("agentPage.work.brain.add.startFailed", { computer })
            : plan
              ? t("aiAccounts.add.keySendFailed")
              : t("agentPage.work.brain.add.sendFailed")}
        </Note>
      ) : null}
    </>
  );

  // Not the account it was for: a new login that came back as another (`other`), or signing in again as another,
  // which the server keeps signed out, saying which came back.
  const otherEmail = other?.email ?? (hint ? result?.signedInAs : undefined);
  const why = otherEmail
    ? t(`connectAi.otherAccount.${kind}`, { email: otherEmail, account: hint })
    : noAnswer
      ? (startFailed ?? t("agentPage.work.brain.add.startFailed", { computer }))
      : result?.state === "expired"
        ? t("agentPage.work.brain.add.expired")
        : result?.duplicate
          ? plan
            ? t("aiAccounts.add.duplicateKey", { account: result.duplicate.label })
            : t(`agentPage.work.brain.add.duplicate.${kind}`, {
                account: result.duplicate.account?.email ?? result.duplicate.label,
              })
          : t("agentPage.work.brain.add.failed");

  const key = code.trim();
  const keyOk = plan ? planKeyFits(plan, key) : key.length > 0;

  // The computer starts the sign-in, then its page opens here.
  const start = async () => {
    setOpened(true);
    const l = await begin();
    if (l) openPage(l.url);
  };
  const openAgain = (url: string) => (
    <OpenPage href={url} label={t("agentPage.work.brain.add.openAgain")} onOpened={() => setOpened(true)} />
  );
  const startButton = (label: string, disabled: boolean) => (
    <Button
      size="sm"
      variant="primary"
      icon="out"
      label={label}
      disabled={disabled || starting || loading}
      onPress={() => void start()}
    />
  );

  // Where the account stays and what to do on the wrong one: the sign-in step's ⓘ.
  const signInHint = t("agentPage.work.brain.add.stepOneHint", { computer, brand: t(`aiAccounts.connect.${kind}`) });
  let steps: ReactNode;
  // A device sign-in's one-time code (ChatGPT's, Grok's), to type on the provider's page.
  const deviceCode = (n: number, label: string, code: string) => (
    <Step n={n} divider title={label} side={waiting}>
      <View style={styles.code}>
        <Text variant="title2" selectable accessibilityLabel={label} style={styles.codeText}>
          {code}
        </Text>
        {/* Copying is a word beside the code, never a second button next to Send. */}
        <Button
          size="sm"
          variant="text"
          label={copied ? t("common.copied") : t("common.copy")}
          onPress={() => void copy()}
        />
      </View>
      <StepText>{t("agentPage.work.brain.add.deviceCodeText")}</StepText>
    </Step>
  );
  if (plan) {
    const site = new URL(plan.site);
    steps = (
      <>
        <Step
          n={1}
          state={opened ? "done" : "now"}
          title={t("aiAccounts.add.keyStep", { maker: plan.maker })}
          side={
            <OpenPage
              href={plan.site}
              primary={!opened}
              label={t("aiAccounts.add.openKeys", { site: site.host })}
              onOpened={() => setOpened(true)}
            />
          }
        >
          {provider === "zai" ? <StepText>{t("connectAi.zaiTeam")}</StepText> : null}
          {kind === "opencode" ? <StepText>{t("agentPage.work.brain.add.opencodeFree")}</StepText> : null}
        </Step>
        <Step n={2} divider title={t("aiAccounts.add.keyTitle")} side={read === "reconnecting" ? waiting : undefined}>
          {busy
            ? busyLine
            : pasteRow(t("aiAccounts.add.keyLabel", { plan: plan.label }), plan.placeholder, true, keyOk)}
          {key && !keyOk ? <Note icon="x">{t("aiAccounts.add.keyShape", { plan: plan.label })}</Note> : null}
          <StepText>{t("aiAccounts.add.keySafe", { computer })}</StepText>
        </Step>
      </>
    );
  } else if (kind === "cursor") {
    steps = (
      <>
        <Step
          n={1}
          state={login && opened ? "done" : "now"}
          title={t("agentPage.work.brain.add.stepOne.cursor")}
          hint={signInHint}
          side={login ? openAgain(login.url) : startButton(t("agentPage.work.brain.add.open.cursor"), !ready)}
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
          {!login && !again ? (
            <View style={styles.send}>
              <Button
                size="sm"
                variant="ghost"
                icon="lock"
                label={t("agentPage.work.brain.add.cursorKey")}
                onPress={() => setCursorKey(true)}
              />
            </View>
          ) : null}
        </Step>
        {login && opened ? (
          <Step n={2} divider title={t("agentPage.work.brain.add.cursorFinish", { computer })} side={waiting} />
        ) : null}
      </>
    );
  } else if (kind === "antigravity") {
    steps = (
      <>
        {!enterprise ? <Note icon="info">{t("connectAi.plan.gemini.warning")}</Note> : null}
        <Step
          n={1}
          state={login && opened ? "done" : "now"}
          title={t(
            enterprise
              ? "agentPage.work.brain.add.stepOne.antigravityEnterprise"
              : "agentPage.work.brain.add.stepOne.antigravity",
          )}
          hint={signInHint}
          side={login ? openAgain(login.url) : startButton(t("agentPage.work.brain.add.open.antigravity"), !ready)}
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
          {!login && !again ? (
            <View style={styles.send}>
              <Button
                size="sm"
                variant="ghost"
                label={t(
                  enterprise ? "agentPage.work.brain.add.geminiPersonal" : "agentPage.work.brain.add.geminiEnterprise",
                )}
                onPress={() => setEnterprise((on) => !on)}
              />
            </View>
          ) : null}
        </Step>
        {login && opened ? (
          <Step
            n={2}
            divider
            title={t("agentPage.work.brain.add.stepTwoGoogle")}
            side={read === "reconnecting" ? waiting : undefined}
          >
            {busy
              ? busyLine
              : pasteRow(
                  t("agentPage.work.brain.add.codeLabelGoogle"),
                  t("agentPage.work.brain.add.codeLabelGoogle"),
                  false,
                  key.length > 0,
                )}
          </Step>
        ) : null}
      </>
    );
  } else if (kind === "grok") {
    steps = (
      <>
        <Step
          n={1}
          state={login ? "done" : "now"}
          title={t("agentPage.work.brain.add.stepOne.grok")}
          hint={signInHint}
          side={login ? openAgain(login.url) : startButton(t("agentPage.work.brain.add.open.grok"), !ready)}
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
        </Step>
        {login?.userCode ? (
          deviceCode(2, t("agentPage.work.brain.add.grokCode"), login.userCode)
        ) : login && opened ? (
          <Step n={2} divider title={t("agentPage.work.brain.add.grokFinish", { computer })} side={waiting} />
        ) : null}
      </>
    );
  } else if (kind === "codex") {
    steps = (
      <>
        <Step
          n={1}
          title={t("connectAi.chatgptCode.title")}
          side={<OpenPage href={CHATGPT_SECURITY} label={t("connectAi.chatgptCode.open")} />}
        >
          <StepText>{t("connectAi.chatgptCode.text")}</StepText>
        </Step>
        <Step
          n={2}
          divider
          state={login ? "done" : "now"}
          title={t("agentPage.work.brain.add.stepOne.codex")}
          hint={signInHint}
          side={login ? openAgain(login.url) : startButton(t("agentPage.work.brain.add.open.codex"), !ready)}
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
        </Step>
        {login?.userCode ? deviceCode(3, t("agentPage.work.brain.add.deviceCode"), login.userCode) : null}
      </>
    );
  } else {
    steps = (
      <>
        <Step
          n={1}
          state={login && opened ? "done" : "now"}
          title={t("agentPage.work.brain.add.stepOne.claude_code")}
          hint={signInHint}
          side={login ? openAgain(login.url) : startButton(t("agentPage.work.brain.add.open.claude_code"), !ready)}
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
        </Step>
        {login && opened ? (
          <Step
            n={2}
            divider
            title={t("agentPage.work.brain.add.stepTwo")}
            side={read === "reconnecting" ? waiting : undefined}
          >
            {busy
              ? busyLine
              : pasteRow(
                  t("agentPage.work.brain.add.codeLabel"),
                  t("agentPage.work.brain.add.codeLabel"),
                  false,
                  key.length > 0,
                )}
            {!busy && key && !isSignInCode(key, login.url) ? (
              <Note icon="x">{t("agentPage.work.brain.add.notCode")}</Note>
            ) : null}
            {local && !busy ? <StepText>{t("agentPage.work.brain.add.local", { computer })}</StepText> : null}
          </Step>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.flow}>
      {ended ? (
        <View style={styles.ended}>
          <Note icon="x" live>
            {why}
          </Note>
          <Button
            size="sm"
            variant="secondary"
            icon="undo"
            label={t("common.retry")}
            onPress={() => {
              // A new login that came back as another account goes; one signed in again stays the person's account.
              if (other && !again) void api.machines.removeAccount(orgId, machineId, other.id).catch(() => undefined);
              onRetry();
            }}
          />
          {other ? (
            <Button
              size="sm"
              variant="secondary"
              label={t("connectAi.useAnyway", { email: other.email ?? other.label })}
              onPress={() => onAdded(other)}
            />
          ) : reuse && onUse ? (
            <Button
              size="sm"
              variant="secondary"
              label={t("connectAi.useAnyway", { email: reuse.email ?? reuse.label })}
              onPress={() => onUse(reuse)}
            />
          ) : null}
        </View>
      ) : (
        <StepsCard>{steps}</StepsCard>
      )}
      {(starting || loading) && !busy ? <ActivityIndicator color={c.muted} style={styles.spinner} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  reuse: { gap: 10 },
  reuseActs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flow: { gap: 10 },
  ended: { gap: 10, alignItems: "flex-start" },
  send: { marginTop: 10 },
  // The field's place and height (`PasteField`), so the step keeps most of its size.
  busy: { minHeight: 46, marginTop: 6, justifyContent: "center" },
  code: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 4 },
  // 22, tabular, spaced: read off one screen and typed on another, character by character.
  codeText: { fontWeight: "700", letterSpacing: 2, fontVariant: ["tabular-nums"] },
  spinner: { alignSelf: "flex-start" },
});
