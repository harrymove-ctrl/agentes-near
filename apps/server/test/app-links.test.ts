import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  APP_LINK_PATHS,
  APP_LINK_WEB_QUERIES,
  androidAssetLinks,
  appleAppSiteAssociation,
  listOf,
  registerAppLinks,
} from "../src/app-links";

test("iOS: the app's pages open the app once team and bundle ids are set, the ones it lacks excluded first", () => {
  expect(appleAppSiteAssociation({ APPLE_TEAM_ID: undefined, APPLE_APP_BUNDLE_ID: "chat.agentes.app" })).toBeNull();
  expect(appleAppSiteAssociation({ APPLE_TEAM_ID: "ABCDE12345", APPLE_APP_BUNDLE_ID: " " })).toBeNull();
  const aasa = appleAppSiteAssociation({
    APPLE_TEAM_ID: "ABCDE12345",
    APPLE_APP_BUNDLE_ID: "chat.agentes.app, chat.agentes.app.preview",
  });
  const details = aasa?.applinks.details[0];
  expect(details?.appIDs).toEqual(["ABCDE12345.chat.agentes.app", "ABCDE12345.chat.agentes.app.preview"]);
  // A settings address with a sign-in's result or a website-only action is left to the website.
  expect(details?.components.slice(0, APP_LINK_WEB_QUERIES.length) as unknown[]).toEqual(
    ["mail", "connected", "outcome", "review", "install", "delete"].map((key) => ({
      "/": "/org/*/settings/*",
      "?": { [key]: "*" },
      exclude: true,
    })),
  );
  const paths = details?.components.slice(APP_LINK_WEB_QUERIES.length).map((c) => c["/"]);
  expect(paths).toEqual(APP_LINK_PATHS);
  for (const path of ["/invite/*", "/reset-password", "/signup", "/org/*/c/*", "/org/*/threads/*", "/org/*/dm/*"])
    expect(paths).toContain(path);
  // Never the API, sign-in callbacks or pages the app has no screen for.
  expect(paths?.some((p) => p.startsWith("/api") || /calendar|billing|voice|settings\/\*/.test(p))).toBe(false);
});

test("Android: every package with every signing fingerprint, upper-cased; nothing without them", () => {
  expect(androidAssetLinks({ ANDROID_APP_PACKAGE: "chat.agentes.app", ANDROID_APP_CERT_SHA256: " " })).toBeNull();
  expect(androidAssetLinks({ ANDROID_APP_PACKAGE: undefined, ANDROID_APP_CERT_SHA256: "AA:BB" })).toBeNull();
  const target = (name: string) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: name, sha256_cert_fingerprints: ["AA:BB", "CC:DD"] },
  });
  expect(
    androidAssetLinks({ ANDROID_APP_PACKAGE: "chat.agentes.app", ANDROID_APP_CERT_SHA256: "aa:bb, CC:DD" }),
  ).toEqual([target("chat.agentes.app")]);
  expect(
    androidAssetLinks({
      ANDROID_APP_PACKAGE: "chat.agentes.app,chat.agentes.app.preview",
      ANDROID_APP_CERT_SHA256: "aa:bb,CC:DD",
    }),
  ).toEqual([target("chat.agentes.app"), target("chat.agentes.app.preview")]);
});

test("a comma-separated list, trimmed, without empty entries", () => {
  expect(listOf(" a, b ,,c ")).toEqual(["a", "b", "c"]);
  expect(listOf(undefined)).toEqual([]);
});

test("served as JSON with no redirect, Apple's at /.well-known/ and at the root; 404 when not configured", async () => {
  const configured = {
    APPLE_TEAM_ID: "ABCDE12345",
    APPLE_APP_BUNDLE_ID: "chat.agentes.app",
    ANDROID_APP_PACKAGE: "chat.agentes.app",
    ANDROID_APP_CERT_SHA256: "AA:BB",
  } as Parameters<typeof registerAppLinks>[1];
  const app = new OpenAPIHono();
  registerAppLinks(app, configured);
  for (const path of ["/.well-known/apple-app-site-association", "/apple-app-site-association"]) {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    const body = (await res.json()) as { applinks: { details: { appIDs: string[] }[] } };
    expect(body.applinks.details[0]?.appIDs).toEqual(["ABCDE12345.chat.agentes.app"]);
  }
  const android = await app.request("/.well-known/assetlinks.json");
  expect(android.status).toBe(200);
  expect(android.headers.get("content-type")).toStartWith("application/json");
  const bare = new OpenAPIHono();
  registerAppLinks(bare, {} as Parameters<typeof registerAppLinks>[1]);
  expect((await bare.request("/apple-app-site-association")).status).toBe(404);
  expect((await bare.request("/.well-known/assetlinks.json")).status).toBe(404);
});
