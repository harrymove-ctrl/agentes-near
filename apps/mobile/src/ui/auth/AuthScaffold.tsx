import type { Expression } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, KeyboardToolbar } from "react-native-keyboard-controller";
import Animated, { Easing, FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar } from "@/agent/AgentAvatar";
import type { AgentLookInput } from "@/agent/looks";
import type { AgentMode } from "@/agent/poses";
import { Sky, WorkspaceSky } from "@/sky/Sky";
import { IconButton } from "../IconButton";
import { Text } from "../Text";
import { useTheme } from "../theme";

/**
 * The sky's height under the status bar. One height whatever the keyboard does: these screens keep the keyboard up
 * from the first question to the last, so a sky that gave way to it would jump on every step. `low` for a question
 * that takes two lines (the workspace's name, the team's address).
 */
const SKY = { normal: 130, low: 88 } as const;
/** The agent over the sky's bottom edge, its feet on the text below. */
const AGENT = 96;
const AGENT_OVERLAP = 8;
/** The system bar over the keyboard (`KeyboardToolbar`), as tall as the library draws it. */
const TOOLBAR = 42;

/** The app's own agent, on the sky of every screen before the app. */
const APP_AGENT: AgentLookInput = { color: "sky", eyes: "round", id: "agentes" };

/** The text of the screens before the app: centered under the agent (fields and buttons keep the width). */
export const CENTER = { textAlign: "center" } as const;

/** Entering a step: a short ease-out fade, the same curve as the rest of the UI (never ease-in). */
const STEP_IN = FadeIn.duration(220).easing(Easing.bezier(0.23, 1, 0.32, 1));

/** A word joiner after each hyphen inside a word: the large title never breaks "e-mail" across two lines. */
const unbrokenHyphens = (text: string) => text.replace(/([A-Za-zÀ-ÿ])-([A-Za-zÀ-ÿ])/g, "$1-⁠$2");

export interface AuthScaffoldProps {
  title: string;
  subtitle?: string;
  /** The subtitle in ink, semibold: an address or an e-mail the question is about, not a second sentence. */
  subtitleStrong?: boolean;
  /** Where this question stands among several ("1 de 3 · Seu e-mail"), over the title. */
  progress?: string;
  onBack?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** A new key fades the question in (the steps of one screen). */
  stepKey?: string;
  /** The agent works while a request is out ("run": writing dashes), sleeps while nothing answers, and reacts with a face. */
  agentMode?: AgentMode;
  /** Another agent on the sky in the app's place: the first run's right hand, who asks its questions. */
  agent?: AgentLookInput;
  expression?: Expression;
  /** Over the screen and outside the steps, so a step's change never remounts it (the bot check's WebView). */
  overlay?: ReactNode;
  /** A lower sky, for a title that takes two lines. */
  sky?: keyof typeof SKY;
  /** The sky of this server (day on the Cloud, dusk on a team's own) instead of the app's: where a connection leads. */
  skyHost?: string;
  /**
   * Several fields on one screen (name, password, a note): the system's bar over the keyboard with ‹ › between them
   * and Pronto, so the keyboard walks the form instead of closing and reopening on each field.
   */
  toolbar?: boolean;
  /**
   * A field low on a long screen, under a list: on iOS the page scrolls it above the keyboard, where a screen giving
   * way to the keyboard leaves it under it. Android's own scrolling keeps a focused field in view.
   */
  scrollToFocus?: boolean;
  /**
   * What stands on the sky's edge instead of the app's agent: an invitation's team (its first agents), so the people
   * who'll work with you are seen before any field. Same overlap as the agent, so the title keeps its place.
   */
  hero?: ReactNode;
}

/**
 * One calm question per screen: a low pixel sky with the agent on its edge, the question as the title, the answer
 * below, the keyboard open from start to end with its return key as the action. Margin 16, rhythm in 8.
 */
export function AuthScaffold({
  title,
  subtitle,
  subtitleStrong = false,
  progress,
  onBack,
  children,
  footer,
  stepKey,
  agentMode = "idle",
  agent = APP_AGENT,
  expression,
  overlay,
  sky = "normal",
  skyHost,
  toolbar = false,
  scrollToFocus = false,
  hero,
}: AuthScaffoldProps) {
  const { colors, reducedMotion } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const skyStyle = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* The keyboard library's view: with its provider on, Android no longer resizes the window by itself. With the
          bar over the keyboard, the content keeps clear of it too. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        enabled={!(scrollToFocus && Platform.OS === "ios")}
        keyboardVerticalOffset={toolbar ? TOOLBAR : 0}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          automaticallyAdjustKeyboardInsets={scrollToFocus}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 16 }}
        >
          <View
            style={{ height: insets.top + SKY[sky], zIndex: 1 }}
            accessibilityLabel={t("mobile.auth.skyLabel")}
            accessibilityRole="image"
          >
            {skyHost ? (
              <WorkspaceSky host={skyHost} fade={0.55} style={skyStyle} />
            ) : (
              <Sky color="sky" depth={0.9} fade={0.55} style={skyStyle} />
            )}
            <View style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", marginBottom: -AGENT_OVERLAP }}>
              {hero ?? <AgentAvatar agent={agent} size={AGENT} mode={agentMode} expression={expression} />}
            </View>
            {onBack ? (
              <View style={{ position: "absolute", top: insets.top + 8, left: 16 }}>
                <IconButton icon="back" label={t("mobile.common.back")} onPress={onBack} plate />
              </View>
            ) : null}
          </View>
          <Animated.View
            key={stepKey}
            entering={reducedMotion ? undefined : STEP_IN}
            style={{ paddingHorizontal: 16, paddingTop: AGENT_OVERLAP + 16, flex: 1 }}
          >
            {progress ? (
              <Text variant="footnote" tone="faint" style={[CENTER, { fontWeight: "600", marginBottom: 8 }]}>
                {progress}
              </Text>
            ) : null}
            {/* Centered, like the agent above it: the screens before the app are one question each. */}
            <Text variant="display" accessibilityRole="header" accessibilityLiveRegion="polite" style={CENTER}>
              {unbrokenHyphens(title)}
            </Text>
            {subtitle ? (
              <Text
                variant="subhead"
                tone={subtitleStrong ? "ink2" : "muted"}
                numberOfLines={subtitleStrong ? 1 : undefined}
                ellipsizeMode="middle"
                style={[CENTER, { marginTop: 8 }, subtitleStrong ? { fontWeight: "600" } : null]}
              >
                {subtitle}
              </Text>
            ) : null}
            <View style={{ marginTop: 24, gap: 8 }}>{children}</View>
            <View style={{ flex: 1 }} />
            {footer ? <View style={{ marginTop: 24, alignItems: "center", gap: 12 }}>{footer}</View> : null}
          </Animated.View>
        </ScrollView>
        {overlay}
      </KeyboardAvoidingView>
      {/* Outside the avoiding view: the bar follows the keyboard itself, so it is never lifted twice. */}
      {toolbar ? (
        <KeyboardToolbar>
          <KeyboardToolbar.Prev />
          <KeyboardToolbar.Next />
          <KeyboardToolbar.Done text={t("mobile.common.done")} />
        </KeyboardToolbar>
      ) : null}
    </View>
  );
}
