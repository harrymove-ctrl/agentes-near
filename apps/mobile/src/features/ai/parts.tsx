import type { OrgSummary } from "@agenteschat/client";
import { useComputerSetup } from "@agenteschat/client";
import { computerEdition } from "@agenteschat/client/lib/computer";
import type { keyRefusal } from "@agenteschat/client/lib/errors";
import { planHoldOf, planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { type CodingPlan, planReplies } from "@agenteschat/client/lib/plans";
import * as Clipboard from "expo-clipboard";
import { openBrowserAsync } from "expo-web-browser";
import type { TFunction } from "i18next";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Linking, Pressable, StyleSheet, TextInput, View } from "react-native";
import {
  Button,
  fieldText,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  InfoHint,
  InkOrbit,
  LineIcon,
  ProviderLogo,
  Text,
  textLineOf,
  useTheme,
} from "@/ui";
import { BUTTON_SIZES } from "@/ui/Button";
import { usePersonalView } from "../settings/hooks";
import { useColors } from "../shared/hooks";

/**
 * The pieces the web's AI panels are made of (`SettingNote`, the numbered `Step`, `OpenPage`), on the phone.
 */

/** The billing hold on this workspace that stops its plans (`planHoldOf`). */
export const usePlanHold = (orgId: string, org: OrgSummary | null | undefined) =>
  planHoldOf(computerEdition(useComputerSetup(orgId).data), org?.standing);

/** A plan this workspace's billing hold stops, said where it would sign in (`planHoldPhoneLine`). */
export function PlanHoldNote({ org, keys }: { org: OrgSummary | null | undefined; keys?: boolean }) {
  const { t } = useTranslation();
  return (
    <Note icon="pause">{planHoldPhoneLine(t, org ? can(org, "manage_billing") : false, keys ? "keys" : "plan")}</Note>
  );
}

/**
 * A row of an agent's AI (its page, Connect an AI's first group): its maker's mark, its name, the lines under it
 * (`accountRow`, `existingRows`).
 */
