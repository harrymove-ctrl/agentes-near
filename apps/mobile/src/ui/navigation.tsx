import {
  DarkTheme,
  DefaultTheme,
  router as expoRouter,
  type Href,
  type NativeStackNavigationOptions,
  type Theme as NavigationTheme,
  Stack,
} from "expo-router";
import { type ReactNode, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { needsHeaderBlur, pushOnce } from "@/lib/nav";
import { IconButton } from "./IconButton";
import { sheetColors } from "./palette";
import { useTheme } from "./theme";

/**
 * Options for the native navigators (react-native-screens through expo-router): the theme the native
 * headers read, the large-title stacks of the tabs, pushed screens and form sheets. Colors always come
 * from our theme, so light/dark follows the person's choice.
 */

const legacyBlur = needsHeaderBlur(Platform.OS, Platform.Version);

const push = pushOnce((...args: Parameters<typeof expoRouter.push>) => expoRouter.push(...args));
/**
 * The app's router: expo-router's, whose screens a quick double tap would push twice (its stack only folds a push of a
 * screen marked `singular`), pushing each screen once per tap (`pushOnce`). expo-router binds its methods after the
 * first render, so each is read when called. Every screen imports this one, never expo-router's.
 */
export const router: typeof expoRouter = new Proxy(expoRouter, {
  get: (target, key, receiver) => (key === "push" ? push : Reflect.get(target, key, receiver)),
});

/** A piece of the native header that changes with the screen (actions, a custom title). */
export interface HeaderSlotStore {
  get(): ReactNode;
  set(node: ReactNode): void;
  subscribe(listener: () => void): () => void;
}

function createSlot(initial: ReactNode): HeaderSlotStore {
  let node = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => node,
    set(next) {
      if (next === node) return;
      node = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Keeps `node` (an element rebuilt on every render of the screen) in a stable store, so the screen's
 * header options stay the same object and `setOptions` isn't called on every render; `HeaderSlot` shows
 * the latest node inside the header.
 */
export function useHeaderSlot(node: ReactNode): HeaderSlotStore {
  const [slot] = useState(() => createSlot(node));
  useLayoutEffect(() => {
    slot.set(node);
  });
  return slot;
}

/** Renders the latest node of a `useHeaderSlot` store. */
export function HeaderSlot({ slot }: { slot: HeaderSlotStore }) {
  const node = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return <>{node}</>;
}

/** React Navigation's theme from ours (back button tint, header text, userInterfaceStyle of the bars). */
export function useNavigationTheme(): NavigationTheme {
  const { colors, scheme } = useTheme();
  return useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === "dark",
      colors: {
        ...base.colors,
        primary: colors.ink,
        background: colors.bg,
        card: colors.bg,
        text: colors.ink,
        border: colors.line,
        notification: colors.ink,
      },
    };
  }, [colors, scheme]);
}

/**
 * The bar over content that scrolls under it: the system glass on iOS 26 (nothing set, so the system
 * draws it), a blur on older iOS, an opaque bar on Android (content starts below it).
 */
function useScrollUnderBar(): NativeStackNavigationOptions {
  const { colors, scheme } = useTheme();
  return useMemo<NativeStackNavigationOptions>(() => {
    if (Platform.OS === "ios") {
      return legacyBlur
        ? {
            headerTransparent: true,
            headerBlurEffect: scheme === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight",
          }
        : {};
    }
    return { headerTransparent: false, headerStyle: { backgroundColor: colors.bg } };
  }, [colors.bg, scheme]);
}

/**
 * A tab's stack root: a clear bar whose title fades in on scroll; the large title is drawn by the screen
 * (`LargeTitleScreen`), not the native one, which stayed expanded over the list inside the system tabs.
 */
export function useLargeTitleOptions(): NativeStackNavigationOptions {
  const { colors } = useTheme();
  return useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      headerLargeTitleEnabled: false,
      headerTitleStyle: { color: colors.ink },
      headerTintColor: colors.ink,
      contentStyle: { backgroundColor: colors.bg },
    }),
    [colors],
  );
}

/**
 * The stack inside a tab (Conversas, Agentes, Atividade): its root screen gets the native large title.
 * The title is set here too so the first frame already has it.
 */
export function TabStack({ title }: { title: string }) {
  const options = useLargeTitleOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
}

/**
 * The stack of Início: its root has no large title (the greeting over the sky is the large title). The
 * bar is clear over the sky; the title fades in once the greeting scrolls away, and what the bar becomes
 * once scrolled is drawn by the screen (`CoverBarBackdrop`) or, on iOS 26, by the system's scroll edge.
 */
