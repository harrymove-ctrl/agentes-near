import type { OrgPlanUsage, PlanAccountUsage } from "@agenteschat/client";
import {
  useAiAccounts,
  useApi,
  useComposioUsage,
  usePlanUsage,
  useSettings,
  useUpdateSettings,
  useUsageReport,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { composioUsageText, showsComposioUsage } from "@agenteschat/client/lib/composio";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { formatPercent, formatShortDate, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  accountName,
  accountOwner,
  accountShares,
  brandOf,
  groupUsageAccounts,
  noWindowsText,
  planMeterText,
  shareFacts,
  splitUsage,
} from "@agenteschat/client/lib/plan-usage";
import { planName } from "@agenteschat/client/lib/plans";
import { parseAmount } from "@agenteschat/client/lib/text";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { PLAN_ALMOST, PLAN_TONE, planLevel, planLine } from "@agenteschat/ui/plan-state";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  Icon,
  InfoHint,
  MEDIA_ROW,
  MediaRow,
  ProviderLogo,
  Segmented,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { LOGO_SIZES } from "@/ui/provider-marks";
import { PlanHoldNote, usePlanHold } from "../ai/parts";
import { AgentFace } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useErrorToast } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Loaded, PushedHeader } from "../shared/parts";
import { Meter, PlanMeter, Tag, UsageCard } from "./parts";
import { MyUsageCard, PeopleList } from "./people";

/*
 * IA e uso, as the web's Configurações › IA e uso (ADR 0063): the workspace's plan accounts, each a row that opens to
 * its windows with every agent's estimated part. What bills per use (the API per agent, its spend by kind, the default
 * budget) shows only once the workspace uses the API (`workspaceUsesApi`). Money only where the server sent it.
 * Connecting an account, what its owner does with it and the workspace's keys are on the AI accounts screen.
 */

const openAiAccounts = () => router.push("/ai-accounts");

/** An account row's mark (`ProviderLogo` at `sm`): what stands beside it centres on this. */
const ROW_MARK = LOGO_SIZES.sm[0];

export const openAgentUsage = (agentId: string) => router.push(`/agent-usage/${agentId}` as never);

