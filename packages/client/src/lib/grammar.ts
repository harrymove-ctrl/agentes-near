/** The app's own starter names (`newAgent.roles.*.agent`) that are feminine without ending in "a". */
const FEMININE = new Set(["iris"]);

/**
 * An agent's grammatical gender, for the languages whose sentences agree with it ("a Ada", "o Theo", she/he): one
 * agent is never "it" in one line and "her" in the next. Agents don't store one, so we infer it from the name: names
 * ending in "a" are feminine. A name someone types that is feminine and ends otherwise ("Beatriz") reads as masculine.
 */
export function isFeminineName(name: string) {
  const plain = name.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return plain.endsWith("a") || FEMININE.has(plain);
}

/**
 * `t` options for a sentence about an agent: its name and the i18next context its gender picks (`key_female` where a
 * language writes one, else `key`).
 */
export function agentGrammar(name: string): { name: string; context: "female" | undefined } {
  return { name, context: isFeminineName(name) ? "female" : undefined };
}
