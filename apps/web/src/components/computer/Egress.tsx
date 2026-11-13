import type { Machine } from "@agenteschat/client";
import { Icon } from "@agenteschat/ui";
import { countryFlagUrl } from "@agenteschat/ui/brand/flags";
import { useTranslation } from "react-i18next";

/** Only a recent observation from an online computer; a country is never inferred from an assigned address. */
export function Egress({ machine, compact = false }: { machine: Machine | null | undefined; compact?: boolean }) {
  const { t } = useTranslation();
  const e = machine?.kind === "managed" && machine.online ? machine.egress : null;
  const transition = machine?.kind === "managed" ? machine.networkTransition : null;
  // A while with no way out for its agents: their connections wait, nothing is broken.
  if (machine?.kind === "managed" && machine.online && machine.egressWaiting)
    return (
      <span role="status" className={compact ? "dsk-egress ac-iconline muted" : "setup-line small"}>
        {t("machines.egress.waiting")}
      </span>
    );
  if (transition)
    return (
      <span role="status" className="setup-line small">
        {t(transition.state === "draining" ? "machines.egress.draining" : "machines.egress.restart", {
          when: new Date(transition.deadline).toLocaleTimeString(),
        })}
      </span>
    );
  if (!e?.ip) return null;
  const flag = countryFlagUrl(e.country);
  return (
    <span
      className={compact ? "dsk-egress ac-iconline muted" : "setup-line ac-iconline small muted"}
      title={t("machines.egress.hint")}
    >
      {flag ? (
        <img src={flag} alt="" width={20} height={14} style={{ borderRadius: 2, objectFit: "cover", flex: "none" }} />
      ) : (
        <Icon name="globe" size={14} />
      )}
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("machines.egress.line", { ip: e.ip })}</span>
    </span>
  );
}
