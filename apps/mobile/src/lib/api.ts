import { type ApiClient, createHttpApi } from "@agenteschat/client";
import { appHeaders, readCookie } from "./auth";

/**
 * The API client for a server: every request with the session cookie from SecureStore and
 * `X-Agentes-Client: mobile` (ADR 0035 §3). Screens reach it through `useApi()`.
 */
export const createApi = (server: string): ApiClient =>
  createHttpApi({ baseUrl: server, headers: async () => appHeaders(await readCookie(server)) });