export function AiRow({
  row,
  checked,
  disabled,
  onPress,
}: {
  row: { label: string; sub?: string; below?: string; mark: string; off: boolean };
  checked?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <GroupedRow
      leading={<ProviderLogo id={row.mark} size="sm" off={row.off} />}
      label={row.label}
      {...(row.sub ? { sub: row.sub } : {})}
      {...(row.below ? { belowText: row.below } : {})}
      {...(checked !== undefined ? { checked } : {})}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

/**
 * A line with its icon (the web's `SettingNote`): why something waits, what is safe, what went wrong. `icon` may be
 * a mark of its own, 15 pt (the orbit of work under way).
 */
export function Note({
  icon,
  children,
  live = false,
}: {
  icon: IconName | ReactElement;
  children: ReactNode;
  live?: boolean;
}) {
  const c = useColors();
  return (
    <View style={styles.note} accessibilityLiveRegion={live ? "polite" : undefined}>
      {/* On the words' first line, where the eye reads it, never at the line's top. */}
      {typeof icon === "string" ? (
        <LineIcon name={icon} variant="small" size={15} color={icon === "x" ? c.danger : c.muted} />
      ) : (
        <LineIcon variant="small" size={15}>
          {icon}
        </LineIcon>
      )}
      <Text variant="small" tone={icon === "x" ? "danger" : "muted"} style={styles.grow}>
        {children}
      </Text>
    </View>
  );
}

/**
 * "Atende outras pessoas" (ADR 0059 §5), the web's `PlanReplies`: off, an agent on its owner's plan answers only them;
 * on, everyone who may talk to it. Under it, a line saying which, on which plan (whose, to an admin), and the plan's
 * terms behind its ⓘ.
 * A plan's page and the agent's AI draw the same. Alone in a personal workspace (ADR 0159) it waits while off, there
 * being nobody else to answer, but where `keep` asks (the agent's Advanced): it comes back as someone joins, and shows
 * whenever it is on.
 */
export function PlanReplies({
  on,
  onChange,
  agent,
  owner,
  brain,
  plan,
  coding,
  disabled,
  keep = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** The agent's name, for the line under the switch. */
  agent: string;
  /** The plan's owner's first name, to anyone else (an admin); absent: the viewer's own plan. */
  owner?: string;
  brain: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  /** The account's plan as the CLI says it (`max`, `team`…): a seat has its own words. */
  plan?: string | null;
  /** A coding plan, named by the line, its maker's words behind the ⓘ. */
  coding?: CodingPlan;
  disabled?: boolean;
  /** Shown even while off and alone in a personal workspace: the agent's Advanced, where the switch always is. */
  keep?: boolean;
}) {
  const { t } = useTranslation();
  const { solo } = usePersonalView();
  if (solo && !on && !keep) return null;
  const says = planReplies(t, { on, agent, owner, brain, plan, coding });
  return (
    <View>
      <GroupedList>
        <GroupedRow
          label={t("aiAccounts.share.switch")}
          labelLines={2}
          toggle={on}
          disabled={disabled}
          onPress={() => onChange(!on)}
        />
      </GroupedList>
      <View style={styles.foot}>
        <InfoHint
          name={t("common.about", { label: t("aiAccounts.share.terms.about") })}
          text={says.text}
          variant="footnote"
        >
          <Text variant="footnote" tone="faint">
            {says.line}
          </Text>
        </InfoHint>
      </View>
    </View>
  );
}

/** The steps' white card (a grouped list of numbered rows). */
export function StepsCard({ children }: { children: ReactNode }) {
  const { colors: c, shadows } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
      {children}
    </View>
  );
}

/**
 * A numbered step, one row of the steps' card: its number (a check once `done`, faint while it waits), the title
 * (with an ⓘ when it has a `hint`), the words under it and its buttons under them. `divider`: a hairline above it,
 * inset to the words. `onPress`: a folded step, its title alone, that opens when tapped.
 */
export function Step({
  n,
  title,
  hint,
  children,
  side,
  divider = false,
  state = "now",
  onPress,
}: {
  n: number;
  title: string;
  hint?: string | undefined;
  children?: ReactNode;
  side?: ReactNode;
  divider?: boolean;
  state?: "now" | "done" | "later";
  onPress?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const head = (
    <Text variant="callout" tone="ink" style={styles.bold}>
      {title}
    </Text>
  );
  const row = (
    <>
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={[styles.n, { backgroundColor: state === "done" ? c.ok : state === "later" ? c.plate : c.ink }]}>
        {state === "done" ? (
          <Icon name="check" size={12} color={c.bg} />
        ) : (
          <Text variant="caption" style={[styles.nText, { color: state === "later" ? c.faint : c.bg }]}>
            {n}
          </Text>
        )}
      </View>
      <View style={styles.text}>
        {hint ? (
          <InfoHint name={t("common.about", { label: title })} text={hint} variant="callout">
            {head}
          </InfoHint>
        ) : (
          head
        )}
        {children}
        {side ? <View style={styles.side}>{side}</View> : null}
      </View>
    </>
  );
  return onPress ? (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: false, checked: state === "done" }}
      style={({ pressed }) => [styles.step, pressed && styles.pressed]}
    >
      {row}
    </Pressable>
  ) : (
    <View style={styles.step}>{row}</View>
  );
}

/** A step's quiet words (13 on the web). */
export function StepText({ children }: { children: ReactNode }) {
  return (
    <Text variant="small" tone="muted">
      {children}
    </Text>
  );
}

/** Opens a maker's own page (a sign-in, its settings, where a key is made) in the in-app browser. */
export function openPage(href: string) {
  void openBrowserAsync(href).catch(() => Linking.openURL(href));
}

/** A stored key its provider refused: why, in the provider's words too, and the page that fixes it. */
export function alertKeyRefused(t: TFunction, refusal: NonNullable<ReturnType<typeof keyRefusal>>) {
  Alert.alert(refusal.text, undefined, [
    { text: t("common.close"), style: "cancel" },
    ...(refusal.href ? [{ text: refusal.site, onPress: () => openPage(refusal.href) }] : []),
  ]);
}

