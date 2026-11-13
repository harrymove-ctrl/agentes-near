import type { ApiClient, SocketFactory } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { domWindow } from "@agenteschat/ui/testing/dom";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, within } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { AppProviders, type AppServices } from "@/app/providers";
import { createQueryClient } from "@/app/query-client";
import type { RouterContext } from "@/app/router-context";
import type { AuthClient } from "@/auth/client";
import { OrgProvider } from "@/components/org-context";
import { forgetComposerDrafts } from "@/hooks/useComposerDraft";
import { createI18n, type LocaleCode, setLocale } from "@/i18n";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { createToastStore } from "@/lib/toast";
import { RealtimeProvider } from "@/realtime/context";
import { routeTree } from "@/routeTree.gen";
import { createFakeAuth } from "./fake-auth";
import { fakeSockets } from "./fake-socket";

// Screen tests check end states: with reduced motion, streamed text shows whole at once and scrolls
// jump instead of gliding. The reveal pace itself is unit-tested in `chat-motion.test.ts`.
domWindow().happyDOM.settings.device.prefersReducedMotion = "reduce";

export function makeServices(
  api: ApiClient,
  auth: AuthClient = createFakeAuth().auth,
  createSocket: SocketFactory = fakeSockets().factory,
): AppServices {
  const toasts = createToastStore();
  const i18n = createI18n("pt-BR");
  const queryClient = createQueryClient({
    onUnauthorized: () => {},
    onMutationError: (m) => toasts.show(m, "error"),
    describeError: (error) => errorText(i18n.t, error, i18n.language),
  });
  // A query that retries by itself (an invitation that got no answer) does so at once.
  queryClient.setDefaultOptions({ queries: { retry: false, retryDelay: 0, refetchOnWindowFocus: false } });
  return { api, auth, queryClient, i18n, toasts, createSocket };
}

/** Lets pending promises and React updates settle. */
export async function settle(times = 3) {
  for (let i = 0; i < times; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
}

export const screen = () => within(document.body);

/**
 * The app in another language, as a person's pick shows it, the page's `lang` too: CI's geometry capture keeps a
 * screen per language, so a test's worst case in German or Japanese is measured there.
 */
export async function showIn(services: { i18n: AppServices["i18n"] }, lang: LocaleCode) {
  await act(async () => setLocale(lang, services.i18n));
  await settle(4);
  // Only words changed, which the capture doesn't watch for: it saves the screen in this language now.
  (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
}

/**
 * Elements matching `selector` are on screen once observed, as a browser's IntersectionObserver says (happy-dom's
 * never answers): what streams only while on screen, like the browser card in the conversation, streams. Returns
 * the undo.
 */
export function onScreen(selector: string) {
  const native = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    answer: IntersectionObserverCallback;
    constructor(answer: IntersectionObserverCallback) {
      this.answer = answer;
    }
    observe(target: Element) {
      if (target.matches(selector))
        this.answer([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  return () => {
    globalThis.IntersectionObserver = native;
  };
}

/**
 * A dialog that closes stays on screen until `endExit`, as a browser keeps it through its exit animation (Radix waits
 * for one): what it shows while it closes can be checked. The next app rendered starts without it.
 */
export function exitsLast() {
  const sheet = document.createElement("style");
  sheet.dataset.exitsLast = "";
  sheet.textContent = '.ac-dialog[data-state="closed"] { animation-name: dialog-out; }';
  document.head.append(sheet);
}

/** Ends the exit of a dialog that `exitsLast` keeps on screen. */
export const endExit = (dialog: Element) =>
  act(async () => void fireEvent.animationEnd(dialog, { animationName: "dialog-out" }));

const forgetExits = () => {
  for (const sheet of document.querySelectorAll("style[data-exits-last]")) sheet.remove();
};

/**
 * Renders one page inside the app providers and a minimal router (for
 * `<Link>`), optionally inside an organization (sidebar context + realtime).
 */
export async function renderPage(
  node: ReactNode,
  options: {
    api: ApiClient;
    auth?: AuthClient;
    org?: boolean;
    createSocket?: SocketFactory;
    path?: string;
  },
) {
  forgetExits();
  const sockets = fakeSockets();
  const createSocket = options.createSocket ?? sockets.factory;
  const services = makeServices(options.api, options.auth, createSocket);
  const me = await options.api.account.me();
  const content =
    options.org && me?.organizations[0] ? (
      <OrgProvider org={me.organizations[0]} me={me}>
        <RealtimeProvider orgId={me.organizations[0].id} createSocket={createSocket}>
          {node}
        </RealtimeProvider>
      </OrgProvider>
    ) : (
      node
    );
  const root = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const page = createRoute({ getParentRoute: () => root, path: "$", component: () => content });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [options.path ?? "/page"] }),
    context: { queryClient: services.queryClient, api: options.api },
  });
  const result = render(
    <AppProviders services={services}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await settle();
  return { ...result, services, router, sockets };
}

/**
 * Renders the real app routes (route guards, redirects) at `path`. `strict`: inside StrictMode, as development runs
 * the app (every effect twice on mounting).
 */
export async function renderApp(
  path: string,
  options: {
    api: ApiClient;
    auth?: AuthClient;
    createSocket?: SocketFactory;
    strict?: boolean;
    /** A reload of the same browser: keep what this browser wrote down (unsent composer text). */
    reload?: boolean;
  },
) {
  // Unsent composer text lives in localStorage, a flow's way back in sessionStorage: an app starts like a fresh
  // browser unless the test reloads one.
  if (!options.reload) {
    forgetComposerDrafts();
    sessionStore.remove(STORAGE_KEYS.flowReturn);
  }
  // Each app starts in its own language (pt-BR), whatever page language a test before it showed (`showIn`).
  document.documentElement.lang = "";
  forgetExits();
  const sockets = fakeSockets();
  const services = makeServices(options.api, options.auth, options.createSocket ?? sockets.factory);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: services.queryClient, api: options.api },
  });
  const app = (
    <AppProviders services={services}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  const result = render(options.strict ? <StrictMode>{app}</StrictMode> : app);
  await settle(6);
  return { ...result, services, router, sockets };
}
