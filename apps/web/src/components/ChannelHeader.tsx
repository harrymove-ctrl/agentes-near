import type { Agent, Channel, Member } from "@agenteschat/client";
import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ChannelPinsButton } from "@/components/ChannelPins";
import { QueueButton } from "@/components/ComputerQueue";
import { useChannelMenu } from "@/components/entity-menus";
import { NavToggle } from "@/components/NavDrawer";
import { HeaderSearch } from "@/components/search/HeaderSearch";
import { ChannelThreadsButton } from "@/components/threads/ThreadLines";
import { entityMenu } from "@/lib/entity-menu";
import "./channel-header.css";

/**
 * A channel's header, as Discord's: `#` and the name, the topic beside it while it fits whole, then icon buttons
 * (threads with their count, pins, the channel's settings, members) and the workspace search.
 */
export function ChannelHeader({
  channel,
  isMember,
  queueMachine,
  people,
  agents,
  onDetails,
  onSearch,
  membersOpen,
  onMembers,
}: {
  channel: Channel;
  isMember: boolean;
  /** The computer the channel's agents share: who waits in line for it shows first. */
  queueMachine: string | null;
  people: Member[];
  agents: Agent[];
  /** The cog: the channel's details dialog (description, members, archive…). */
  onDetails: () => void;
  /** Enter in the search: its results in the panel. */
  onSearch: () => void;
  /** The members column (a sheet on a phone) is showing. */
  membersOpen: boolean;
  onMembers: () => void;
}) {
  const { t } = useTranslation();
  const channelEntries = useChannelMenu();
  const settings = t("shell.sidebarMenu.channelSettings");
  const total = people.length + agents.length;
  return (
    <header className="channel__header">
      <NavToggle />
      <div className="ac-actline channel__line">
        <div className="channel__head-text" {...entityMenu(() => channelEntries(channel))}>
          <h1 className="channel__title">
            <Icon name="channel" className="channel__title-hash" />
            <span>{channel.name}</span>
          </h1>
          {channel.topic && (
            <span className="channel__topic">
              <span>{channel.topic}</span>
            </span>
          )}
        </div>
        <div className="channel__acts">
          <QueueButton machineId={queueMachine} />
          {isMember && <ChannelThreadsButton channelId={channel.id} channelName={channel.name} />}
          {isMember && <ChannelPinsButton channelId={channel.id} channelName={channel.name} />}
          <button
            type="button"
            className="ac-btn ac-btn--ghost ac-btn--icon channel__icon channel__cog"
            aria-label={settings}
            title={settings}
            onClick={onDetails}
          >
            <Icon name="cog" />
          </button>
          {total > 0 && (
            <button
              type="button"
              className="ac-btn ac-btn--ghost ac-btn--icon channel__icon channel__members-toggle"
              aria-label={t("channel.membersButton", { count: total })}
              aria-pressed={membersOpen}
              title={t(membersOpen ? "channel.header.hideMembers" : "channel.header.showMembers")}
              onClick={onMembers}
            >
              <Icon name="members" />
            </button>
          )}
          {isMember && <HeaderSearch channelId={channel.id} onOpen={onSearch} />}
        </div>
      </div>
    </header>
  );
}