/**
 * One of our own website's pages the app was opened with but can't show: the in-app browser only. Handing it to the
 * system (`openPage`'s fallback) would give a link the app is verified for back to the app, in a loop.
 */
export function openOwnPage(href: string) {
  setTimeout(() => void openBrowserAsync(href).catch(() => undefined), 0);
}

/** The web's `OpenPage`: a small button with the external mark. */
export function OpenPage({
  href,
  label,
  primary = false,
  onOpened,
}: {
  href: string;
  label: string;
  primary?: boolean;
  onOpened?: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "secondary"}
      icon="out"
      label={label}
      onPress={() => {
        onOpened?.();
        openPage(href);
      }}
    />
  );
}

/**
 * A step's field with "Colar" in it while it is empty (a code, a plan's key, an API key), sunken inside the steps'
 * white card. `onPasted`: what the clipboard had, trimmed (nothing when it was empty).
 */
export function PasteField({
  value,
  onChangeText,
  onPasted,
  label,
  placeholder,
  secret = false,
  disabled = false,
  returnKeyType = "done",
  onSubmit,
  onBlur,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onPasted: (value: string) => void;
  label: string;
  placeholder?: string | undefined;
  secret?: boolean;
  disabled?: boolean;
  returnKeyType?: "done" | "send";
  onSubmit?: () => void;
  onBlur?: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const empty = !value.trim();
  return (
    <View style={[styles.inset, !empty && styles.insetFull, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        secureTextEntry={secret}
        textContentType="none"
        editable={!disabled}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmit}
        onBlur={onBlur}
        style={[styles.insetInput, { color: c.ink }]}
      />
      {/* A button sits at its row's top (`alignSelf: flex-start`); this box keeps it on the field's middle. */}
      {empty ? (
        <View style={styles.insetAction}>
          <Button
            size="sm"
            variant="secondary"
            icon="copy"
            label={t("aiAccounts.add.paste")}
            disabled={disabled}
            onPress={() =>
              void Clipboard.getStringAsync()
                .catch(() => "")
                .then((v) => {
                  if (v.trim()) onPasted(v.trim());
                })
            }
          />
        </View>
      ) : null}
    </View>
  );
}

/** "Esperando…" beside a step that waits on the computer, after the pixel loader as on the web. */
export function Waiting({ label }: { label: string }) {
  const c = useColors();
  return (
    <View style={styles.wait} accessibilityLiveRegion="polite">
      <InkOrbit size={13} color={c.faint} />
      <Text variant="caption" tone="faint" style={styles.bold}>
        {label}
      </Text>
    </View>
  );
}

/** A step's number, in a circle on its title's first line. */
const N = 22;
/** The pasted-key field, and the small Paste button inside it with as much room above, below and after it. */
const FIELD = 46;
const PASTE_INSET = (FIELD - BUTTON_SIZES.sm.height) / 2;

const styles = StyleSheet.create({
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 4 },
  // As a group's footer (`GroupedFooter`).
  foot: { paddingTop: 8, paddingHorizontal: 16 },
  grow: { flex: 1, minWidth: 0 },
  card: { borderRadius: 14, overflow: "hidden" },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  divider: { position: "absolute", top: 0, left: 14 + N + 12, right: 0, height: StyleSheet.hairlineWidth },
  // Centered where the eye reads the callout title's first line.
  n: {
    width: N,
    height: N,
    borderRadius: N / 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: textLineOf("callout", 1).middle - N / 2,
  },
  nText: { fontWeight: "700", lineHeight: 14 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  bold: { fontWeight: "600" },
  side: { marginTop: 6, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pressed: { opacity: 0.6 },
  wait: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  inset: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: FIELD,
    marginTop: 6,
    paddingLeft: 12,
    paddingRight: PASTE_INSET,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Without "Colar" beside it, the text keeps the same edge on both sides.
  insetFull: { paddingRight: 12 },
  insetInput: { flex: 1, minWidth: 0, paddingVertical: 8, ...fieldText("callout") },
  insetAction: { alignSelf: "center" },
});
