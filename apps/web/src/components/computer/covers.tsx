import type { Edition, Machine } from "@agenteschat/client";
import { type CantShow, cantShowLine } from "@agenteschat/client/lib/agent-computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { commandInReason, toolOnCommand } from "@agenteschat/client/lib/machines";
import type { AgentColor } from "@agenteschat/ui";
import { Button } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Cover } from "../browser/Cover";
import { CommandBlock } from "../machine-bits";
import { Egress } from "./Egress";

/** The stage with nothing live on it: the screen's shape, and the cover that says why. */
export function Stage({ children }: { children: ReactNode }) {
  return (
    <div className="brw-ac__stage cmp-stage">
      <div className="cmp-stage__box" aria-hidden="true" />
      {children}
    </div>
  );
}

/**
 * Watching, the line under the screen: what programs there can see. A cover the screen opens from by itself keeps it
 * too, so the screen opens where its cover was; a cover that stays until someone acts takes its room.
 */
export function ScreenNotice({ name, machine }: { name: string; machine?: Machine | null }) {
  const { t } = useTranslation();
  return (
    <div className="dsk-line">
      <span className="dsk-words">
        <span className="muted">{t("desktop.watch.notice", agentGrammar(name))}</span>
      </span>
      <Egress machine={machine} compact />
    </div>
  );
}

/**
 * The agent's screen can't be shown: why, as the entry's line says it (`cause`), and to try again in a moment; on
 * self-host, for its admins and whoever paired the computer, the fix to run there. A Mac never gets this: it has no
 * screens, and shows the agent's page instead.
 */
export function CantShowCover({
  edition,
  machine,
  computer,
  name,
  reason,
  detail,
  cause,
  color,
  onRetry,
}: {
  edition: Edition;
  machine: Machine | null;
  computer: string;
  name: string;
  /** `GET …/desktop`'s reason, or the stream's: `not_allowed`, `desktop_unavailable`, `runner_outdated`… */
  reason: string | null;
  detail: string | null;
  /** Why, as the entry's line says it (`cantShow`), where the dialog knows it. */
  cause?: CantShow;
  color: AgentColor;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const g = agentGrammar(name);
  const again = (
    <Button size="sm" icon="refresh" onClick={onRetry}>
      {t("desktop.retry")}
    </Button>
  );
  if (edition === "selfhost" && reason === "runner_outdated") {
    return (
      <Cover color={color} icon="alert" text={t("agentComputer.state.outdated", { ...g, computer })} action={again} />
    );
  }
  const fixer = edition === "selfhost" && machine?.canManage === true && machine.os !== "darwin";
  const command =
    reason === "not_allowed" && machine
      ? toolOnCommand(machine, "desktop")
      : reason === "desktop_unavailable"
        ? commandInReason(detail)
        : null;
  if (fixer && command) {
    return (
      <Cover
        color={color}
        icon="dash"
        text={
          reason === "not_allowed"
            ? t("agentComputer.state.screensOff", { computer })
            : t("agentComputer.state.screensMissing", { computer })
        }
        help={<CommandBlock command={command} />}
        action={again}
      />
    );
  }
  return (
    <Cover
      color={color}
      icon="dash"
      text={(cause && cantShowLine(t, cause, { edition, computer })) || t("agentComputer.state.unavailable", g)}
      help={t("agentComputer.state.unavailableHelp")}
      action={again}
    />
  );
}
