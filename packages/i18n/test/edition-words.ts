/**
 * Words a computer's screens never say, by edition (the shared dictionary's guard and the phone's). On the
 * Cloud the workspace's computer is always on, nobody pairs one, and it isn't "in the cloud"; "sempre ligado"
 * is the one power word there, and it passes. Self-host never says "in the cloud" either.
 */
export const CLOUD_BANNED = {
  en: [
    "your computer",
    "your computers",
    "computer of yours",
    "connect a computer",
    "connect another computer",
    "connected computer",
    "in the cloud",
    "cloud computer",
    "turn on",
    "turn off",
    "turns on",
    "turns off",
    "turning on",
    "turning off",
    "turning it on",
    "turning it off",
    " is off",
    "off right now",
    "back on",
    "wakes",
    "pair",
    "terminal",
  ],
  "pt-BR": [
    "seu computador",
    "seus computadores",
    "computador seu",
    "conectar um computador",
    "computador conectado",
    "na nuvem",
    "computador na nuvem",
    "ligar",
    "ligando",
    "desligad",
    "liga sozinh",
    "parear",
    "terminal",
  ],
} as const;

export const SELFHOST_BANNED = ["in the cloud", "cloud computer", "na nuvem", "computador na nuvem"] as const;

/**
 * System names, addresses and tool lists that the computer's screens never show to people who aren't developers.
 * Case-insensitive, so the Go language is left out: it would match English "Go to…".
 */
export const TECHNICAL =
  /\bLinux\b|\bIP(v[46])?\b|\bvCPU|Chrome|\bgit\b|\bNode\b|Python|\bRust\b|Debian|Ubuntu|Docker|kernel/i;

/** The banned phrases a text holds, ignoring case. */
export const bannedIn = (text: string, phrases: readonly string[]) =>
  phrases.filter((p) => text.replaceAll("\u00a0", " ").toLowerCase().includes(p));
