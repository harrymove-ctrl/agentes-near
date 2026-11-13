import { passwordState } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "@/lib/auth";
import { Button, Locked } from "@/ui";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { haptics } from "@/ui/haptics";
import { router } from "@/ui/navigation";

/**
 * "Esqueci a senha"'s link opened in the app (`/reset-password?token=`, a universal link / App Link): a new
 * password, then back to signing in. No token, or one the server refuses: the link expired.
 */
export function ResetPasswordScreen({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"form" | "done" | "expired">(token ? "form" : "expired");
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const ready = passwordState(password) === "ok";
  const save = async () => {
    if (!token || !ready || pending) return;
    setPending(true);
    try {
      const res = await authClient().resetPassword({ newPassword: password, token });
      if (res.error) {
        haptics.warning();
        setState("expired");
        return;
      }
      haptics.success();
      setState("done");
    } catch {
      setState("expired");
    } finally {
      setPending(false);
    }
  };
  const toSignIn = () => router.replace("/sign-in");
  if (state === "expired")
    return (
      <AuthScaffold title={t("mobile.reset.expired")} subtitle={t("mobile.reset.expiredLead")} expression="closed">
        <Button variant="primary" wide label={t("mobile.reset.toSignIn")} onPress={toSignIn} />
      </AuthScaffold>
    );
  if (state === "done")
    return (
      <AuthScaffold title={t("mobile.reset.done")} expression="happy">
        <Button variant="primary" wide label={t("mobile.reset.toSignIn")} onPress={toSignIn} />
      </AuthScaffold>
    );
  return (
    <AuthScaffold
      title={t("mobile.reset.title")}
      agentMode={pending ? "run" : "idle"}
      {...(secret ? { expression: "closed" as const } : {})}
    >
      <Locked when={pending}>
        <PasswordField
          value={password}
          onChangeText={setPassword}
          fresh
          onSecretChange={setSecret}
          onSubmitEditing={() => void save()}
          label={t("invite.createPassword")}
        />
      </Locked>
      <Button
        variant="primary"
        wide
        label={t("mobile.reset.save")}
        loading={pending}
        disabled={!ready}
        onPress={() => void save()}
      />
    </AuthScaffold>
  );
}
