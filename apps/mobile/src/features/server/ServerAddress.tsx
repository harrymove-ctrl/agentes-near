import { checkServer, normalizeServer, serverHost } from "@agenteschat/client/lib/server";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_URL } from "@/config";
import { connectToServer, problemText } from "@/features/server";
import { ALLOW_HTTP, serverUrl } from "@/lib/server";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Locked } from "@/ui/Locked";
import { router } from "@/ui/navigation";
import { Text } from "@/ui/Text";
import { useToast } from "@/ui/Toast";

/**
 * "Onde fica o seu agentes.chat?": the team's own server (self-hosted, usually on Tailscale), by address with the
 * URL keyboard open and its return key as the action, or by the QR code the web app shows. The server is checked
 * before anything changes. `onDone` leaves it (back on the sign-in, or closing the sheet it was opened in); `scan`
 * off where the camera's screen can't be pushed (over the waiting splash).
 */
export function ServerAddress({ onDone, scan = true }: { onDone: () => void; scan?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const custom = serverUrl() !== API_URL;
  const [address, setAddress] = useState(custom ? serverHost(serverUrl()) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchTo = async (server: string) => {
    setBusy(true);
    await connectToServer({ server });
    toast({ title: t("mobile.auth.server.now", { host: serverHost(server) }) });
    onDone();
  };

  const submit = async () => {
    if (busy || !address.trim()) return;
    const server = normalizeServer(address, { allowHttp: ALLOW_HTTP });
    if (!server) return setError(t("mobile.auth.server.invalid"));
    setBusy(true);
    setError(null);
    const check = await checkServer(server);
    if (check.ok) return switchTo(check.server);
    haptics.warning();
    const host = serverHost(check.server);
    setError(t(problemText(check.problem, check.server), { host }));
    setBusy(false);
  };

  return (
    <AuthScaffold
      title={t("mobile.auth.server.title")}
      subtitle={t("mobile.auth.server.subtitle")}
      onBack={() => onDone()}
      agentMode={busy ? "run" : "idle"}
      footer={
        custom && !busy ? (
          <AuthLink
            label={t("mobile.auth.server.backTo", { host: serverHost(API_URL) })}
            onPress={() => void switchTo(API_URL)}
          />
        ) : null
      }
    >
      <Locked when={busy} keepKeyboard>
        <AuthField
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setError(null);
          }}
          placeholder={t("mobile.auth.server.placeholder")}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="URL"
          // The keyboard's blue key says "ir"; gray until an address is typed.
          returnKeyType="go"
          enablesReturnKeyAutomatically
          onSubmitEditing={() => void submit()}
          accessibilityLabel={t("mobile.auth.server.label")}
          autoFocus
        />
      </Locked>
      {error ? (
        <Text tone="danger" variant="small" style={CENTER}>
          {error}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        label={busy ? t("mobile.auth.server.checking") : t("mobile.auth.server.use")}
        loading={busy}
        disabled={!address.trim()}
        onPress={() => void submit()}
      />
      {scan ? (
        <Button
          variant="secondary"
          wide
          label={t("mobile.auth.server.scan")}
          disabled={busy}
          onPress={() => router.push("/scan")}
        />
      ) : null}
    </AuthScaffold>
  );
}
