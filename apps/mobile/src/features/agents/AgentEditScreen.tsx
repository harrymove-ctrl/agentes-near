import { useUpdateAgent } from "@agenteschat/client";
import {
  agentsReach,
  audienceModeKey,
  audienceOf,
  consultableLocked,
  modeOf,
  offersConsultable,
} from "@agenteschat/client/lib/audience";
import { engineOfBrain } from "@agenteschat/client/lib/brain";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { cleanHandle, handleAfterRename, handleProblemText, takenHandles } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { usePreventRemove } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useOrg } from "@/providers/org";
import {
  AgentAvatar,
  EmptyState,
  fieldText,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Locked,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { MessageText } from "../chat/MessageText";
import { useWidenAsk } from "../chat/ReachLines";
import { useFailed } from "../routines/hooks";
import { usePersonalView } from "../settings/hooks";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { BrakesSection } from "./BrakesSection";
import { BudgetSection } from "./BudgetSection";
import { openAgentDelete } from "./DeleteAgentScreen";
import { type AgentDraft, agentChanges, editableFields, fullLook } from "./edit";
import { ErrorLine, HandleInput } from "./HandleInput";
import { LookList } from "./LookPicker";
import { openAgentMore } from "./more-link";
import { ReportsToSection } from "./ReportsToSection";
import { RoleInput } from "./RoleInput";
import { openSetupStep } from "./setup/SetupStepScreen";

/** Opens "Editar" for an agent. */
export const openAgentEdit = (id: string) => router.push({ pathname: "/agent-edit", params: { id } });

/**
 * "Editar agente", as the web's Configurações › Identidade and Instruções: name, its @ (Menções, which follows a
 * new name until typed), role, look and instructions for admins; the look only for
 * the agent's own person (the server's rules). One Salvar. The team's right hand (ADR 0137) is its name, @ and look
 * only: its instructions are the product's, and it is never archived or deleted. On the grouped gray, in the same
 * groups, headers and fields as "Create agent".
 */
export function AgentEditScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const meId = useMeId();
  const org = useOrg().org;
  const agent = dir.agentById.get(id);
  const update = useUpdateAgent(useOrgId(), id);
  const ask = useWidenAsk(agent);
  const admin = can(org, "manage_agents");
  const rightHand = isRightHand(agent);
  const owner = Boolean(meId && agent?.ownerUserId === meId);
  const fields = editableFields({ admin, owner });
  const onPlan = engineOfBrain(agent?.brain?.kind) !== "agent";
  const { personal, others } = usePersonalView();
  const saved = useMemo<AgentDraft | null>(
    () =>
      agent
        ? {
            name: agent.name,
            handle: agent.handle,
            role: agent.role,
            instructions: agent.instructions,
            look: fullLook(agent.appearance),
            audience: audienceOf(agent),
          }
        : null,
    [agent],
  );
  const [edits, setEdits] = useState<Partial<AgentDraft>>({});
  const draft = saved
    ? { ...saved, ...edits, handle: handleAfterRename(saved, edits.name ?? saved.name, edits.handle) }
    : null;
  const changes = saved && draft ? agentChanges(saved, draft, fields) : null;
  const reach = draft ? agentsReach(draft.audience, onPlan, agent?.ownerUserId ?? null) : null;
  const nameMissing = Boolean(draft && fields.has("name") && !draft.name.trim());
  const taken = useMemo(
    () => takenHandles(dir.agents, [...dir.memberById.values()], id),
    [dir.agents, dir.memberById, id],
  );
  const moved = Boolean(saved && draft && draft.handle !== saved.handle);
  const handleIssue = moved && draft ? handleProblemText(t, draft.handle, taken) : null;
  const done = useRef(false);

  // Leaving with changes asks first (as writing a wiki page).
  usePreventRemove(Boolean(changes), ({ repeat }) => {
    if (done.current) return repeat();
    Alert.alert(t("mobile.agentEdit.discardTitle"), t("mobile.agentEdit.discardText"), [
      { text: t("mobile.agentEdit.keepEditing"), style: "cancel" },
      { text: t("mobile.agentEdit.discard"), style: "destructive", onPress: repeat },
    ]);
  });

  if (!agent || !draft) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("agent.edit")} solid={false} />
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </View>
    );
  }

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setEdits((e) => ({ ...e, [key]: value }));
  const save = async () => {
    if (!changes || nameMissing || handleIssue || update.isPending) return;
    if (changes.audience && !(await ask(changes.audience)([]))) return;
    update.mutate(changes, {
      onSuccess: () => {
        done.current = true;
        successHaptic();
        toast({ title: t("mobile.agentEdit.saved"), agentId: id });
        router.back();
      },
      onError: failed,
    });
  };
  const field = [styles.field, fieldText("body"), { color: c.ink }];
  // What only an admin changes, read where its field would be.
  const readOnly = (label: string, value: string) => (
    <>
      <GroupedHeader>{label}</GroupedHeader>
      <GroupedList>
        <Text variant="body" tone="ink2" selectable style={styles.field}>
          {value || t("agentPage.none")}
        </Text>
      </GroupedList>
    </>
  );

  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("agent.edit")}
        solid={false}
        grouped
        action={{
          label: t("common.save"),
          onPress: () => void save(),
          disabled: !changes || nameMissing || Boolean(handleIssue) || update.isPending,
        }}
      />
      <KeyboardAwareScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        contentContainerStyle={styles.form}
      >
        <Locked when={update.isPending}>
          <View style={styles.hero}>
            <AgentAvatar agent={{ ...draft.look, id }} size={96} name={draft.name} />
            <Text variant="footnote" tone="muted">
              @{draft.handle}
            </Text>
          </View>

          {fields.has("name") ? (
            <>
              <GroupedHeader
                hint={{ name: t("common.about", { label: t("agent.nameLabel") }), text: t("agent.identityHelp") }}
              >
                {t("agent.nameLabel")}
              </GroupedHeader>
              <GroupedList>
                <TextInput
                  value={draft.name}
                  onChangeText={(v) => set("name", v)}
                  maxLength={32}
                  autoCorrect={false}
                  placeholder={t("newAgent.namePlaceholder")}
                  placeholderTextColor={c.faint}
                  accessibilityLabel={t("agent.nameLabel")}
                  style={field}
                />
              </GroupedList>
              {nameMissing ? (
                <View style={styles.foot}>
                  <ErrorLine text={t("newAgent.errors.nameRequired")} />
                </View>
              ) : moved && !handleIssue ? (
                <GroupedFooter>{t("agent.handleMoves", { handle: draft.handle, old: agent.handle })}</GroupedFooter>
              ) : null}
              <GroupedHeader>{t("agent.handleLabel")}</GroupedHeader>
              <GroupedList>
                <HandleInput
                  value={draft.handle}
                  onChangeText={(v) => set("handle", cleanHandle(v))}
                  label={t("agent.handleLabel")}
                  grouped
                />
              </GroupedList>
              {handleIssue ? (
                <View style={styles.foot}>
                  <ErrorLine text={handleIssue} />
                </View>
              ) : null}
            </>
          ) : (
            readOnly(t("agent.nameLabel"), agent.name)
          )}

          {rightHand ? null : fields.has("role") ? (
            <RoleInput
              value={draft.role}
              onChangeText={(v) => set("role", v)}
              placeholder={t("agent.roleHelp")}
              grouped
            />
          ) : (
            readOnly(t("agent.roleLabel"), agent.role)
          )}

          {fields.has("look") ? <LookList look={draft.look} onChange={(look) => set("look", look)} /> : null}

          {/* With family in a personal workspace (ADR 0159), who talks to it is a row here for whoever may change
              it, to its step's screen (otherwise only the setup card opens it). The same audience, one more way in. */}
          {personal && (others ?? 0) > 0 && !rightHand && agent.setup && (admin || owner) ? (
            <>
              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow
                  icon="members"
                  label={t("audience.title", agentGrammar(agent.name))}
                  value={t(audienceModeKey(org, modeOf(agent)))}
                  chevron
                  onPress={() => openSetupStep(id, "who")}
                />
              </GroupedList>
            </>
          ) : null}

          {/* Only an audience that leaves someone out has anyone to be consulted for, and says whether it holds for agents. */}
          {!rightHand && reach ? (
            <>
              <View style={styles.gap} />
              {offersConsultable(draft.audience, onPlan) ? (
                <GroupedList>
                  <GroupedRow
                    icon="agent"
                    label={t("audience.consultable", agentGrammar(agent.name))}
                    labelLines={2}
                    hint={{
                      name: t("common.about", { label: t("audience.consultable", agentGrammar(agent.name)) }),
                      text: t("audience.consultableHint", agentGrammar(agent.name)),
                    }}
                    toggle={draft.audience.consultable !== false}
                    disabled={
                      !fields.has("consultable") || (!!saved && consultableLocked(saved.audience, { owner, onPlan }))
                    }
                    onPress={() =>
                      set("audience", { ...draft.audience, consultable: draft.audience.consultable === false })
                    }
                  />
                </GroupedList>
              ) : null}
              <GroupedFooter>{t(`audience.agents.${reach}`, agentGrammar(agent.name))}</GroupedFooter>
            </>
          ) : null}

          {rightHand ? (
            <>
              <View style={styles.gap} />
              <GroupedFooter>{t("rightHand.settings.lock", agentGrammar(agent.name))}</GroupedFooter>
            </>
          ) : (
            <>
              {admin ? <BudgetSection agent={agent} /> : null}
              {/* A personal workspace keeps these in Advanced (ADR 0159 §3): each saves on its own, as here. */}
              {personal ? null : (
                <>
                  <BrakesSection agent={agent} />
                  <ReportsToSection agentId={id} />
                </>
              )}

              <GroupedHeader>{t("agent.instructions")}</GroupedHeader>
              {/* The list draws the field's surface (radius 14, raised), as on "Create agent". */}
              <GroupedList>
                {fields.has("instructions") ? (
                  <TextArea
                    value={draft.instructions}
                    maxLength={50_000}
                    onChangeText={(v) => set("instructions", v)}
                    placeholder={t("newAgent.instructionsPlaceholder")}
                    accessibilityLabel={t("agent.instructions")}
                    minHeight={180}
                    scrollEnabled={false}
                    style={styles.bare}
                  />
                ) : agent.instructions.trim() ? (
                  // Read as the chat reads Markdown: an imported agent's "## Papel" and "**sempre**" never show as marks.
                  <View style={styles.field}>
                    <MessageText body={agent.instructions} />
                  </View>
                ) : (
                  <Text variant="body" tone="ink2" selectable style={styles.field}>
                    {t("agentPage.none")}
                  </Text>
                )}
              </GroupedList>
              {!fields.has("name") ? <GroupedFooter>{t("mobile.agentEdit.adminsOnly")}</GroupedFooter> : null}
            </>
          )}

          {/* A personal workspace's Advanced (ADR 0159 §3): its brakes, who it reports to, its rules, deleting it. */}
          {personal && !rightHand ? (
            <>
              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow
                  icon="more"
                  label={t("agentPage.tabs.advanced")}
                  chevron
                  onPress={() => openAgentMore(id)}
                />
              </GroupedList>
            </>
          ) : null}

          {/* Deleting for good asks for its name on a screen of its own (ADR 0082). */}
          {admin && !rightHand && !personal ? (
            <>
              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow
                  icon="x"
                  label={t("agentPage.delete.action", agentGrammar(agent.name))}
                  sub={t("agentPage.delete.help")}
                  subLines={2}
                  danger
                  chevron
                  onPress={() => openAgentDelete(id)}
                />
              </GroupedList>
            </>
          ) : null}
        </Locked>
      </KeyboardAwareScrollView>
    </View>
  );
}

// "Create agent"'s numbers: the page's 16 pt sides, a field row of a group, the gap between groups with no header.
const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { paddingHorizontal: 16, paddingBottom: 48 },
  hero: { alignItems: "center", gap: 6, paddingVertical: 12 },
  field: {
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.tallPadY,
  },
  bare: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  foot: { paddingTop: 7, paddingHorizontal: 16 },
  gap: { height: 24 },
});
