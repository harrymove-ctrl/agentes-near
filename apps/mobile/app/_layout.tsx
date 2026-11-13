import { keys, useApi, useAuthConfig, useMe } from "@agenteschat/client";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { serverHost } from "@agenteschat/client/lib/server";
import { skyHourOf } from "@agenteschat/ui/sky/workspace";
import { useQueryClient } from "@tanstack/react-query";
import { type Href, ThemeProvider as NavigationThemeProvider, Stack, usePathname } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Entering } from "@/features/auth/Entering";
import { forgetInvite, loadPendingInvite, waitingAsk } from "@/features/auth/invite";
import { resumesAsk } from "@/features/auth/invite-steps";
import { LaunchSplash } from "@/features/launch/LaunchSplash";
import { markLaunched } from "@/features/launch/launched";
import { takeLink } from "@/features/links/pending";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { ServerDownPanel, useServerDown } from "@/features/server/ServerDown";
import { ScreenError } from "@/features/shared/ScreenError";
import { catchGlobalErrors, setErrorScope, startErrorReports } from "@/lib/error-reports";
import { keepLastCrash } from "@/lib/last-crash";
import { newWorkspaceDone, newWorkspaceMade, newWorkspaceShown, useNewWorkspaceAsk } from "@/lib/new-workspace";
import { enteringShown, firstRunMounted, suspendedOf } from "@/lib/org-choice";
import { useServer } from "@/lib/server";
import { AppProviders } from "@/providers/AppProviders";
import { useAppFonts } from "@/providers/fonts";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { DeletingAccount } from "@/ui/auth/DeletingAccount";
import { SuspendedWorkspace } from "@/ui/auth/SuspendedWorkspace";
import { router, useNavigationTheme } from "@/ui/navigation";
import { useTheme } from "@/ui/theme";

void SplashScreen.preventAutoHideAsync().catch(() => {});
// Upright everywhere but the agent's screen (`useSideways`). iOS starts this way (the plugin); Android only from here.
void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
keepLastCrash();
catchGlobalErrors();

/**
 * Root: the providers, then the session gate. What breaks while drawing outside `(app)`'s own boundary (the sign-in
 * screens, the server and scan screens, an invitation, a reset, connect, not-found, and the first run, splash,
 * suspended and entering overlays) gets the same screen, "Tentar de novo" drawing it again, instead of the app
 * closing.
 */
export default function RootLayout() {
  return (
    <AppProviders>
      <ErrorBoundary fallback={(error, reset) => <ScreenError error={error as Error} retry={async () => reset()} />}>
        <Gate />
      </ErrorBoundary>
    </AppProviders>
  );
}

/**
 * Signed out → `(auth)`; signed in → `(app)` (the screens, which wait for the organization themselves). The
 * splash (`LaunchSplash`) stays up until the fonts, the session and the organization are known, so nobody sees
 * a flash of the wrong side. Exactly one group is open at any moment: with both guarded (e.g. signed in while the
 * organization still loads), expo-router sends the guarded screen to the first open route, `+not-found`, and
 * the app would stay there once the organization arrived. While the session is still being read (the saved
 * one comes out of SecureStore a moment after launch) `(app)` is the open one, so the URL the app opened with
 * ("/", a push's conversation) is kept: closing it then sent "/" to `+not-found`, still on screen when the
 * session arrived ("Não achamos isso" on every launch). Each side sends a closed screen to the other's start.
 */