export function UsageScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const usage = usePlanUsage(orgId);
  const hold = usePlanHold(orgId, org);
  const allowed = can(org, "view_usage");
  const usesApi = useWorkspaceUsesApi(orgId);
  const report = useUsageReport(orgId, allowed && usesApi);
  // Calls, not money: every member sees them (ADR 0107 §7).
  const composio = useComposioUsage(orgId);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  // Uso › Pessoas (ADR 0141): each person's month for who sees money, else one's own.
  const [view, setView] = useState<"summary" | "people">("summary");
  // The viewer's own logins of one account are one row, as their plans group them.
  const mine = useAiAccounts(orgId);
  const data = usage.data ? { ...usage.data, accounts: groupUsageAccounts(usage.data.accounts, mine.data) } : undefined;
  const several = new Set(data?.accounts.map((a) => a.machineId)).size > 1;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("settings.section.usage")} solid={false} grouped />
      {/* The default budget's field: Salvar takes the first tap, and the field stays above the keyboard. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <Segmented
          value={view}
          onChange={(v) => setView(v === "people" ? "people" : "summary")}
          items={[
            { key: "summary", label: t("peopleUsage.tabs.summary") },
            { key: "people", label: allowed ? t("peopleUsage.tabs.people") : t("peopleUsage.tabs.mine") },
          ]}
        />
        {/* A view switched to, or numbers that came in, fade in; what is here when the screen opens just shows. */}
        <LayoutAnimationConfig skipEntering>
          {view === "people" ? <Loaded>{allowed ? <PeopleList /> : <MyUsageCard />}</Loaded> : null}
          {view === "people" ? null : usage.isLoading ? <ActivityIndicator color={c.muted} /> : null}
          {view === "people" ? null : !usage.isLoading && !data ? (
            <Text variant="small" tone="muted">
              {t("common.loadFailed")}
            </Text>
          ) : null}
          {data && view === "summary" ? (
            <Loaded>
              <View style={styles.stack}>
                <UsageCard
                  icon="laptop"
                  title={t("usageViews.accounts.title")}
                  {...(data.accounts.length > 0
                    ? {
                        hint: {
                          name: t("common.about", { label: t("usageViews.accounts.title") }),
                          text: t("usageViews.estimate"),
                        },
                      }
                    : {})}
                >
                  {data.accounts.length === 0 && hold ? (
                    <PlanHoldNote org={org} />
                  ) : data.accounts.length === 0 ? (
                    <FirstUse
                      place="ai"
                      size="inline"
                      acts
                      label={t("aiAccounts.page.connect")}
                      onPress={openAiAccounts}
                    />
                  ) : (
                    <View>
                      {data.accounts.map((a, i) => (
                        <View key={a.key} style={i > 0 ? [styles.divided, { borderTopColor: c.line }] : undefined}>
                          <AccountRow
                            account={a}
                            money={data.money}
                            computer={
                              several ? computerNameOf(t, org?.name ?? "", a.machineName, isPersonal(org)) : null
                            }
                          />
                        </View>
                      ))}
                    </View>
                  )}
                  {/* Connecting one more, and the workspace's keys: the AI accounts screen. */}
                  {data.accounts.length > 0 && !hold ? (
                    <View style={styles.start}>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="plus"
                        label={t("aiAccounts.page.connect")}
                        onPress={openAiAccounts}
                      />
                    </View>
                  ) : null}
                </UsageCard>
                {usesApi ? <ApiCard data={data} /> : null}
              </View>
            </Loaded>
          ) : null}
          {view === "summary" && composio.data && showsComposioUsage(composio.data) ? (
            <UsageCard icon="chart" title={composioUsageText(t, i18n.language, composio.data)}>
              {null}
            </UsageCard>
          ) : null}
          {view === "summary" && allowed && usesApi && report.data ? (
            <UsageCard icon="chart" title={t("settings.usageTitle")}>
              <Text variant="small" tone="muted">
                {t("settings.usageTotal", {
                  amount: formatUsd(i18n.language, report.data.totalUsd),
                  since: formatShortDate(i18n.language, report.data.since),
                })}
              </Text>
              <View>
                {report.data.byKind.map((k, i) => (
                  <View
                    key={k.kind}
                    style={[styles.kind, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
                  >
                    <Text variant="subhead" tone="ink" numberOfLines={1} style={styles.grow}>
                      {t(`settings.kinds.${k.kind}`)}
                    </Text>
                    <Text variant="small" tone="muted" style={styles.tabular}>
                      {t("settings.usageCalls", { count: k.calls })}
                    </Text>
                    <Text variant="subhead" tone="ink2" style={[styles.tabular, styles.amount]}>
                      {formatUsd(i18n.language, k.costUsd)}
                    </Text>
                  </View>
                ))}
              </View>
            </UsageCard>
          ) : null}
          {view === "summary" && allowed && usesApi ? <DefaultBudgetCard /> : null}
        </LayoutAnimationConfig>
      </ScrollView>
    </View>
  );
}

/**
 * A plan account as a row that opens (the web's `AccountRow`). Closed: its maker's mark, its name and plan, whose it
 * is and one meter, the window closest to its limit, with what matters near the limit under it. Open: its maker and
 * address, every window with its bar split by agent in their colours, its agents, when it renews, the month's total
 * and, for its owner, the way to the screen where they rename it, sign in again or disconnect it. Near its limit it
 * starts open.
 */
