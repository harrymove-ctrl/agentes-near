import type { AccountLoginStart, AccountLoginStatus, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAccountLogin, useAiAccounts, useApi } from "@agenteschat/client";
import { accountTitle, reusableAccount, signInOf } from "@agenteschat/client/lib/ai-accounts";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import {
  beginLogin,
  freeDuplicate,
  isSignInCode,
  type LoginRead,
  loginRead,
  loginReadPasses,
  otherThanHint,
} from "@agenteschat/client/lib/machines";
import { GEMINI_ENTERPRISE_PROVIDER, planKeyFits, signInKey } from "@agenteschat/client/lib/plans";
import { accountCodeAad, sealSecret } from "@agenteschat/client/lib/secret-box";
import { AffixInput, Button, cx, Icon, InfoHint, Locked, ProviderLogo, SettingNote, SwapLabel } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { inDesktopApp } from "@/lib/desktop";
import { openPopup, openWaitingPopup, sendPopup } from "@/lib/popup";

/*
 * "Add account" (ADR 0041 §2, ADR 0059): the computer starts the
 * provider's own sign-in and its link opens here, in a window of its own: the
 * account chosen there is the one connected. Claude: the code Claude shows
 * goes to the computer by itself as soon as it lands in the field ("Paste",
 * a paste, typed or dropped) when it is this sign-in's; anything else waits
 * for "Send", with a line under it. Either way it is sealed here to the
 * computer's key. ChatGPT: device code sign-in allowed in its settings first,
 * then the device page and the one-time code to type there. A coding plan:
 * its own key page, then the key, sealed the same way; it never reaches our
 * server. Cursor (ADR 0114): its sign-in page, and the computer finishes by
 * itself; or, chosen under it, a Cursor API key, sent like a plan's key. Gemini (ADR 0143): Google's sign-in page,
 * then the code it shows, pasted like Claude's; a personal Google account under the plain warning about Google's
 * terms, or (chosen under it) Gemini Enterprise. "Paste" shows only while the field is empty. Every start is a click,
 * never the block showing. The page asks every 2 s; Back or closing stops
 * the sign-in on the computer. "Copy link" beside a sign-in's button copies
 * its link instead, to open in another browser or profile (it begins the
 * sign-in when it hasn't yet). Reads that fail while the server restarts or
 * the computer reconnects say Reconnecting, and the same sign-in goes on
 * (`loginRead`). One key can go to several logins at once (`fanOut`): each is
 * begun, sealed to and watched on its own.
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
   * Claude's login hint, never asked: the email of the account signing in again, or of the one a turn shares. A sign-in
   * that comes back as another account says so instead of thinking with it.
   */
  email?: string | null;
  /** The computer is one the person connected: its own browser may open the page itself. */
  local?: boolean;
  /** False while the computer isn't ready: nothing starts there yet, but the fields and the makers' pages work. */
  ready?: boolean;
  /** It just got ready and the page is still asking about it: what starts there shows it's loading. */
  loading?: boolean;
  /** The sign-in button's words when it signs in for one agent of several ("Sign in for Theo"). */
  signInLabel?: string;
  /**
   * A key sealed to one login per target: each agent of "All agents", or each login of an account getting a new
   * key (`again`).
   */
  fanOut?: { id: string; again?: string }[];
  /** Its own head, with Back; without it, the place that shows it says what it is. */
  onBack?: () => void;
  /** `target`: the `fanOut` target it signed in for. */
  onAdded: (account: MachineAccount, target?: string) => void;
  /**
   * Where an agent is in view: the sign-in came back as an account the person already connected there, signed in and
   * thinking for no agent, and it thinks for that agent instead ("Use x").
   */
  onUse?: (account: MachineAccount) => void;
  /** The code or the key went to the computer. */
  onSent?: () => void;
  /** A `fanOut` target's login ended without signing in (failed or expired). */
  onFailed?: (target: string) => void;
  /**
   * Whether a sign-in begun here may still finish on the computer: a place that hides this block while its computer
   * is offline keeps it meanwhile, so the same sign-in goes on once it's back.
   */
  onSigningIn?: (on: boolean) => void;
  /**
   * A dialog's footer: the buttons that start a sign-in (sign in and copy its link, sign in again or another account)
   * go there, as the dialog's main action and the one beside it, instead of under their step.
   */
  actionsAt?: HTMLElement | null;
  /**
   * The place above it says what this sign-in is (one agent's turn of several: whose turn it is): the first step's
   * title stays out, and with `actionsAt` a sign-in that didn't end says why only through `onEnd`, its way on in the
   * footer.
   */
  quiet?: boolean;
  /** Why the sign-in ended without signing in, in words; null while it goes on or starts over. */
  onEnd?: (why: string | null) => void;
  /** With `quiet` and `actionsAt`: what goes beside "Try again" once a sign-in didn't end (skip that agent). */
  endActions?: ReactNode;
}

