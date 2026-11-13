import { expect, test } from "bun:test";
import {
  APP_OAUTH_RETURN,
  appOAuthRedirect,
  desktopOAuthRedirect,
  desktopReturnPath,
  isAppReturn,
  isDesktopReturn,
  oauthReturnTo,
} from "../src/connectors/oauth-return";

test("returnTo: a path on our site, the phone app's marker, or the home page", () => {
  expect(oauthReturnTo("/settings?tab=connectors")).toBe("/settings?tab=connectors");
  expect(oauthReturnTo(APP_OAUTH_RETURN)).toBe(APP_OAUTH_RETURN);
  // Never another host.
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "app:other", "", undefined])
    expect(oauthReturnTo(bad)).toBe("/");
  expect(isAppReturn(oauthReturnTo(APP_OAUTH_RETURN))).toBe(true);
  expect(isAppReturn("/settings")).toBe(false);
});

test("the app's deep link carries state and code, or only the error", () => {
  const ok = new URL(appOAuthRedirect({ state: "s1", code: "c 2" }));
  expect(`${ok.protocol}//${ok.host}${ok.pathname}`).toBe("agenteschat://connectors/oauth");
  expect(ok.searchParams.get("state")).toBe("s1");
  expect(ok.searchParams.get("code")).toBe("c 2");
  expect(appOAuthRedirect({ error: "access_denied" })).toBe("agenteschat://connectors/oauth?error=access_denied");
});

test("the desktop app's window: its marker with a path on our site, never another host", () => {
  expect(oauthReturnTo("desktop:/org/o1/settings/connectors")).toBe("desktop:/org/o1/settings/connectors");
  for (const bad of ["desktop://evil.example", "desktop:/\\evil.example", "desktop:https://evil.example", "desktop:"])
    expect(oauthReturnTo(bad)).toBe("desktop:/");
  expect(isDesktopReturn(oauthReturnTo("desktop:/settings"))).toBe(true);
  expect(isDesktopReturn("/settings")).toBe(false);
  expect(isDesktopReturn(APP_OAUTH_RETURN)).toBe(false);
  expect(desktopReturnPath("desktop:/org/o1/settings/connectors")).toBe("/org/o1/settings/connectors");
});

test("the desktop app's deep link carries the organization with state and code, or the error", () => {
  const ok = new URL(desktopOAuthRedirect({ org: "o1", state: "s1", code: "c 2" }));
  expect(`${ok.protocol}//${ok.host}${ok.pathname}`).toBe("agenteschat://desktop/connectors/oauth");
  expect([...ok.searchParams]).toEqual([
    ["org", "o1"],
    ["state", "s1"],
    ["code", "c 2"],
  ]);
  expect(desktopOAuthRedirect({ org: "o1", error: "access_denied" })).toBe(
    "agenteschat://desktop/connectors/oauth?org=o1&error=access_denied",
  );
});
