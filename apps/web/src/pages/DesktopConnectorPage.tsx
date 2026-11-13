import { ApiError, useCompleteOAuth } from "@agenteschat/client";
import { errorCode, oauthReturnText } from "@agenteschat/client/lib/errors";
import { safeRedirect } from "@agenteschat/client/lib/guards";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { DESKTOP_MAIL_STATE } from "@/lib/desktop";
import { useToast } from "@/lib/toast";

/**
 * In the app's window: a connector's sign-in that the browser handed back, finished with the window's session
 * (`POST …/connectors/oauth/complete`), then on to where it started with `?connected=…` (Conectores says it).
 * Refused at the provider or not finished: Conectores, with why. A mailbox's return (Composio) comes already
 * read by the server: Conectores with `?mail=connected|failed`, which opens "O que faz" for it.
 */
export function DesktopConnectorPage({
  org,
  state,
  code,
  error,
}: {
  org?: string;
  state?: string;
  code?: string;
  error?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const complete = useCompleteOAuth(org ?? "");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Replacing this page: the code it carried leaves the history.
    const go = (href: string) => void navigate({ href, replace: true });
    // `reason`: why, as the callbacks say it (oauthReturnText), or the API's code (and what it names) when finishing
    // here failed.
    const fail = (reason: string, params?: Record<string, unknown>) => {
      toast.show(oauthReturnText(t, reason, params), "error");
      go(org ? `/org/${encodeURIComponent(org)}/settings/connectors` : "/");
    };
    if (state === DESKTOP_MAIL_STATE) {
      if (org) {
        return go(
          `/org/${encodeURIComponent(org)}/settings/connectors?mail=${code === "connected" ? "connected" : "failed"}`,
        );
      }
      toast.show(t("mail.failed"), "error");
      return go("/");
    }
    // The provider's own refusal (its `error`): cancelled. No code and no reason: it failed.
    // A connector's own refusal (Composio's unfinished sign-in) comes as its full code.
    if (error?.startsWith("connector.")) return fail(error);
    if (!org || error || !state || !code) return fail(error && error !== "missing_code" ? "cancelled" : "failed");
    complete.mutate(
      { state, code },
      {
        onSuccess: (done) => {
          const to = safeRedirect(done.returnTo) ?? `/org/${encodeURIComponent(org)}/settings/connectors`;
          const back = `connected=${encodeURIComponent(done.connector)}&outcome=${done.outcome}`;
          go(`${to}${to.includes("?") ? "&" : "?"}${back}`);
        },
        onError: (failed) =>
          fail(errorCode(failed) ?? "failed", failed instanceof ApiError ? failed.params : undefined),
      },
    );
  }, [org, state, code, error, complete, navigate, toast, t]);

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state="writing" />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">{t("auth.desktop.connecting")}</h1>
          </div>
        </header>
      </div>
    </AuthShell>
  );
}
