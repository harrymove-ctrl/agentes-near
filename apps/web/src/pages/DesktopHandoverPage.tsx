import { Button } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { takeFragmentParam } from "@/lib/fragment";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * In the app's window: the one-time sign-in a connect link carried, taken out of the address and the history
 * at once, then traded for a session of the window's own (`POST /api/auth/sign-in/one-time-token`). Refused
 * (expired, already used): the way to sign in by hand.
 */
export function DesktopHandoverPage({ to }: { to?: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeFragmentParam("token");
    if (!token) {
      setFailed(true);
      return;
    }
    void auth.signInOneTime(token).then((r) => {
      // A whole load: the session is new, so everything is asked again with it.
      if (r.ok) {
        storage.remove(STORAGE_KEYS.signedOut);
        window.location.assign(to ?? "/");
      } else setFailed(true);
    });
  }, [auth, to]);

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state={failed ? undefined : "writing"} />
          <div className="auth__bubble" key={String(failed)} aria-live="polite">
            <h1 className="auth__title">{failed ? t("auth.desktop.handoverFailed") : t("auth.desktop.handover")}</h1>
            {failed && <p className="auth__lead">{t("auth.desktop.handoverFailedLead")}</p>}
          </div>
        </header>
        {failed && (
          <Button variant="primary" onClick={() => window.location.assign("/login")}>
            {t("common.continue")}
          </Button>
        )}
      </div>
    </AuthShell>
  );
}
