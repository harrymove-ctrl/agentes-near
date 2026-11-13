import { File, Paths } from "expo-file-system";

type Handler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler(): Handler; setGlobalHandler(handler: Handler): void };

/** In the app's own documents: never sent anywhere, gone with the app. */
const NAME = "last-crash.txt";

/**
 * Keeps the last error that closed the app (its time, message and stack) in a file of the app's own folder before
 * the system's handler ends it, so a crash of a test build can be read off the phone afterwards (`xcrun devicectl
 * device copy from --domain-type appDataContainer`) when nothing was attached to watch it. Errors drawing a screen
 * don't get here: its error boundary shows them (`ScreenError`).
 */
export function keepLastCrash() {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils) return;
  const next = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal) {
      try {
        const e = error instanceof Error ? error : new Error(String(error));
        new File(Paths.document, NAME).write(`${new Date().toISOString()}\n${e.message}\n${e.stack ?? ""}\n`);
      } catch {
        // Nothing to keep it in: the crash goes on as before.
      }
    }
    next(error, isFatal);
  });
}
