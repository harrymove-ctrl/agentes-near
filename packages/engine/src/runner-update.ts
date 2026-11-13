/**
 * How a computer too old for something gets its update, said to the agent that tells the person. The workspace's own
 * computer (`managed`) updates by itself; this server's computer (`host`) and one that runs every agent as its own
 * user (system mode) take the install command again, as root. Their runners all refuse `agentes-runner update`.
 */
export const runnerUpdateWay = (
  computer: { kind?: string | null; executors?: { mode?: string } | null } | null | undefined,
) =>
  computer?.kind === "managed"
    ? "It updates by itself, so try again later."
    : computer?.kind === "host" || computer?.executors?.mode === "system"
      ? "Its owner updates it by running the install command again, as root."
      : "Its owner updates the agentes app there, or runs `agentes-runner update`.";

/**
 * Where the person at a computer changes what agents may use there, said to the agent that tells them: the
 * agentes.chat app's Preferences (`pane`) on a Mac or a PC, else the runner's `commands` (a server may have no app).
 */
export const personAtComputerWay = (
  computer: { os: string; executors?: { mode?: string } | null },
  pane: string,
  commands: string[],
) =>
  computer.os === "darwin" || computer.os === "windows"
    ? `in the agentes.chat app there (Preferences › ${pane})`
    : `with ${commands.map((c) => `\`${computer.executors?.mode === "system" ? "sudo " : ""}agentes-runner ${c}\``).join(" and ")} there`;
