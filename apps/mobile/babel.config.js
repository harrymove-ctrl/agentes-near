/**
 * babel-preset-expo adds the worklets plugin (Reanimated 4) by itself when
 * `react-native-worklets` is installed, and resolves the `@/*` paths from
 * tsconfig.json. Nothing else is needed.
 */
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
