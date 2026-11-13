import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import Constants from "expo-constants";

/** Removes trailing slashes: "https://app.agentes.chat/" → "https://app.agentes.chat". */
export const trimBase = (url: string) => url.replace(/\/+$/, "");

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; variant?: string };

/**
 * The build's server: `extra.apiUrl` from app.config.ts (env `EXPO_PUBLIC_API_URL` at build time). The person
 * can choose another one ("Seu servidor"); read the current one with `serverUrl()` (src/lib/server.ts).
 */
export const API_URL = trimBase(extra.apiUrl ?? process.env.EXPO_PUBLIC_API_URL ?? CLOUD_SERVER);

/** "development" | "preview" | "production". */
export const APP_VARIANT = extra.variant ?? "production";

/** The deep-link scheme (app.config.ts `scheme`). */
export const SCHEME = "agenteschat";

/** Prefix for everything the app keeps in SecureStore (keys allow only letters, digits, ".", "-" and "_"). */
export const STORAGE_PREFIX = "agenteschat";
