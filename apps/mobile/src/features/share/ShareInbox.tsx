import { usePathname } from "expo-router";
import { useShareIntent } from "expo-share-intent";
import { useEffect, useRef } from "react";
import { router } from "@/ui/navigation";
import { receiveShare, SHARE_ROUTE, sharedFromIntent } from "./inbox";

/**
 * Listens for the system's share sheet (an iOS share extension and Android's send intent, from `expo-share-intent`):
 * what arrives is kept (`receiveShare`), the native copy is cleared so it never comes back, and "Compartilhar com…"
 * opens over whatever is on screen. On iOS the extension opens the app with a link `+native-intent` already sends to
 * that screen; on Android nothing navigates, so this does. Mounted in the signed-in app: shared while signed out, it
 * opens once the person is in. A build without the native part (the module missing) simply never hears anything.
 */
export function ShareInbox() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const pathname = usePathname();
  const where = useRef(pathname);
  where.current = pathname;
  useEffect(() => {
    if (!hasShareIntent) return;
    const shared = sharedFromIntent(shareIntent);
    resetShareIntent();
    if (!shared) return;
    receiveShare(shared);
    if (where.current !== SHARE_ROUTE) router.push(SHARE_ROUTE);
  }, [hasShareIntent, shareIntent, resetShareIntent]);
  return null;
}
