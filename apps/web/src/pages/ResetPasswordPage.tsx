import { authErrorText } from "@agenteschat/client/lib/errors";
import { passwordState } from "@agenteschat/client/lib/text";
import { Button, Icon, Input, Locked } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { PasswordHelp } from "@/pages/AuthPage";

/** "Esqueci a senha"'s link: a new password, in the sign-in screen's calm style. No token = the link expired. */
export function ResetPasswordPage({ token }: { token?: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [expired, setExpired] = useState(!token);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || passwordState(password) !== "ok" || pending) return;
    setPending(true);
    setError(null);
    const result = await auth.resetPassword({ token, newPassword: password });
    setPending(false);
    if (result.ok) return setDone(true);
    if (result.status === 400) return setExpired(true);
    setError(authErrorText(t, result));
  };

  // Before saving, no lead: the line under the field says what a password needs.
  const [title, lead]: [string, string?] = expired
    ? [t("auth.reset.expired"), t("auth.reset.expiredLead")]
    : done
      ? [t("auth.reset.done"), t("auth.reset.doneLead")]
      : [t("auth.reset.title")];
  const expression = done ? "happy" : focus && !show ? "closed" : undefined;

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state={pending ? "writing" : undefined} expression={expression} />
          <div className="auth__bubble" key={`${expired}-${done}`} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            {lead && <p className="auth__lead">{lead}</p>}
          </div>
        </header>
        <div className="auth__step">
          <Locked when={pending}>
            {expired || done ? (
              <Button asChild variant="primary" size="lg" block>
                <Link to="/login">{expired ? t("auth.reset.askAgain") : t("auth.signIn")}</Link>
              </Button>
            ) : (
              <>
                <div className="auth__field">
                  <div className="auth__pass">
                    <Input
                      className="auth__big"
                      type={show ? "text" : "password"}
                      aria-label={t("auth.reset.title")}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onFocus={() => setFocus(true)}
                      onBlur={() => setFocus(false)}
                      autoFocus
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={show ? "eyeOff" : "eye"}
                      aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
                      aria-pressed={show}
                      className="auth__eye"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setShow((s) => !s)}
                    />
                  </div>
                  <PasswordHelp password={password} />
                </div>
                {error && (
                  <p className="auth__error ac-iconline" role="alert">
                    <Icon name="alert" size={14} />
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  kbd={["↵"]}
                  loading={pending}
                  disabled={passwordState(password) !== "ok"}
                >
                  {t("auth.reset.save")}
                </Button>
              </>
            )}
          </Locked>
        </div>
      </form>
    </AuthShell>
  );
}
