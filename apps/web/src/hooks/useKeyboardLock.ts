import { useEffect, useRef } from "react";

type WithKeyboard = Navigator & { keyboard?: { lock(): Promise<void>; unlock(): void } };

/**
 * Keyboard Lock (Chromium) while `on` and in full screen: Esc, Ctrl+W, Ctrl+T and the like reach the page, not the
 * browser; holding Esc leaves full screen, and the browser says so. `current`: whether the lock holds.
 */
export function useKeyboardLock(on: boolean) {
  const locked = useRef(false);
  useEffect(() => {
    const keyboard = (navigator as WithKeyboard).keyboard;
    if (!on || typeof keyboard?.lock !== "function") return;
    let live = true;
    keyboard.lock().then(
      () => {
        locked.current = live;
      },
      () => {},
    );
    return () => {
      live = false;
      locked.current = false;
      keyboard.unlock();
    };
  }, [on]);
  return locked;
}
