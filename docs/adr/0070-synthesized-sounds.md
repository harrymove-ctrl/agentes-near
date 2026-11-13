# 0070. Sounds synthesized in code, chosen per device

- Status: Proposed
- Date: 2026-10-26
- Code: `packages/ui/src/sfx/synth.ts` (`@agenteschat/ui/sfx`), `packages/client/src/lib/sounds.ts`, `apps/web/src/lib/sounds.ts`, `apps/mobile/src/lib/sounds.ts`

## Context

The apps had no sound. Haptics on the phone and the desktop app's notifications said that something happened, but nothing played when a message went out, an agent answered, an approval was waiting or a run was stopped.

Sounds could be recorded or generated as files, or computed. Generated sound effects were tried (a text-to-sound service) and rejected: they were vague, uneven in level, and every change meant generating, trimming and normalizing a file again. A service called at runtime was ruled out from the start, because the self-hosted server needs nothing but Postgres and a sound must play at once.

## Decision

1. **The sounds are computed.** `renderSound(style, name)` builds each sound sample by sample: band-limited oscillators, additive partials, envelopes, filtered noise and a small Schroeder room. The noise is seeded, so every platform and every render produce the same samples. The melodies use E major pentatonic, so any two notes go together.
2. **Eight sounds, three styles.** The sounds are `send`, `reply`, `done`, `attention`, `approved`, `error`, `stop` and `mention`. Each sound exists in every style. `tactile` (a dry marimba with the mallet's tick) is the default. `sky` is glass with a short room, and `pixel` a soft 8-bit pulse.
3. **The shared client names the sound; each app plays it.** `playSound` goes to the player the app set (`setSoundPlayer`), and without one it is silence. `usePostMessage` plays `send`. `useDecideApproval` plays `approved`, or `error` for a refusal, once the server confirms. Stopping a run plays `stop`. A notification that just arrived plays the sound for its kind (`soundForNotification`), once per group, never for a read or done one. With the app in the background, only what matters plays: something waiting on the person, a mention, or work that finished or failed.
4. **Web and desktop app:** Web Audio, rendered once per sound and kept, at a low volume. Audio starts with the person's first click or key; before that nothing plays, because a late sound is worse than none. With the app open in several tabs, only the tab the person used last plays what arrives while hidden.
5. **Phone app:** the samples become WAV files in the cache, made shortly after start and again only if the system clears them (`VERSION` in the file name changes them when the synth changes). They play through `expo-audio`, mixed with the person's music, and stay silent in silent mode. In the background the push notification speaks instead.
6. **The choice belongs to the device**, like the theme and the language: a style or off, kept in local storage. On the web it is a row in the account menu; on the phone it is Você › Sons. Picking a style plays a sample of it.

## Consequences

- No audio file is in the repository and no service is involved. A sound changes by editing its numbers, and the tests check that every sound is finite, short, below full scale and silent at both ends.
- `expo-audio` is a native module, so the phone app needs a new build before the sounds play there.
- Rendering costs a few milliseconds per sound on the web (once) and more on the phone (once per style, one sound per tick).
- Push notifications on the phone keep the system sound. A custom push sound would need the files bundled into the app, which is left for later.
