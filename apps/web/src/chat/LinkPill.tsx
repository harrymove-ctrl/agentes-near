import { linkPillLabel, linkPillText, type LinkPill as Pill } from "@agenteschat/client/lib/link-pills";
import { Icon, type IconName } from "@agenteschat/ui";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

const KIND_ICON: Record<NonNullable<Pill["kind"]>, IconName> = {
  pull: "gitPull",
  merge: "gitPull",
  issue: "issue",
};

/**
 * A bare address of a known service (`linkPill`), as a pill like a #channel's: the service's logo and a few words. It
 * stays an ordinary link: the same new tab, the full address on hover, in its context menu and when copied
 * (`copyPillAddresses`).
 */
export function LinkPill({ href, pill }: { href: string; pill: Pill }) {
  const { t } = useTranslation();
  const mark = {
    "--connector-icon": `url("${pill.iconUrl}")`,
    ...(pill.brandColor ? { "--connector-color": pill.brandColor } : {}),
  } as CSSProperties;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="channel-ref link-pill"
      title={href}
      aria-label={linkPillLabel(t, pill)}
    >
      <span className="link-pill__mark" style={mark} />
      {pill.kind ? (
        <>
          {pill.name}{" "}
          <span className="link-pill__ref">
            <Icon name={KIND_ICON[pill.kind]} size={14} />
            {pill.ref}
          </span>
        </>
      ) : (
        linkPillText(t, pill)
      )}
    </a>
  );
}
