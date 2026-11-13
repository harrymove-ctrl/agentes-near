import { ApiProvider, createSnapshot, outbox } from "@agenteschat/client";
import { textSizeOf } from "@agenteschat/client/lib/chat-look";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo } from "react";
import { I18nextProvider } from "react-i18next";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { frameClock } from "@/agent/clock";
import { PickerHost } from "@/features/shared/PickerSheet";
import { createApi } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { outboxStoreFor } from "@/lib/outbox";
import { useServer } from "@/lib/server";
import { snapshotStoreFor } from "@/lib/snapshot";
import { hintTouches } from "@/ui/hints";
import { ToastHost } from "@/ui/Toast";
import { TextScaleProvider } from "@/ui/text-scale";
import { ThemeProvider } from "@/ui/theme";
import { setupI18n } from "./i18n";
import { OrgProvider, useOrgMaybe } from "./org";
import { PushProvider } from "./push";
import { bindFocusToAppState, createQueryClient } from "./query";
import { RealtimeProvider } from "./realtime";
import { SessionProvider } from "./session";

const i18n = setupI18n();

/**
 * Everything the screens rely on, outermost first: gestures, safe areas, the keyboard (its height and
 * position on the UI thread, for the chat), theme, i18n, React Query, the API
 * client (`useApi`), the session, the current organization (`useOrg`), realtime (`useRealtime`), push and
 * toasts (`useToast`). Living agents pause while the app is in the background.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const server = useServer();
  // Each server gets its own cache, API client and auth client, so no data or session crosses servers.
  const scope = useMemo(
    () => ({ server, queryClient: createQueryClient(), api: createApi(server), auth: authClient(server) }),
    [server],
  );

  useEffect(() => bindFocusToAppState(), []);
  // The last lists and chats saved on this phone show at once; everything revalidates as usual. Saved again
  // when the app goes to the background. Leaving a server clears its cache, and with it the saved snapshot.
  useEffect(() => {
    const { queryClient } = scope;
    const snapshot = createSnapshot(queryClient, snapshotStoreFor(scope.server));
    const stop = snapshot.start();
    // What waits for the connection outlives the app being closed, and shows again in its conversation.
    const stopOutbox = outbox.keep(queryClient, outboxStoreFor(scope.server));
    void snapshot.restore().then(() => outbox.show(queryClient));
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background") void snapshot.flush();
    });
    return () => {
      // Another server (ADR 0154): this one's snapshot and waiting messages stay in its own files. They let go of
      // them before the cache clears, which would otherwise empty both as if the person had signed out.
      stopOutbox();
      stop();
      queryClient.clear();
      sub.remove();
    };
  }, [scope]);
  useEffect(() => {
    frameClock.setPaused(AppState.currentState !== "active");
    const sub = AppState.addEventListener("change", (s) => frameClock.setPaused(s !== "active"));
    return () => sub.remove();
  }, []);

  return (
    // Every touch passes here: a tap away from an open ⓘ hint closes it.
    <GestureHandlerRootView style={{ flex: 1 }} {...hintTouches}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <I18nextProvider i18n={i18n}>
              {/* Keyed by server: a query hook keeps the client it mounted with (TanStack's observer is made once), so
                  without a fresh tree the screens kept the first server's cache across a switch and asked this
                  server for another one's workspace (ADR 0154). */}
              <QueryClientProvider key={scope.server} client={scope.queryClient}>
                <ApiProvider client={scope.api}>
                  <SessionProvider auth={scope.auth} server={server}>
                    <OrgProvider>
                      <AppTextSize>
                        <RealtimeProvider>
                          <PushProvider>
                            <ToastHost>
                              {children}
                              {/* Every picker (`pickOne`) and Android's action menus, in the app's sheet, once for the whole app. */}
                              <PickerHost />
                            </ToastHost>
                          </PushProvider>
                        </RealtimeProvider>
                      </AppTextSize>
                    </OrgProvider>
                  </SessionProvider>
                </ApiProvider>
              </QueryClientProvider>
            </I18nextProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The person's text size (Você › Conversa) for every screen, read from the workspace they are in; the default before
 * one is chosen (sign-in, the first run).
 */
function AppTextSize({ children }: { children: ReactNode }) {
  const org = useOrgMaybe()?.org;
  return <TextScaleProvider size={textSizeOf(org?.chatPrefs)}>{children}</TextScaleProvider>;
}
