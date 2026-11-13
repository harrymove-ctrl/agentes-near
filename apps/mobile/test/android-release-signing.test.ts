import { describe, expect, test } from "bun:test";

// The config plugin is plain CommonJS (expo prebuild loads it); only its pure part is tested here.
const { withReleaseSigning } = require("../plugins/with-android-release-signing") as {
  withReleaseSigning: (gradle: string) => string;
};

/** The parts of Expo's android/app/build.gradle template the plugin edits. */
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

describe("Android release signing (the Android build workflow)", () => {
  test("adds a release config read from the environment and signs release builds with it when set", () => {
    const out = withReleaseSigning(TEMPLATE);
    expect(out).toContain('storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))');
    expect(out).toContain('keyAlias System.getenv("ANDROID_KEY_ALIAS")');
    expect(out).toContain(
      'signingConfig System.getenv("ANDROID_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug',
    );
    // Debug builds keep the debug key.
    expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug\s*\}/);
  });

  test("runs twice without adding twice, and carries no key or password", () => {
    const once = withReleaseSigning(TEMPLATE);
    expect(withReleaseSigning(once)).toBe(once);
    expect(once).not.toMatch(/storePassword '(?!android')/);
  });

  test("refuses a build.gradle it doesn't recognize", () => {
    expect(() => withReleaseSigning("android {}")).toThrow("signingConfigs");
  });
});