export function AddAccount(props: AddAccountProps) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // "Tentar de novo" starts over with a new sign-in: of a `fanOut`, only for the targets that didn't sign in, so no
  // login is left on the computer with none to think for.
  const [attempt, setAttempt] = useState(0);
  const [signedIn, setSignedIn] = useState<string[]>([]);
  const { fanOut, onAdded } = props;
  // A new sign-in where the person already has that plan's account on that computer: Entrar de novo on it first
  // (already chosen when it's signed out), Outra conta beside it. Decided once, so the account signing in doesn't
  // change it.
  const offers = !props.again && !fanOut && !props.email && !props.signInLabel && !props.fresh;
  const ai = useAiAccounts(org.id, offers);
  const [reuse, setReuse] = useState<MachineAccount | null>();
  const [pick, setPick] = useState<"again" | "new">();
  useEffect(() => {
    if (reuse !== undefined || (offers && ai.isPending)) return;
    const found = offers
      ? reusableAccount(ai.data?.accounts, { machineId: props.machineId, kind: props.kind, provider: props.provider })
      : undefined;
    setReuse(found ?? null);
  }, [reuse, offers, ai.isPending, ai.data, props.machineId, props.kind, props.provider]);
  if (reuse === undefined) return <Icon name="spinner" size={14} />;
  const chosen = reuse ? (pick ?? (signInOf(reuse) === "signed_out" ? "again" : undefined)) : "new";
  const label = reuse ? accountTitle(reuse) : "";
  const another = (
    <Button size="sm" onClick={() => setPick("new")}>
      {t("connectAi.another")}
    </Button>
  );
  if (reuse && chosen === undefined && props.actionsAt)
    return (
      <>
        <SettingNote icon="repeat">{t("connectAi.reuse.active", { label })}</SettingNote>
        {createPortal(
          <>
            <Button onClick={() => setPick("new")}>{t("connectAi.another")}</Button>
            <Button variant="primary" onClick={() => setPick("again")}>
              {t("aiAccounts.page.signInAgain")}
            </Button>
          </>,
          props.actionsAt,
        )}
      </>
    );
  if (reuse && chosen === undefined)
    return (
      <div className="ai-panel__row">
        <SettingNote icon="repeat">{t("connectAi.reuse.active", { label })}</SettingNote>
        <span className="ac-acts">
          <Button size="sm" variant="primary" onClick={() => setPick("again")}>
            {t("aiAccounts.page.signInAgain")}
          </Button>
          {another}
        </span>
      </div>
    );
  const again = reuse && chosen === "again" ? { again: reuse.id, email: reuse.email } : {};
  return (
    <>
      {reuse && chosen === "again" && pick === undefined && (
        <div className="ai-panel__row">
          <SettingNote icon="repeat">{t("connectAi.reuse.signedOut", { label })}</SettingNote>
          {another}
        </div>
      )}
      <AddAccountFlow
        key={`${attempt}:${chosen}`}
        {...props}
        {...again}
        {...(fanOut ? { fanOut: fanOut.filter((x) => !signedIn.includes(x.id)) } : {})}
        onAdded={(account, target) => {
          if (target) setSignedIn((s) => [...s, target]);
          onAdded(account, target);
        }}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </>
  );
}

/**
 * A step: its number on the title's line, the text under it, its button (or the wait) under its words, on the text's
 * column. Unnumbered where each step shows only once the one before it is done (Claude's sign-in, then its code): a
 * lone 1 counts nothing.
 */
export function Step({ n, children, side }: { n?: number; children: ReactNode; side?: ReactNode }) {
  return (
    <div className={cx("agp-addacct__step", n !== undefined && "ac-iconline")}>
      {n !== undefined && <i aria-hidden="true">{n}</i>}
      <span className="agp-addacct__text">{children}</span>
      {side}
    </div>
  );
}

/**
 * A step's title, its ⓘ right after it when it has one (outside the label, so pressing it never reaches the field);
 * `htmlFor`: the title names that field, which the hint (`hintId`) then also describes.
 */
