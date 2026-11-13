/**
 * "Editar canal" and "Adicionar pessoas ou agentes" from outside the channel's page (the sidebar's right click and its
 * rows' hover buttons): the page opens its details, or goes straight to adding members, when it shows that channel,
 * now or once it mounts after the navigation.
 */
const EVENT = "agentes:channel-details";
export type ChannelDetailsAsk = "details" | "add";
let pending: { channelId: string; ask: ChannelDetailsAsk } | null = null;

export function requestChannelDetails(channelId: string, ask: ChannelDetailsAsk = "details") {
  pending = { channelId, ask };
  window.dispatchEvent(new CustomEvent(EVENT, { detail: channelId }));
}

/** What was asked for this channel, once (the page then opens its details); null otherwise. */
export function takeChannelDetails(channelId: string): ChannelDetailsAsk | null {
  if (pending?.channelId !== channelId) return null;
  const { ask } = pending;
  pending = null;
  return ask;
}

export function onChannelDetails(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
