import type { ImportCard } from "@agenteschat/client/lib/import/flow";

/**
 * Each import source's official logo (assets/images/brands/README.md), a dark file where the maker has one. Our own
 * export draws our mark and "Outro app" an icon, so neither is here.
 */
export const IMPORT_LOGO: Record<Exclude<ImportCard, "other" | "agenteschat">, { light: number; dark?: number }> = {
  "grok-bot": {
    light: require("../../../assets/images/brands/grok-bot.png"),
    dark: require("../../../assets/images/brands/grok-bot-dark.png"),
  },
  "chatgpt-dots": { light: require("../../../assets/images/brands/chatgpt-dots.png") },
  openbotrun: { light: require("../../../assets/images/brands/openbotrun.png") },
  openmausbot: { light: require("../../../assets/images/brands/openmausbot.png") },
  hermes: {
    light: require("../../../assets/images/brands/hermes.png"),
    dark: require("../../../assets/images/brands/hermes-dark.png"),
  },
  openclaw: { light: require("../../../assets/images/brands/openclaw.png") },
  paperclip: {
    light: require("../../../assets/images/brands/paperclip.png"),
    dark: require("../../../assets/images/brands/paperclip-dark.png"),
  },
};
