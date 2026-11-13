import { authErrorText } from "@agenteschat/client/lib/errors";
import { isEmail, nameIsPassword, passwordState } from "@agenteschat/client/lib/text";
import { Button, Icon, Input, Locked } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { prepareBurst } from "@/components/Sky";
import { NameHint, PasswordHelp } from "@/pages/AuthPage";

type Problem = "noLink" | "wrongLink" | "taken";

/**
 * The installer's owner link (ADR 0060 §6): the installation's first account, with a name, an email
 * and a password, in the sign-in screen's style. The password is required: whoever opens the link is
 * on another computer or a phone, with nothing else that could sign them in again.
 */
export function OwnerPage({ claim }: { claim: string | null }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const header = useRef<HTMLElement>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(claim ? null : "noLink");

  const ready = name.trim().length > 0 && isEmail(email) && passwordState(password) === "ok";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!claim || !ready || pending) return;
    if (nameIsPassword(name, password)) {
      setPassword("");
      return setError(t("auth.flow.nameIsPassword"));
    }
    setPending(true);
    setError(null);
    const result = await auth.ownerClaim({ token: claim, name: name.trim(), email: email.trim(), password });
    setPending(false);
    if (result.ok) {
      prepareBurst(header.current ?? document.body)();
      qc.clear();
      await navigate({ to: "/onboarding" });
      return;
    }
    if (result.status === 401) return setProblem("wrongLink");
    if (result.status === 409) return setProblem("taken");
    setError(authErrorText(t, result));
  };

  const [title, lead] = problem
    ? [t(`auth.owner.${problem}`), t(`auth.owner.${problem}Lead`)]
    : [t("auth.owner.title"), t("auth.owner.lead")];

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        <header className="auth__ask" ref={header} data-burst>
          <AgentAvatar name="agentes.chat" size="lg" state={pending ? "writing" : undefined} />
          <div className="auth__bubble" key={problem ?? "form"} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>
        <div className="auth__step">
          <Locked when={pending}>
            {problem === "taken" && (
              <Button asChild variant="primary" size="lg" block>
                <Link to="/login">{t("auth.signIn")}</Link>
              </Button>
            )}
            {!problem && (
              <>
                <div className="auth__field">
                  <Input
                    className="auth__big"
                    aria-label={t("auth.yourName")}
                    autoComplete="name"
                    spellCheck={false}
                    placeholder={t("auth.flow.namePlaceholder")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                  <NameHint name={name} />
                </div>
                <Input
                  className="auth__big"
                  type="email"
                  inputMode="email"
                  aria-label={t("auth.email")}
                  autoComplete="email"
                  placeholder={t("auth.flow.emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <div className="auth__field">
                  <div className="auth__pass">
                    <Input
                      className="auth__big"
                      type={show ? "text" : "password"}
                      aria-label={t("invite.createPassword")}
                      autoComplete="new-password"
                      placeholder={t("invite.createPassword")}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
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
                <Button type="submit" variant="primary" size="lg" block kbd={["↵"]} loading={pending} disabled={!ready}>
                  {t("auth.owner.create")}
                </Button>
              </>
            )}
          </Locked>
        </div>
      </form>
    </AuthShell>
  );
}
