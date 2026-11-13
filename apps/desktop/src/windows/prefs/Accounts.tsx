/**
 * Preferências > Ferramentas, under the tools card: one "Contas"
 * card per CLI found on this Mac. "Conta deste Mac" is the sign-in already in the CLI (not removable
 * here); each added account has its email, plan and "Remover"; "Adicionar conta" opens the CLI's own
 * sign-in in the browser and waits. Accounts belong to one organization's home, so with several
 * organizations a switch picks which one (as Pastas). A runner from before accounts hides the cards.
 */
import type { AccountKind, RunnerAccountInfo } from "@agenteschat/adapters/machine-protocol";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import {
  BRAIN_ICONS,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  InfoHint,
  PixelSpinner,
  ProviderLogo,
  Segmented,
} from "@agenteschat/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useStore } from "../../app";
import {
  type AccountsRequest,
  accountsOf,
  isUnsupported,
  type LoginView,
  planLabel,
  startAccountLogin,
} from "../../control/accounts";
import { type Home, orgName } from "../../control/store";
import { OrgTile } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";

/**
 * What changes between Claude Code and Codex (names stay in the strings; sites are not words). Cursor's accounts
 * (ADR 0114), OpenCode's keys (ADR 0132), Grok's accounts (ADR 0142) and Gemini's (ADR 0143) are added from the web app, not here yet.
 */
type DesktopKind = Exclude<AccountKind, "cursor" | "opencode" | "grok" | "antigravity">;
const KINDS: Record<
  DesktopKind,
  { title: string; tool: string; product: string; signIn: string; signInLead: string; site: string }
> = {
  claude_code: {
    title: "desktop.prefs.accounts.titleClaude",
    tool: "desktop.tools.claudeName",
    product: "Claude",
    signIn: "desktop.prefs.accounts.signInClaude",
    signInLead: "desktop.prefs.accounts.signInClaudeLead",
    site: "claude.ai",
  },
  codex: {
    title: "desktop.prefs.accounts.titleCodex",
    tool: "desktop.tools.codexName",
    product: "ChatGPT",
    signIn: "desktop.prefs.accounts.signInCodex",
    signInLead: "desktop.prefs.accounts.signInCodexLead",
    site: "chatgpt.com",
  },
};

type Loaded = { state: "loading" } | { state: "ready"; accounts: RunnerAccountInfo[] } | { state: "hidden" };

