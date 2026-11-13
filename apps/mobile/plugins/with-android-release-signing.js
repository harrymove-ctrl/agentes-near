/**
 * Expo config plugin: Android release builds signed with the app's upload key, read from the environment when
 * Gradle runs (the "Android build" workflow, .github/workflows/android.yml):
 * `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
 * Without them a release build keeps the template's debug signing (a local build), as before. The key itself
 * never enters the repo or the generated project.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// agentes: release signing from the environment";

const RELEASE_CONFIG = `
        ${MARK}
        release {
            if (System.getenv("ANDROID_KEYSTORE_PATH")) {
                storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }`;

/** The template's build.gradle with a `release` signing config and the release build type using it. */
function withReleaseSigning(gradle) {
  if (gradle.includes(MARK)) return gradle;
  const configs = /signingConfigs\s*\{/;
  if (!configs.test(gradle)) throw new Error("with-android-release-signing: no `signingConfigs` block in build.gradle");
  let out = gradle.replace(configs, (m) => `${m}${RELEASE_CONFIG}`);
  // In `buildTypes { … release { … signingConfig signingConfigs.debug` (the template's), use the release key when set.
  const release = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!release.test(out))
    throw new Error("with-android-release-signing: the release build type's signing wasn't found");
  out = out.replace(
    release,
    `$1signingConfig System.getenv("ANDROID_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug`,
  );
  return out;
}

module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("with-android-release-signing: expected a Groovy build.gradle");
    }
    cfg.modResults.contents = withReleaseSigning(cfg.modResults.contents);
    return cfg;
  });

module.exports.withReleaseSigning = withReleaseSigning;
