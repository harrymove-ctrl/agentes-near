import type { SignInProvider } from "@agenteschat/client";
import { earlyAccessToken } from "@agenteschat/client/lib/guards";
import { createFileRoute } from "@tanstack/react-router";
import { DesktopSignInPage } from "@/pages/DesktopSignInPage";

const PROVIDERS: SignInProvider[] = ["google", "github", "apple"];

/**
 * The Mac app's social sign-in, in the browser (ADR 0036): the app opens this here instead of loading it. `error`:
 * the provider or the server refused it (Better Auth's code).
 */
export const Route = createFileRoute("/desktop/sign-in")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { provider?: SignInProvider; request?: string; done?: string; error?: string; access?: string } => ({
    provider: PROVIDERS.find((p) => p === search.provider),
    request:
      typeof search.request === "string" && /^[A-Za-z0-9_-]{43}$/.test(search.request) ? search.request : undefined,
    done: search.done === "1" || search.done === 1 ? "1" : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    access: earlyAccessToken(search.access),
  }),
  component: function DesktopSignIn() {
    const { provider, request, done, error, access } = Route.useSearch();
    return (
      <DesktopSignInPage provider={provider} request={request} done={done === "1"} error={error} access={access} />
    );
  },
});
