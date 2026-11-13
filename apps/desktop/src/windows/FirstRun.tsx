/**
 * The welcome window: how the app finds its server. agentes.chat is the one big action; your own server is a
 * small line under it, leading to Connect (an address, or one found on this computer or the Tailscale
 * network, and the one-command setup for a server that has none yet) or to running agentes.chat on this
 * computer. A connect link (`agenteschat://connect`) opens here
 * too: the server in large type, nothing changes before Connect. Choosing a server opens the main window there
 * and closes this one. A pair link (`agenteschat://pair`) asks to connect this computer instead (`PairLinkSheet`).
 */
import {
  CLOUD_SERVER,
  type ConnectLink,
  connectLink,
  isLoopback,
  parseConnectLink,
  type ServerCheck,
} from "@agenteschat/client/lib/server";
import { isEmail } from "@agenteschat/client/lib/text";
import {
  Button,
  Chip,
  ComputerPortrait,
  Field,
  glowTones,
  Icon,
  InfoHint,
  Input,
  PixelSky,
  PixelSpinner,
  type SkyOptions,
  Switch,
  useNow,
} from "@agenteschat/ui";
import { type FormEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../app";
import {
  type Candidate,
  CHECK_MS,
  type ConnectProblem,
  connectOutcome,
  escapeAction,
  type FirstScreen,
  foundServers,
  INSTALL_COMMAND,
  INSTALL_COMMAND_LIVE,
  type LinkView,
  LOOK_MS,
  linkView,
  ownAddresses,
  ownServerScreen,
  PROBLEM_TEXT,
  terminalStartCommand,
  typedServer,
} from "../control/first-run";
import {
  FAIL_TEXT,
  failedStep,
  hereView,
  type LocalServerStatus,
  type ReachStage,
  type SetupStep,
  type StepChange,
  setupSteps,
  stepClock,
  stepStates,
  tailscaleFrom,
} from "../control/local-server";
import { parsePairLink } from "../control/pair";
import { serverKind, serverName } from "../control/server";
import { useOnShown, useTailnet, writePref } from "../hooks";
import { BrandFace, CommandCopy, HelpLink } from "../ui/bits";
import { CopyDetails, ReachProblem, ReachProgress, ReachRow, ServerTile } from "../ui/here";
import { hintFor, PrefRow } from "../ui/settings";
import { elapsedClock, shortPath } from "../ui/time";
import { PairLinkSheet } from "./Pair";

/** The sky as a horizon at the bottom of the first screen: the surface, then the sky. */
const HORIZON: SkyOptions = {
  pixel: 4,
  palette: (bg) => glowTones("sky", bg),
  light: 0,
  base: (u, v, t) => {
    const top = 1 - 0.7 * (0.8 + 0.2 * Math.sin(u * 4 + t * 0.4));
    const e = Math.max(0, Math.min(1, (v - top) / (1 - top)));
    return e * e * (3 - 2 * e) * 0.95;
  },
};

const PROBLEM_HOSTLESS: ReadonlySet<ConnectProblem> = new Set(["invalid"]);

export function FirstRun() {
  const host = useHost();
  const [screen, setScreen] = useState<FirstScreen>("choose");
  // Opened by the site's "Add a workspace" (ADR 0154): its first screen says so.
  const [adding, setAdding] = useState(false);
  // Adding a workspace with agentes.chat already signed in here: making one is the big button, not signing in.
  const [cloudSignedIn, setCloudSignedIn] = useState(false);
  const [trail, setTrail] = useState<FirstScreen[]>([]);
  // `typed`: the sheet confirms an address typed or picked in Connect, so Cancel goes back there with it.
  const [link, setLink] = useState<{ raw: string; parsed: ConnectLink | null; view: LinkView; typed?: boolean } | null>(
    null,
  );
  // This build carries the server (Mac and Linux): "Run agentes.chat on this computer" is offered.
  const [canRunHere, setCanRunHere] = useState(false);
  // The agentes.chat this computer runs (the app's, or one from the terminal): named as such, never by its address,
  // and its owner page opened directly while it waits for one.
  const [local, setLocal] = useState<LocalServerStatus | null>(null);
  // Connect's address: it stays when a sheet about it is cancelled (the screen comes back new).
  const [address, setAddress] = useState("");
  // The setup's screen is up (running, failed or done): Esc and the window shown again leave it on screen.
  const settingUp = useRef(false);
  const setSettingUp = useCallback((busy: boolean) => {
    settingUp.current = busy;
  }, []);
  // A pair link on screen; `seq` makes a newer one start over.
  const [pair, setPair] = useState<{ server: string; code: string; seq: number } | null>(null);
  const linkSeq = useRef(0);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const go = useCallback(
    (next: FirstScreen) => {
      setTrail((t) => [...t, screen]);
      setScreen(next);
    },
    [screen],
  );
  const back = useCallback(() => {
    setTrail((t) => {
      const prev = t[t.length - 1];
      if (prev) setScreen(prev);
      return t.slice(0, -1);
    });
  }, []);

  const finish = useCallback(
    async (server: string, page?: string) => {
      await host.chooseServer(server, page);
      await host.hideWindow("welcome").catch(() => {});
    },
    [host],
  );

  /** A server confirmed in large type (a link, or a typed address whose own address is another host). */
  const confirm = useCallback(
    async (server: string) => {
      const { current } = await host.servers();
      const view: LinkView = {
        kind: "ask",
        server,
        question: "question",
        button: "connect",
        leave: current && current !== server ? serverName(current) : null,
      };
      setLink({ raw: "", parsed: { server }, view, typed: true });
      go("link");
    },
    [host, go],
  );

  /** A connect link: checked before it shows; the newest one replaces any still on screen. */
  const openLink = useCallback(
    async (raw: string) => {
      const seq = ++linkSeq.current;
      const asked = parsePairLink(raw);
      if (asked) {
        setPair({ ...asked, seq });
        const from = screenRef.current;
        if (from !== "pair") setTrail((t) => [...t, from]);
        setScreen("pair");
        return;
      }
      const parsed = parseConnectLink(raw, { allowHttp: "loopback" });
      const list = await host.servers();
      setLink({ raw, parsed, view: linkView(parsed, "checking", list.current) });
      // Cancel comes back to where the person was.
      const from = screenRef.current;
      if (from !== "link") setTrail((t) => [...t, from]);
      setScreen("link");
      if (!parsed) return;
      const check = await host.checkServer(parsed.server);
      if (seq !== linkSeq.current) return;
      const view = linkView(parsed, check, list.current);
      if (view.kind === "front") {
        await finish(view.server);
        return;
      }
      setLink({ raw, parsed, view });
    },
    [host, finish],
  );

  // How it opened: taken when it's made, and each time it shows again.
  const takeMode = useCallback(() => {
    void host
      .welcomeMode()
      .then((mode) => setAdding(mode === "add"))
      .catch(() => setAdding(false));
    void host
      .workspaces()
      .then((list) => setCloudSignedIn(list.some((s) => s.server === CLOUD_SERVER && s.signedIn)))
      .catch(() => setCloudSignedIn(false));
  }, [host]);
  useEffect(takeMode, [takeMode]);

  useEffect(() => {
    void host
      .localServer()
      .then((s) => {
        setCanRunHere(s.bundled);
        setLocal(s);
      })
      .catch(() => {});
  }, [host]);
  const own = ownAddresses(local?.run || local?.installed === "terminal" ? local : null);

  // A link waiting when the window opens, and any that arrives while it's open.
  useEffect(() => {
    const take = () =>
      void host
        .takeLink()
        .then((raw) => {
          if (raw) void openLink(raw);
        })
        .catch(() => {});
    take();
    return host.onLink(take);
  }, [host, openLink]);

  // Opened again ("Add a server…"): from the start, unless a link or the setup is on screen.
  useOnShown("welcome", () => {
    takeMode();
    // A link or pair screen whose sheet is gone has nothing to draw: it starts over too.
    if ((screen === "link" && link) || (screen === "pair" && pair) || settingUp.current) return;
    setTrail([]);
    setScreen("choose");
    setAddress("");
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const action = escapeAction(trail.length, settingUp.current);
      if (action === "back") back();
      else if (action === "close")
        void host.servers().then(({ current }) => {
          if (current) void host.hideWindow("welcome").catch(() => {});
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host, trail, back]);

  return (
    <div className="dk-fr" data-screen={screen}>
      <div className="dk-fr__body" key={screen}>
        {screen === "choose" && (
          <Choose
            adding={adding}
            cloudSignedIn={cloudSignedIn}
            onCloud={(page) => void finish(CLOUD_SERVER, page)}
            onOwn={() => go(ownServerScreen(canRunHere))}
          />
        )}
        {screen === "own" && (
          <Own adding={adding} onBack={back} onConnect={() => go("connect")} onHere={() => go("here")} />
        )}
        {screen === "connect" && (
          <Connect
            onBack={back}
            backLabel={trail[trail.length - 1] === "own" ? "own" : "choose"}
            local={local}
            own={own}
            address={address}
            onAddress={setAddress}
            onUse={finish}
            onConfirm={confirm}
            onLink={openLink}
          />
        )}
        {screen === "here" && (
          <RunHere onBack={back} onUse={finish} onConfirm={confirm} onLink={openLink} onBusy={setSettingUp} />
        )}
        {screen === "link" && link && (
          <LinkSheet
            view={link.view}
            own={own}
            onRetry={() => void (link.raw ? openLink(link.raw) : link.parsed && confirm(link.parsed.server))}
            onAccept={(server, page) => void finish(server, page)}
            onCancel={() => {
              setLink(null);
              // An address typed in Connect: back there with it, as Esc does.
              if (link.typed && trail.length > 0) return back();
              void host.servers().then(({ current }) => {
                if (current) void host.hideWindow("welcome").catch(() => {});
                else if (trail.length > 0) back();
                else setScreen("choose");
              });
            }}
          />
        )}
        {screen === "pair" && pair && (
          <PairLinkSheet
            key={pair.seq}
            server={pair.server}
            code={pair.code}
            onClose={() => {
              setPair(null);
              void host.servers().then(({ current }) => {
                if (current) void host.hideWindow("welcome").catch(() => {});
                else if (trail.length > 0) back();
                else setScreen("choose");
              });
            }}
          />
        )}
      </div>
      {screen === "choose" && (
        <span className="dk-wel__horizon" aria-hidden="true">
          <PixelSky options={HORIZON} />
        </span>
      )}
    </div>
  );
}

/**
 * agentes.chat, big; your own server, small. `adding` (the site's "Add a workspace", ADR 0154): signing in to
 * agentes.chat (the workspaces an account already has, or was invited to) is the big one and a new workspace the
 * line under it; with agentes.chat already signed in here, a new workspace is the big one. The team's server stays
 * the small one; the workspaces already there stay.
 */
function Choose({
  adding,
  cloudSignedIn,
  onCloud,
  onOwn,
}: {
  adding: boolean;
  cloudSignedIn: boolean;
  onCloud: (page: string) => void;
  onOwn: () => void;
}) {
  const { t } = useTranslation();
  const makeFirst = adding && cloudSignedIn;
  return (
    <>
      <div className="dk-fr__hello">
        <span className="dk-fr__mark">
          <BrandFace size="xl" />
        </span>
        <h1>{t(adding ? "desktop.first.addTitle" : "desktop.first.title")}</h1>
        <p className="dk-lead">{t(adding ? "desktop.first.addLead" : "desktop.first.lead")}</p>
        <Button
          variant="primary"
          className="dk-btn-lg dk-fr__cloud"
          autoFocus
          onClick={() => onCloud(makeFirst ? "/onboarding" : "/login")}
        >
          {t(makeFirst ? "desktop.first.addCloud" : "desktop.first.cloud")}
          <Icon name="arrowRight" size={16} />
        </Button>
        {/* The other way under it: an account (first run) or a new workspace (adding, signed in there or not). */}
        {!makeFirst && (
          <span className="dk-help">
            {t(adding ? "desktop.first.addNew" : "desktop.first.create")}{" "}
            <button
              type="button"
              className="ac-link dk-link"
              onClick={() => onCloud(adding ? "/onboarding" : "/signup")}
            >
              {t(adding ? "desktop.first.addNewLink" : "desktop.first.createLink")}
            </button>
          </span>
        )}
      </div>
      <button type="button" className="dk-fr__own" onClick={onOwn}>
        {t(adding ? "desktop.first.addOwn" : "desktop.first.own")}
        <Icon name="chevronRight" size={14} />
      </button>
    </>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="dk-fr__back" onClick={onClick}>
      <Icon name="chevronLeft" size={14} />
      {label}
    </button>
  );
}

/** The two ways to use your own server; adding a workspace, it reads as the line that led here. */
function Own({
  adding,
  onBack,
  onConnect,
  onHere,
}: {
  adding: boolean;
  onBack: () => void;
  onConnect: () => void;
  onHere: () => void;
}) {
  const { t } = useTranslation();
  const host = useHost();
  return (
    <>
      <BackLink label={t("desktop.own.back")} onClick={onBack} />
      <h1>{t(adding ? "desktop.first.addOwn" : "desktop.own.title")}</h1>
      <p className="dk-lead">{t("desktop.own.lead")}</p>
      <div className="dk-fr__cards">
        <button type="button" className="dk-fr__card" onClick={onConnect}>
          <span className="dk-fr__card-art" aria-hidden="true">
            <Icon name="computer" size={18} />
            <Icon name="arrowRight" size={14} />
            <Icon name="computerLinux" size={18} />
          </span>
          <b>{t("desktop.own.connect")}</b>
          <small>{t("desktop.own.connectText")}</small>
          <Icon name="chevronRight" size={16} className="dk-fr__card-go" />
        </button>
        <button type="button" className="dk-fr__card" onClick={onHere}>
          <span className="dk-fr__card-art" aria-hidden="true">
            <Icon name={host.platform === "windows" ? "computerWindows" : "computer"} size={18} />
          </span>
          <b>{t("desktop.own.here")}</b>
          <small>{t("desktop.own.hereText")}</small>
          <Icon name="chevronRight" size={16} className="dk-fr__card-go" />
        </button>
      </div>
      <p className="dk-help dk-fr__which">
        <HelpLink slug="run-on-your-computer" section="who">
          {t("desktop.own.which")}
        </HelpLink>
      </p>
    </>
  );
}

/**
 * What's wrong with an address, with the one thing that fixes it where the app can do it: its updates for a server
 * newer than this app, Tailscale's app for a server on a Tailscale network it can't reach.
 */
function ProblemLine({ problem, host: where }: { problem: ConnectProblem; host: string }) {
  const { t } = useTranslation();
  const host = useHost();
  const tailnet = useTailnet();
  const action =
    problem === "app-too-old"
      ? {
          label: t("desktop.connect.checkUpdates"),
          run: () => {
            writePref("prefsTab", "updates");
            void host.showWindow("prefs").catch(() => {});
          },
        }
      : problem === "unreachable-tailnet" && tailscaleFrom(host.platform, tailnet) === "app"
        ? { label: t("desktop.here.openTailscale"), run: () => void host.openTailscale("app").catch(() => {}) }
        : null;
  return (
    <span className="dk-honest dk-fr__problem ac-iconline" role="alert">
      <Icon name="alert" size={16} />
      <span>
        {t(PROBLEM_TEXT[problem], PROBLEM_HOSTLESS.has(problem) ? {} : { host: where })}
        {action && (
          <>
            {" "}
            <button type="button" className="ac-link dk-link" onClick={action.run}>
              {action.label}
            </button>
          </>
        )}
      </span>
    </span>
  );
}

const wait = (ms: number) => new Promise<"late">((r) => setTimeout(() => r("late"), ms));

/**
 * The address, what was found, and the one-command setup for a server that has none yet. Discovery lists each server
 * as soon as its check answers, one that answered with a problem with that problem, and can look again. While this
 * computer's Tailscale is off it says the servers there can't show up. The address typed stays when a sheet about it
 * is cancelled (`address` lives in the window).
 */
function Connect({
  onBack,
  backLabel,
  local,
  own,
  address,
  onAddress,
  onUse,
  onConfirm,
  onLink,
}: {
  onBack: () => void;
  backLabel: "own" | "choose";
  /** The agentes.chat this computer runs or has from the terminal (its owner claim, while it waits for one). */
  local: LocalServerStatus | null;
  /** Its addresses (`ownAddresses`). */
  own: readonly string[];
  address: string;
  onAddress: (address: string) => void;
  onUse: (server: string) => Promise<void>;
  onConfirm: (server: string) => Promise<void>;
  onLink: (raw: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const host = useHost();
  const tailnet = useTailnet();
  const [checking, setChecking] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ problem: ConnectProblem; host: string } | null>(null);
  const [looking, setLooking] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [checks, setChecks] = useState<(ServerCheck | null)[]>([]);
  // "Look again" bumps it: discovery runs once more from the start.
  const [scan, setScan] = useState(0);

  // Discovery: this computer and the Tailscale network. The list comes within LOOK_MS, then each candidate's check
  // within CHECK_MS of its own; only servers that answered show, each as soon as it did.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scan` asks for the search again
  useEffect(() => {
    let live = true;
    setLooking(true);
    setCandidates([]);
    setChecks([]);
    void (async () => {
      const listed = await Promise.race([host.discover().catch(() => [] as Candidate[]), wait(LOOK_MS)]);
      if (!live) return;
      if (listed === "late" || listed.length === 0) return setLooking(false);
      setCandidates(listed);
      setChecks(listed.map(() => null));
      await Promise.race([
        Promise.all(
          listed.map(async (c, i) => {
            const check = await host.checkServer(c.server).catch(() => null);
            if (live) setChecks((now) => now.map((x, j) => (j === i ? check : x)));
          }),
        ),
        wait(CHECK_MS),
      ]);
      if (live) setLooking(false);
    })();
    return () => {
      live = false;
    };
  }, [host, scan]);
  const found = foundServers(candidates, checks);

  // A server on this computer still waiting for its owner: the app knows its owner link, so its page opens.
  const claimHere = (server: string) =>
    local?.claim && (isLoopback(server) || own.includes(server))
      ? connectLink(local.url ?? server, { claim: local.claim })
      : null;

  const submit = async (input: string) => {
    if (checking) return;
    const typed = typedServer(input);
    if (!typed.ok) return setProblem({ problem: typed.problem, host: typed.host });
    setProblem(null);
    setChecking(typed.server);
    const check = await host.checkServer(typed.server);
    setChecking(null);
    const outcome = connectOutcome(typed.server, check, own);
    const claim = outcome.kind === "problem" && outcome.problem === "no-owner" ? claimHere(typed.server) : null;
    if (claim) await onLink(claim);
    else if (outcome.kind === "problem") setProblem(outcome);
    else if (outcome.kind === "use") await onUse(outcome.server);
    else await onConfirm(outcome.server);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim()) void submit(address);
  };
  const none = hintFor(t, t("desktop.connect.none"), t("desktop.connect.noneText"));
  const hereCount = found.filter((o) => o.where === "here").length;

  return (
    <>
      <BackLink label={backLabel === "own" ? t("desktop.own.title") : t("desktop.own.back")} onClick={onBack} />
      <h1>{t("desktop.connect.title")}</h1>
      <p className="dk-lead">{t("desktop.connect.lead")}</p>
      <form className="dk-fr__form" onSubmit={onSubmit}>
        <Input
          autoFocus
          value={address}
          placeholder={t("desktop.connect.placeholder")}
          aria-label={t("desktop.connect.label")}
          aria-describedby="connect-address-hint"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          invalid={problem !== null}
          onChange={(e) => {
            onAddress(e.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" variant="primary" disabled={!address.trim() || checking !== null}>
          {checking ? (
            <>
              <PixelSpinner size={14} color="sky" />
              {t("desktop.connect.checking")}
            </>
          ) : (
            t("desktop.connect.go")
          )}
        </Button>
      </form>
      {problem ? (
        <ProblemLine problem={problem.problem} host={problem.host} />
      ) : (
        <span className="dk-help" id="connect-address-hint">
          {t("desktop.connect.addressHint")}
        </span>
      )}
      {found.length > 0 && (
        <section className="dk-fr__found" aria-label={t("desktop.connect.found")}>
          <h2 className="dk-ctitle">{t("desktop.connect.found")}</h2>
          {found.map((f) => {
            const mine = f.where === "here" || own.includes(f.server);
            const claim = f.problem === "no-owner" ? claimHere(f.server) : null;
            // Used as is; one with a problem only when the app can take it from there (its owner page here).
            const usable = !f.problem || claim !== null;
            return (
              <div key={f.server} className="dk-fr__foundrow">
                <ServerTile kind={f.where} />
                <span className="dk-fr__foundtext">
                  {/* This computer by its name; its address only when more than one answers here. */}
                  <b>{mine ? t("desktop.link.chipHere") : serverName(f.server)}</b>
                  <small>
                    {f.problem && !claim
                      ? t(PROBLEM_TEXT[f.problem], { host: mine ? t("desktop.link.thisServer") : serverName(f.server) })
                      : f.where === "tailnet"
                        ? t("desktop.connect.foundTailnet")
                        : hereCount > 1
                          ? `${t("desktop.connect.foundHere")} · ${serverName(f.server)}`
                          : claim
                            ? t("desktop.connect.foundNoOwner")
                            : t("desktop.connect.foundHere")}
                  </small>
                </span>
                {usable && (
                  <Button
                    size="sm"
                    disabled={checking !== null}
                    onClick={() => void (claim ? onLink(claim) : submit(f.server))}
                  >
                    {claim ? t("desktop.connect.setUp") : t("desktop.connect.use")}
                  </Button>
                )}
              </div>
            );
          })}
        </section>
      )}
      {looking ? (
        <p className="dk-fr__looking" aria-live="polite">
          <PixelSpinner size={14} color="sky" />
          <span className="dk-shimmer">{t("desktop.connect.looking")}</span>
        </p>
      ) : (
        <p className="dk-help dk-fr__lookagain">
          {found.length === 0 && <>{t("desktop.connect.noneFound")} </>}
          <button type="button" className="ac-link dk-link" onClick={() => setScan((n) => n + 1)}>
            {t("desktop.connect.lookAgain")}
          </button>
        </p>
      )}
      {tailnet?.state === "off" && (
        <p className="dk-help dk-fr__tailnet ac-iconline">
          <Icon name="globe" size={14} />
          <span>
            {t("desktop.connect.tailnetOff")}
            {tailscaleFrom(host.platform, tailnet) === "app" && (
              <>
                {" "}
                <button
                  type="button"
                  className="ac-link dk-link"
                  onClick={() => void host.openTailscale("app").catch(() => {})}
                >
                  {t("desktop.here.openTailscale")}
                </button>
              </>
            )}
          </span>
        </p>
      )}
      {INSTALL_COMMAND_LIVE && (
        <section className="dk-fr__none" aria-label={t("desktop.connect.none")}>
          <span className="ac-hintline">
            <h2>{t("desktop.connect.none")}</h2>
            <InfoHint name={none.name}>{none.text}</InfoHint>
          </span>
          <CommandCopy command={INSTALL_COMMAND} />
        </section>
      )}
    </>
  );
}

/**
 * agentes.chat on this computer, inside the app: the owner's name and email (until the owner exists), reach
 * through Tailscale (off), usage statistics (on; as they were, for one that ran here before), then Start, and the
 * steps as the app runs them, each problem on its own step. One installed from the terminal already runs here:
 * Use it (its owner page while it waits for one); installed but not running: it starts there. The app runs it
 * already: open it.
 */
function RunHere({
  onBack,
  onUse,
  onConfirm,
  onLink,
  onBusy,
}: {
  onBack: () => void;
  onUse: (server: string) => Promise<void>;
  onConfirm: (server: string) => Promise<void>;
  onLink: (raw: string) => Promise<void>;
  /** The setup's screen is up (Esc and the window shown again leave it on screen). */
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const host = useHost();
  const [status, setStatus] = useState<LocalServerStatus | null>(null);
  // A server (a Docker install) answering on this computer when the app doesn't run one: checked once.
  const [answering, setAnswering] = useState<string | null | undefined>(undefined);
  const tailnet = useTailnet();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [reach, setReach] = useState(false);
  const [usage, setUsage] = useState(true);
  // Start was pressed with a field missing: each one says what it needs.
  const [tried, setTried] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [problem, setProblem] = useState<{ problem: ConnectProblem; host: string } | null>(null);
  const [checking, setChecking] = useState(false);
  // Reach ended with a warning: the window stays until the person read it (the main window is already open).
  const warned = useRef(false);

  const read = useCallback(() => {
    void host
      .localServer()
      .then((s) => {
        setStatus(s);
        if (s.systemName) setName((n) => n || (s.systemName ?? ""));
        // One that ran here before starts again as it was.
        setReach(s.reach);
        setUsage(s.usage);
      })
      .catch(() => {});
    void host
      .checkServer("http://127.0.0.1:3000")
      .then((c) => setAnswering(c.ok ? c.server : null))
      .catch(() => setAnswering(null));
  }, [host]);
  useEffect(read, [read]);
  // Left mid-setup (a link arrived): the setup goes on in the app, and Esc works again on what shows.
  const busy = setup !== null;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  useEffect(
    () =>
      host.onSetupStep((c) => {
        if (c.state === "warn") warned.current = true;
        setSetup((s) =>
          s ? { ...s, changes: [...s.changes, c], activeAt: c.state === "active" ? Date.now() : s.activeAt } : s,
        );
      }),
    [host],
  );

  if (!status || answering === undefined) {
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.title")}</h1>
        <p className="dk-fr__looking" aria-live="polite">
          <PixelSpinner size={14} color="sky" />
        </p>
      </>
    );
  }
  const view = hereView(status, answering);

  if (view.kind === "running") {
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.running")}</h1>
        <p className="dk-lead">{t("desktop.here.runningText")}</p>
        <div className="dk-fr__end" data-near>
          <Button variant="primary" autoFocus onClick={() => void onUse(view.server)}>
            {t("desktop.here.openIt")}
          </Button>
        </div>
      </>
    );
  }

  if (view.kind === "stopped") {
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.notRunning")}</h1>
        <p className="dk-lead">{t("desktop.here.notRunningText", { path: shortPath(status.dir) })}</p>
        <CommandCopy command={terminalStartCommand(status.dir)} />
        <div className="dk-fr__end" data-near>
          <Button variant="primary" icon="refresh" autoFocus onClick={read}>
            {t("desktop.common.retry")}
          </Button>
        </div>
      </>
    );
  }

  if (view.kind === "already") {
    const use = async () => {
      if (view.claim) return onLink(connectLink(view.server, { claim: view.claim }));
      setChecking(true);
      const outcome = connectOutcome(view.server, await host.checkServer(view.server), ownAddresses(status));
      setChecking(false);
      if (outcome.kind === "problem") setProblem(outcome);
      else if (outcome.kind === "use") await onUse(outcome.server);
      else await onConfirm(outcome.server);
    };
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.already")}</h1>
        {/* From the terminal, or the Docker install answering on this computer: how it runs, never its address. */}
        <p className="dk-lead">
          {t(status.installed === "terminal" ? "desktop.here.alreadyText" : "desktop.here.alreadyDocker")}
        </p>
        {problem && <ProblemLine problem={problem.problem} host={problem.host} />}
        <div className="dk-fr__end" data-near>
          <Button variant="primary" autoFocus loading={checking} onClick={() => void use()}>
            {t("desktop.here.useIt")}
          </Button>
        </div>
      </>
    );
  }

  // The computer is as it was before Start: the form comes back, with what was typed and chosen (the undone setup
  // reads as reach off, and usage on when it stopped before writing it).
  const backToForm = () => {
    setSetup(null);
    void host
      .localServer()
      .then(setStatus)
      .catch(() => {});
  };
  const start = async () => {
    const choice = view.ask ? { name: name.trim(), email: email.trim(), reach, usage } : { reach, usage };
    setSetup({ steps: setupSteps(reach), changes: [], activeAt: Date.now(), end: "running" });
    warned.current = false;
    try {
      await host.installLocalServer(choice);
      setSetup((s) => s && { ...s, end: "done" });
      if (!warned.current) await host.hideWindow("welcome").catch(() => {});
    } catch (e) {
      if (e === "cancelled") backToForm();
      else setSetup((s) => s && { ...s, end: "failed" });
    }
  };
  const cancel = () => {
    // After a failure the app has put everything back already.
    if (setup?.end === "failed") return backToForm();
    setSetup((s) => s && { ...s, end: "stopping" });
    void host.cancelLocalSetup().catch(() => {});
  };

  if (setup) {
    return (
      <HereSetup
        {...setup}
        onCancel={cancel}
        onRetry={() => void start()}
        onContinue={() => void host.hideWindow("welcome").catch(() => {})}
      />
    );
  }

  const nameOk = name.trim().length > 0;
  const emailOk = isEmail(email);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!view.ask || (nameOk && emailOk)) void start();
    else setTried(true);
  };
  return (
    <>
      <BackLink label={t("desktop.own.title")} onClick={onBack} />
      <h1 className="dk-fr__h1sm">{t("desktop.here.title")}</h1>
      <p className="dk-lead dk-fr__wide">
        {view.ask ? t("desktop.here.how") : t("desktop.here.again", { path: shortPath(status.dir) })}
      </p>
      <form className="dk-fr__here" onSubmit={submit} noValidate>
        {view.ask && (
          <div className="dk-fr__who">
            <Field label={t("desktop.here.name")} error={tried && !nameOk ? t("desktop.here.nameNeeded") : undefined}>
              <Input
                autoFocus
                value={name}
                maxLength={100}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label={t("desktop.here.email")}
              error={tried && !emailOk ? t("desktop.here.emailNeeded") : undefined}
            >
              <Input
                type="email"
                inputMode="email"
                value={email}
                maxLength={254}
                autoComplete="email"
                spellCheck={false}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          </div>
        )}
        <div className="dk-card">
          <ReachRow tailnet={tailnet} on={reach} onChange={setReach} />
          <PrefRow
            title={t("desktop.here.usage")}
            hint={hintFor(t, t("desktop.here.usage"), t("desktop.here.usageText"))}
            htmlFor="here-usage"
            end={
              <Switch id="here-usage" aria-describedby="here-usage-hint" checked={usage} onCheckedChange={setUsage} />
            }
          />
        </div>
        <div className="dk-fr__end">
          <Button type="submit" variant="primary" autoFocus={!view.ask}>
            {t("desktop.here.start")}
          </Button>
        </div>
      </form>
    </>
  );
}

/** How a setup on screen stands: under way, stopping after Cancel, failed, or done (with reach's warning). */
type SetupEnd = "running" | "stopping" | "failed" | "done";

interface Setup {
  steps: SetupStep[];
  changes: StepChange[];
  /** When the step under way began. */
  activeAt: number;
  end: SetupEnd;
}

/**
 * Setting it up, in the window's middle: this computer, the title, then the steps, the bar and the buttons in one
 * column. The step under way shows its time from 10 s and, from 30 s, that it takes longer than expected. A failed
 * step says what happened, with Copy details. Cancel works at every step, and Esc presses it.
 */
function HereSetup({
  steps,
  changes,
  activeAt,
  end,
  onCancel,
  onRetry,
  onContinue,
}: Setup & { onCancel: () => void; onRetry: () => void; onContinue: () => void }) {
  const { t } = useTranslation();
  const host = useHost();
  const title = useRef<HTMLHeadingElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const now = useNow(end === "running" ? 1000 : false);
  const states = stepStates(steps, changes);
  // Never every step done and no button: an error with no failed step ends on the step under way.
  const failed = end === "failed" ? failedStep(steps, states) : null;
  const done = steps.filter((s) => states[s] === "done" || states[s] === "warn").length;
  // Reach's own progress while its step runs: Tailscale's page for HTTPS shows as soon as Tailscale names it.
  const [stage, setStage] = useState<ReachStage | null>(null);
  useEffect(() => host.onLocalReach(setStage), [host]);
  const reachProblem = changes.find((c) => c.step === "reach" && c.state === "warn")?.reason;
  const clock = stepClock(now - activeAt);
  // Opens in the window's middle, then stays where it opened: a slow step's line or a failure's words grow the
  // column downward instead of moving the title and Cancel. The room above is pinned once (the window keeps its size)
  // and gives way only by what the column would run past the window, so its last button stays in view.
  useLayoutEffect(() => {
    const el = column.current;
    const first = el?.firstElementChild;
    const run = el?.lastElementChild;
    const scroller = el?.parentElement;
    if (!el || !first || !run || !scroller) return;
    const pinned = Number.parseFloat(getComputedStyle(first).marginTop);
    const fit = () => {
      el.style.setProperty("--dk-setup-lead", `${pinned}px`);
      const over = scroller.scrollHeight - scroller.clientHeight;
      if (over > 0) el.style.setProperty("--dk-setup-lead", `${Math.max(0, pinned - over)}px`);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(fit);
    resized.observe(run);
    return () => resized.disconnect();
  }, []);
  // Screen readers start where they are, at every run.
  useEffect(() => {
    if (end === "running") title.current?.focus();
  }, [end]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (end === "done") onContinue();
      else if (end !== "stopping") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [end, onCancel, onContinue]);
  return (
    <div className="dk-fr__setup" ref={column}>
      <ComputerPortrait kind={host.platform} state={failed ? "paused" : "online"} size={96} />
      <h1 ref={title} className="dk-fr__h1sm" tabIndex={-1}>
        {t("desktop.here.setting")}
      </h1>
      <div className="dk-fr__run">
        <ol className="dk-fr__steps" aria-live="polite">
          {steps.map((step) => {
            const state = step === failed ? "failed" : states[step];
            return (
              <li key={step} className="ac-iconline" data-state={state}>
                <span className="dk-fr__stepmark" aria-hidden="true">
                  {state === "active" ? (
                    <PixelSpinner size={16} color="sky" />
                  ) : state === "done" ? (
                    <Icon name="check" size={16} />
                  ) : state === "failed" ? (
                    <Icon name="close" size={16} />
                  ) : state === "warn" ? (
                    <Icon name="alert" size={16} />
                  ) : (
                    <span className="dk-fr__stepdot" />
                  )}
                </span>
                <span className="dk-fr__steptext">
                  <span className="dk-fr__stepname">
                    <b className={state === "active" ? "dk-shimmer" : undefined}>{t(`desktop.here.step.${step}`)}</b>
                    {step === "database" && <small>{t("desktop.here.step.databaseNote")}</small>}
                    {/* The marks are drawn: screen readers hear the state as words. The time is silent. */}
                    {state !== "todo" && (
                      <span className="ac-visually-hidden">{t(`desktop.here.stepState.${state}`)}</span>
                    )}
                    {state === "active" && clock.time && (
                      <span className="dk-fr__steptime" aria-hidden="true">
                        {elapsedClock(now - activeAt)}
                      </span>
                    )}
                  </span>
                  {/* Waiting on the person to allow HTTPS isn't slow. */}
                  {state === "active" && clock.slow && !(step === "reach" && stage?.stage === "approve") && (
                    <span className="dk-fr__stepline">
                      {t("desktop.here.slow")} · <CopyDetails as="link" />
                    </span>
                  )}
                  {state === "failed" && (
                    <span className="dk-honest">
                      {t(FAIL_TEXT[step])} <CopyDetails as="link" />
                    </span>
                  )}
                  {step === "reach" && state === "active" && stage && stage.stage !== "signingIn" && (
                    <ReachProgress stage={stage} />
                  )}
                  {step === "reach" && reachProblem && <ReachProblem problem={reachProblem} text="fail" />}
                </span>
              </li>
            );
          })}
        </ol>
        <div
          className="dk-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-label={t("desktop.here.setting")}
        >
          <span style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
        <div className="dk-fr__runacts">
          {end === "done" ? (
            <Button variant="primary" autoFocus onClick={onContinue}>
              {t("desktop.common.continue")}
            </Button>
          ) : (
            <>
              <Button loading={end === "stopping"} onClick={onCancel}>
                {t("desktop.common.cancel")}
              </Button>
              {end === "failed" && (
                <Button variant="primary" icon="refresh" autoFocus onClick={onRetry}>
                  {t("desktop.common.retry")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * L: a server in large type, asked about before anything changes. The agentes.chat this computer runs reads as such
 * (at its local or its Tailscale address alike), never as an address; one on a Tailscale network says what that means.
 */
function LinkSheet({
  view,
  own,
  onRetry,
  onAccept,
  onCancel,
}: {
  view: LinkView;
  own: readonly string[];
  onRetry: () => void;
  onAccept: (server: string, page?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const server = view.kind === "notALink" ? null : view.server;
  const mine = server !== null && (own.includes(server) || serverKind(server) === "here");
  const kind = server ? serverKind(server) : null;
  const name = server ? (mine ? t("desktop.link.thisServer") : serverName(server)) : "";
  let body: ReactNode;
  let acts: ReactNode;
  if (view.kind === "notALink") {
    body = <p className="dk-fr__question">{t("desktop.link.notALink")}</p>;
    acts = (
      <Button variant="primary" autoFocus onClick={onCancel}>
        {t("desktop.common.close")}
      </Button>
    );
  } else if (view.kind === "checking" || view.kind === "front") {
    body = (
      <p className="dk-fr__question dk-fr__checking" aria-live="polite">
        <PixelSpinner size={14} color="sky" />
        <span className="dk-shimmer">{t("desktop.link.checking")}</span>
      </p>
    );
    acts = (
      <>
        <Button variant="ghost" onClick={onCancel}>
          {t("desktop.common.cancel")}
        </Button>
        <Button variant="primary" disabled>
          {t("desktop.link.connect")}
        </Button>
      </>
    );
  } else if (view.kind === "problem") {
    body = <ProblemLine problem={view.problem} host={name} />;
    acts = (
      <>
        <Button variant="ghost" onClick={onCancel}>
          {t("desktop.common.cancel")}
        </Button>
        <Button variant="primary" icon="refresh" autoFocus onClick={onRetry}>
          {t("desktop.common.retry")}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <p className="dk-fr__question">{t(`desktop.link.${view.question}`)}</p>
        {view.leave && (
          <p className="dk-help">
            {t("desktop.link.leave", {
              current: own.some((o) => serverName(o) === view.leave) ? t("desktop.link.thisServer") : view.leave,
            })}
          </p>
        )}
      </>
    );
    acts = (
      <>
        <Button variant="ghost" onClick={onCancel}>
          {t("desktop.common.cancel")}
        </Button>
        <Button variant="primary" autoFocus onClick={() => onAccept(view.server, view.page)}>
          {t(`desktop.link.${view.button}`)}
        </Button>
      </>
    );
  }
  return (
    <div className="dk-fr__sheet">
      {server && (
        <div className="dk-fr__server">
          <span className="dk-fr__host">{name}</span>
          {kind === "tailnet" && !mine && <Chip icon="globe">{t("desktop.link.chipTailnet")}</Chip>}
        </div>
      )}
      {kind === "tailnet" && !mine && <p className="dk-help">{t("desktop.link.tailnetHelp")}</p>}
      {body}
      <div className="dk-fr__acts">{acts}</div>
    </div>
  );
}
