import type { Agent, TeamTemplate } from "@agenteschat/client";
import { useApplyTeamTemplate, useRoutines, useUpdateSettings } from "@agenteschat/client";
import { planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { firstJob } from "@agenteschat/client/lib/onboarding";
import {
  aboutContext,
  aboutOf,
  BUSINESS_TYPES,
  type BusinessType,
  teamFailureText,
} from "@agenteschat/client/lib/team-plan";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import {
  AgentAvatar,
  Button,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  LineIcon,
  Locked,
  MEDIA_ROW,
  MediaRow,
  SkeletonList,
  Text,
  useTheme,
} from "@/ui";
import { CENTER } from "@/ui/auth/AuthScaffold";
import { fullLook } from "../agents/edit";
import { TeamRows } from "../right-hand/TeamCard";
import { chooseAction } from "../settings/parts";
import { tapHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { stepFailedText } from "./logic";

/*
 * The onboarding's steps after the workspace's name (ADR 0162), as on the web, in the phone's own lists: what the
 * workspace does, its team, and, where it waits for its first plan, the plan in words only.
 */

function Failed({ text }: { text: string }) {
  return (
    <Text variant="small" tone="danger" accessibilityRole="alert" style={CENTER}>
      {text}
    </Text>
  );
}

/**
 * Step 2, "O que a Acme faz?": the business types to pick one and a sentence, saved as the workspace's context, which
 * every agent reads. "Outra coisa" asks for the sentence.
 */
export function BusinessStep({
  orgId,
  context,
  business,
  onDone,
}: {
  orgId: string;
  context: string;
  business: BusinessType | null;
  onDone: (business: BusinessType | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const save = useUpdateSettings(orgId);
  const [kind, setKind] = useState<BusinessType | null>(business);
  const [line, setLine] = useState(() => aboutOf(t, context).line);
  const other = kind === "other";
  const text = aboutContext(t, kind, line);
  return (
    <>
      <Locked when={save.isPending}>
        <GroupedList>
          {BUSINESS_TYPES.map((b) => (
            <GroupedRow
              key={b}
              label={t(`teamPlan.business.${b}`)}
              checked={b === kind}
              onPress={() => {
                tapHaptic();
                setKind(b === kind ? null : b);
              }}
            />
          ))}
        </GroupedList>
        <GroupedHeader
          {...(other
            ? {}
            : {
                hint: {
                  name: t("common.about", { label: t("agentSetup.firstRun.about.line") }),
                  text: t("agentSetup.firstRun.about.optional"),
                },
              })}
        >
          {t("agentSetup.firstRun.about.line")}
        </GroupedHeader>
        <TextArea
          value={line}
          onChangeText={setLine}
          maxLength={500}
          accessibilityLabel={t("agentSetup.firstRun.about.line")}
          minHeight={88}
          scrollEnabled={false}
        />
      </Locked>
      {save.isError ? <Failed text={stepFailedText(t, save.error, i18n.language)} /> : null}
      <View style={styles.action}>
        <Button
          variant="primary"
          wide
          label={t("onboarding.actions.continue")}
          disabled={!text}
          loading={save.isPending}
          onPress={() => save.mutate({ context: text }, { onSuccess: () => onDone(kind) })}
        />
      </View>
    </>
  );
}

/**
 * Step 3, "Seu time": the template for the workspace's business (another from its row), made in one tap with no model
 * call. Once the team exists it shows who is in it. Bringing agents from another app instead opens the workspace's
 * import.
 */
export function TeamStep({
  orgId,
  team,
  templates,
  chosen,
  listFailed,
  onRetryList,
  reviewer,
  onPick,
  onContinue,
  onImport,
  leaving,
}: {
  orgId: string;
  team: Agent[];
  templates: TeamTemplate[];
  chosen: TeamTemplate | undefined;
  listFailed: boolean;
  onRetryList: () => void;
  reviewer: string;
  onPick: (templateId: string) => void;
  onContinue: () => void;
  onImport: () => void;
  leaving: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  // Pending until the team is in the agents' list, when the next step opens: a second tap never makes a second team.
  const use = useApplyTeamTemplate(orgId);
  const [failed, setFailed] = useState<string | null>(null);
  if (team.length > 0)
    return (
      <>
        <View style={styles.rows}>
          {team.map((a, i) => (
            <View key={a.id} style={i > 0 && [styles.divided, { borderTopColor: c.line2 }]}>
              <MediaRow
                face={
                  <AgentAvatar agent={fullLook(a.appearance)} size={MEDIA_ROW.card.face} name={a.name} live={false} />
                }
                name={a.name}
                meta={a.role}
              />
            </View>
          ))}
        </View>
        <View style={styles.action}>
          <Button
            variant="primary"
            wide
            label={t("onboarding.actions.continue")}
            loading={leaving}
            onPress={onContinue}
          />
        </View>
      </>
    );
  const create = () =>
    chosen &&
    use.mutate(
      { templateId: chosen.id, locale: i18n.language },
      {
        onSuccess: (out) => {
          // A step that failed: its reason here, and the same button tries again.
          if (out.state !== "created")
            return setFailed(out.error ? teamFailureText(t, out.error, i18n.language) : t("mobile.onb.failed"));
          setFailed(null);
        },
        onError: (e) => setFailed(stepFailedText(t, e, i18n.language)),
      },
    );
  return (
    <>
      <Locked when={use.isPending || leaving} style={styles.stack}>
        {chosen ? (
          <>
            {/* The template's name as the row's own line, whole: a value beside a label is cut at half the row. */}
            <View>
              <GroupedHeader>{t("teamPlan.templates.title")}</GroupedHeader>
              <GroupedList>
                <GroupedRow
                  label={chosen.name}
                  labelLines={2}
                  menu
                  onPress={() =>
                    chooseAction(
                      t("teamPlan.templates.title"),
                      templates.map((x) => ({
                        label: x.name,
                        checked: x.id === chosen.id,
                        onPress: () => {
                          onPick(x.id);
                          setFailed(null);
                        },
                      })),
                      t("mobile.common.cancel"),
                    )
                  }
                />
              </GroupedList>
            </View>
            <TeamRows plan={chosen.team} reviewer={reviewer} />
          </>
        ) : listFailed ? (
          <View style={styles.center}>
            <Failed text={t("common.loadFailed")} />
            <Button variant="text" size="sm" label={t("mobile.common.retry")} onPress={onRetryList} />
          </View>
        ) : (
          // The team's shape while the templates load, so nothing moves when they arrive.
          <SkeletonList rows={4} />
        )}
        <View style={styles.start}>
          <Button variant="text" size="sm" label={t("teamPlan.templates.import")} onPress={onImport} />
        </View>
      </Locked>
      {failed ? <Failed text={failed} /> : null}
      <View style={styles.action}>
        <Button
          variant="primary"
          wide
          label={t(failed ? "teamPlan.card.retry" : "teamPlan.templates.create")}
          loading={use.isPending}
          disabled={!chosen || leaving}
          onPress={() => void create()}
        />
      </View>
    </>
  );
}

/**
 * Step 4 on the phone, "Ligue o time" (agentes.chat Cloud, a workspace waiting for its first plan): what each agent
 * does first, then where the plan is chosen, in words only. The phone shows no price, no button and no link to pay
 * (ADR 0079 §6, App Store 3.1.1). The team sleeps on the sky above until then; the way on is the workspace itself,
 * where the hold's banner says the same.
 */
export function PlanStep({
  orgId,
  team,
  mayPay,
  leaving,
  onEnter,
}: {
  orgId: string;
  team: Agent[];
  mayPay: boolean;
  leaving: boolean;
  onEnter: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const routines = useRoutines(orgId).data;
  return (
    <>
      <View style={styles.stack}>
        <View style={styles.rows}>
          {team.map((a) => (
            <View key={a.id} style={styles.line}>
              <LineIcon name="check" size={15} color={c.muted} variant="small" />
              <Text variant="small" style={styles.fill}>
                <Text variant="small" style={styles.bold}>
                  {a.name}
                </Text>
                {` · ${firstJob(a, routines)}`}
              </Text>
            </View>
          ))}
        </View>
        <Text variant="small" tone="muted">
          {planHoldPhoneLine(t, mayPay, "team")}
        </Text>
      </View>
      <View style={styles.action}>
        <Button variant="primary" wide label={t("mobile.onb.enter")} loading={leaving} onPress={onEnter} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  rows: { gap: 8 },
  // 12 above the hairline (with the rows' gap) and 12 under it.
  divided: { marginTop: 4, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  // An icon on the first line of its words, as the team card's lines.
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  start: { alignItems: "flex-start" },
  center: { alignItems: "center", gap: 4 },
  // The step's one action, 16 under what it acts on.
  action: { marginTop: 8 },
});
