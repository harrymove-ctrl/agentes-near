import { type ReactNode, useEffect } from "react";
import { Keyboard, type StyleProp, View, type ViewStyle } from "react-native";

/**
 * `<Locked when={sending}>` turns off every control inside while its action runs, or once its result is final: no touch
 * reaches them, the keyboard closes on the field in use, the words stay. It is a real box, so it takes the children's
 * place in the layout: `style` gives it what the parent gave them (a `gap`). A `loading` Button and a Cancel that really
 * cancels stay outside: this dims what it holds. Inside a ScrollView, never around it: the page must still scroll.
 * `keepKeyboard`: the keyboard stays up. The screens before the app ask one thing after another on the same keyboard;
 * closing it while a step's request ran and reopening it on the next field made the whole screen jump twice.
 * `readable`: a lock that lasts (a workspace being deleted), so screen readers still read what it holds.
 */
export function Locked({
  when,
  style,
  keepKeyboard = false,
  readable = false,
  children,
}: {
  when: boolean;
  style?: StyleProp<ViewStyle>;
  keepKeyboard?: boolean;
  readable?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (when && !keepKeyboard) Keyboard.dismiss();
  }, [when, keepKeyboard]);
  return (
    <View
      pointerEvents={when ? "none" : "auto"}
      aria-hidden={when && !readable}
      style={[style, when ? { opacity: 0.6 } : null]}
    >
      {children}
    </View>
  );
}
