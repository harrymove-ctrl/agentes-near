import { type InvitationPreview, useAuthConfig } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeInUp } from "react-native-reanimated";
import { agentLook } from "@/features/shared/logic";
import { useSession } from "@/providers/session";
import { AgentAvatar, type AgentMode, Button, Icon, LineIcon, Text, useTheme } from "@/ui";
import { CENTER } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { Terms } from "./AuthFlow";
import { boldParts } from "./links";

/** What an invitation's screens show of who works there. */
export type InvitedAgents = NonNullable<InvitationPreview["agents"]>;

/** Back from an invitation's first screen: the previous one, else home when signed in, else the sign-in. */
export function useLeaveInvite() {
  const session = useSession();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(session.signedIn ? "/" : "/sign-in");
  };
}

/** Leaves an invitation that leads nowhere: home when signed in, else the sign-in. */
export function LeaveButton() {
  const { t } = useTranslation();
  const session = useSession();
  return (
    <Button
      variant="ghost"
      wide
      label={t("mobile.invite.otherAccount")}
      onPress={() => router.replace(session.signedIn ? "/" : "/sign-in")}
    />
  );
}

/** The sentence naming who works there, or null with nobody: "Ada e Theo trabalham lá" in the given key's words. */
export function useAgentsLine(key: "invite.crew" | "invite.ask.agents", agents: InvitedAgents, more: number) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  const names = [...agents.map((a) => a.name), ...(more ? [t("invite.ask.moreAgents", { count: more })] : [])];
  return t(key, { count: agents.length + more, names: joinNames(names, t) });
}

/** The faces leading "who already works there": as tall as that line, so they sit on it. */
const FACE = 22;

/** "Ada, Theo, Lia e mais 2 já trabalham lá", their faces leading the first line. */
export function AgentsThere({ agents, more }: { agents: InvitedAgents; more: number }) {
  const line = useAgentsLine("invite.ask.agents", agents, more);
  if (!line) return null;
  return (
    <View style={styles.lead}>
      <LineIcon variant="small" size={FACE}>
        <View style={styles.faces}>
          {agents.map((a, i) => (
            <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
              <AgentAvatar agent={{ ...agentLook(a), id: a.id }} size={FACE} live={false} />
            </View>
          ))}
        </View>
      </LineIcon>
      <Text variant="small" tone="muted" style={styles.grow}>
        {line}
      </Text>
    </View>
  );
}

/** The team's faces on the sky: as large as the sign-in's agent's frame allows four of them side by side. */
const CREW_FACE = 56;
const CREW_MAX = 4;

/**
 * An invitation's team standing on the sky's edge, before any field (`AuthScaffold`'s `hero`): its first agents,
 * alive, in their own colors. The first time a screen shows them they rise onto the horizon as one wave (the lead
 * first, each next one a little sooner and from less far), once; with reduced motion they are simply there.
 * `happy`: the face they make when you're let in. A face's `mode`: the first run's team asleep until its plan.
 */
export function InviteCrew({
  agents,
  happy = false,
}: {
  agents: readonly { id: string; appearance?: unknown; mode?: AgentMode }[];
  happy?: boolean;
}) {
  const { reducedMotion } = useTheme();
  const shown = agents.slice(0, CREW_MAX);
  if (shown.length === 0) return null;
  return (
    <View style={styles.crew} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((a, i) => (
        <Animated.View
          key={a.id}
          entering={
            reducedMotion
              ? undefined
              : FadeInUp.duration(360 - i * 30)
                  .delay(60 + i * Math.max(30, 70 - i * 15))
                  .easing(Easing.bezier(0.23, 1, 0.32, 1))
                  .withInitialValues({ transform: [{ translateY: 14 - i * 2 }] })
          }
        >
          <AgentAvatar
            agent={{ ...agentLook(a), id: a.id }}
            size={CREW_FACE}
            framed
            {...(a.mode ? { mode: a.mode } : {})}
            {...(happy ? { expression: "happy" as const } : {})}
          />
        </Animated.View>
      ))}
    </View>
  );
}

/** The workspace's first agent beside who it's from: "**Acme** · Ana compartilhou este link". */
export function OrgLine({ agent, strong, text }: { agent?: InvitedAgents[number]; strong: string; text?: string }) {
  return (
    <View style={styles.org}>
      {agent ? <AgentAvatar agent={{ ...agentLook(agent), id: agent.id }} size={30} live={false} /> : null}
      <Text variant="small" tone="muted" style={styles.grow}>
        <Text variant="small" tone="ink2" style={styles.link}>
          {strong}
        </Text>
        {text ? ` · ${text}` : null}
      </Text>
    </View>
  );
}

/** The address an invitation is locked to: no field, nothing to change. */
export function LockedEmail({ email }: { email: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={[styles.locked, { backgroundColor: c.sunken }]} accessible accessibilityHint={t("invite.emailHelp")}>
      <Icon name="lock" size={15} color={c.muted} />
      <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.grow}>
        {email}
      </Text>
    </View>
  );
}

/** A refusal in words, under the field it's about. */
export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
      {error}
    </Text>
  );
}

/** "Did you mean …?" under an address with a common typo. */
export function DidYouMean({ fix, onFix }: { fix: string; onFix: (email: string) => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={() => onFix(fix)}
      accessibilityRole="button"
      hitSlop={12}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <Text variant="subhead" style={[CENTER, styles.link]}>
        {t("auth.flow.didYouMean", { email: fix })}
      </Text>
    </Pressable>
  );
}

/** The Terms and the Privacy policy, where the server has both. */
export function InviteTerms() {
  const config = useAuthConfig().data;
  if (!config?.termsUrl || !config.privacyUrl) return null;
  return <Terms termsUrl={config.termsUrl} privacyUrl={config.privacyUrl} />;
}

/** Stands in for the person's words while the sentence is split into its bold label and the rest. */
const WORDS = "⁣";

/** Someone else's words, as they wrote them (an admin's note to someone turned down), after the label in bold. */
export function Said({ reason }: { reason: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={[styles.said, { backgroundColor: c.sunken }]}>
      <Text variant="body">
        {boldParts(t("invite.ask.reasonSaid", { reason: WORDS })).map((part, i) =>
          part.bold ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence, in order
            <Text key={i} variant="body" style={styles.link}>
              {part.text.replace(WORDS, reason)}
            </Text>
          ) : (
            part.text.replace(WORDS, reason)
          ),
        )}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The team side by side on the horizon, 12 apart, their feet on the sky's edge like the sign-in's agent.
  crew: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  lead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
  grow: { flex: 1, minWidth: 0 },
  org: { flexDirection: "row", alignItems: "center", gap: 10 },
  locked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  link: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  said: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
});