export function ToolAccounts({ homes, executors }: { homes: Home[]; executors: ControlStatus["executors"] }) {
  const { t } = useTranslation();
  const store = useStore();
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [adding, setAdding] = useState<DesktopKind | null>(null);
  const [removing, setRemoving] = useState<RunnerAccountInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** Shown once a list came back: an older runner never shows the cards, switching organizations doesn't blink. */
  const seen = useRef(false);
  const home = homes.find((h) => h.homeId === picked) ?? homes[0];
  const homeId = home?.homeId;
  const running = home?.running === true;

  const load = useCallback(
    async (id: string, isCurrent: () => boolean = () => true) => {
      try {
        const { accounts } = await store.request(id, { type: "accounts.list" });
        if (!isCurrent()) return;
        seen.current = true;
        setLoaded({ state: "ready", accounts: Array.isArray(accounts) ? accounts : [] });
      } catch (err) {
        // An older runner doesn't know accounts; any other failure keeps what is on screen.
        if (!isCurrent()) return;
        if (isUnsupported(err)) setLoaded({ state: "hidden" });
        else setLoaded((prev) => (prev.state === "ready" ? prev : { state: "hidden" }));
      }
    },
    [store],
  );

  useEffect(() => {
    if (!homeId || !running) {
      setLoaded({ state: "hidden" });
      return;
    }
    let current = true;
    setLoaded({ state: "loading" });
    void load(homeId, () => current);
    return () => {
      current = false;
    };
  }, [homeId, running, load]);

  const kinds = (["claude_code", "codex"] as const).filter((k) =>
    k === "claude_code" ? !!executors.claude : !!executors.codex,
  );
  if (!home || kinds.length === 0 || loaded.state === "hidden" || !seen.current) return null;

  const org = orgName(home);
  const accounts = loaded.state === "ready" ? loaded.accounts : [];

  const remove = async () => {
    if (!removing || !homeId) return;
    setBusy(true);
    try {
      await store.request(homeId, { type: "account.remove", kind: removing.kind, accountId: removing.id });
      toast(t("desktop.prefs.accounts.removed"));
      setLoaded((prev) =>
        prev.state === "ready" ? { ...prev, accounts: prev.accounts.filter((a) => a.id !== removing.id) } : prev,
      );
      void load(homeId);
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
    setBusy(false);
    setRemoving(null);
  };

  const executorOf = (kind: DesktopKind) => (kind === "claude_code" ? executors.claude : executors.codex);
  const accountName = (a: RunnerAccountInfo) => a.email ?? t("desktop.prefs.accounts.noEmail");
  const logo = (kind: DesktopKind) => (
    <span className="dk-logo">
      <Icon name={BRAIN_ICONS[kind]} size={16} />
    </span>
  );

  return (
    <>
      {kinds.map((kind, i) => (
        <section key={kind} aria-busy={loaded.state === "loading" || undefined}>
          <CardTitle
            hint={hintFor(
              t,
              t(KINDS[kind].title),
              homes.length > 1 ? t("desktop.prefs.accounts.helpOrg", { org }) : t("desktop.prefs.accounts.help"),
            )}
          >
            <ProviderLogo id={kind} size="xs" />
            {t(KINDS[kind].title)}
          </CardTitle>
          {i === 0 && homes.length > 1 && (
            <div className="dk-orgpick">
              <Segmented
                label={t("desktop.prefs.accounts.org")}
                value={home.homeId}
                onValueChange={(id) => setPicked(id)}
                options={homes.map((h) => ({
                  value: h.homeId,
                  label: orgName(h),
                  mark: <OrgTile logo={h.logo} size="sm" />,
                }))}
              />
            </div>
          )}
          <PrefCard>
            <PrefRow
              lead={logo(kind)}
              title={t("desktop.prefs.accounts.thisMac")}
              end={
                executorOf(kind)?.loggedIn === false ? (
                  <Chip icon="alert" tone="waiting">
                    {t("desktop.tools.loggedOut")}
                  </Chip>
                ) : (
                  <small className="dk-help">
                    {t("desktop.prefs.accounts.thisMacHint", { tool: t(KINDS[kind].tool) })}
                  </small>
                )
              }
            />
            {accountsOf(accounts, kind).map((a) => {
              const plan = planLabel(a.plan);
              return (
                <PrefRow
                  key={a.id}
                  lead={logo(kind)}
                  title={
                    <>
                      {accountName(a)} {plan && <Chip icon="wallet">{plan}</Chip>}
                      {!a.loggedIn && (
                        <>
                          {" "}
                          <Chip icon="alert" tone="waiting">
                            {t("desktop.tools.loggedOut")}
                          </Chip>
                        </>
                      )}
                    </>
                  }
                  desc={a.loggedIn ? undefined : t("desktop.prefs.accounts.loggedOutDesc")}
                  end={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("desktop.prefs.accounts.removeLabel", { account: accountName(a) })}
                      onClick={() => setRemoving(a)}
                    >
                      {t("desktop.common.remove")}
                    </Button>
                  }
                />
              );
            })}
            <PrefRow
              end={
                <Button size="sm" icon="plus" disabled={loaded.state !== "ready"} onClick={() => setAdding(kind)}>
                  {t("desktop.prefs.accounts.add")}
                </Button>
              }
            />
          </PrefCard>
        </section>
      ))}

      {adding && homeId && (
        <AddAccountDialog
          kind={adding}
          homeId={homeId}
          onClose={() => setAdding(null)}
          onAdded={() => void load(homeId)}
        />
      )}

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && !busy && setRemoving(null)}
        title={t("desktop.prefs.accounts.removeTitle", { account: removing ? accountName(removing) : "" })}
        description={t("desktop.prefs.accounts.removeBody", {
          site:
            removing &&
            removing.kind !== "cursor" &&
            removing.kind !== "opencode" &&
            removing.kind !== "grok" &&
            removing.kind !== "antigravity"
              ? KINDS[removing.kind].site
              : "",
        })}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t("desktop.common.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** "Adicionar conta": the CLI's sign-in in the browser, the app waiting; then which account came back. */
function AddAccountDialog({
  kind,
  homeId,
  onClose,
  onAdded,
}: {
  kind: DesktopKind;
  homeId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const [view, setView] = useState<LoginView>({ phase: "starting" });
  const [attempt, setAttempt] = useState(0);
  const k = KINDS[kind];

  // A new sign-in per attempt ("Tentar de novo"); closing the dialog cancels the one waiting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` starts a new sign-in on purpose.
  useEffect(() => {
    const request: AccountsRequest = (req) => store.request(homeId, req);
    const login = startAccountLogin({
      request,
      kind,
      onChange: (next) => {
        setView(next);
        if (next.phase === "done") onAdded();
      },
    });
    return () => login.cancel();
  }, [store, homeId, kind, attempt]);

  /** The runner already opened the browser; this opens it again, or copies the link if the app can't. */
  const openLink = async (url: string) => {
    try {
      await host.openExternal(url);
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        toast(t("desktop.prefs.accounts.linkCopied"), "copy");
      } catch {
        toast(t("desktop.common.error"), "alert");
      }
    }
  };

  if (view.phase === "done") {
    const plan = planLabel(view.account?.plan);
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={t("desktop.prefs.accounts.addedTitle")}
        description={t("desktop.prefs.accounts.addedBody")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        {view.account?.email && (
          <DialogBody>
            <p className="dk-acct-who">
              <b>{view.account.email}</b>
              {plan && <span> · {t("desktop.prefs.accounts.addedPlan", { plan })}</span>}
            </p>
          </DialogBody>
        )}
        <DialogFooter bar>
          <Button variant="primary" onClick={onClose}>
            {t("desktop.prefs.accounts.ok")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  if (view.phase === "failed") {
    const why =
      view.reason === "expired"
        ? t("desktop.prefs.accounts.failedExpired")
        : view.reason === "failed"
          ? t("desktop.prefs.accounts.failedLogin")
          : t("desktop.prefs.accounts.failedError");
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={t("desktop.prefs.accounts.failedTitle")}
        description={why}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={onClose}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setView({ phase: "starting" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("desktop.common.retry")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  const waiting = view.phase === "waiting" ? view : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t(k.signIn)}
      description={t(k.signInLead)}
      descriptionAside={
        <InfoHint name={t("desktop.prefs.accounts.wrongAccountAbout")}>
          {t("desktop.prefs.accounts.wrongAccount", { product: k.product })}
        </InfoHint>
      }
      closeLabel={t("desktop.common.close")}
      width={440}
    >
      <DialogBody>
        {waiting?.userCode && (
          <div className="dk-acct-code">
            <AccountCode code={waiting.userCode} />
            <p className="dk-help">{t("desktop.prefs.accounts.codeHint")}</p>
          </div>
        )}
        <p className="dk-waitline dk-acct-wait">
          <PixelSpinner size={14} color="sky" />
          <span className="dk-shimmer">
            {waiting ? t("desktop.prefs.accounts.waiting") : t("desktop.prefs.accounts.opening")}
          </span>
        </p>
      </DialogBody>
      <DialogFooter
        bar
        note={
          waiting?.url ? (
            <span className="dk-help">
              {t("desktop.prefs.accounts.notOpened")}{" "}
              <button type="button" className="ac-link dk-link" onClick={() => void openLink(waiting.url)}>
                {t("desktop.prefs.accounts.openLink")}
              </button>
            </span>
          ) : undefined
        }
      >
        <Button variant="ghost" onClick={onClose}>
          {t("desktop.common.cancel")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Codex's one-time code (`ABCD-EFGHI`) big, in Doto. */
function AccountCode({ code }: { code: string }) {
  const { t } = useTranslation();
  const parts = code
    .toUpperCase()
    .split(/[^0-9A-Z]+/)
    .filter(Boolean);
  return (
    <span
      className="dk-code"
      role="img"
      aria-label={t("desktop.prefs.accounts.codeAria", { code: parts.join("").split("").join(" ") })}
    >
      {parts[0]}
      {parts.length > 1 && <span className="dk-code__dot">·</span>}
      {parts.slice(1).join("·")}
    </span>
  );
}
