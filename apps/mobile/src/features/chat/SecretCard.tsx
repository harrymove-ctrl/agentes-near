import {
  type SecretRequest,
  type SecretToVaultInput,
  useApi,
  useSaveSecretToVault,
  type VaultAccess,
  type VaultScope,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { secretAad } from "@agenteschat/client/lib/secret-box";
import {
  secretClosedBy,
  secretLabel,
  secretRefusalKey,
  secretValueProblem,
  secretWhere,
} from "@agenteschat/client/lib/secret-requests";
import { secretEndedAt, secretOutcome } from "@agenteschat/client/lib/secret-words";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { sealSecret } from "@/lib/secret-box";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  CodeInput,
  EventPillAction,
  fieldText,
  haptics,
  Icon,
  LineIcon,
  Locked,
  Segmented,
  Text,
  ToggleSwitch,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { IconTile } from "../connectors/ConnectorIcon";
import { chatHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { useSheetIfAny } from "../shared/SheetHost";
import { codeComplete, codeLength, LIMITS, secretToVaultInput, vaultSaveOffered } from "../vault/logic";
import { AgentPickSheet } from "../vault/parts";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore, useExpired } from "./asks";
import { markName } from "./logic";

type AgentPick = Pick<VaultAccess, "allAgents" | "agentIds">;

/** How long a failed save keeps the typed value for "Try again" (ADR 0144), at most. */
const RETRY_MS = 2 * 60_000;

/**
 * An agent asks for a secret for its computer (`request_secret`, ADR 0027), as the request card. Only the
 * person asked sees the field; the value is sealed here, on the phone, to the key the computer made, so it
 * never reaches our server, the chat or the agent. Everyone else sees who was asked. Once it ends, one line.
 *
 * ADR 0144 §6: a site's password or a key can also go to the Vault ("Save to the Vault", on by default), personal or
 * the team's, for the agents chosen (the one that asked first), with the username the agent filled in. Only then
 * does the value reach the server, once, after the box was delivered. A code asked by the site comes in one box per
 * digit and is never saved.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const when = useWhen();
  const c = useColors();
  const toast = useToast();
  const asks = useAskStore();
  const sheet = useSheetIfAny();
  const saveToVault = useSaveSecretToVault(orgId);
  // What this phone did to it (the message's copy changes only when the server says so).
  const [answered, setAnswered] = useState<SecretRequest | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | null>(null);
  const r = answered ?? request;
  const code = codeLength(r);
  const offered = vaultSaveOffered(r);
  const site = r.target.kind === "site";
  const canTeam = can(org, "manage_credentials");
  const [save, setSave] = useState(true);
  const [scope, setScope] = useState<VaultScope>("personal");
  const [pick, setPick] = useState<AgentPick>(() => ({ allAgents: false, agentIds: [request.agentId] }));
  const [username, setUsername] = useState(request.username ?? "");
  // "dropped": it failed and the time to try again is over, so the typed value is gone.
  const [kept, setKept] = useState<"saved" | "failed" | "saving" | "dropped" | null>(null);
  // A save that failed keeps what it sent, for "Try again", while this card is on screen and for two minutes at most.
  // The mutation itself forgets it as soon as it ends (`reset`, `gcTime: 0`).
  const retry = useRef<(SecretToVaultInput & { requestId: string }) | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      retry.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );
  // It closes at its expiry even when no event says so (as the line above the composer stops counting it).
  const expired = useExpired(r.expiresAt);
  const agentName = dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent");
  const mine = r.requestedForUserId === meId;
  const person = dir.memberById.get(r.requestedForUserId)?.name ?? t("channel.unknownPerson");
  const pending = r.status === "pending" && !expired;
  // It ended (an event, its deadline, a refusal): what was typed goes with the field.
  useEffect(() => {
    if (!pending) setValue("");
  }, [pending]);

  const done = (res: SecretRequest) => {
    asks?.settle(r.id);
    setAnswered(res);
  };
  // Refused: the computer can't take it now and the card goes on, or the request ended and the card says how.
  const failed = async (err: unknown) => {
    const away = secretRefusalKey(err);
    if (away) return setError(t(away, { agent: agentName, time: formatTime(i18n.language, r.expiresAt) }));
    if ((err as { status?: number }).status !== 409) return setError(t("secret.failed"));
    const fresh = await api.secrets.get(orgId, r.id).catch(() => null);
    const closed = secretClosedBy(err, r, fresh);
    if (closed) return done(closed);
    if (fresh) setAnswered(fresh);
    setError(t(fresh ? "secret.changed" : "secret.failed"));
  };
  const showNewer = async () => {
    const newer = r.supersededBy ? await api.secrets.get(orgId, r.supersededBy).catch(() => null) : null;
    if (newer?.messageId) router.push(chatHref(newer.channelId, newer.threadId, newer.messageId));
  };
  const keep = async (input: SecretToVaultInput & { requestId: string }) => {
    setKept("saving");
    try {
      await saveToVault.mutateAsync(input);
      retry.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setKept("saved");
    } catch {
      if (!retry.current) {
        retry.current = input;
        retryTimer.current = setTimeout(() => {
          retry.current = null;
          setKept((k) => (k === "failed" ? "dropped" : k));
        }, RETRY_MS);
      }
      setKept("failed");
      toast({ title: t("mobile.vault.card.notSaved"), icon: "x" });
    } finally {
      saveToVault.reset();
    }
  };
  const send = async () => {
    const problem = code
      ? codeComplete(value, code)
        ? null
        : "mobile.vault.card.codeIncomplete"
      : secretValueProblem(value);
    if (problem) return setError(t(problem));
    setError(null);
    setBusy("send");
    try {
      if (!r.publicKey) throw Object.assign(new Error("closed"), { status: 409 });
      const aad = secretAad({ requestId: r.id, orgId, name: r.name, target: r.target });
      const res = await api.secrets.deliver(orgId, r.id, await sealSecret(r.publicKey, value, aad));
      const sent = value;
      setValue("");
      successHaptic();
      done(res);
      // Delivered first: the Vault keeps it only once the computer has it (the server checks it too).
      if (offered && save) {
        void keep({
          requestId: r.id,
          ...secretToVaultInput(r, sent, { scope: scope === "team" && canTeam ? "team" : "personal", pick, username }),
        });
      }
    } catch (err) {
      await failed(err);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setError(null);
    setBusy("decline");
    try {
      done(await api.secrets.decline(orgId, r.id));
    } catch (err) {
      await failed(err);
    } finally {
      setBusy(null);
    }
  };
  const chooseAgents = () =>
    sheet?.open(<AgentPickSheet initial={pick} onChange={setPick} onDone={() => sheet.close()} />);

  const label = secretLabel(t, r, agentName);
  const where = [
    secretWhere(t, r, agentName),
    site && r.username ? t("mobile.vault.card.as", { username: r.username }) : null,
  ]
    .filter(Boolean)
    .join(" ");
  // Closed: one pill, how it ended and which secret, never its value, and when; what it was for when asked.
  const endedAt = secretEndedAt(r);
  if (!pending)
    return (
      <>
        <AskDone
          done={r.status === "delivered"}
          words={`${secretOutcome(t, r, mine, person, agentName)}: ${markName(label)}`}
          time={endedAt ? when.short(endedAt) : undefined}
          actions={
            r.supersededBy ? <EventPillAction label={t("secret.seeNewer")} onPress={() => void showNewer()} /> : null
          }
          more={{
            label: t("approval.seeDetails"),
            content: (
              <Text variant="small" tone="muted">
                {[r.purpose, where, kept === "saved" ? t("mobile.vault.card.saved") : null].filter(Boolean).join("\n")}
              </Text>
            ),
          }}
        />
        {kept === "failed" || kept === "dropped" || (kept === "saving" && retry.current) ? (
          <View style={styles.retry}>
            <Icon name="x" size={13} color={c.danger} />
            <Text variant="footnote" tone="muted" style={styles.grow}>
              {t("mobile.vault.card.notSaved")}
            </Text>
            {kept === "dropped" ? null : (
              <Button
                variant="ghost"
                size="sm"
                label={t("common.retry")}
                loading={kept === "saving"}
                onPress={() => {
                  if (retry.current) void keep(retry.current);
                }}
              />
            )}
          </View>
        ) : null}
      </>
    );

  return (
    <AskCard
      id={r.id}
      kind="secret"
      agentId={r.agentId}
      waitsFor={mine ? "you" : t("ask.waitingFor", { name: person })}
      lead={r.purpose}
      well={{ tile: <IconTile name="lock" size={20} bare />, title: label, detail: where }}
      body={
        mine ? (
          <Locked when={busy !== null} style={styles.body}>
            {code ? (
              <CodeInput
                length={code}
                value={value}
                onChange={(v) => {
                  setValue(v);
                  setError(null);
                }}
                label={label}
                error={Boolean(error)}
                onSubmit={() => void send()}
              />
            ) : (
              <View style={[styles.field, { backgroundColor: c.raised, borderColor: error ? c.danger : c.line2 }]}>
                <TextInput
                  value={value}
                  onChangeText={(v) => {
                    setValue(v);
                    setError(null);
                  }}
                  placeholder={t("secret.placeholder")}
                  placeholderTextColor={c.faint}
                  accessibilityLabel={label}
                  style={[styles.input, { color: c.ink }]}
                  secureTextEntry
                  textContentType="none"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType="send"
                  onSubmitEditing={() => void send()}
                  submitBehavior="submit"
                />
              </View>
            )}
            {error ? (
              <Text variant="footnote" tone="danger">
                {error}
              </Text>
            ) : null}
            <View style={styles.note}>
              <LineIcon variant="footnote" name="lock" size={13} color={c.muted} />
              <Text variant="footnote" tone="muted" style={styles.grow}>
                {code ? t("mobile.vault.card.codeNote") : t("secret.private")}
              </Text>
            </View>
            {offered ? (
              <View style={[styles.save, { borderTopColor: c.line2 }]}>
                <Pressable
                  onPress={() => {
                    haptics.selection();
                    setSave((s) => !s);
                  }}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: save }}
                  accessibilityLabel={t("mobile.vault.card.save")}
                  accessibilityHint={t("mobile.vault.card.saveText")}
                  style={({ pressed }) => [styles.saveRow, pressed && styles.pressed]}
                >
                  <LineIcon variant="subhead" name={site ? "globe" : "key"} size={16} color={c.muted} />
                  <View style={styles.grow}>
                    <Text variant="subhead" style={styles.semibold}>
                      {t("mobile.vault.card.save")}
                    </Text>
                    <Text variant="footnote" tone="muted">
                      {t("mobile.vault.card.saveText")}
                    </Text>
                  </View>
                  <ToggleSwitch value={save} />
                </Pressable>
                {save ? (
                  <>
                    {canTeam ? (
                      <Segmented
                        items={[
                          { key: "personal", label: t("mobile.vault.tab.personal") },
                          { key: "team", label: t("mobile.vault.tab.team") },
                        ]}
                        value={scope}
                        onChange={(k) => setScope(k === "team" ? "team" : "personal")}
                      />
                    ) : (
                      <Text variant="footnote" tone="muted">
                        {t("mobile.vault.card.personalOnly")}
                      </Text>
                    )}
                    <View style={styles.agents}>
                      {pick.allAgents ? (
                        <Chip icon="agent" label={t("mobile.vault.access.allAgents")} />
                      ) : pick.agentIds.length === 0 ? (
                        <Text variant="footnote" tone="muted">
                          {t("mobile.vault.access.noAgent")}
                        </Text>
                      ) : (
                        pick.agentIds.map((id) => (
                          <Chip
                            key={id}
                            leading={<AgentFace agentId={id} size={16} live={false} />}
                            label={dir.anyAgent(id)?.name ?? t("channel.unknownAgent")}
                          />
                        ))
                      )}
                      {sheet ? (
                        <Pressable
                          onPress={chooseAgents}
                          accessibilityRole="button"
                          hitSlop={12}
                          style={({ pressed }) => pressed && styles.pressed}
                        >
                          <Text variant="subhead" tone="ink2" style={styles.semibold}>
                            {t("mobile.vault.card.choose")}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {site ? (
                      <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line2 }]}>
                        <TextInput
                          value={username}
                          onChangeText={setUsername}
                          maxLength={LIMITS.username}
                          placeholder={t("mobile.vault.field.username")}
                          placeholderTextColor={c.faint}
                          accessibilityLabel={t("mobile.vault.field.username")}
                          style={[styles.input, { color: c.ink }]}
                          textContentType="username"
                          autoCapitalize="none"
                          autoCorrect={false}
                          spellCheck={false}
                        />
                      </View>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : null}
          </Locked>
        ) : null
      }
      expiry={<ExpiryLine expiresAt={r.expiresAt} />}
      foot={
        <AskFoot>
          {mine ? (
            <AskButtons
              primary={
                <Button
                  variant="primary"
                  size="card"
                  wide
                  icon="lock"
                  label={t("secret.send")}
                  loading={busy === "send"}
                  disabled={busy !== null}
                  onPress={() => void send()}
                />
              }
              secondary={
                <Button
                  variant="secondary"
                  size="card"
                  wide
                  label={t("approval.notNow")}
                  loading={busy === "decline"}
                  disabled={busy !== null}
                  onPress={() => void decline()}
                />
              }
            />
          ) : (
            <Text variant="small" tone="muted">
              {t("secret.waitingFor", { person })}
            </Text>
          )}
        </AskFoot>
      }
    />
  );
}

const styles = StyleSheet.create({
  // The card's body gives its children this gap: the lock takes their place in it.
  body: { gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: "center",
  },
  input: { ...fieldText("body"), paddingVertical: 10 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  save: { gap: 10, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  // Its explanation wraps: the icon and the switch stay on the title's line, not centred on the whole row.
  saveRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  agents: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  retry: { flexDirection: "row", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.6 },
});