export function CoverTabStack({ title }: { title: string }) {
  const { colors } = useTheme();
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      headerLargeTitleEnabled: false,
      headerTitleStyle: { color: colors.ink },
      headerTintColor: colors.ink,
      contentStyle: { backgroundColor: colors.bg },
    }),
    [colors],
  );
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
}

/**
 * A pushed screen (conversation, mission, agent, delete account): native bar, back chevron only, the
 * edge swipe back, the platform's push animation. Opaque by default (lists and composers lay out below
 * it); `PushedHeader` switches a screen to a bar its content scrolls under. On Android the back button is a
 * round plate floating like iOS 26's glass one (the toolbar's own arrow sat bare on the bar).
 */
export function usePushedOptions(): NativeStackNavigationOptions {
  const { colors, reducedMotion } = useTheme();
  const { t } = useTranslation();
  const backTitle = t("mobile.common.back");
  return useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      title: "",
      headerBackButtonDisplayMode: "minimal",
      // Hidden by the minimal button, but VoiceOver reads it: without it the back button was named after the
      // route group under it, "(tabs)".
      headerBackTitle: backTitle,
      headerTransparent: false,
      headerStyle: { backgroundColor: colors.bg },
      headerShadowVisible: false,
      headerTitleStyle: { color: colors.ink },
      headerTintColor: colors.ink,
      gestureEnabled: true,
      // From the right on both platforms (Android's default rises from below); a cross-fade with less motion.
      animation: reducedMotion ? "fade" : "slide_from_right",
      contentStyle: { backgroundColor: colors.bg },
      ...plateBack(backTitle),
    }),
    [colors, backTitle, reducedMotion],
  );
}

/** Android's back button: a round plate (the toolbar's own arrow hidden); iOS keeps the system's. */
function plateBack(label: string): NativeStackNavigationOptions {
  if (Platform.OS !== "android") return {};
  return {
    headerBackVisible: false,
    headerLeft: ({ canGoBack }) =>
      canGoBack ? <IconButton icon="back" label={label} plate onPress={() => goBack()} /> : null,
  };
}

/**
 * Back to the screen this one was opened from, so leaving a flow lands where the person was; `fallback` (home by
 * default) when it was opened by a link with nothing under it.
 */
export function goBack(fallback: Href = "/") {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/** The bar of a pushed screen whose content scrolls under it (needs `contentInsetAdjustmentBehavior="automatic"`). */
export function useScrollUnderPushedOptions(): NativeStackNavigationOptions {
  const bar = useScrollUnderBar();
  return useMemo<NativeStackNavigationOptions>(
    () =>
      // On iOS, clear the opaque defaults of `usePushedOptions` (options merge by spread, so an explicit
      // `undefined` lets iOS 26 draw its own glass bar).
      Platform.OS === "ios" ? { headerTransparent: undefined, headerStyle: undefined, ...bar } : bar,
    [bar],
  );
}

/** Over a full-bleed cover (the agent's sky): a clear bar on both platforms, the back button over the art. */
export const coverBarOptions: NativeStackNavigationOptions = {
  headerTransparent: true,
  headerStyle: { backgroundColor: "transparent" },
};

/**
 * A native form sheet (Requests, Você): drag to dismiss, detents, the grabber, and on iOS the screen behind
 * scales back. `detents` are fractions of the screen height, ascending, or `"fitToContents"`: the sheet is as tall
 * as what it holds (its content in `SheetScreen fit`), the same on every screen size. On iOS 26 the system draws its
 * corners (floating, concentric with the screen's); a radius of ours would square them off at the bottom. Sheets sit on the grouped gray
 * (white cards on it, like iOS), lifted above the screen in dark (`sheetColors`); `raised` for a sheet that is
 * one white card. The content goes in `SheetSurface` (`SheetScreen` does it): its colors, and Android's grabber.
 */
export function useFormSheetOptions(
  detents: number[] | "fitToContents",
  background: "raised" | "bg" = "bg",
): NativeStackNavigationOptions {
  const { colors: screen, scheme } = useTheme();
  const colors = useMemo(() => sheetColors(screen, scheme), [screen, scheme]);
  const key = typeof detents === "string" ? detents : detents.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the detents array
  return useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: false,
      presentation: "formSheet",
      sheetAllowedDetents: detents,
      sheetGrabberVisible: true,
      ...(Platform.OS === "ios" && !legacyBlur ? null : { sheetCornerRadius: 28 }),
      sheetExpandsWhenScrolledToEdge: true,
      // One white card in light; in dark the lifted sheet either way.
      contentStyle: { backgroundColor: background === "raised" ? screen.raised : colors.grouped },
    }),
    [key, background, colors, screen],
  );
}
