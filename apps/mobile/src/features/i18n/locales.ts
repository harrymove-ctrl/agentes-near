import type { AppLocale } from "@agenteschat/i18n/locale";
import type { LocaleStrings } from "@agenteschat/i18n/plurals";
import { featureKeysEn } from "./keys.en";
import { featureKeysPtBR } from "./keys.pt-BR";
import de from "./locales/de.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import id from "./locales/id.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import ru from "./locales/ru.json";
import tr from "./locales/tr.json";
import zhHans from "./locales/zh-Hans.json";

/** The screens' strings per language. */
export const FEATURES: Record<AppLocale, LocaleStrings> = {
  en: featureKeysEn,
  "pt-BR": featureKeysPtBR,
  es,
  fr,
  de,
  it,
  nl,
  ja,
  ko,
  "zh-Hans": zhHans,
  id,
  tr,
  pl,
  ru,
};
