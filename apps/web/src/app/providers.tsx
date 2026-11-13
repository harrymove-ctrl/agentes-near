import type { ApiClient, SocketFactory } from "@agenteschat/client";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { i18n as I18n } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ApiProvider } from "@/api/context";
import type { AuthClient } from "@/auth/client";
import { AuthProvider } from "@/auth/context";
import { ThemeProvider } from "@/lib/theme";
import { ToastProvider, type ToastStore } from "@/lib/toast";
import { SocketFactoryContext } from "@/realtime/context";

export interface AppServices {
  api: ApiClient;
  auth: AuthClient;
  queryClient: QueryClient;
  i18n: I18n;
  toasts: ToastStore;
  /** WebSocket factory; defaults to the browser's (tests pass a fake). */
  createSocket?: SocketFactory;
}

/** Everything a page needs around it: theme, i18n, data, auth, toasts. Shared by the app and the tests. */
export function AppProviders({ services, children }: { services: AppServices; children: ReactNode }) {
  return (
    <I18nextProvider i18n={services.i18n}>
      <ThemeProvider>
        <QueryClientProvider client={services.queryClient}>
          <ApiProvider client={services.api}>
            <AuthProvider client={services.auth}>
              <ToastProvider store={services.toasts} closeLabel={services.i18n.t("common.close")}>
                {services.createSocket ? (
                  <SocketFactoryContext.Provider value={services.createSocket}>
                    {children}
                  </SocketFactoryContext.Provider>
                ) : (
                  children
                )}
              </ToastProvider>
            </AuthProvider>
          </ApiProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
