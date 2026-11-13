import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Icon, type IconName, Sky, Text, weights } from "@/ui";
import { AskButtons, ExpiryLine } from "../chat/asks";
import { AgentFace } from "./Face";
import { useColors, useDirectory } from "./hooks";
import { agentLook } from "./logic";
import { useSurface } from "./parts";

/** The leading face: an agent's (on its sky), or what stands for whoever asks (a server's mark, people's faces). */
const FACE = 36;

export interface WaitingCardProps {
  /** The agent asking: its face leads the card and its sky tints the card's top (gray when none asks). */
  agentId?: string | null;
  /** Leads the card when no agent asks (a connector's mark, the faces of who asks to join), FACE points wide. */
  leading?: ReactNode;
  /** Who asks ("Ada", "TikTok"); the kind goes under it. */
  name?: string;
  kind: { icon: IconName; label: string };
  title?: string;
  /** Under the title: why it was asked in muted, then what it goes through (`WaitingSource`), what it costs. */
  children?: ReactNode;
  /** Its deadline: the amber fuse and the time left, at the top line's right (`ExpiryLine`). */
  expires?: { createdAt?: string | null; expiresAt: string } | null;
  /** Without a deadline, at the top line's right: where and when ("#marketing · 19:58"). */
  where?: string;
  /**
   * The one action, wide under the request: the screen's one primary on the card that decides something, else
   * secondary (`variant`), so a page of cards has one primary.
   */
  action?: { label: string; onPress: () => void; variant?: "primary" | "secondary" } | null;
  /** The decision taken on the card itself (the chat's `AskButtons`), in place of `action`. */
  decision?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Under the card's foot, after a hairline ("e mais 2 esperando você"). */
  footer?: ReactNode;
}

/**
 * One thing waiting on you, as Atividade, Conversas' strip and an agent's profile show it, read as the chat's request
 * card: the card with its cut corner (square bottom left, as the chat's blocks), the asking agent's sky faint across
 * the top (gray when no agent asks), its face with the name (15, regular: the request is the card's one bold) and
 * the kind under it (its icon quiet: no "waiting for you" mark, the card itself is the ask) and, at the right, where
 * and when; then the request in words (17 semibold), why in muted, what it goes through on one quiet line, the
 * decision (or its one action) wide under it and, at its end, the fuse to its deadline.
 */
export function WaitingCard({
  agentId,
  leading,
  name,
  kind,
  title,
  children,
  expires,
  where,
  action,
  decision,
  onPress,
  accessibilityLabel,
  footer,
}: WaitingCardProps) {
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  const foot =
    decision ??
    (action ? (
      <AskButtons
        primary={
          <Button
            variant={action.variant ?? "primary"}
            size="card"
            wide
            label={action.label}
            onPress={action.onPress}
          />
        }
      />
    ) : null);
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.clip}>
        {/* The asking agent's sky; a gray one when no agent asks (a server, people), so every card reads the same. */}
        <Sky
          color={agent ? agentLook(agent).color : "graphite"}
          depth={0.55}
          fade={0.15}
          surface="raised"
          style={styles.sky}
        />
        <Pressable
          onPress={onPress}
          disabled={!onPress}
          accessibilityRole={onPress ? "button" : undefined}
          accessibilityLabel={accessibilityLabel}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        >
          <View style={styles.hd}>
            {agentId ? <AgentFace agentId={agentId} size={FACE} live={false} /> : leading}
            <View style={styles.grow}>
              {name ? (
                <Text variant="small" tone="ink2" numberOfLines={1}>
                  {name}
                </Text>
              ) : null}
              <View style={styles.kind}>
                <Icon name={kind.icon} size={13} color={c.muted} />
                <Text variant="footnote" tone="muted" numberOfLines={1} style={[styles.medium, styles.shrink]}>
                  {kind.label}
                </Text>
              </View>
            </View>
            {where ? (
              <Text variant="footnote" tone="faint" numberOfLines={1} style={[styles.when, styles.where]}>
                {where}
              </Text>
            ) : null}
          </View>
          {title ? (
            <Text variant="title" tone="ink" numberOfLines={3}>
              {title}
            </Text>
          ) : null}
          {children}
        </Pressable>
        {foot || expires ? (
          <View style={styles.ft}>
            {foot}
            {expires ? (
              <View style={styles.expiry}>
                <ExpiryLine createdAt={expires.createdAt} expiresAt={expires.expiresAt} />
              </View>
            ) : null}
          </View>
        ) : null}
        {footer ? <View style={[styles.footer, { borderTopColor: c.line2 }]}>{footer}</View> : null}
      </View>
    </View>
  );
}

/** What a waiting card's request goes through, on one quiet line as the chat's card says it: its mark, its details. */
export function WaitingSource({ mark, text }: { mark?: ReactNode; text: string }) {
  return (
    <View style={styles.source}>
      {mark ? <View style={styles.sourceMark}>{mark}</View> : null}
      <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

/** The cut corner: square-ish bottom left, the rest round (the chat's blocks, the web's cards). */
const RADIUS = 20;
const CUT = 6;

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS, borderBottomLeftRadius: CUT },
  clip: { borderRadius: RADIUS, borderBottomLeftRadius: CUT, overflow: "hidden", paddingBottom: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 56, opacity: 0.5 },
  body: { paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  hd: { flexDirection: "row", alignItems: "center", gap: 12 },
  kind: { flexDirection: "row", alignItems: "center", gap: 4 },
  // The source line as the chat's card draws it: its mark, its details faint on one line.
  source: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", minHeight: 24 },
  sourceMark: { flexShrink: 0 },
  // The decision under the request, as the chat card's foot (its 8 + 4 points above).
  ft: { paddingHorizontal: 16, paddingTop: 12 },
  // The deadline at the foot's end, right-aligned under the decision (as the chat's card).
  expiry: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  when: { fontVariant: ["tabular-nums"] },
  // Where and when never take the name's room: at most half the line.
  where: { flexShrink: 1, maxWidth: "50%" },
  footer: { marginTop: 12, marginHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  medium: { fontWeight: weights.medium },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.85 },
});
