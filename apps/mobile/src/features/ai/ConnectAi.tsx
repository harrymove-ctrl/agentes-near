import {
  type ConnectIntent,
  type Credential,
  keys,
  useAiAccounts,
  useAiStatus,
  useApi,
  useModels,
} from "@agenteschat/client";
import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import { errorText, keyRefusal } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, choiceOfIntent, freePlanAccount, PLAN_CHOICES } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import {
  keyLooksValid,
  type ProviderId,
  providerGuess,
  providerLabel,
  providerOf,
} from "@agenteschat/client/lib/providers";
import { isRightHand, rightHandOnKey, thinksWithLine } from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, usePreventRemove } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { ConnectAiFlow, viewOf } from "./ConnectAiSteps";
import type { FlowView } from "./logic";
import { PlanHoldNote, usePlanHold } from "./parts";

/**
 * The first run's API key (the web's key panel, saved by the step's button): a pay-as-you-go key for the
 * workspace. Agents without a key of their own think with the newest one of their provider, so nothing else needs
 * pointing. `orgId` is passed in: the first run goes before a workspace is chosen.
 */
export function useConnectKey(orgId: string, asked?: string) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderId>(() => providerGuess(undefined, asked));
  // "Outro provedor" (ADR 0146): its own form, saved by its own button (a sheet only: the first run saves a key).
  const [custom, setCustom] = useState(asked === CUSTOM_PROVIDER);
  const [key, setKeyRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<ReturnType<typeof keyRefusal>>(null);
  const [savedNote, setSavedNote] = useState<string>();
  const clean = key.trim();
  const looksRight = clean.length === 0 || keyLooksValid(provider, clean);
  // A pasted key says whose it is when only one provider's keys look like it.
  const setKey = (value: string) => {
    setKeyRaw(value);
    setFailed(false);
    setRefused(null);
    if (value.trim().length > 12) setProvider(providerGuess(value, provider));
  };
  const save = async (): Promise<Credential | null> => {
    if (!clean || saving) return null;
    setSaving(true);
    setFailed(false);
    setRefused(null);
    try {
      const entry = providerOf(provider);
      const saved = await api.agents.addCredential(orgId, { provider, label: entry?.label ?? provider, apiKey: clean });
      if (saved.check === "unchecked")
        setSavedNote(t("connectAi.key.savedUnchecked", { provider: providerLabel(provider) }));
      // `aiStatus` lives under `credentials`: both refresh.
      await qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
      return saved;
    } catch (error) {
      const refusal = keyRefusal(t, error);
      setRefused(refusal);
      setFailed(!refusal);
      return null;
    } finally {
      setSaving(false);
    }
  };
  return {
    provider,
    setProvider,
    custom,
    setCustom,
    key,
    setKey,
    looksRight,
    ready: clean.length > 0,
    saving,
    failed,
    refused,
    savedNote,
    setSavedNote,
    save,
  };
}

export type ConnectKey = ReturnType<typeof useConnectKey>;

/** The flow's three steps as the bar's subtitle: the way, the sign-in or the key, done. */
const STEPS = 3;

/**
 * "Conectar uma IA" as pushed screens (`/connect-ai?from=<messageId>&intent=<step>&provider=<id>&agentId=<id>
 * &plan=<plan>&email=<address>&ready=1&forNew=1`), one question per screen under a bar that counts the steps
 * ("1 de 3 · Dora"): how the agent will think (a plan or a key, and what the workspace already has), then the plan's
 * sign-in on the agent's computer or the workspace's API key (ConnectAiFlow), then done. The native back goes one
 * page back inside the flow before it leaves it. A message that asked for one of them opens on its page, and `plan`
 * on that plan's (Sign in again). Once connected from a message, the agent answers it by itself. `email`: one more
 * login of the account other agents use. `ready`: opened because the workspace's computer just got ready (its
 * notification): a plan's page says so.
 */
