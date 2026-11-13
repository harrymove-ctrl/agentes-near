import type { AuthConfig } from "../api/types";

/**
 * The About screen's links (AGPL-3.0's Appropriate Legal Notices and the attribution its section 7(b) term asks for,
 * see NOTICE). The same on every server: there is no setting that hides them.
 */
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/** Mirror of `SOURCE_URL`'s default (packages/config/src/schema.ts), for a server too old to send `sourceUrl`. */
export const PUBLIC_SOURCE_URL = "https://github.com/agentes-chat/agentes-chat";

/**
 * A self-hosted server: never agentes.chat Cloud, nor before the server's config arrives, so the Cloud never shows
 * what is only for self-hosting for a moment.
 */
export const selfHosted = (server: AuthConfig | undefined) => server !== undefined && server.cloud !== true;

/**
 * Whether the About screen shows: on every self-hosted server, for everyone; never on agentes.chat Cloud, which is
 * agentes.chat itself.
 */
export const showsAbout = selfHosted;
