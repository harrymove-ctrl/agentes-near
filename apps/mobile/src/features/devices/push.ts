import type { ApiClient } from "@agenteschat/client";
import * as Notifications from "expo-notifications";
import type { TFunction } from "i18next";
import type { PushData } from "@/lib/push-payload";

/**
 * The buttons of a device notification on the lock screen, by its kind (the push's category): Stop an agent on the
 * phone, Let it join / Deny a computer, Allow once / No for an agent asking. Each opens the app on the device, so
 * what happened is right there.
 */
const ACTIONS: Record<string, readonly (readonly [id: string, key: string])[]> = {
  "device.in_use": [["stop", "mobile.devices.notice.stop"]],
  "device.join_request": [
    ["allow", "mobile.devices.join.allow"],
    ["deny", "mobile.devices.join.deny"],
  ],
  "device.access_request": [
    ["once", "mobile.devices.notice.allowOnce"],
    ["no", "mobile.devices.notice.no"],
  ],
};

export function registerDeviceActions(t: TFunction) {
  return Promise.all(
    Object.entries(ACTIONS).map(([kind, actions]) =>
      Notifications.setNotificationCategoryAsync(
        kind,
        actions.map(([identifier, key]) => ({
          identifier,
          buttonTitle: t(key),
          options: { opensAppToForeground: true, isDestructive: identifier === "deny" || identifier === "no" },
        })),
      ),
    ),
  ).catch(() => undefined);
}

/** Runs the button pressed on a device notification; the device's page then shows how it went. */
export function runDeviceAction(api: ApiClient, orgId: string, d: PushData, action: string) {
  const done = (p: Promise<unknown>) => void p.catch(() => undefined);
  if (d.kind === "device.in_use" && action === "stop" && d.phoneId) done(api.devices.stopPhone(orgId, d.phoneId));
  if (d.kind === "device.join_request" && d.requestId) {
    if (action === "allow") done(api.devices.approveRequest(orgId, d.requestId, {}));
    if (action === "deny") done(api.devices.denyRequest(orgId, d.requestId));
  }
  if (d.kind === "device.access_request" && d.requestId && (action === "once" || action === "no"))
    done(api.devices.decideAccess(orgId, d.requestId, action));
}
