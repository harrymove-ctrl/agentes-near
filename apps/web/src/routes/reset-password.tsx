import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";

/** Where "Esqueci a senha"'s e-mail lands: `?token=` (or `?error=INVALID_TOKEN` when it expired). */
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: function ResetPassword() {
    const { token, error } = Route.useSearch();
    return <ResetPasswordPage token={error ? undefined : token} />;
  },
});
