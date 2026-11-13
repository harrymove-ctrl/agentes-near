# 0140. Back to the latest messages

- Status: Accepted (built: the shared client, the web and the phone app)
- Date: 2026-11-04
- Code: client `lib/chat.ts` (`screenAboveEnd`), `lib/unread.ts` (`badgeCount`); web `components/ToLatest.tsx`, `chat/unseen.ts` (`unseenOf` with `mentionsMe`, `pillParts`), `pages/ChannelPage.tsx`, `layout.css` (`.channel__latest*`); phone `features/chat/ChatScreen.tsx` (`ToLatest`), `features/chat/scroll.ts` (`Unseen.mentionsMe`), `ui/Count.tsx` (`fill`)

## Context

Reading above the end of a conversation, the web showed a way back only when something new arrived: a "↓ 2 novas · Marina e Ada" pill centred above the composer. With nothing new there was no way back but scrolling. The phone had a small round button above the composer when nothing was new, and the same pill when something was. People asked for one round button with a down arrow, as other chat apps have.

## Decision

1. **One round button, bottom right.** A fully round icon button (`Button` with the `arrowDown` icon, web; the `down` icon, phone) at the bottom right of the message list, right above the composer and its working bar (never over them), clear of the members column and the scrollbar. On the web it follows the list in the page (`.channel__latest`, before `.channel__composer`), so it rises from the list's bottom edge; on the phone it rides the keyboard with the composer (a `KeyboardStickyView` at the composer's height). It was first at the top right, under the header; people looked for it at the bottom, where the newest messages are, as in other chat apps. It replaces the "↓ novas" pill on both platforms; "Fim da resposta" (a long answer held at its start) stays, since it says something the button doesn't.
2. **When it shows.** More than one screen of conversation below what is on screen (`screenAboveEnd(distance, viewport)`), or something new arrived below while the person reads above (a message, or an agent writing out of view), on the web whatever the distance. On the phone also while a long message is held at its start. It fades in and out; reduced motion keeps only the fade.
3. **What it says.** A count of the messages that arrived below (99+ past 99, `badgeCount`), red when one of them @mentions the person (as the sidebar's mention count), ink otherwise. The accessible label is "Ir para as mensagens mais recentes", followed by who spoke, who is writing and "mencionaram você" when that applies; hidden, it is out of the tab order and of the accessibility tree.
4. **What a click does.** It glides to the end (at once with reduced motion) and marks read as reaching the end by scrolling does: the hold ends, the count clears, the "Novas" divider fades a little later. It never lands on the divider; the web's catch-up while the person is away (no gesture for a while, or the window elsewhere) still lands on it when it is far, as before.
5. **Everywhere a conversation scrolls.** Channels, DMs, threads (page and side panel) and conversations opened at a message (`?m=`, search results) share `ChannelPage` on the web and `ChatScreen` on the phone, so the button is in all of them.

## Consequences

- The pill's faces (avatars of who spoke) are gone; the names are in the button's label.
- The phone's divider-landing helper (`landsOnDivider`) had no other caller and was removed.
- Copy: `channel.toLatest`, `channel.newPill.mentionsYou` and the new `channel.newPill.label` on the web, `chat.toLatestNew` and `chat.unseen.mentionsYou` on the phone, in the 14 languages; `channel.newMessages` became `channel.toLatest`.