function AccountRow({
  account,
  money,
  computer,
}: {
  account: PlanAccountUsage;
  money: boolean;
  computer: string | null;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const text = planMeterText(t, i18n.language);
  const line = account.usage ? planLine(account.usage, text) : null;
  const [open, setOpen] = useState(line != null && line.state !== "ok");
  const tone = c[PLAN_TONE[planLevel(line?.top?.used ?? 0, line?.state === "limited")]];
  const shares = accountShares(account);
  const list =
    shares.shown.length > 0 ? (
      <AgentShares shares={shares} window={shares.window ? text.short(shares.window) : null} />
    ) : null;
  const owner = accountOwner(t, account);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View style={styles.rowHead}>
          <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
          <View style={styles.rowName}>
            <Text variant="callout" tone="ink" style={styles.bold}>
              {accountName(t, account)}
            </Text>
            {account.plan ? <Tag text={planName(account.plan)} color={c.muted} /> : null}
            {account.signedOut ? <Tag text={t("usageViews.signedOut")} color={c.warn} /> : null}
            {owner ? (
              <Text variant="small" tone="muted">
                {owner}
              </Text>
            ) : null}
          </View>
          <View style={[styles.chevron, open && styles.turned]}>
            <Icon name="right" size={14} color={c.faint} />
          </View>
        </View>
        {line?.top ? (
          <View style={styles.rowMeter}>
            <Text variant="caption" tone="muted" style={styles.tabular}>
              {`${text.short(line.top)} ${line.top.used}%`}
            </Text>
            <Meter value={line.top.used} label={text.window(line.top)} mark={PLAN_ALMOST} color={tone} />
          </View>
        ) : null}
        {line?.alert ? (
          <Text variant="caption" style={[styles.bold, { color: tone }]}>
            {line.alert}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <Loaded>
          <View style={styles.rowBody}>
            <Text variant="small" tone="muted">
              {[brandOf(account), account.email, computer].filter(Boolean).join(" · ")}
            </Text>
            {account.usage ? (
              <PlanMeter
                plain
                usage={splitUsage(account.usage, (id) => gradientOf(agentLook(dir.agentById.get(id)).color))}
              >
                {list}
              </PlanMeter>
            ) : (
              <>
                <Text variant="small" tone="muted">
                  {noWindowsText(t, account)}
                </Text>
                {list}
              </>
            )}
            {account.monthTokens > 0 ? (
              money && typeof account.equivalentUsd === "number" ? (
                <InfoHint
                  name={t("common.about", { label: t("usageViews.apiPrice") })}
                  text={t("usageViews.apiPriceHint")}
                  variant="small"
                >
                  <Text variant="small" tone="muted">
                    {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
                    {` · ${t("usageViews.equivalent", { amount: formatUsd(i18n.language, account.equivalentUsd) })}`}
                  </Text>
                </InfoHint>
              ) : (
                <Text variant="small" tone="muted">
                  {t("usageViews.monthTokens", { tokens: formatTokensShort(t, i18n.language, account.monthTokens) })}
                </Text>
              )
            ) : null}
            {account.mine && account.accountId ? (
              <View style={styles.start}>
                <Button variant="secondary" size="sm" label={t("mobile.ai.row")} onPress={openAiAccounts} />
              </View>
            ) : null}
          </View>
        </Loaded>
      ) : null}
    </View>
  );
}

/**
 * The account's agents, biggest share first, each on one line of words ("Lia · semana 48% · 4,8 mi tokens"); past the
 * first few, one row that opens the rest in place.
 */
function AgentShares({ shares, window }: { shares: ReturnType<typeof accountShares>; window: string | null }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const divided = { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth };
  return (
    <View>
      {(open ? [...shares.shown, ...shares.rest] : shares.shown).map((a, i) => (
        <Pressable
          key={a.agentId}
          onPress={() => openAgentUsage(a.agentId)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.share, i > 0 && divided, pressed && styles.pressed]}
        >
          <AgentFace agentId={a.agentId} size={18} live={false} />
          <Text variant="small" tone="muted" style={[styles.grow, styles.tabular]}>
            <Text variant="small" tone="ink" style={styles.bold}>
              {dir.agentById.get(a.agentId)?.name ?? a.name}
            </Text>
            {shareFacts(t, i18n.language, window, a)}
          </Text>
        </Pressable>
      ))}
      {!open && shares.rest.length > 0 ? (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          style={({ pressed }) => [styles.share, divided, pressed && styles.pressed]}
        >
          <View style={styles.face} />
          <Text variant="small" tone="muted" style={[styles.grow, styles.tabular]}>
            <Text variant="small" tone="ink" style={styles.bold}>
              {t("usageViews.moreAgents", { count: shares.rest.length })}
            </Text>
            {shareFacts(t, i18n.language, window, { share: shares.restShare, tokens: shares.restTokens })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The API per agent: its tokens, its share of its budget and (with money) what it spent of it. */
function ApiCard({ data }: { data: OrgPlanUsage }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  if (data.api.length === 0) return null;
  return (
    <UsageCard icon="lock" title={t("usageViews.api.title")}>
      <View>
        {data.api.map((a, i) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          return (
            <Pressable
              key={a.agentId}
              onPress={() => openAgentUsage(a.agentId)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.api,
                i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth },
                pressed && styles.pressed,
              ]}
            >
              {/* The face on the name's line, the numbers under them at the row's width: never a column beside them. */}
              <MediaRow
                size="row"
                face={<AgentFace agentId={a.agentId} size={MEDIA_ROW.row.face} live={false} />}
                name={name}
              >
                <View>
                  <Text variant="small" tone="muted" style={styles.tabular}>
                    {`${t("usageViews.tokens", { tokens: formatTokensShort(t, i18n.language, a.tokens) })} · ${t("usageViews.budgetShare", { percent: formatPercent(i18n.language, a.budgetPercent) })}`}
                  </Text>
                  {a.costUsd !== undefined && a.budgetUsd !== undefined ? (
                    <Text variant="small" tone="muted" style={styles.tabular}>
                      {t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                        spent: formatUsd(i18n.language, a.costUsd),
                        budget: formatUsd(i18n.language, a.budgetUsd),
                      })}
                    </Text>
                  ) : null}
                </View>
              </MediaRow>
            </Pressable>
          );
        })}
      </View>
    </UsageCard>
  );
}

