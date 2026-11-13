import { type SignInProvider, useAuthConfig } from "@agenteschat/client";
import { Button, Icon } from "@agenteschat/ui";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { GitHubMark } from "./GitHubMark";

const BRAND: Record<SignInProvider, ReactNode> = {
  google: (
    <svg className="auth-social__mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.6 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8Z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23Z"
      />
      <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8l3.7-2.8Z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4Z"
      />
    </svg>
  ),
  github: <GitHubMark className="auth-social__mark" />,
  apple: (
    <svg className="auth-social__mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.5 1.3 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.5a10 10 0 0 0 1.4-2.8c-.1 0-2.6-1-2.6-4.1ZM13.9 5c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4Z" />
    </svg>
  ),
};

const ORDER: SignInProvider[] = ["google", "github", "apple"];

/** How this browser signed in last (marked "Último usado"). */
export const lastSignIn = () => storage.get(STORAGE_KEYS.lastSignIn);
export const rememberSignIn = (method: SignInProvider | "email") => {
  storage.set(STORAGE_KEYS.lastSignIn, method);
  storage.remove(STORAGE_KEYS.signedOut);
};

/** The providers the server has configured, or only `only` (an account linked to them). */
export function useSocialProviders(only?: SignInProvider[]): SignInProvider[] {
  const config = useAuthConfig();
  const on = config.data?.socialProviders;
  if (!on) return [];
  return ORDER.filter((p) => on[p] && (!only || only.includes(p)));
}

/**
 * "Continuar com Google/GitHub/Apple": the brand's mark and the words centred, as on every button. "Último usado" is a
 * line under the one used last: inside it, the note would push them off centre, or onto the words on a narrow column.
 * `onSocial` takes over the redirect (the Mac app signs in through the browser).
 * `earlyAccess`: the early-access link's token, for the sign-up it opens.
 */
export function SocialButtons({
  callbackURL,
  providers,
  onSocial,
  earlyAccess,
}: {
  callbackURL: string;
  providers: SignInProvider[];
  onSocial?: (provider: SignInProvider) => void;
  earlyAccess?: string;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const last = lastSignIn();
  const lastId = useId();
  if (providers.length === 0) return null;
  const label = {
    google: t("auth.continueWithGoogle"),
    github: t("auth.continueWithGithub"),
    apple: t("auth.continueWithApple"),
  };
  return (
    <div className="auth-social">
      {providers.map((p) => (
        <div key={p} className="auth-social__item">
          <Button
            type="button"
            size="lg"
            block
            aria-describedby={last === p ? lastId : undefined}
            onClick={() => {
              rememberSignIn(p);
              if (onSocial) onSocial(p);
              else void auth.signInSocial(p, callbackURL, earlyAccess);
            }}
          >
            {BRAND[p]}
            {label[p]}
          </Button>
          {last === p && (
            <span className="auth-social__last ac-iconline" id={lastId}>
              <Icon name="clock" size={14} />
              {t("auth.lastUsed")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