function Gate() {
  const fontsReady = useAppFonts();
  const session = useSession();
  const org = useOrgGate();
  const { colors, scheme } = useTheme();
  const navigationTheme = useNavigationTheme();
  const signedIn = session.signedIn;
  const inApp = signedIn || session.pending;
  // The server down or out of reach (a self-hosted one, often): the splash stays and says so, never the first run.
  const down = useServerDown(signedIn && !session.pending);
  const ready = fontsReady && !session.pending && (!signedIn || !org.loading) && down === null;
  // The account was deleted and waits for its date: its own screen, over everything else.
  const me = useMe();
  // Where the phone's error reports go, once the server says (ADR 0104).
  const authConfig = useAuthConfig();
  const reportsTo = authConfig.isSuccess ? (authConfig.data.mobileErrorReports ?? null) : undefined;
  useEffect(() => {
    if (reportsTo !== undefined) void startErrorReports(reportsTo);
  }, [reportsTo]);
  const userId = me.data?.user.id;
  const orgId = org.state?.orgId;
  useEffect(() => setErrorScope({ orgId, userId }), [orgId, userId]);
  const accountDeletion = ready && signedIn ? me.data?.user.deletion : undefined;
  // A workspace being deleted opens as ever, read-only, under its notice (ADR 0088 §7): only a suspension covers it.
  const suspended = ready && signedIn && org.state ? suspendedOf(org.state.orgs, org.state.orgId) : null;
  // Apagar conta opened from that screen goes over it: the screen steps aside while it is open.
  const pathname = usePathname();
  const deletingAccount = pathname === "/account-delete";
  // "Criar um workspace novo" from Adicionar workspace (ADR 0154): the first run on that server once signed in there,
  // until the new workspace is chosen or they go back.
  const server = useServer();
  const ask = useNewWorkspaceAsk();
  const openOrg = org.state?.orgId ?? null;
  const asking = ask !== null && ask.server === server && ready && signedIn && !newWorkspaceMade(ask, openOrg);
  useEffect(() => {
    if (!ask || ask.server !== server || !ready || !signedIn) return;
    if (newWorkspaceMade(ask, openOrg)) newWorkspaceDone();
    else newWorkspaceShown(openOrg);
  }, [ask, server, ready, signedIn, openOrg]);
  const fresh = asking;

  // Opening the app: the native launch image hands over to the animated splash on its first frame (they look
  // the same), which leaves once the app is ready. The fallback hide covers a splash that never lays out.
  const [launching, setLaunching] = useState(true);
  const hideNative = useCallback(() => void SplashScreen.hideAsync().catch(() => {}), []);
  const launched = useCallback(() => {
    setLaunching(false);
    markLaunched();
  }, []);
  useEffect(() => {
    if (ready) hideNative();
  }, [ready, hideNative]);
  // The server stops answering after the splash left, or while it was leaving (just signed in, nothing cached):
  // it comes back to say so.
  const isDown = down !== null;
  useEffect(() => {
    if (isDown && !launching) setLaunching(true);
  }, [isDown, launching]);

  // Just signed in (not a cold start already signed in): "Entrando…" for a moment while the app fills in. The timer
  // outlives this effect: the session flipping within that moment reruns it past the sign-in check, and clearing the
  // timer there left the screen up for good.
  const [welcoming, setWelcoming] = useState(false);
  const wasSignedIn = useRef<boolean | null>(null);
  useEffect(() => {
    if (session.pending) return;
    const before = wasSignedIn.current;
    wasSignedIn.current = signedIn;
    // A web link opened while signed out opens now; one opened before signing out never does.
    if (before === true && !signedIn) takeLink();
    if (before !== false || !signedIn) return;
    const link = takeLink();
    if (link) setTimeout(() => router.navigate(link as Href), 0);
    setWelcoming(true);
    setTimeout(() => setWelcoming(false), 1400);
  }, [signedIn, session.pending]);
  const accepting = useAcceptPendingInvite(signedIn && !session.pending);
  const entering = enteringShown({ signedIn, launching, welcoming, ready, accepting });
  useResumeAsk(!signedIn && !session.pending, pathname);
  // An invitation's own screen stays in front of the first run: someone with no workspace yet may be joining one.
  const onInvite = pathname.startsWith("/invite/");
  const [firstRunBefore, setFirstRunBefore] = useState(false);
  const firstRun = firstRunMounted(
    firstRunBefore,
    ready && signedIn && (org.none || fresh) && !accepting && !accountDeletion,
    onInvite,
  );
  if (firstRun !== firstRunBefore) setFirstRunBefore(firstRun);
  const suspendedShown = suspended !== null && !deletingAccount;
  const covered = suspendedShown || down !== null || (firstRun && fresh) || !!accountDeletion;

  // The navigator is always mounted (so links and pushes can navigate); the splash covers it until ready.
  return (
    // The native bars (headers, back button tint, interface style) read React Navigation's theme: ours.
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {/* Under the suspended screen or the waiting splash the app stays mounted, out of screen readers' reach. */}
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
      >
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Protected guard={inApp} redirectTo="/sign-in">
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={!inApp} redirectTo="/">
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
        </Stack>
      </View>
      {/* No workspace to open yet (none, or one still being set up): the first run, over the navigator (a waiting
          invitation is accepted instead). */}
      {firstRun ? (
        <View style={onInvite ? { display: "none" } : StyleSheet.absoluteFill}>
          <OnboardingFlow
            another={fresh ? (org.state?.org?.name ?? null) : null}
            onLeave={fresh ? newWorkspaceDone : undefined}
          />
        </View>
      ) : null}
      {entering ? <Entering org={org.state?.org?.name ?? null} /> : null}
      {org.state && suspended && suspendedShown ? <SuspendedWorkspace state={org.state} suspended={suspended} /> : null}
      {accountDeletion ? <DeletingAccount dueAt={accountDeletion.dueAt} /> : null}
      {launching ? (
        <LaunchSplash
          ready={ready}
          fontsReady={fontsReady}
          onShown={hideNative}
          onDone={launched}
          waiting={down ? <ServerDownPanel down={down} /> : null}
          eyesClosed={down !== null && !down.checking}
          dusk={down !== null && skyHourOf(serverHost(down.server)) === "dusk"}
        />
      ) : null}
    </NavigationThemeProvider>
  );
}

/**
 * A request made through a link still waits on this phone (ADR 0090 §3): opening the app returns to its screen, once,
 * from the sign-in a signed-out launch lands on. Back from there stays on the sign-in, and the request keeps waiting.
 */
function useResumeAsk(signedOut: boolean, pathname: string) {
  const resumed = useRef(false);
  useEffect(() => {
    if (!signedOut || resumed.current || !resumesAsk(pathname)) return;
    resumed.current = true;
    const asked = waitingAsk();
    if (asked) router.navigate(`/invite/${asked.token}`);
  }, [signedOut, pathname]);
}

/**
 * An invitation opened before signing in (features/auth/invite.ts), once the person is in: an email invitation is
 * accepted and its organization becomes the current one; a link's page opens again, for the account to ask to
 * join. True while one is being accepted (the first run waits).
 */
function useAcceptPendingInvite(signedIn: boolean): boolean {
  const api = useApi();
  const qc = useQueryClient();
  const org = useOrgGate();
  const [accepting, setAccepting] = useState(false);
  const choose = org.choose;
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    void loadPendingInvite().then(async (next) => {
      if (!next || !alive) return;
      if ("open" in next) {
        forgetInvite();
        router.navigate(next.open);
        return;
      }
      setAccepting(true);
      try {
        const { orgId } = await api.orgs.acceptInvitation(next.accept, next.mail);
        await qc.invalidateQueries({ queryKey: keys.me });
        choose(orgId);
      } catch {
        // Expired, used or for another e-mail: the invitation's own screen says why when it is opened again.
      } finally {
        forgetInvite();
        if (alive) setAccepting(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [signedIn, api, qc, choose]);
  return accepting;
}
