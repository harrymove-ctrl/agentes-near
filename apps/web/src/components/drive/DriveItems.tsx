import type { Artifact, ArtifactKind } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { fileIcon } from "@agenteschat/client/lib/files";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Checkbox, cx, Icon, type IconName } from "@agenteschat/ui";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ArtifactMoreMenu, useArtifactEntries } from "@/components/artifacts/ArtifactActions";
import { useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { entityMenu } from "@/lib/entity-menu";
import { DrivePreview } from "./DrivePreview";

/** Shift on a checkbox picks the range from the last pick, as Shift on a title does. */
const shiftRange = (e: MouseEvent<HTMLButtonElement>, a: Artifact, onPick: ItemProps["onPick"]) => {
  if (!e.shiftKey) return;
  e.preventDefault();
  onPick(a, e);
};

/** The kind's icon; uploaded files by their name (the list has no content type). */
export const itemIcon = (a: Pick<Artifact, "kind" | "title">): IconName =>
  a.kind === "file" ? fileIcon(a.title) : (KIND_ICON[a.kind as ArtifactKind] ?? "file");

export interface ItemProps {
  artifact: Artifact;
  /** Shown in the details panel. */
  open: boolean;
  selected: boolean;
  /** Where it came from: "#eng", "DM com Theo", "sem canal". */
  channelName: (a: Artifact) => string;
  /** A click: details, or selection with Shift / ⌘ / while selecting. Shift on a checkbox comes here too. */
  onPick: (a: Artifact, e: MouseEvent) => void;
  onToggle: (a: Artifact) => void;
  /** Straight to the viewer ("Abrir"; a double click goes there through the details it opens). */
  onOpen: (a: Artifact) => void;
}

/**
 * A grid card: the real preview, the kind (and version) on glass, the title,
 * who made it, where and when. The title's button stretches over the card;
 * the checkbox sits above it.
 */
export function DriveCard({
  artifact: a,
  open,
  selected,
  channelName,
  onPick,
  onToggle,
  onOpen,
  onDelete,
}: ItemProps & { onDelete: (a: Artifact) => void }) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(a.createdBy);
  const menu = useItemMenu(a, onOpen, onDelete);
  return (
    <>
      <article
        className={cx("drive-card", open && "drive-card--open", selected && "drive-card--selected")}
        data-kind={a.kind}
        {...menu.props}
      >
        <DrivePreview artifact={a} />
        <span className="drive-card__kind">
          <Icon name={itemIcon(a)} size={14} />
          <span>
            {t(`artifacts.kind.${a.kind}`)}
            {a.version > 1 && ` · ${t("artifacts.version", { version: a.version })}`}
          </span>
        </span>
        <div className="drive-card__body">
          <button
            type="button"
            className="drive-card__title drive-hit"
            aria-haspopup="dialog"
            onClick={(e) => onPick(a, e)}
          >
            {a.title}
          </button>
          <span className="drive-card__meta">
            <ActorAvatar size="xs" actor={a.createdBy} name={name} />
            <span className="drive-card__name">{name}</span>
            <span className="drive-card__where">{channelName(a)}</span>
            <time className="drive-card__when tabular" dateTime={a.updatedAt}>
              {relativeTime(t, i18n.language, a.updatedAt)}
            </time>
          </span>
        </div>
        <Checkbox
          className="drive-check"
          checked={selected}
          onCheckedChange={() => onToggle(a)}
          onClick={(e) => shiftRange(e, a, onPick)}
          aria-label={t("drive.select", { title: a.title })}
        />
      </article>
      {menu.dialog}
    </>
  );
}

/**
 * A card's or row's right click and menu key: the same actions as its "…", with open and download first. `dialog`
 * (its share dialog) goes beside the item, so the dialog's keys never reach the item's own.
 */
function useItemMenu(a: Artifact, onOpen: (a: Artifact) => void, onDelete: (a: Artifact) => void) {
  const entries = useArtifactEntries();
  const props = entityMenu(() => [
    { kind: "header", label: a.title },
    ...entries(a, { onOpen: () => onOpen(a), onDelete: () => onDelete(a), download: true }),
  ]);
  return { props, dialog: entries.dialog };
}

/** A list row: checkbox, small preview + title, who, where, when, "…". */
export function DriveRow({
  artifact: a,
  open,
  selected,
  channelName,
  onPick,
  onToggle,
  onOpen,
  onDelete,
}: ItemProps & { onDelete: (a: Artifact) => void }) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(a.createdBy);
  const when = relativeTime(t, i18n.language, a.updatedAt);
  const menu = useItemMenu(a, onOpen, onDelete);
  return (
    <>
      <li
        className={cx("drive-row", open && "drive-row--open", selected && "drive-row--selected")}
        data-kind={a.kind}
        {...menu.props}
      >
        <Checkbox
          className="drive-check"
          checked={selected}
          onCheckedChange={() => onToggle(a)}
          onClick={(e) => shiftRange(e, a, onPick)}
          aria-label={t("drive.select", { title: a.title })}
        />
        <span className="drive-row__name">
          <DrivePreview artifact={a} size="sm" />
          <span className="drive-row__text">
            <button
              type="button"
              className="drive-row__title drive-hit"
              aria-haspopup="dialog"
              onClick={(e) => onPick(a, e)}
            >
              {a.title}
            </button>
            <span className="drive-row__sub">
              <Icon name={itemIcon(a)} size={14} />
              <span className="drive-row__subtext">
                {t(`artifacts.kind.${a.kind}`)}
                {a.version > 1 && ` · ${t("artifacts.version", { version: a.version })}`}
                <span className="drive-row__mobile">{` · ${name} · ${when}`}</span>
              </span>
            </span>
          </span>
        </span>
        <span className="drive-row__who">
          <ActorAvatar size="xs" actor={a.createdBy} name={name} />
          <span>{name}</span>
        </span>
        <span className="drive-row__where">{channelName(a)}</span>
        <time className="drive-row__when tabular" dateTime={a.updatedAt}>
          {when}
        </time>
        <span className="drive-row__more">
          <ArtifactMoreMenu artifact={a} onOpen={() => onOpen(a)} onDelete={() => onDelete(a)} />
        </span>
      </li>
      {menu.dialog}
    </>
  );
}
