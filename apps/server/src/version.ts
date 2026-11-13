import type { Config } from "@agenteschat/config";
import pkg from "../package.json" with { type: "json" };

/** Server version, taken from apps/server/package.json. */
export const version: string = pkg.version;

/** This deploy's version: `APP_VERSION` when the deploy set one, else the package's. */
export const releaseOf = (config: Pick<Config, "APP_VERSION">) => config.APP_VERSION ?? version;
