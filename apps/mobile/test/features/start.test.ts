import { describe, expect, test } from "bun:test";
import { chatChannelOf, inConversation, placesOf, startHref, withPlace } from "../../src/features/me/logic";

/** What opens when the app starts on the phone (ADR 0108): pushed over Conversas, or Conversas itself (null). */
describe("the phone's start", () => {
  // As the app reads them: `GET /channels` lists channels only (a DM never), `GET /dms` my DMs.
  const channels = [
    { id: "c-eng", isMember: true },
    { id: "c-left", isMember: false },
  ];
  const mine = inConversation(channels, [{ channelId: "c-dm" }]);
  const places = withPlace(withPlace(null, "org-1", "/chat/c-dm"), "org-2", "/chat/c-eng?thread=t-1");

  test("Conversas by default; the chosen channel while I'm in it", () => {
    expect(startHref(undefined, places, "org-1", mine)).toBeNull();
    expect(startHref({ page: "home", channelId: null }, places, "org-1", mine)).toBeNull();
    expect(startHref({ page: "channel", channelId: "c-eng" }, places, "org-1", mine)).toBe("/chat/c-eng");
    expect(startHref({ page: "channel", channelId: "c-left" }, places, "org-1", mine)).toBeNull();
  });

  test("where I left off: this workspace's last conversation on this phone, a DM too, while I'm still in it", () => {
    const last = { page: "last" as const, channelId: null };
    expect(startHref(last, places, "org-1", mine)).toBe("/chat/c-dm");
    expect(startHref(last, places, "org-2", mine)).toBe("/chat/c-eng?thread=t-1");
    expect(startHref(last, places, "org-3", mine)).toBeNull();
    expect(startHref(last, places, "org-1", inConversation(channels, []))).toBeNull();
    expect(startHref(last, null, "org-1", mine)).toBeNull();
  });

  test("the places kept: one per workspace, the newest wins, anything unreadable is none", () => {
    expect(placesOf(withPlace(places, "org-1", "/chat/c-eng"))).toEqual({
      "org-1": "/chat/c-eng",
      "org-2": "/chat/c-eng?thread=t-1",
    });
    expect(placesOf("not json")).toEqual({});
    expect(placesOf(null)).toEqual({});
    expect(chatChannelOf("/chat/c-eng?thread=t-1")).toBe("c-eng");
    expect(chatChannelOf("/agent/a-1")).toBeNull();
  });
});
