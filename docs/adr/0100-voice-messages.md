# 0100. Voice messages

- Status: Accepted
- Date: 2026-10-31
- Code: `packages/adapters/src/speech.ts`, `packages/engine/src/speech-settings.ts`, `packages/engine/src/voice.ts`, `packages/db/src/schema/voice.ts`, `apps/server/src/routes/app/voice.ts`, `deploy/speech/server.py`

## Context

People want to talk to agents, on the web, the desktop and the phone. Models take text, not audio. To the person it should feel like sending audio; turning it into text is an internal step.

## Decision

### 1. The message is the audio; the agent reads its words

We keep the recording and the apps show a wave and a player. The words go in `messages.body`, so routing, mentions, context, memory and search work as for any message, and `meta.voice` (`clipId`, `durationMs`, `peaks`, `expiresAt`, `noWords`) says it is a voice message.

### 2. Words only in the message itself: one line under the wave, the rest on request

On the message itself, one line of the words sits under the wave, in the player's card, and opens in full there; they come from `message.body`, so they stay in the API. Everywhere a message is listed, they don't appear: channel and DM previews, thread titles and excerpts, notifications, push, quotes and search snippets go through `readableBody` and say "voice message" in the reader's language (`mediaKind: "voice"`). A voice message is found by its words and shown as its audio. When no engine could make out the words, `body` holds a placeholder for the agent and `meta.voice.noWords` is true, so the apps never offer it as text.

### 3. One interface, swappable engines

`SpeechEngine` is a small adapter per provider: AssemblyAI, ElevenLabs, Soniox, and the OpenAI format for OpenAI, Groq and a server of one's own. Engines are tried in order (`SPEECH_ENGINES`), the next one taking over when one fails. The workspace's names (agents, people, channels) go with every call, so nobody keeps a vocabulary list. With no engine, the microphone stays hidden and the server still needs only Postgres.

A server of one's own is told more than a provider ever is: the workspace each recording comes from (`X-Agentes-Org`), so one server can route or count by workspace, and, with `LOCAL_SPEECH_WARM=on`, that someone is about to record (`POST /warm` when the app asks whether it may), so a model loaded on demand is ready when the recording arrives. Every server of the OpenAI format gets half a minute plus twice the recording's length to answer; past that it counts as busy and the next engine tries.

The key is the server's, not the workspace's. On agentes.chat's servers it comes from the environment and nobody chooses. Elsewhere the installation's owner may also pick a provider and paste its key in Settings, kept like the Jev key (ADR 0073): sealed, tried with a second of silence before it is stored, never returned.

### 4. The finished recording first

The app sends the finished recording and shows it at once. The server stores it, answers, and a job (`voice.transcribe`) gets the words and posts the message through `postPersonMessage`, so what was said survives a closed app or a provider's bad minute, and a resend with the same `clientId` writes nothing new. It is also the only path that needs no new native module on the phone. Nothing said drops the recording and tells its sender (`voice.dropped`). After every try fails, the message still goes, as audio people can hear.

Streaming audio while the person speaks would make the words ready on release. It is left for later, as another method on `SpeechEngine` next to `file`.

### 5. Recordings as they came

The server stores the app's recording as is, with no transcoding, so it needs no encoder in the image. Only audio types are accepted, since they are served back from our own address.

### 6. Outside the Drive

A recording is part of its message, so it lives in `voice_clips` on the workspace's storage (`BlobStoreResolver`), not in `artifacts`. Who can read the channel can play it. It counts in `storedBytes` and moves in a storage migration.

### 7. Fair use, invisible

On agentes.chat's servers only: a person and a workspace have a number of minutes in a rolling 24 hours (`VOICE_LIMIT_*`, 60 per person; 20 per member, at least 300, per workspace; 0 turns one off). It is checked before a recording starts and when it arrives, never cutting one short. Nobody sees a counter or a price. It is counted from `voice_clips`, not `usage_records`, so nothing reaches the Usage screens. A self-hosted server has no limit.

### 8. Recordings expire

`VOICE_RETENTION_DAYS` (default 90; 0 keeps them forever) applies on every server, so storage doesn't fill up. A daily sweep deletes the audio in pages and sets `voice_clips.audio_deleted_at`. The row stays, as fair use counts it, and so does the message with its words. A recording waiting for its words never expires. The audio route answers 410 `voice.expired` for a swept recording or one past its date; swept recordings leave `storedBytes` and aren't copied by a storage migration. `meta.voice.expiresAt` is written when the message is posted, so a later change of the setting applies on the server but doesn't rewrite that date.

