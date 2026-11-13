import type { ControlAgent, ControlStatus } from "@agenteschat/adapters/runner-control";
import { helpUrl } from "@agenteschat/client/lib/server";
import type { HelpSlug } from "@agenteschat/i18n/help";
import {
  type AgentState,
  Avatar,
  Button,
  Chip,
  ComputerPortrait,
  type ComputerState,
  CountChip,
  type Expression,
  Icon,
  type IconName,
  LogoMark,
  normalizeAppearance,
} from "@agenteschat/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../app";

/**
 * A command to copy, with Copy turning into Copied. `inline`: a short one inside a line of text, with an icon
 * button (a row that has no room for a box of its own).
 */
export function CommandCopy({ command, inline = false }: { command: string; inline?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () =>
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch(() => {});
  if (inline) {
    return (
      <span className="dk-fr__cmd dk-fr__cmd--inline">
        <code>{command}</code>
        <button
          type="button"
          className="dk-iconbtn"
          aria-label={copied ? t("desktop.common.copied") : t("desktop.common.copy")}
          onClick={copy}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
      </span>
    );
  }
  return (
    <div className="dk-fr__cmd">
      {/* Breaks only between words: a flag like `--network` never splits (selecting it copies the same text). */}
      <code>
        {command.split(" ").map((word, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the words of a fixed command, in order
          <span key={i}>
            {i > 0 && " "}
            <span className="dk-fr__word">{word}</span>
          </span>
        ))}
      </code>
      <Button size="sm" icon={copied ? "check" : "copy"} onClick={copy}>
        {copied ? t("desktop.common.copied") : t("desktop.common.copy")}
      </Button>
    </div>
  );
}

/**
 * A help page on agentes.chat, in the app's language, as a help line's link: the browser opens it with only the
 * page, the language and the section, so the site never learns which server this app opens.
 */
export function HelpLink({ slug, section, children }: { slug: HelpSlug; section?: string; children: ReactNode }) {
  const { i18n } = useTranslation();
  const host = useHost();
  return (
    <button
      type="button"
      className="ac-link ac-link--muted dk-link"
      onClick={() => void host.openExternal(helpUrl(slug, i18n.language, section)).catch(() => {})}
    >
      {children}
    </button>
  );
}

const ORG_TILE_PX = { sm: 16, md: 20, lg: 30 };

/**
 * An organization's tile: its logo when it has one (a `data:` URL from the runner), otherwise the pixel mark, as the
 * web and the phone show a workspace with no logo.
 */
export function OrgTile({ logo, size = "md" }: { logo?: string | null; size?: "sm" | "md" | "lg" }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (logo && broken !== logo) {
    return (
      <img
        className="dk-org dk-org--logo"
        data-size={size}
        src={logo}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBroken(logo)}
      />
    );
  }
  return <LogoMark className="dk-orgmark" size={ORG_TILE_PX[size]} />;
}

/** An agent drawn by the shared engine, from the look the server sends with the agents frame. */
export function AgentFace({
  agent,
  size = "sm",
  state,
  expression,
}: {
  agent: { name: string; look?: ControlAgent["look"] };
  size?: "xs" | "sm" | "md" | "lg";
  state?: AgentState;
  expression?: Expression;
}) {
  return (
    <Avatar
      kind="agent"
      name={agent.name}
      size={size}
      appearance={normalizeAppearance(agent.look)}
      state={state}
      expression={expression}
    />
  );
}

/** The app's own mark (the sky agent). */
export function BrandFace({ size = "sm", state }: { size?: "xs" | "sm" | "md" | "lg" | "xl"; state?: AgentState }) {
  return <Avatar kind="agent" name="agentes" size={size} appearance={{ color: "sky" }} state={state} />;
}

/** This Mac's portrait: the screen lit, dimmed (paused) or dark (offline). */
export function MacPortrait({ state, size = 48 }: { state: ComputerState; size?: 48 | 96 | 144 }) {
  return <ComputerPortrait kind="mac" state={state} size={size} />;
}

/** A number with − and + (custom, never a native input). */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a custom stepper, labelled as a group
    <span className="dk-stepper" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={t("desktop.common.less")}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Icon name="dash" size={14} />
      </button>
      <output className="ac-num">{value}</output>
      <button
        type="button"
        aria-label={t("desktop.common.more")}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Icon name="plus" size={14} />
      </button>
    </span>
  );
}

/** A raised note at the top of the popover (paused, offline, update, a request). */
export function Banner({
  icon,
  lead,
  title,
  children,
  actions,
  shimmer,
}: {
  icon?: IconName;
  /** In place of the icon (a pixel orbit, an agent). */
  lead?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  shimmer?: boolean;
}) {
  return (
    <div className="dk-banner">
      <div className="dk-banner__head">
        <span className="dk-logo dk-logo--soft">{lead ?? (icon ? <Icon name={icon} size={16} /> : null)}</span>
        <span className="dk-banner__text">
          <b className={shimmer ? "dk-shimmer" : undefined}>{title}</b>
          {children && <small>{children}</small>}
        </span>
      </div>
      {actions && <div className="dk-banner__acts">{actions}</div>}
    </div>
  );
}

/** A row of the popover's menu. */
export function MenuRow({
  icon,
  lead,
  children,
  onClick,
  trailing,
  danger,
  expanded,
  disabled,
}: {
  icon?: IconName;
  /** In place of the icon, as an organization's tile. */
  lead?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  trailing?: ReactNode;
  danger?: boolean;
  expanded?: boolean;
  /** While what it does is running. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="dk-mi"
      data-danger={danger || undefined}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {lead ?? (icon && <Icon name={icon} size={16} />)}
      <span className="dk-mi__label">{children}</span>
      {trailing && <span className="dk-mi__end">{trailing}</span>}
    </button>
  );
}

/** A quiet count in Doto ("Agora 3"). */
export const Count = ({ n }: { n: number }) => (n > 0 ? <CountChip size="sm">{n}</CountChip> : null);

/** How an organization's connection reads, as a chip with an icon (never a colored dot). */
export function ConnectionChip({ status, running }: { status: ControlStatus | null; running: boolean }) {
  const { t } = useTranslation();
  if (!running || !status) return <Chip icon="spinner">{t("desktop.status.starting")}</Chip>;
  if (status.paused.paused) return <Chip icon="pause">{t("desktop.status.paused")}</Chip>;
  switch (status.connection) {
    case "online":
      return (
        <Chip icon="check" tone="done">
          {t("desktop.status.connected")}
        </Chip>
      );
    case "connecting":
      return <Chip icon="spinner">{t("desktop.status.connecting")}</Chip>;
    case "refused":
      return (
        <Chip icon="alert" tone="waiting">
          {t("desktop.status.refused")}
        </Chip>
      );
    case "outdated":
      return (
        <Chip icon="download" tone="waiting">
          {t("desktop.status.outdated")}
        </Chip>
      );
    default:
      return (
        <Chip icon="cloud" tone="waiting">
          {t("desktop.status.offline")}
        </Chip>
      );
  }
}
