import { existsSync } from "node:fs";
import { Config } from "@remotion/cli/config";
import { webpackOverride } from "./webpack-override";

const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (existsSync(CHROME_MAC)) {
  Config.setBrowserExecutable(CHROME_MAC);
}
Config.setChromiumOpenGlRenderer("angle");
Config.setChromeMode("chrome-for-testing");
Config.setRspack(false);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(1);
Config.overrideBundlerConfig(webpackOverride);
