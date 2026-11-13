import type { MachineAccountKind } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";

/**
 * The sign-in popup while the computer looks up the provider's page: the opener sends it there (`sendPopup`), or closes
 * it and says why in the dialog. Fechar is the way out if the opener never does.
 */
export function ConnectingPage({ kind }: { kind?: MachineAccountKind }) {
  const { t } = useTranslation();
  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state="writing" />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">
              {kind ? t("connectAi.popup.title", { name: t(`aiAccounts.connect.${kind}`) }) : t("connectAi.popup.any")}
            </h1>
            <p className="auth__lead">{t("connectAi.popup.text")}</p>
          </div>
        </header>
        <Button onClick={() => window.close()}>{t("common.close")}</Button>
      </div>
    </AuthShell>
  );
}
