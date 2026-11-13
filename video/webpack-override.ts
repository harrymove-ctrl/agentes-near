import path from "node:path";
import type { WebpackOverrideFn } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";

export const webpackOverride: WebpackOverrideFn = (config) => {
  const c = enableTailwind(config);
  return {
    ...c,
    resolve: {
      ...c.resolve,
      alias: { ...c.resolve?.alias, "@": path.join(process.cwd(), "src") },
    },
  };
};
