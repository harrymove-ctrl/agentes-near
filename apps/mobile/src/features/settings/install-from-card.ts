import { type CardInstall, cardInstallAgent } from "@agenteschat/client/lib/action-cards";

/**
 * The install an agent's card on this phone opened last, in memory only: a link from outside the app to Instalar
 * skill that names an agent turns nothing on for it.
 */
let opened: CardInstall | null = null;

/** Said by an agent's install card right before it opens Instalar skill. */
export function openedFromCard(install: CardInstall) {
  opened = install;
}

/** The agent Instalar skill's route (`url`, `agent`) may turn what installs on for: only the card's own. */
export const routeAgent = (url?: string, agent?: string) => cardInstallAgent(opened, url, agent);
