/**
 * Metro for a Bun workspace (apps/*, packages/*).
 *
 * - Watches the repo root so the workspace packages (`@agenteschat/client`, `i18n`, `tokens`, `ui`) are
 *   bundled from their TypeScript sources (Bun links them into node_modules; Metro follows the links).
 * - Looks for modules in this app's node_modules first, then the root's.
 * - Hierarchical lookup stays ON: Bun's hoisted layout nests conflicting versions under the package that
 *   needs them (`node_modules/a/node_modules/b`), and turning it off would hand those packages the wrong
 *   version. Expo's monorepo guide no longer asks for `disableHierarchicalLookup` since SDK 52.
 * - React, React Native, React Query and i18next are singletons: the web app may resolve a newer React at the root, while
 *   React Native's renderer needs the exact React this app pins. Every import of them, from any package,
 *   resolves from this app's folder, so the bundle never carries two Reacts.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = false;
config.resolver.unstable_enablePackageExports = true;

// Libraries with module-level state (contexts, instances): one copy for the app and the shared packages,
// or a hook from one copy can't see the provider of the other ("No QueryClient set").
const SINGLETONS = ["react", "react-native", "@tanstack/react-query", "react-i18next", "i18next"];
const fromApp = path.join(projectRoot, "package.json");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton = SINGLETONS.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));
  if (singleton && context.originModulePath !== fromApp) {
    return context.resolveRequest({ ...context, originModulePath: fromApp }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