## Consequences

- Recordings hold people's voices and go to the chosen provider; `SELF_HOSTING.md` says so, and a server of one's own keeps them in.
- Agents aren't told yet that a message was spoken: a change to their prompt needs an eval first.

## Addendum (2026-11-07): Parakeet on our own server, the language heard in the audio

**The decision.** agentes.chat's Cloud turns voice into text on its own production server: NVIDIA's Parakeet TDT 0.6B v3
(int8, on ONNX Runtime) in the compose file's `speech` profile (`deploy/speech`), with `SPEECH_ENGINES=local,deepinfra`.
When that service is busy, down, or not for the language spoken, DeepInfra's `whisper-large-v3-turbo` takes the
recording, the cheapest hosted engine (below). No model runs on the workspaces' computers, which are the agents' to work
on. Published measurements on 2 vCPUs give Parakeet about 6 s per minute of audio, about 3 s end to end for a short
note, and 1.2 to 1.8 GB of memory; our own server's numbers come from a benchmark run there.

**DeepInfra after our server.** The engines are assemblyai, elevenlabs, soniox, groq, openai, local and deepinfra, and
with `SPEECH_ENGINES` empty every one with a key is tried in that order. DeepInfra (`DEEPINFRA_API_KEY`) speaks the
OpenAI format (`https://api.deepinfra.com/v1/openai`) and runs the same Whisper as Groq (`openai/whisper-large-v3-turbo`)
for $0.012 an audio hour, billed by the second, where Groq asks $0.04 and bills 10 s at least. A test with a real key
turned a 4.4 s Portuguese note into the right words in 1.8 s, for $0.0000146, about 7.6 times less than Groq bills for
it, and past 10 s DeepInfra costs 3.3 times less. Groq can still follow it (`SPEECH_ENGINES=local,deepinfra,groq`) for
the minutes DeepInfra is busy.

**The language comes from the audio.** The apps send their interface language, and someone with the app in English may
speak Portuguese. Engines that detect the language themselves (Groq, DeepInfra, OpenAI, AssemblyAI, ElevenLabs and our
own server) no longer get it: Whisper takes `language` as an order, so the words came out wrong or translated. Soniox
still gets it, as `language_hints`, which is a hint. Our server never reads it: Whisper tiny guesses the language from
the first 30 s, and when the shares of Parakeet's 25 European languages add up to `SPEECH_LANGUAGE_MIN` (0.7) or
more, Parakeet transcribes; it detects which of them by itself. Anything else, or a guess that unsure, answers 422
`unsupported_language`, which the adapter reads as `refused`: the next engine tries at once, in the same attempt, and
with no next engine the message goes out as audio with no words, as for any refusal. A recording with no signal at all
(a muted microphone, the silent second a key test sends) has no words and runs no model. Parakeet hearing no words in
one that has sound answers 422 `no_words` the same way, since the core drops a recording whose words are empty as
silent, and a slip of ours must not lose a message. The core gives up on a recording only when every engine refused
it: an earlier engine that was busy still earns a retry, whatever the order. Parakeet takes no prompt, so the
workspace's names don't steer it as they steer Whisper.

**The overflow.** The service runs `SPEECH_WORKERS` recordings at once (2) on `SPEECH_THREADS` threads each (2; one
alone gets them all), within `SPEECH_CPUS` (4) and `SPEECH_MEMORY` (4 GB). Up to `SPEECH_QUEUE` (4) more wait, each at
most `SPEECH_WAIT_SECONDS` (3); past that, or past the queue, it answers 503 and the next engine takes the recording,
so nothing waits behind a long one. A server that answers 500, or nothing within half a minute plus twice the
recording, counts as busy the same way. When the next engine fails too, the job retries as before.

**Optional, everywhere.** The service is on an internal network the app alone reaches, so the audio never leaves the
machine, and the image carries its models, pinned by revision and sha256 (`deploy/speech/models.txt`, credits in
`deploy/speech/NOTICE`). `deploy/deploy.sh` builds and starts it after the app is live and never waits for it, so a
speech image that doesn't build or a service that doesn't start never holds a deploy or a rollback; a build gets 15
minutes at most. Models that don't load leave the service up, unhealthy and answering 503, rather than restarting to
load the same files again on a machine it shares. A release whose speech image doesn't build publishes the app without
it. Self-hosted servers turn on the same profile, with the image each release publishes (SELF_HOSTING.md, Voice
messages).
