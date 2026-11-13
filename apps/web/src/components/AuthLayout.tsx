import { Logo } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";
import { AuthHorizon } from "@/components/Sky";
import { LanguageSelect } from "./LanguageSelect";
import "./auth.css";

/**
 * Sign in, sign up and new password: one calm question at a time in a narrow
 * column, the logo on top, the language beside it (signed out: the next sign-in sends it) and the sky's horizon at
 * the bottom. `languages={false}` for a signed-in screen in that look, already in the person's language.
 */
export function AuthShell({ children, languages = true }: { children: ReactNode; languages?: boolean }) {
  const col = useRef<HTMLElement>(null);
  return (
    <div className="auth">
      <AuthHorizon clear={() => [col.current]} />
      <span className="auth__logo">
        <Logo size={24} />
      </span>
      {languages && (
        <span className="auth__lang">
          <LanguageSelect signedIn={false} align="end" />
        </span>
      )}
      <main className="auth__col" ref={col}>
        {children}
      </main>
    </div>
  );
}

/** Centered card of the invitation and onboarding pages. */
export function CenteredLayout({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
  return (
    <div className="center">
      <Logo size={24} />
      <main className={narrow ? "center__card center__card--narrow" : "center__card"}>{children}</main>
    </div>
  );
}