export function StepTitle({
  title,
  hint,
  htmlFor,
  hintId,
}: {
  title: string;
  hint?: ReactNode;
  htmlFor?: string;
  hintId?: string;
}) {
  const { t } = useTranslation();
  const b = <b>{title}</b>;
  const label = htmlFor ? <label htmlFor={htmlFor}>{b}</label> : b;
  if (!hint) return label;
  return (
    <span className="ac-hintline">
      {label}
      <InfoHint name={t("common.about", { label: title })} id={hintId}>
        {hint}
      </InfoHint>
    </span>
  );
}

/** A maker's own page (a sign-in, its settings, where a key is made), opened from the click in a window of its own. */
export function OpenPage({
  href,
  primary,
  onOpened,
  children,
}: {
  href: string;
  primary?: boolean;
  onOpened?: () => void;
  children: ReactNode;
}) {
  return (
    <Button asChild size="sm" variant={primary ? "primary" : "default"}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (openPopup(href)) e.preventDefault();
          onOpened?.();
        }}
      >
        <Icon name="external" size={14} />
        {children}
      </a>
    </Button>
  );
}

function AddAccountFlow({
  machineId,
  kind,
  computer,
  provider,
  again,
  email: hint,
  local,
  ready = true,
  loading = false,
  signInLabel,
  fanOut,
  onBack,
  onAdded,
  onUse,
  onSent,
  onFailed,
  onSigningIn,
  actionsAt,
  quiet = false,
  onEnd,
  endActions,
  onRetry,
}: AddAccountProps & { onRetry: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const codeId = useId();
  // Cursor: its sign-in, or (chosen under it) its API key, which goes like a coding plan's key.
  const [cursorKey, setCursorKey] = useState(false);
  const { plan, provider: keyProvider } = signInKey(provider, kind, cursorKey);
  // Gemini: a personal Google account, or (chosen under it, or the account's own) Gemini Enterprise.
  const [enterprise, setEnterprise] = useState(provider === GEMINI_ENTERPRISE_PROVIDER);
  const signInProvider = keyProvider ?? (kind === "antigravity" && enterprise ? GEMINI_ENTERPRISE_PROVIDER : undefined);
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
  const [pasteFailed, setPasteFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  // "Copy link": the sign-in's link on its way to the clipboard (it may begin the sign-in first), then copied.
  const [copyingLink, setCopyingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // Signed in, but not as the account it was for (the hint): theirs to use or not.
  const [other, setOther] = useState<MachineAccount | null>(null);
  // The logins a key went to (`fanOut`), and the first of them that didn't end signed in.
  const [fan, setFan] = useState<{ id: string; loginId: string }[]>([]);
  const [fanFailed, setFanFailed] = useState<AccountLoginStatus | null>(null);
  // What each of their latest reads says (`loginRead`): only an end on the computer ends one of them.
  const [fanReads, setFanReads] = useState<Record<string, LoginRead>>({});
  const fanned = useRef<{ id: string; loginId: string }[]>([]);
  const fanEnded = useRef(new Set<string>());
  // The sign-ins still running and the computer each started on, where they're stopped when this block goes away:
  // the block shows while its computer is still being prepared, with no computer yet.
  const running = useRef<{ machineId: string; loginId: string }[]>([]);
  const gone = useRef(false);
  const reported = useRef(false);
  // With its own head, the dropdown that opened this block is gone: keyboard focus starts here. In a panel under a
  // picker, focus stays on the option the person just chose.
  const box = useRef<HTMLElement>(null);
  const headed = onBack !== undefined;
  useEffect(() => {
    if (headed) box.current?.focus();
  }, [headed]);
  const status = useAccountLogin(org.id, machineId, login?.loginId ?? null);
  const result = status.data;
  const read = loginRead(status);

  const begin = async (popup?: Window | null): Promise<AccountLoginStart | null> => {
    setStarting(true);
    setStartFailed(null);
    try {
      const l = await beginLogin((input) => api.machines.beginAccountLogin(org.id, machineId, kind, input), kind, {
        again,
        provider: signInProvider,
        hint,
      });
      if (gone.current) {
        popup?.close();
        void api.machines.cancelAccountLogin(org.id, machineId, l.loginId).catch(() => undefined);
        return null;
      }
      running.current = [...running.current, { machineId, loginId: l.loginId }];
      setLogin(l);
      if (popup) sendPopup(popup, l.url);
      return l;
    } catch (error) {
      popup?.close();
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
      const runs = running.current;
      running.current = [];
      for (const run of runs)
        void api.machines.cancelAccountLogin(org.id, run.machineId, run.loginId).catch(() => undefined);
    };
  }, []);

  const begun = login !== null || fan.length > 0;
  useEffect(() => {
    onSigningIn?.(begun);
    return () => onSigningIn?.(false);
  }, [begun, onSigningIn]);

  useEffect(() => {
    if (!result || result.state === "waiting" || !login) return;
    // Ended on the computer: nothing left to stop.
    running.current = running.current.filter((r) => r.loginId !== login.loginId);
    if (result.state === "done" && result.account && !reported.current) {
      reported.current = true;
      if (otherThanHint(hint, result.account)) setOther(result.account);
      else onAdded(result.account);
    }
  }, [result, login, hint, onAdded]);

  /** One login a key went to (`fanOut`) ended on the computer. */
  const fanEnd = (loginId: string, end: AccountLoginStatus) => {
    if (fanEnded.current.has(loginId)) return;
    fanEnded.current.add(loginId);
    running.current = running.current.filter((r) => r.loginId !== loginId);
    const target = fanned.current.find((f) => f.loginId === loginId)?.id;
    if (end.state === "done" && end.account) onAdded(end.account, target);
    else {
      setFanFailed((first) => first ?? end);
      if (target) onFailed?.(target);
    }
  };

  /** A `fanOut` login's latest read: its end on the computer, or how its reads fail for now. */
  const fanRead = (loginId: string, end: AccountLoginStatus | undefined, read: LoginRead) => {
    setFanReads((last) => ((last[loginId] ?? null) === read ? last : { ...last, [loginId]: read }));
    if (end && end.state !== "waiting") fanEnd(loginId, end);
  };

  const reads = [read, ...Object.values(fanReads)];
  const shown = fanFailed ?? result;
  const noAnswer = startFailed !== null || reads.includes("noAnswer");
  const ended = noAnswer || reads.includes("failed") || shown?.state === "failed" || shown?.state === "expired";
  // The code or the key on its way to the computer, then the computer signing in with it: a line stands in for the
  // field and its buttons until the sign-in ends.
  const busy = (sending || sent) && !(other || ended);
  const field = useRef<HTMLInputElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  // Focus on the field or its buttons would fall to the page as they go: it goes to the line, back to the field when
  // a failed send brings it back, or to the block when the sign-in ended. A layout effect, so it lands before a
  // dialog's focus trap takes it to the dialog.
  const wasBusy = useRef(false);
  useLayoutEffect(() => {
    if (wasBusy.current === busy) return;
    wasBusy.current = busy;
    if (document.activeElement && document.activeElement !== document.body) return;
    (busy ? line.current : (field.current ?? box.current))?.focus();
  }, [busy]);

  /** The code or the plan's key, sealed here to the computer's key for a sign-in. */
  const seal = async (l: AccountLoginStart | null, text: string) => {
    if (!l?.publicKey) throw new Error("no key");
    const sealed = await sealSecret(l.publicKey, text, accountCodeAad(l.loginId, org.id));
    await api.machines.sendAccountCode(org.id, machineId, l.loginId, sealed);
    void qc.invalidateQueries({ queryKey: keys.accountLogin(org.id, machineId, l.loginId) });
  };

  /** The code (Claude) or the plan's key: to this sign-in, or to one login per `fanOut` target not sent yet. */
  const send = async (value = code) => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setSendFailed(null);
    try {
      if (plan && fanOut) {
        for (const target of fanOut.filter((x) => !fanned.current.some((f) => f.id === x.id))) {
          const l = await api.machines.beginAccountLogin(org.id, machineId, kind, {
            provider: keyProvider,
            ...(target.again ? { accountId: target.again } : {}),
          });
          if (gone.current) {
            void api.machines.cancelAccountLogin(org.id, machineId, l.loginId).catch(() => undefined);
            return;
          }
          running.current = [...running.current, { machineId, loginId: l.loginId }];
          await seal(l, text);
          fanned.current = [...fanned.current, { id: target.id, loginId: l.loginId }];
          setFan(fanned.current);
        }
      } else await seal(login ?? (plan ? await begin() : null), text);
      setSent(true);
      setCode("");
      onSent?.();
    } catch (error) {
      // Never sent again by itself: a call that got no answer may have reached the computer.
      setSendFailed(loginReadPasses(error) ? "away" : "refused");
    } finally {
      setSending(false);
    }
  };

  /**
   * What the field holds now, however it got there: a code of this sign-in goes to the computer by itself, once the
   * computer is ready. Before that it waits in the field for Send.
   */
  const take = (text: string) => {
    setCode(text);
    setSendFailed(null);
    setPasteFailed(false);
    if (!plan && login && ready && !loading && isSignInCode(text, login.url)) void send(text);
  };

  const paste = async () => {
    setPasteFailed(false);
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      setPasteFailed(true);
      return;
    }
    if (text) take(text);
  };

  const copy = async () => {
    if (!login?.userCode) return;
    try {
      await navigator.clipboard?.writeText(login.userCode);
      setCopied(true);
    } catch {
      // The code stays on screen to type by hand.
    }
  };

  /**
   * The sign-in's link copied, to open in another browser or profile (where the person is signed in to the maker):
   * the sign-in begins here when it hasn't yet. The write starts in the click itself, the link to come: Safari allows
   * no later write. Copied, it counts as opened, so Claude's code field shows.
   */
  const copyLink = () => {
    setCopyingLink(true);
    const url = login
      ? Promise.resolve(login.url)
      : begin().then((l) => {
          if (!l) throw new Error("no sign-in");
          return l.url;
        });
    const done = () => {
      setLinkCopied(true);
      setOpened(true);
    };
    const later = () =>
      url
        .then((u) => navigator.clipboard.writeText(u))
        .then(done, () => undefined)
        .finally(() => setCopyingLink(false));
    try {
      const blob = url.then((u) => new Blob([u], { type: "text/plain" }));
      // Rejected when the sign-in doesn't begin, which only fails the write (the block says why).
      blob.catch(() => undefined);
      void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).then(() => {
        done();
        setCopyingLink(false);
      }, later);
    } catch {
      void later();
    }
  };

  const waiting = (
    <span className="agp-addacct__wait" role="status">
      <Icon name="spinner" size={14} />
      {reads.includes("reconnecting")
        ? t("agentPage.work.brain.add.reconnecting")
        : t("agentPage.work.brain.add.waiting")}
    </span>
  );
  const keyHintId = `${codeId}-hint`;
  const busyLine = (
    <p ref={line} tabIndex={-1} role="status" className="agp-addacct__busy ac-iconline">
      <Icon name="spinner" size={14} />
      <span>
        {plan
          ? sent
            ? t("aiAccounts.add.keySent", { computer })
            : t("aiAccounts.add.keySending", { computer })
          : sent
            ? t("agentPage.work.brain.add.sent", { computer })
            : t("agentPage.work.brain.add.sending", { computer })}
      </span>
    </p>
  );
  // Empty, the field offers Colar inside its end. Filled, Send comes up under it: no greyed button before there's a key.
  const pasteRow = (label: string, placeholder: string | undefined, secret: boolean, valid: boolean) => (
    <>
      <span className="agp-addacct__paste">
        <Locked when={loading}>
          <AffixInput
            ref={field}
            id={codeId}
            type={secret ? "password" : "text"}
            value={code}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            aria-label={label}
            aria-describedby={plan ? keyHintId : undefined}
            onChange={(e) => take(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (valid && ready && !loading) void send();
              }
            }}
            action={
              !code.trim() && (
                <Button variant="ghost" size="sm" icon="copy" onClick={() => void paste()}>
                  {t("aiAccounts.add.paste")}
                </Button>
              )
            }
          />
        </Locked>
        {(code.trim() || !ready) && (
          <Button variant="primary" loading={loading} disabled={!valid || !ready} onClick={() => void send()}>
            {t("agentPage.work.brain.add.send", { computer })}
          </Button>
        )}
      </span>
      {pasteFailed && <SettingNote icon="alert">{t("aiAccounts.add.pasteFailed")}</SettingNote>}
      {sendFailed && (
        <SettingNote icon="alert">
          {sendFailed === "away"
            ? t("agentPage.work.brain.add.startFailed", { computer })
            : plan
              ? t("aiAccounts.add.keySendFailed")
              : t("agentPage.work.brain.add.sendFailed")}
        </SettingNote>
      )}
    </>
  );

  // Not the account it was for: one that came back done (`other`), or signing in again, which the server refuses.
  const otherEmail = other?.email ?? (hint ? shown?.signedInAs : undefined);
  const why = otherEmail
    ? t(`connectAi.otherAccount.${kind}`, { email: otherEmail, account: hint })
    : noAnswer
      ? (startFailed ?? t("agentPage.work.brain.add.startFailed", { computer }))
      : shown?.state === "expired"
        ? t("agentPage.work.brain.add.expired")
        : shown?.duplicate
          ? plan
            ? t("aiAccounts.add.duplicateKey", { account: shown.duplicate.label })
            : t(`agentPage.work.brain.add.duplicate.${kind}`, {
                account: shown.duplicate.account?.email ?? shown.duplicate.label,
              })
          : t("agentPage.work.brain.add.failed");

  const endWhy = other || ended ? why : null;
  useEffect(() => {
    onEnd?.(endWhy);
  }, [endWhy, onEnd]);

  const title = plan ? t("aiAccounts.add.titleKey", { plan: plan.label }) : t(`agentPage.work.brain.add.title.${kind}`);
  const key = code.trim();
  const keyOk = plan ? planKeyFits(plan, key) : key.length > 0;

  const retry = (
    <Button
      size="sm"
      icon="refresh"
      onClick={() => {
        // A new login that came back as another account goes; one signed in again stays the person's account.
        if (other && !again) void api.machines.removeAccount(org.id, machineId, other.id).catch(() => undefined);
        onRetry();
      }}
    >
      {t("common.retry")}
    </Button>
  );
  // What the person may think with instead: the account that came back (`other`), or, for the agent in view, one they
  // already connected there, signed in and thinking for no agent.
  const free = plan ? null : freeDuplicate(shown);
  const instead = other
    ? { account: other, use: () => onAdded(other) }
    : free && onUse
      ? { account: free, use: () => onUse(free) }
      : null;

  // Opened on the click itself, then sent to the provider's page once the computer has it.
  const start = () => {
    const popup = openWaitingPopup(kind);
    setOpened(true);
    // The desktop app has no popup: its page goes to the browser (main_window.rs).
    void begin(popup).then((l) => {
      if (l && inDesktopApp()) openPopup(l.url);
    });
  };
  const openAgain = (url: string) => (
    <OpenPage href={url} onOpened={() => setOpened(true)}>
      {t("agentPage.work.brain.add.openAgain")}
    </OpenPage>
  );
  /** The sign-in's button (or "Open again" once begun) with "Copy link" beside it. */
  const signIn = (label: string) => {
    // The footer's size where the footer holds them; under the step (and once begun, beside "Open again", always small)
    // the small one, so the two stand as tall as each other.
    const size = actionsAt && !login ? undefined : "sm";
    const main = login ? (
      openAgain(login.url)
    ) : (
      <Button
        {...(size ? { size } : {})}
        variant="primary"
        icon="external"
        loading={(starting && !copyingLink) || loading}
        disabled={!ready || starting}
        onClick={start}
      >
        {label}
      </Button>
    );
    const copy = (
      <Button
        {...(size ? { size } : {})}
        loading={starting && copyingLink}
        disabled={!ready || loading || (starting && !copyingLink)}
        onClick={copyLink}
      >
        <SwapLabel
          icon="copy"
          altIcon="check"
          label={t("agentPage.work.brain.add.copyLink")}
          alt={t("common.copied")}
          showAlt={linkCopied}
        />
      </Button>
    );
    // In a dialog's footer the main action ends the row; under its step it starts it.
    return actionsAt && !login ? (
      createPortal(
        <>
          {copy}
          {main}
        </>,
        actionsAt,
      )
    ) : (
      <span className="agp-addacct__acts">
        {main}
        {copy}
      </span>
    );
  };

  /**
   * The step that starts a sign-in: its button (or the footer's) beside its title, and "Asking…" while it starts. With
   * `quiet` the place above says what it is, so only the button and that wait are left.
   */
  const firstStep = (label: string, heading: ReactNode, n?: number) =>
    quiet ? (
      <>
        {signIn(label)}
        {starting && (
          <span className="agp-addacct__starting">{t("agentPage.work.brain.add.starting", { computer })}</span>
        )}
      </>
    ) : (
      <Step n={n} side={signIn(label)}>
        {heading}
        {starting && <span>{t("agentPage.work.brain.add.starting", { computer })}</span>}
      </Step>
    );
  const signInHint = t("agentPage.work.brain.add.stepOneHint", { computer, brand: t(`aiAccounts.connect.${kind}`) });
  // Under `quiet` the step that starts the sign-in shows no number of its own, so the steps after it count one less.
  const after = (n: number) => (quiet ? n - 1 : n);
  let steps: ReactNode;
  // A device sign-in's one-time code (ChatGPT's, Grok's), to type on the provider's page.
  const deviceCode = (n: number, label: string, code: string) => (
    <Step n={n} side={waiting}>
      <b>{label}</b>
      <span className="agp-addacct__code">
        <output aria-label={label}>{code}</output>
        <Button size="sm" onClick={() => void copy()}>
          <SwapLabel icon="copy" altIcon="check" label={t("common.copy")} alt={t("common.copied")} showAlt={copied} />
        </Button>
      </span>
      <span>{t("agentPage.work.brain.add.deviceCodeText")}</span>
    </Step>
  );
  if (plan) {
    const site = new URL(plan.site);
    steps = (
      <>
        <Step
          n={1}
          side={
            <OpenPage href={plan.site} primary={!opened && !code.trim()} onOpened={() => setOpened(true)}>
              {t("aiAccounts.add.openKeys", { site: site.host })}
            </OpenPage>
          }
        >
          <StepTitle
            title={t("aiAccounts.add.keyStep", { maker: plan.maker })}
            hint={
              provider === "zai"
                ? t("connectAi.zaiTeam")
                : kind === "opencode"
                  ? t("agentPage.work.brain.add.opencodeFree")
                  : undefined
            }
          />
        </Step>
        <Step n={2} side={reads.includes("reconnecting") ? waiting : undefined}>
          <StepTitle
            title={t("aiAccounts.add.keyTitle")}
            hint={t("aiAccounts.add.keySafe", { computer })}
            htmlFor={codeId}
            hintId={keyHintId}
          />
          {busy
            ? busyLine
            : pasteRow(t("aiAccounts.add.keyLabel", { plan: plan.label }), plan.placeholder, true, keyOk)}
          {key && !keyOk && (
            <SettingNote icon="alert">{t("aiAccounts.add.keyShape", { plan: plan.label })}</SettingNote>
          )}
        </Step>
      </>
    );
  } else if (kind === "cursor") {
    steps = (
      <>
        {firstStep(
          signInLabel ?? t("agentPage.work.brain.add.open.cursor"),
          <StepTitle title={t("agentPage.work.brain.add.stepOne.cursor")} hint={signInHint} />,
        )}
        {login && opened && <Step side={waiting}>{t("agentPage.work.brain.add.cursorFinish", { computer })}</Step>}
        {!login && !again && (
          <Button size="sm" variant="ghost" icon="key" onClick={() => setCursorKey(true)}>
            {t("agentPage.work.brain.add.cursorKey")}
          </Button>
        )}
      </>
    );
  } else if (kind === "antigravity") {
    steps = (
      <>
        {!enterprise && <SettingNote icon="alert">{t("connectAi.plan.gemini.warning")}</SettingNote>}
        {firstStep(
          signInLabel ?? t("agentPage.work.brain.add.open.antigravity"),
          <StepTitle
            title={t(
              enterprise
                ? "agentPage.work.brain.add.stepOne.antigravityEnterprise"
                : "agentPage.work.brain.add.stepOne.antigravity",
            )}
            hint={signInHint}
          />,
        )}
        {login && opened && (
          <Step side={busy && !reads.includes("reconnecting") ? undefined : waiting}>
            <label htmlFor={codeId}>
              <b>{t("agentPage.work.brain.add.stepTwoGoogle")}</b>
            </label>
            {busy
              ? busyLine
              : pasteRow(
                  t("agentPage.work.brain.add.codeLabelGoogle"),
                  t("agentPage.work.brain.add.codeLabelGoogle"),
                  false,
                  key.length > 0,
                )}
          </Step>
        )}
        {!login && !again && (
          <Button size="sm" variant="ghost" onClick={() => setEnterprise((on) => !on)}>
            {t(enterprise ? "agentPage.work.brain.add.geminiPersonal" : "agentPage.work.brain.add.geminiEnterprise")}
          </Button>
        )}
      </>
    );
  } else if (kind === "grok") {
    steps = (
      <>
        {firstStep(
          signInLabel ?? t("agentPage.work.brain.add.open.grok"),
          <StepTitle title={t("agentPage.work.brain.add.stepOne.grok")} hint={signInHint} />,
          1,
        )}
        {login?.userCode
          ? deviceCode(after(2), t("agentPage.work.brain.add.grokCode"), login.userCode)
          : login && opened && <Step side={waiting}>{t("agentPage.work.brain.add.grokFinish", { computer })}</Step>}
      </>
    );
  } else if (kind === "codex") {
    steps = (
      <>
        <Step n={1} side={<OpenPage href={CHATGPT_SECURITY}>{t("connectAi.chatgptCode.open")}</OpenPage>}>
          <b>{t("connectAi.chatgptCode.title")}</b>
          <span>{t("connectAi.chatgptCode.text")}</span>
        </Step>
        {firstStep(
          signInLabel ?? t("agentPage.work.brain.add.open.codex"),
          <StepTitle title={t("agentPage.work.brain.add.stepOne.codex")} hint={signInHint} />,
          2,
        )}
        {login?.userCode && deviceCode(after(3), t("agentPage.work.brain.add.deviceCode"), login.userCode)}
      </>
    );
  } else {
    steps = (
      <>
        {firstStep(
          signInLabel ?? t("agentPage.work.brain.add.open.claude_code"),
          <StepTitle title={t("agentPage.work.brain.add.stepOne.claude_code")} hint={signInHint} />,
        )}
        {login && opened && (
          <Step side={busy && !reads.includes("reconnecting") ? undefined : waiting}>
            <label htmlFor={codeId}>
              <b>{t("agentPage.work.brain.add.stepTwo")}</b>
            </label>
            {busy
              ? busyLine
              : pasteRow(
                  t("agentPage.work.brain.add.codeLabel"),
                  t("agentPage.work.brain.add.codeLabel"),
                  false,
                  key.length > 0,
                )}
            {!busy && key && !isSignInCode(key, login.url) && (
              <SettingNote icon="alert">{t("agentPage.work.brain.add.notCode")}</SettingNote>
            )}
            {local && !busy && <span>{t("agentPage.work.brain.add.local", { computer })}</span>}
          </Step>
        )}
      </>
    );
  }

  return (
    <section ref={box} tabIndex={-1} className="agp-addacct" aria-label={title}>
      {onBack && (
        <div className="agp-addacct__head">
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronLeft"
            aria-label={t("common.back")}
            title={t("common.back")}
            onClick={onBack}
          />
          <b className="row" style={{ gap: 8 }}>
            {plan && <ProviderLogo id={provider ?? ""} size="xs" />}
            {title}
          </b>
        </div>
      )}
      {(other || ended) && quiet && actionsAt ? (
        // The place above says why; its way on is the dialog's footer: skipping, the account that came back, again.
        createPortal(
          <>
            {endActions}
            {instead && (
              <Button onClick={instead.use}>
                <span className="ai-panel__use">
                  {t("connectAi.useAnyway", { email: instead.account.email ?? instead.account.label })}
                </span>
              </Button>
            )}
            <Button
              variant="primary"
              icon="refresh"
              onClick={() => {
                if (other && !again)
                  void api.machines.removeAccount(org.id, machineId, other.id).catch(() => undefined);
                onRetry();
              }}
            >
              {t("common.retry")}
            </Button>
          </>,
          actionsAt,
        )
      ) : other || ended ? (
        <div className="ai-panel__row">
          <SettingNote icon="alert" live>
            {why}
          </SettingNote>
          {instead ? (
            <span className="ac-acts">
              {retry}
              <Button size="sm" onClick={instead.use}>
                <span className="ai-panel__use">
                  {t("connectAi.useAnyway", { email: instead.account.email ?? instead.account.label })}
                </span>
              </Button>
            </span>
          ) : (
            retry
          )}
        </div>
      ) : (
        steps
      )}
      {fan.map((f) => (
        <LoginWatch key={f.loginId} machineId={machineId} loginId={f.loginId} onRead={fanRead} />
      ))}
    </section>
  );
}

/** One login a key went to, asked about every 2 s until it ends on the computer, through failed reads too. */
function LoginWatch({
  machineId,
  loginId,
  onRead,
}: {
  machineId: string;
  loginId: string;
  onRead: (loginId: string, end: AccountLoginStatus | undefined, read: LoginRead) => void;
}) {
  const { org } = useOrg();
  const status = useAccountLogin(org.id, machineId, loginId);
  const end = status.data;
  const read = loginRead(status);
  useEffect(() => onRead(loginId, end, read), [end, read, loginId, onRead]);
  return null;
}