export function ConnectAiSheet() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const status = useAiStatus(orgId);
  const params = useLocalSearchParams<{
    from?: string;
    provider?: string;
    agentId?: string;
    intent?: string;
    plan?: string;
    email?: string;
    ready?: string;
    forNew?: string;
  }>();
  // An API key is the organization's (admins); a plan thinks only for its owner's agents (ADR 0059 §3).
  const mayAddKey = can(org, "manage_credentials");
  const hold = usePlanHold(orgId, org);
  // From the create-agent step: for the agent being made, never one I have.
  // The team's right hand thinks with each person's own AI (ADR 0137 §11): everyone's to connect for their DM.
  const mine = params.forNew === "1" ? [] : dir.agents.filter((a) => a.ownerUserId === meId || isRightHand(a));
  const named = params.agentId ? [params.agentId] : null;
  const agents = (named ? mine.filter((a) => named.includes(a.id)) : mine).map((a) => ({ id: a.id, name: a.name }));
  // The agents a plan was connected for here: they think with it before the AI status says so.
  const [linked, setLinked] = useState<string[]>([]);
  const hasAi = (id: string) => linked.includes(id) || (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  const [view, setView] = useState<FlowView>(() =>
    viewOf(PLAN_CHOICES.find((c) => c === params.plan) ?? choiceOfIntent(params.intent as ConnectIntent | undefined)),
  );
  const form = useConnectKey(orgId, params.provider);
  const models = useModels();
  const toast = useToast();
  const [keySaved, setKeySaved] = useState(false);
  const answer = () => {
    void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
    if (params.from) void api.chat.answerNow(orgId, params.from).catch(() => undefined);
  };
  // Opened for one agent: its name in the title.
  const one = named?.length === 1 ? dir.agentById.get(named[0] ?? "") : undefined;
  const rightHand = isRightHand(one);
  // No agent of theirs yet, and it isn't opened for someone else's: a plan signs in for the agents they create.
  const bare = !named && agents.length === 0;
  const [accountAdded, setAccountAdded] = useState(false);
  // Or one of that plan they already have, which the plan's page says is connected.
  const ai = useAiAccounts(orgId, bare);
  const hasPlan = bare && view.page === "plan" && freePlanAccount(ai.data?.accounts, view.choice) !== undefined;
  // Someone else's agent: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked =
    agents.length > 0 || bare
      ? undefined
      : one && owner
        ? t("noAi.locked", { name: one.name, owner: owner.split(" ")[0] })
        : t("noAi.lockedAdmins");
  const close = () => {
    if (router.canGoBack()) router.back();
  };
  const insets = useSafeAreaInsets();
  // The bar's title and the way back come from the flow, page by page.
  const [chrome, setChrome] = useState<{ title: string; back: (() => void) | null }>({ title: "", back: null });
  const onChrome = useCallback((next: { title: string; back: (() => void) | null }) => setChrome(next), []);
  const done = keySaved || linked.length > 0 || accountAdded || hasPlan;
  // Past the first page, the native back (the button and the edge swipe) goes back inside the flow; once done,
  // back and "Pronto" leave it.
  usePreventRemove(chrome.back !== null && !done, () => chrome.back?.());
  const step = done ? STEPS : view.page === "home" ? 1 : 2;
  const subtitle = [t("mobile.ai.stepOf", { step, total: STEPS }), one?.name ?? null].filter(Boolean).join(" · ");
  const ready = !hold && !dir.loading && !status.isPending;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={done ? t("connectAi.done") : chrome.title || t("connectAi.title.any")}
        subtitle={subtitle}
        solid={false}
        grouped
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
      >
        {ready && view.page === "home" && !done ? (
          // The question the first page answers, then the ways under it.
          <View style={styles.head}>
            <Text variant="title2" accessibilityRole="header">
              {one ? t("mobile.ai.question", agentGrammar(one.name)) : t("mobile.ai.questionAny")}
            </Text>
            <Text variant="small" tone="muted">
              {t("mobile.ai.questionLead")}
            </Text>
          </View>
        ) : null}
        {hold ? (
          <PlanHoldNote org={org} />
        ) : dir.loading || status.isPending ? (
          <ActivityIndicator color={c.faint} style={styles.loading} />
        ) : (
          <ConnectAiFlow
            view={view}
            onView={setView}
            sheetTitle={t("connectAi.title.any")}
            onChrome={onChrome}
            agents={agents}
            hasAi={hasAi}
            {...(params.agentId ? { startAgentId: params.agentId } : {})}
            {...(params.email ? { email: params.email } : {})}
            locked={locked}
            bare={bare}
            onAccount={() => {
              setAccountAdded(true);
              void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
              void qc.invalidateQueries({ queryKey: keys.brainMachines(orgId) });
              answer();
            }}
            {...(one && one.ownerUserId !== meId && mayAddKey && !rightHand
              ? { theirs: { id: one.id, name: one.name } }
              : {})}
            justReady={params.ready === "1"}
            mayAddKey={mayAddKey}
            keyForm={form}
            keySaved={keySaved}
            onSaveKey={() =>
              void form.save().then(async (key) => {
                if (!key) return;
                // The right hand asked for a key ("Usar uma chave de API"): the workspace's AI from now on, and the person's
                // own DM goes back to it.
                if (one && rightHand) {
                  const moved = await rightHandOnKey(api, orgId, one, key, models.data?.models ?? []).then(
                    () => true,
                    (error) => {
                      toast({ title: errorText(t, error), icon: "x" });
                      return false;
                    },
                  );
                  if (moved && key.check !== "unchecked")
                    form.setSavedNote(thinksWithLine(t, "workspace", one.name, key.label));
                  void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
                  void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, one.id) });
                }
                setKeySaved(true);
                answer();
              })
            }
            // Computers live in the app: no site opens for one.
            onComputer={() => router.push("/computer-setup" as never)}
            onPlanDone={(id) => {
              setLinked((l) => [...l, id]);
              answer();
            }}
          />
        )}
      </ScrollView>
      {done ? (
        // The last step's one button, at the screen's foot.
        <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 12), backgroundColor: c.grouped }]}>
          <Button variant="primary" wide label={t("connectAi.done")} onPress={close} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 4 },
  head: { gap: 2, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 16 },
  loading: { marginTop: 24 },
  foot: { paddingHorizontal: 16, paddingTop: 12 },
});
