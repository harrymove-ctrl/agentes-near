import type { Plugin } from "vite";

/** Where index.html's inline script takes each language's file: empty in development, where it preloads nothing. */
export const LOCALE_FILES = "/* LOCALE_FILES */ {}";

/** The language a bundled module is the file of: `packages/i18n/src/en.ts`, `pt-BR.ts` or `locales/<code>.json`. */
export function localeOfModule(id: string): string | null {
  const m = /\/packages\/i18n\/src\/(?:locales\/([\w-]+)\.json|(en|pt-BR)\.ts)$/.exec(id.replaceAll("\\", "/"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * The person's language file loads with the app instead of after it: the built index.html gets each language's file,
 * and its inline script preloads the one it picks, as `savedLocale()` does (src/i18n/index.ts).
 */
export function preloadLocale(): Plugin {
  let base = "/";
  return {
    name: "agentes:preload-locale",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const files: Record<string, string> = {};
        for (const out of Object.values(ctx.bundle ?? {})) {
          const code = out.type === "chunk" && out.facadeModuleId ? localeOfModule(out.facadeModuleId) : null;
          if (code) files[code] = base + out.fileName;
        }
        return html.replace(LOCALE_FILES, JSON.stringify(files));
      },
    },
  };
}
