import type { Machine } from "@agenteschat/client";
import { commandInReason, machineReasonText } from "@agenteschat/client/lib/machines";
import { Card, CardHeader, Chip, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { CommandBlock } from "../machine-bits";
import "../browser/browser.css";

/** Both switches desktop use needs, turned on at the computer. */
const TURN_ON = "agentes-runner tools enable desktop && agentes-runner tools enable commands";

/**
 * Apps on the agents' desktops, on a computer's page (ADR 0062): whether agents can use apps on their own
 * desktops there; when not, on Linux the computer's own words on what is missing (each agent its own user,
 * packages) with the command in them, elsewhere that it takes a Linux computer; or the two switches to turn on.
 * What the card is for is its title's ⓘ. Not on the workspace's own computer.
 */
export function MachineDesktopUseCard({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const use = m.desktopUse;
  if (!use) return null;
  const off = use.available && !(m.access?.tools.desktop && m.access.tools.commands);
  // A Mac or Windows has nothing to install for it: said in the app's words, not the runner's English.
  const linux = m.os === "linux";
  const reason = use.available
    ? null
    : linux
      ? machineReasonText(t, use, "desktop_use_install")
      : t("desktop.use.linuxOnly");
  const command = linux && !use.available ? commandInReason(use.reason) : null;
  return (
    <Card aria-labelledby="sec-machine-desktop-use">
      <CardHeader
        id="sec-machine-desktop-use"
        icon="computer"
        title={t("desktop.use.title")}
        hint={{ name: t("common.about", { label: t("desktop.use.title") }), text: t("desktop.use.description") }}
      />
      <div className="brw-status">
        {!use.available ? (
          <Chip icon="alert">{t("desktop.use.unavailable")}</Chip>
        ) : off ? (
          <Chip icon="dash">{t("desktop.use.off")}</Chip>
        ) : (
          <Chip icon="check" tone="done">
            {t("desktop.use.ready")}
          </Chip>
        )}
      </div>
      {off && (
        <div className="brw-note ac-iconline">
          <Icon name="computer" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {t("desktop.use.offHelp")}
            <CommandBlock command={TURN_ON} />
          </div>
        </div>
      )}
      {reason && (
        <div className="brw-note ac-iconline">
          <Icon name="alert" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {reason}
            {command && <CommandBlock command={command} />}
          </div>
        </div>
      )}
    </Card>
  );
}
