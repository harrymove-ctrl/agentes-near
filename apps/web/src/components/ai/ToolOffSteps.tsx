import { useMachines } from "@agenteschat/client";
import { allowsInApp, toolOnCommand } from "@agenteschat/client/lib/machines";
import { Icon, LogoMark } from "@agenteschat/ui";
import { Trans, useTranslation } from "react-i18next";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { OpenPrefsButton, useIsThisMac } from "@/components/ThisMac";

/**
 * The way to the switch of a program that is off on a computer the person connected (ADR 0160, amended 2026-11-12):
 * under the computer's name, three plain lines for the app's three clicks (the icon by the clock, Preferences, the
 * switch under Tools), what to look for in bold and the switch drawn at the end of the last one. On a computer that may
 * have no app, the command; in the app on that very computer, one button to its Tools. Then that the dialog waits and
 * changes by itself, which it does: a computer's switches come back as its own event.
 */
export function ToolOffSteps({
  computer,
  machineId,
  kind,
  program,
}: {
  computer: string;
  machineId: string | undefined;
  /** The program's switch in the computer's settings (`MachineAccess.tools`). */
  kind: Parameters<typeof toolOnCommand>[1];
  /** As its switch names it there: "Claude Code". */
  program: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const here = useIsThisMac(org.id, machineId ?? "");
  const row = useMachines(org.id).data?.find((m) => m.id === machineId);
  const b = { b: <b /> };
  return (
    <>
      <div className="tool-off">
        <p className="tool-off__where ac-iconline">
          <Icon name="computer" size={16} />
          <span>{t("connectAi.toolOff.where", { computer })}</span>
        </p>
        {here ? (
          <div className="tool-off__row">
            <span>
              <Trans i18nKey="connectAi.toolOff.here" values={{ program }} components={b} />
            </span>
            <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
          </div>
        ) : row && !allowsInApp(row.os) ? (
          <div className="tool-off__row tool-off__row--stack">
            <span>{t("connectAi.toolOff.terminal")}</span>
            <CommandBlock command={toolOnCommand(row, kind)} />
          </div>
        ) : (
          <ol className="tool-off__list">
            <li>
              <i>1</i>
              <span>
                <Trans
                  i18nKey="connectAi.toolOff.one"
                  components={{
                    mark: (
                      <span className="tool-off__app" aria-hidden="true">
                        <LogoMark size={12} />
                      </span>
                    ),
                  }}
                />
                {row?.os === "windows" && <small>{t("connectAi.toolOff.oneWindows")}</small>}
              </span>
            </li>
            <li>
              <i>2</i>
              <span>
                <Trans i18nKey="connectAi.toolOff.two" components={b} />
              </span>
            </li>
            <li>
              <i>3</i>
              <span>
                <Trans i18nKey="connectAi.toolOff.three" values={{ program }} components={b} />
              </span>
              <span className="tool-off__switch" aria-hidden="true" />
            </li>
          </ol>
        )}
      </div>
      <p className="tool-off__wait ac-iconline" role="status">
        <Icon name="spinner" size={14} />
        <span>{t("connectAi.toolOff.waiting")}</span>
      </p>
    </>
  );
}