/** The budget of every agent without its own (the web's card); members only ever see percentages of it. */
function DefaultBudgetCard() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const toast = useToast();
  const failed = useErrorToast();
  const { colors: c, shadows } = useTheme();
  const editable = can(org, "configure");
  const saved = settings.data?.defaultAgentBudgetUsd;
  const [value, setValue] = useState("");
  useEffect(() => {
    if (saved !== undefined) setValue(new Intl.NumberFormat(i18n.language).format(saved));
  }, [saved, i18n.language]);
  const amount = parseAmount(value);
  const invalid = value.trim() !== "" && !(amount > 0);
  const dirty = saved !== undefined && amount > 0 && amount !== saved;
  return (
    <UsageCard icon="lock" title={t("settings.defaultBudgetTitle")}>
      <View style={styles.budget}>
        <Text variant="small" tone="ink2" style={styles.bold}>
          {t("settings.defaultBudget")}
        </Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          keyboardType="decimal-pad"
          editable={editable && saved !== undefined}
          accessibilityLabel={t("settings.defaultBudget")}
          style={[styles.input, { color: c.ink, backgroundColor: c.bg, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
        />
        <Text variant="small" tone={invalid ? "danger" : "muted"}>
          {invalid ? t("agent.budgetInvalid") : t("settings.defaultBudgetHelp")}
        </Text>
        {editable ? (
          <View style={styles.start}>
            <Button
              size="sm"
              variant="primary"
              label={t("common.save")}
              disabled={!dirty || update.isPending}
              onPress={() =>
                update.mutate(
                  { defaultAgentBudgetUsd: amount },
                  {
                    onSuccess: () => toast({ title: t("settings.defaultBudgetSaved"), icon: "check" }),
                    onError: failed,
                  },
                )
              }
            />
          </View>
        ) : null}
      </View>
    </UsageCard>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  shrink: { flexShrink: 1 },
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  // The page's own gap, for the cards that fade in together.
  stack: { gap: 14 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  caps: { fontWeight: "700", letterSpacing: 0.5 },
  tabular: { fontVariant: ["tabular-nums"] },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  // An account's row: one step (12) between everything in it, a finger's 44 points at least to open it.
  row: { gap: 12, paddingVertical: 12, minHeight: 44, justifyContent: "center" },
  // A name that wraps keeps the mark and the chevron on its first line, never at the middle of a tall row.
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  // The name wraps instead of losing its end, its plan and whose it is after it, on the next line with no room. One
  // line sits on the mark's middle.
  rowName: {
    flex: 1,
    minWidth: 0,
    minHeight: ROW_MARK,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    alignContent: "center",
    columnGap: 7,
    rowGap: 4,
  },
  chevron: { height: ROW_MARK, justifyContent: "center" },
  rowMeter: { gap: 4 },
  turned: { transform: [{ rotate: "90deg" }] },
  rowBody: { gap: 12, paddingBottom: 12 },
  // An account's agents: a face, then one line of words. The rows open an agent: a finger's 44 points.
  share: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  face: { width: 18 },
  // Narrower than the web's row: the tokens and the budget's share on one line under the name, the spend under it.
  api: { paddingVertical: 10 },
  kind: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  amount: { minWidth: 64, textAlign: "right" },
  budget: { gap: 6 },
  input: { minHeight: 46, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 10, ...fieldText("body") },
  start: { alignSelf: "flex-start", marginTop: 4 },
});
