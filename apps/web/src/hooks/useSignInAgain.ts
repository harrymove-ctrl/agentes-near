import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/auth/context";

/**
 * "Sign in again": a fresh sign-in is what adding a password takes. Out of this session, then to the sign-in page
 * with the address filled in, which comes back to this page as it is now (a dialog kept in the address opens again).
 */
export function useSignInAgain(email: string) {
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    const back = `${window.location.pathname}${window.location.search}`;
    await auth.signOut();
    qc.clear();
    await navigate({ to: "/login", search: { redirect: back, email } });
  };
}
