#!/usr/bin/env python3
from __future__ import annotations
"""
Agentes NEAR Phase 6 Multi-Voice V-Drill Audio Pipeline (60 FPS, -14 LUFS).

Compositions:
  - AgentesNearDemo:    90.0s = 5400 frames @ 60 FPS
  - AgentesNearXTeaser: 30.0s = 1800 frames @ 60 FPS

Voices (100% English, 0 Vietnamese speech):
  - alex   : en-US-AndrewMultilingualNeural (+4%)  ALEX · FOUNDER
  - ada    : en-US-AvaMultilingualNeural    (+5%)  ADA · 1CLICK QUANT
  - kronos : en-US-BrianMultilingualNeural  (+3%)  KRONOS · OUTLAYER TDX

Narration: 8 concise 1-sentence English demo cues (~32s total speech),
           2 concise English teaser voiceovers.

Beat: V-Drill Dan Tranh + Sao Truc + sliding 808 + tresillo hi-hat (118 BPM).
      Sidechain-ducked smoothly to -14 LUFS. Exact flyover foley (whooshes /
      hits / comic silence) matched to ActLandingFlyover3D segment timestamps.

Demo foley (absolute seconds in 90s timeline):
  ActShowreel15s  0..15s:
    whoosh at 0.0, pop at 7.5
  ActLandingFlyover3D 15..29.5s (Act 2, offset +15s from its own 14.5s):
    whoosh at 15+8.66 = 23.66s  (matches Act2 internal 8.66s)
    whoosh at 15+9.80 = 24.80s
    hit    at 15+9.97 = 24.97s
    comic-silence cut at 15+4.6 = 19.6s (Act3 internal 4.6s, -foley only)
  Remaining acts 29.5..90s: standard spaced foley
"""

import asyncio
import base64
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

# Auto-bootstrap edge_tts via uvx when ELEVENLABS_API_KEY is unset
if not os.environ.get("ELEVENLABS_API_KEY", "").strip() and not os.environ.get("_AGENTES_UVX_BOOTSTRAPPED"):
    try:
        import edge_tts  # type: ignore # noqa: F401
    except ImportError:
        uvx_bin = shutil.which("uvx") or str(Path.home() / ".local" / "bin" / "uvx")
        if Path(uvx_bin).exists():
            env = dict(os.environ)
            env["_AGENTES_UVX_BOOTSTRAPPED"] = "1"
            os.execve(
                uvx_bin,
                [uvx_bin, "--from", "edge-tts", "python3", str(Path(__file__).resolve()), *sys.argv[1:]],
                env,
            )

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "public" / "audio"
MANIFEST_PATH = ROOT / "src" / "scene-manifest.json"
FPS = 60
SAMPLE_RATE = 44100

VOICES = {
    "alex": {
        "id": "alex",
        "label": "ALEX · FOUNDER",
        "role": "Founder Host",
        "accent": "#00EC97",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_ALEX", "nPczCjzI2devNBz1zQrb").strip(),
        "edge_voice": "en-US-AndrewMultilingualNeural",
        "edge_rate": "+4%",
        "say_voice": "Reed",
    },
    "ada": {
        "id": "ada",
        "label": "ADA · 1CLICK QUANT",
        "role": "@ada · 1Click Quant Agent",
        "accent": "#38BDF8",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_ADA", "cgSgspJ2msm6clMCkdW9").strip(),
        "edge_voice": "en-US-AvaMultilingualNeural",
        "edge_rate": "+5%",
        "say_voice": "Samantha",
    },
    "kronos": {
        "id": "kronos",
        "label": "KRONOS · OUTLAYER TDX",
        "role": "@kronos · OutLayer TDX Guard",
        "accent": "#F59E0B",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_KRONOS", "cjVigY5qzO86Huf0OWal").strip(),
        "edge_voice": "en-US-BrianMultilingualNeural",
        "edge_rate": "+3%",
        "say_voice": "Reed",
    },
}

# ---------------------------------------------------------------------------
# 90.0s (5,400 frames @ 60 FPS) Visual Blocks
# ---------------------------------------------------------------------------
# Act layout (@ 60fps):
#   Act 1: ActShowreel15s       0..900f   (15.0s)
#   Act 2: ActLandingFlyover3D  900..1770f (14.5s)
#   Act 3: Act2Yapp (8.0s)      1770..2250f
#   Act 4: Act3Cutline (12.0s)  2250..2970f
#   Act 5: Act4Fitting (15.0s)  2970..3870f
#   Act 6: Act5Graph (9.0s)     3870..4410f
#   Act 7: Act6Molote (11.0s)   4410..5070f
#   Act 8: Act7OneLockup (5.5s) 5070..5400f

DEMO_VISUALS = [
    {"id": "v_act1_showreel", "chapter": 1, "chapter_title": "Ch 1 · 15s Motion Showreel", "kind": "act", "act": "showreel", "start_frame": 0, "duration_frames": 900},
    {"id": "v_act2_flyover",  "chapter": 2, "chapter_title": "Ch 2 · 14.5s 3D Studio Page Fly-Over", "kind": "act", "act": "flyover", "start_frame": 900, "duration_frames": 870},
    {"id": "v_act3_yapp",     "chapter": 3, "chapter_title": "Ch 3 · 8s Viral 99K Intent Counter",   "kind": "act", "act": 2, "start_frame": 1770, "duration_frames": 480},
    {"id": "v_act4_cutline",  "chapter": 4, "chapter_title": "Ch 4 · 12s Intent Engine Node Graph",  "kind": "act", "act": 3, "start_frame": 2250, "duration_frames": 720},
    {"id": "v_act5_fitting",  "chapter": 5, "chapter_title": "Ch 5 · 15s One Slack Showcase",        "kind": "act", "act": 4, "start_frame": 2970, "duration_frames": 900},
    {"id": "v_act6_graph",    "chapter": 6, "chapter_title": "Ch 6 · 9s @ada 5-Node Tool Hub",       "kind": "act", "act": 5, "start_frame": 3870, "duration_frames": 540},
    {"id": "v_act7_molote",   "chapter": 7, "chapter_title": "Ch 7 · 11s OutLayer TDX Zine Drop",    "kind": "act", "act": 6, "start_frame": 4410, "duration_frames": 660},
    {"id": "v_act8_lockup",   "chapter": 8, "chapter_title": "Ch 8 · 5.5s ONE Workspace Finale",     "kind": "act", "act": 7, "start_frame": 5070, "duration_frames": 330},
]

# ---------------------------------------------------------------------------
# 8 concise 1-sentence English demo cues (~32s total speech across 90.0s)
# Frames @ 60fps. No Vietnamese, no mira_vi.
# ---------------------------------------------------------------------------
DEMO_UTTERANCES = [
    # Act 1: Showreel (0..900f = 0..15s)
    {
        "id": "u01_alex_hook",
        "chapter": 1,
        "speaker": "alex",
        "start_frame": 120,
        "duration_frames": 420,
        "voice_offset_sec": 0.18,
        "step_badge": "CH 01 · THE HOOK",
        "text": "Welcome to Agentes NEAR: one self-hosted Slack where your engineering team and six specialized NEAR AI agents collaborate across live protocol surfaces.",
        "caption": "Agentes NEAR: one Slack for teams and 6 NEAR AI agents across live protocol surfaces.",
    },
    # Act 2: Flyover (900..1770f = 15..29.5s)
    {
        "id": "u02_ada_flyover",
        "chapter": 2,
        "speaker": "ada",
        "start_frame": 1020,
        "duration_frames": 480,
        "voice_offset_sec": 0.20,
        "step_badge": "CH 02 · OCELLI WORKSPACE",
        "text": "Three-column Ocelli dark-glass workspace: judge sign-in in one click, six live protocol channels on the left, and real-time solver quotes in the right inspector rail.",
        "caption": "3-col Ocelli: 1-click judge sign-in, 6 protocol channels, live solver quotes inspector.",
    },
    # Act 3: Yapp 99K (1770..2250f = 29.5..37.5s)
    {
        "id": "u03_kronos_99k",
        "chapter": 3,
        "speaker": "kronos",
        "start_frame": 1860,
        "duration_frames": 360,
        "voice_offset_sec": 0.18,
        "step_badge": "CH 03 · 99K INTENTS",
        "text": "Ninety-nine thousand NEAR intents routed in Slack: 1Click Chaindefuser beats Wintermute by sixteen basis points and settles in twenty-two seconds.",
        "caption": "99,412 intents routed: 1Click beats Wintermute +16 bps, settled in 22s.",
    },
    # Act 4: Cutline (2250..2970f = 37.5..49.5s)
    {
        "id": "u04_ada_cutline",
        "chapter": 4,
        "speaker": "ada",
        "start_frame": 2370,
        "duration_frames": 480,
        "voice_offset_sec": 0.20,
        "step_badge": "CH 04 · INTENT ENGINE",
        "text": "NEAR Intents 1Click cross-chain solver auctions: prompt Ada in-channel, watch competing solvers bid, and receive three-fifty-eight wNEAR with a signed NEP-two-nine-seven receipt in twenty-two seconds.",
        "caption": "1Click: prompt in-channel, solvers compete, 358.1357 wNEAR settled in 22s with NEP-297 receipt.",
    },
    # Act 5: Fitting (2970..3870f = 49.5..64.5s)
    {
        "id": "u05_alex_fitting",
        "chapter": 5,
        "speaker": "alex",
        "start_frame": 3090,
        "duration_frames": 540,
        "voice_offset_sec": 0.22,
        "step_badge": "CH 05 · ONE SLACK",
        "text": "One self-hosted Slack: mention Ada, Kronos, Theo, Lia, Mira, or Zen to route swaps, audit Intel TDX spend caps, and render motion videos from a single channel.",
        "caption": "One Slack: @ada, @kronos, @theo, @lia, @mira, @zen — swap, audit TDX, render motion.",
    },
    # Act 6: Graph (3870..4410f = 64.5..73.5s)
    {
        "id": "u06_ada_graph",
        "chapter": 6,
        "speaker": "ada",
        "start_frame": 3960,
        "duration_frames": 360,
        "voice_offset_sec": 0.18,
        "step_badge": "CH 06 · ADA 5-NODE HUB",
        "text": "Ada's five-node tool hub self-funds via a two-hundred-fifty-thousand-dollar Corpus Endowment, streams H100 TEE compute at one-eighty-four an hour, and enforces OutLayer TDX spend caps on every intent.",
        "caption": "@ada 5-node hub: $250K Endowment funds H100 TEE at $1.84/hr, OutLayer TDX caps every intent.",
    },
    # Act 7: Molote OutLayer TDX (4410..5070f = 73.5..84.5s)
    {
        "id": "u07_kronos_tdx",
        "chapter": 7,
        "speaker": "kronos",
        "start_frame": 4500,
        "duration_frames": 420,
        "voice_offset_sec": 0.18,
        "step_badge": "CH 07 · OUTLAYER TDX GUARD",
        "text": "OutLayer Intel TDX hardware enclave: a twelve-dollar intent signs in four milliseconds; a forty-five-dollar rogue drain is deterministically blocked and sealed with Kyvera ML-DSA-sixty-five post-quantum proof.",
        "caption": "OutLayer TDX: $12 safe intent in 4ms, $45 rogue drain blocked + Kyvera ML-DSA-65 PQ.",
    },
    # Act 8: Lockup finale (5070..5400f = 84.5..90s)
    {
        "id": "u08_alex_cta",
        "chapter": 8,
        "speaker": "alex",
        "start_frame": 5130,
        "duration_frames": 240,
        "voice_offset_sec": 0.16,
        "step_badge": "ONE WORKSPACE · 13 TRACKS",
        "text": "Agentes NEAR: MIT open source, thirteen NEAR tracks live at slash ocelli today.",
        "caption": "Agentes NEAR · MIT License · 13 NEAR Tracks · /ocelli · github.com/harrymove-ctrl/agentes-near",
    },
]

# ---------------------------------------------------------------------------
# 30.0s (1,800 frames @ 60 FPS) X Launch Teaser Visuals + 2 English Voiceovers
# ---------------------------------------------------------------------------
TEASER_VISUALS = [
    {"id": "tv_1", "chapter": 1, "chapter_title": "15s Motion Showreel", "kind": "act", "act": "showreel", "start_frame": 0, "duration_frames": 900},
    {"id": "tv_2", "chapter": 2, "chapter_title": "15s 3D Fly-Over",      "kind": "act", "act": "flyover",  "start_frame": 900, "duration_frames": 900},
]

TEASER_UTTERANCES = [
    {
        "id": "tu01_alex_hook",
        "chapter": 1,
        "speaker": "alex",
        "start_frame": 120,
        "duration_frames": 480,
        "voice_offset_sec": 0.16,
        "step_badge": "TEASER HOOK",
        "text": "Agentes NEAR: your engineering team and six autonomous NEAR AI agents together in one self-hosted Slack.",
        "caption": "Agentes NEAR: team + 6 NEAR AI agents in one self-hosted Slack.",
    },
    {
        "id": "tu02_ada_cta",
        "chapter": 2,
        "speaker": "ada",
        "start_frame": 1020,
        "duration_frames": 540,
        "voice_offset_sec": 0.18,
        "step_badge": "TEASER CTA",
        "text": "Three-column Ocelli workspace, 1Click solver auctions, OutLayer Intel TDX spend caps, and thirteen NEAR hackathon tracks open source today.",
        "caption": "Ocelli workspace, 1Click auctions, OutLayer TDX caps, 13 NEAR tracks — open source today.",
    },
]


# ---------------------------------------------------------------------------
# Audio synthesis helpers (unchanged from Phase 5, unchanged provider chain)
# ---------------------------------------------------------------------------

def _words_from_elevenlabs_alignment(alignment: dict, text: str) -> list[dict]:
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    if not chars or len(chars) != len(starts) or len(chars) != len(ends):
        return []
    words: list[dict] = []
    cur_chars: list[str] = []
    w_start = 0.0
    w_end = 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if cur_chars:
                words.append({"word": "".join(cur_chars), "start": round(float(w_start), 3), "end": round(float(w_end), 3)})
                cur_chars = []
        else:
            if not cur_chars:
                w_start = float(s)
            cur_chars.append(ch)
            w_end = float(e)
    if cur_chars:
        words.append({"word": "".join(cur_chars), "start": round(float(w_start), 3), "end": round(float(w_end), 3)})
    return words


def synth_clip_elevenlabs(text: str, out_mp3: Path, api_key: str, voice_id: str) -> tuple[bool, list[dict]]:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    payload = json.dumps({
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.46, "similarity_boost": 0.82, "style": 0.18, "use_speaker_boost": True},
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload,
        headers={"xi-api-key": api_key, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        audio_b64 = body.get("audio_base64", "")
        if not audio_b64:
            return False, []
        out_mp3.write_bytes(base64.b64decode(audio_b64))
        words = _words_from_elevenlabs_alignment(body.get("alignment") or {}, text)
        return out_mp3.exists() and out_mp3.stat().st_size > 500, words
    except Exception as exc:
        print(f"[voice] ElevenLabs notice ({exc}); using studio neural voice.")
        return False, []


async def _edge_tts_synth_async(text: str, voice_name: str, rate: str, out_mp3: Path, boundary: str | None = "WordBoundary") -> list[dict]:
    import edge_tts  # type: ignore
    kwargs: dict = {"rate": rate}
    if boundary:
        kwargs["boundary"] = boundary
    communicate = edge_tts.Communicate(text, voice_name, **kwargs)
    words: list[dict] = []
    audio_chunks = bytearray()
    async for chunk in communicate.stream():
        ctype = chunk.get("type")
        if ctype == "audio":
            audio_chunks.extend(chunk["data"])
        elif ctype == "WordBoundary":
            start_s = float(chunk["offset"]) / 10_000_000.0
            dur_s = float(chunk["duration"]) / 10_000_000.0
            words.append({"word": str(chunk["text"]), "start": round(start_s, 3), "end": round(start_s + max(0.04, dur_s), 3)})
    out_mp3.write_bytes(bytes(audio_chunks))
    return words


def synth_clip_edge_neural(text: str, out_wav: Path, tmp_dir: Path, speaker_cfg: dict) -> tuple[bool, list[dict]]:
    try:
        import edge_tts  # type: ignore # noqa: F401
    except ImportError:
        return False, []
    mp3_path = tmp_dir / f"{out_wav.stem}_edge.mp3"
    attempts = [
        ("WordBoundary", speaker_cfg["edge_rate"]),
        ("SentenceBoundary", speaker_cfg["edge_rate"]),
        (None, "+0%"),
    ]
    last_exc: Exception | None = None
    for attempt_idx, (boundary_mode, rate_val) in enumerate(attempts):
        try:
            if attempt_idx > 0:
                time.sleep(0.35 * attempt_idx)
            if mp3_path.exists():
                mp3_path.unlink()
            words = asyncio.run(_edge_tts_synth_async(text=text, voice_name=speaker_cfg["edge_voice"],
                rate=rate_val, out_mp3=mp3_path, boundary=boundary_mode))
            if not mp3_path.exists() or mp3_path.stat().st_size < 400:
                continue
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3_path),
                "-af", "highpass=f=80,equalizer=f=3200:width_type=q:w=1.2:g=1.5,acompressor=threshold=-19dB:ratio=2.2:attack=8:release=110",
                "-ar", str(SAMPLE_RATE), "-ac", "2", str(out_wav),
            ], check=True)
            if not words:
                words = _proportional_words(text, probe_duration(out_wav))
            time.sleep(0.15)
            return True, words
        except Exception as exc:
            last_exc = exc
            continue
    print(f"[voice] edge-tts notice ({last_exc}); falling back to macOS say.")
    return False, []


def _proportional_words(text: str, dur: float) -> list[dict]:
    tokens = [t for t in text.split() if t]
    if not tokens:
        return []
    weights = [max(1, len(t)) for t in tokens]
    total_w = sum(weights)
    cursor = 0.0
    out: list[dict] = []
    usable = max(0.3, dur - 0.08)
    for tok, w in zip(tokens, weights):
        span = usable * (w / total_w)
        out.append({"word": tok, "start": round(cursor, 3), "end": round(cursor + span * 0.92, 3)})
        cursor += span
    return out


def synth_clip_macos_say(text: str, out_wav: Path, tmp_dir: Path, speaker_cfg: dict) -> list[dict]:
    aiff_path = tmp_dir / f"{out_wav.stem}.aiff"
    subprocess.run(["say", "-v", speaker_cfg["say_voice"], "-r", "184", "-o", str(aiff_path), text], check=True)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff_path),
        "-af", "highpass=f=85,lowpass=f=11500,acompressor=threshold=-18dB:ratio=2.3:attack=8:release=110",
        "-ar", str(SAMPLE_RATE), "-ac", "2", str(out_wav),
    ], check=True)
    dur = probe_duration(out_wav)
    return _proportional_words(text, dur)


def probe_duration(path: Path) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ], text=True).strip()
    return float(out or "1.0")


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def generate_vdrill_score_and_foley(
    out_wav: Path,
    duration_sec: float,
    speech_windows: list[tuple[float, float]],
    whoosh_times: list[float],
    pop_times: list[float],
    laser_times: list[float],
    chime_times: list[float],
) -> None:
    """
    V-Drill Dan Tranh + Sao Truc + 808 portamento + tresillo hi-hat (118 BPM).
    Sidechain-ducked smoothly during speech. Same synth engine as Phase 5.
    """
    total_samples = int(duration_sec * SAMPLE_RATE)
    bpm = 118.0
    beat_sec = 60.0 / bpm
    sixteenth_sec = beat_sec / 4.0
    triplet_sec = beat_sec / 3.0
    bar_sec = beat_sec * 4.0

    progression = [
        {"bass_midi": 38.0, "pad": [50, 57, 60, 65], "dan_tranh": [62, 65, 67, 69, 72, 74, 69, 65]},
        {"bass_midi": 34.0, "pad": [46, 53, 57, 62], "dan_tranh": [65, 69, 72, 74, 72, 69, 67, 65]},
        {"bass_midi": 43.0, "pad": [55, 58, 62, 65], "dan_tranh": [67, 69, 72, 74, 77, 74, 72, 69]},
        {"bass_midi": 33.0, "pad": [45, 52, 57, 60], "dan_tranh": [69, 72, 69, 67, 65, 62, 65, 69]},
    ]

    rng = random.Random(20261116)
    noise_table = [rng.uniform(-1.0, 1.0) for _ in range(16384)]

    whoosh_idx = [int(t * SAMPLE_RATE) for t in whoosh_times]
    pop_idx    = [int(t * SAMPLE_RATE) for t in pop_times]
    laser_idx  = [int(t * SAMPLE_RATE) for t in laser_times]
    chime_idx  = [int(t * SAMPLE_RATE) for t in chime_times]

    ctrl_rate = 100
    ctrl_len = int(duration_sec * ctrl_rate) + 4
    duck_ctrl = [1.0] * ctrl_len
    for s_start, s_end in speech_windows:
        i0 = max(0, int((s_start - 0.12) * ctrl_rate))
        i1 = min(ctrl_len - 1, int((s_end + 0.18) * ctrl_rate))
        for k in range(i0, i1 + 1):
            duck_ctrl[k] = 0.28
    for _ in range(3):
        smoothed = list(duck_ctrl)
        for k in range(3, ctrl_len - 3):
            smoothed[k] = sum(duck_ctrl[k - 3: k + 4]) / 7.0
        duck_ctrl = smoothed

    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)

        buf = bytearray()
        two_pi = 2.0 * math.pi
        bass_phase = 0.0

        for i in range(total_samples):
            t = i / SAMPLE_RATE
            fade_in  = min(1.0, t / 0.6)
            fade_out = min(1.0, (duration_sec - t) / 1.6)
            master_env = max(0.0, min(fade_in, fade_out))

            c_idx = min(ctrl_len - 1, int(t * ctrl_rate))
            duck = duck_ctrl[c_idx]

            bar_num  = int(t / bar_sec)
            chord    = progression[bar_num % 4]
            beat_num = int(t / beat_sec)
            beat_dt  = t - beat_num * beat_sec
            sixteenth_num = int(t / sixteenth_sec)
            sixteenth_dt  = t - sixteenth_num * sixteenth_sec
            triplet_num   = int(t / triplet_sec)
            triplet_dt    = t - triplet_num * triplet_sec
            step16 = sixteenth_num % 16

            # 1. Kick
            kick = 0.0
            if step16 in (0, 6, 10, 12) and sixteenth_dt < 0.15:
                pitch = 146.0 * math.exp(-sixteenth_dt * 36.0) + 46.0
                kick = 0.26 * math.exp(-sixteenth_dt * 18.0) * math.sin(two_pi * pitch * sixteenth_dt)

            # 2. Sliding 808 portamento
            root_midi = chord["bass_midi"]
            glide_semitones = 0.0
            if step16 in (6, 7):
                u_g = min(1.0, sixteenth_dt / 0.11)
                glide_semitones = 7.0 * (1.0 - math.exp(-u_g * 4.5))
            elif step16 in (14, 15):
                u_g = min(1.0, sixteenth_dt / 0.11)
                glide_semitones = 12.0 * (1.0 - math.exp(-u_g * 5.0))
            bass_hz = midi_to_hz(root_midi + glide_semitones)
            bass_phase = (bass_phase + two_pi * bass_hz / SAMPLE_RATE) % two_pi
            bass_pump = 0.52 + 0.48 * (1.0 - math.exp(-beat_dt * 11.0))
            bass = 0.21 * bass_pump * math.tanh(1.65 * math.sin(bass_phase))

            # 3. Tresillo hi-hat + triplet ratchets
            hat = 0.0
            if (beat_num % 4 == 3) and triplet_dt < 0.040:
                n = noise_table[(i * 5) & 16383]
                hat = 0.072 * math.exp(-triplet_dt * 80.0) * n
            elif step16 in (0, 3, 6, 8, 11, 14) and sixteenth_dt < 0.046:
                n = noise_table[(i * 3) & 16383]
                hat = 0.058 * math.exp(-sixteenth_dt * 72.0) * n

            # 4. Snare/rimshot
            snare = 0.0
            if step16 in (4, 8, 15) and sixteenth_dt < 0.12:
                n = noise_table[(i * 7) & 16383]
                rim = math.sin(two_pi * 320.0 * sixteenth_dt) * math.exp(-sixteenth_dt * 42.0)
                amp_s = 0.14 if step16 == 8 else 0.08
                snare = amp_s * (0.65 * n * math.exp(-sixteenth_dt * 28.0) + 0.55 * rim)

            # 5. Dan Tranh
            dan_l = 0.0
            dan_r = 0.0
            if step16 in (0, 2, 3, 6, 8, 10, 11, 14) and sixteenth_dt < 0.24:
                note_midi = chord["dan_tranh"][(sixteenth_num // 2) % 8]
                vib_semi = 0.14 * math.sin(two_pi * 6.2 * sixteenth_dt) * min(1.0, sixteenth_dt / 0.06)
                dt_hz = midi_to_hz(note_midi + vib_semi)
                env_1 = math.exp(-sixteenth_dt * 14.0)
                env_2 = math.exp(-sixteenth_dt * 22.0)
                env_3 = math.exp(-sixteenth_dt * 34.0)
                pluck_sig = 0.105 * (
                    env_1 * math.sin(two_pi * dt_hz * sixteenth_dt)
                    + 0.48 * env_2 * math.sin(two_pi * dt_hz * 2.0 * sixteenth_dt)
                    + 0.26 * env_3 * math.sin(two_pi * dt_hz * 3.0 * sixteenth_dt)
                    + 0.12 * env_3 * math.sin(two_pi * dt_hz * 4.0 * sixteenth_dt)
                )
                pan_d = 0.5 + 0.38 * math.sin(sixteenth_num * 0.95)
                dan_l = pluck_sig * pan_d
                dan_r = pluck_sig * (1.0 - pan_d)

            # 6. Sao Truc flute + warm pad
            pad_l = 0.0
            pad_r = 0.0
            flute_vib = 1.0 + 0.0025 * math.sin(two_pi * 5.4 * t)
            flute_hz = midi_to_hz(chord["dan_tranh"][0] + 12) * flute_vib
            flute_gate = 0.5 + 0.5 * math.sin(two_pi * (t / (bar_sec * 2.0)))
            flute_sig = 0.024 * flute_gate * (
                math.sin(two_pi * flute_hz * t) + 0.25 * math.sin(two_pi * flute_hz * 2.0 * t)
            )
            pad_l += flute_sig * 0.65
            pad_r += flute_sig * 0.35
            for p_i, m in enumerate(chord["pad"]):
                hz = midi_to_hz(m)
                s1 = math.sin(two_pi * hz * 0.999 * t)
                s2 = math.sin(two_pi * hz * 1.001 * t + 0.4)
                amp = 0.036 / (1.0 + 0.2 * p_i)
                pad_l += amp * s1
                pad_r += amp * s2

            music_l = (kick + bass + hat + snare + dan_l + pad_l) * duck * master_env
            music_r = (kick + bass + hat + snare + dan_r + pad_r) * duck * master_env

            # 7. Foley SFX
            sfx_l = 0.0
            sfx_r = 0.0
            for ws in whoosh_idx:
                dt = (i - ws) / SAMPLE_RATE
                if -0.16 <= dt < 0.30:
                    u = (dt + 0.16) / 0.46
                    w_env = math.sin(math.pi * u) ** 1.5
                    n_val = noise_table[i & 16383]
                    sweep = math.sin(two_pi * (150.0 + 340.0 * u) * (dt + 0.18))
                    sfx_l += 0.14 * w_env * (0.45 * n_val + 0.55 * sweep) * (1.0 - 0.45 * u)
                    sfx_r += 0.14 * w_env * (0.45 * n_val + 0.55 * sweep) * (0.55 + 0.45 * u)
            for ps in pop_idx:
                dt = (i - ps) / SAMPLE_RATE
                if 0.0 <= dt < 0.07:
                    freq = 400.0 + 460.0 * (dt / 0.07)
                    p_val = 0.16 * math.exp(-dt * 44.0) * math.sin(two_pi * freq * dt)
                    sfx_l += p_val
                    sfx_r += p_val
            for ls in laser_idx:
                dt = (i - ls) / SAMPLE_RATE
                if 0.0 <= dt < 0.28:
                    freq = 680.0 - 440.0 * (dt / 0.28)
                    l_val = 0.16 * math.exp(-dt * 11.0) * math.sin(two_pi * freq * dt)
                    sfx_l += l_val * 0.9
                    sfx_r += l_val * 1.1
            for cs in chime_idx:
                dt = (i - cs) / SAMPLE_RATE
                if 0.0 <= dt < 0.50:
                    c_env = math.exp(-dt * 7.0)
                    ch_l = 0.12 * c_env * (
                        math.sin(two_pi * 587.33 * dt)
                        + 0.7 * math.sin(two_pi * 880.00 * dt)
                        + 0.5 * math.sin(two_pi * 1174.66 * dt)
                    )
                    ch_r = 0.12 * c_env * (
                        math.sin(two_pi * 587.33 * dt)
                        + 0.7 * math.sin(two_pi * 1046.50 * dt)
                        + 0.5 * math.sin(two_pi * 1318.51 * dt)
                    )
                    sfx_l += ch_l
                    sfx_r += ch_r

            out_l = max(-0.96, min(0.96, music_l + sfx_l))
            out_r = max(-0.96, min(0.96, music_r + sfx_r))
            buf.extend(struct.pack("<hh", int(out_l * 32767), int(out_r * 32767)))

        wf.writeframes(bytes(buf))


def build_cut_mix(
    utterances: list[dict],
    total_frames: int,
    out_wav: Path,
    whooshes: list[float],
    pops: list[float],
    lasers: list[float],
    chimes: list[float],
    api_key: str | None,
) -> tuple[str, list[dict]]:
    duration_sec = total_frames / FPS
    used_provider = "macos_neural_say"
    enriched_utterances: list[dict] = []

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp_dir = Path(tmp_str)
        clip_records: list[tuple[Path, int, float]] = []
        speech_windows: list[tuple[float, float]] = []

        for utt in utterances:
            speaker_key = utt["speaker"]
            speaker_cfg = VOICES[speaker_key]
            clip_wav = tmp_dir / f"{utt['id']}.wav"
            max_slot_sec = (utt["duration_frames"] / FPS) - utt["voice_offset_sec"] - 0.16
            words: list[dict] = []

            if api_key:
                mp3_path = tmp_dir / f"{utt['id']}_el.mp3"
                ok, el_words = synth_clip_elevenlabs(utt["text"], mp3_path, api_key, speaker_cfg["elevenlabs_id"])
                if ok:
                    used_provider = "elevenlabs"
                    words = el_words
                    subprocess.run([
                        "ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3_path),
                        "-ar", str(SAMPLE_RATE), "-ac", "2", str(clip_wav),
                    ], check=True)

            if not clip_wav.exists():
                ok_edge, edge_words = synth_clip_edge_neural(utt["text"], clip_wav, tmp_dir, speaker_cfg)
                if ok_edge:
                    if used_provider == "macos_neural_say":
                        used_provider = "studio_neural_3voice_edge_tts_vdrill"
                    words = edge_words

            if not clip_wav.exists():
                words = synth_clip_macos_say(utt["text"], clip_wav, tmp_dir, speaker_cfg)

            clip_dur = probe_duration(clip_wav)
            tempo = 1.0
            fitted_wav = clip_wav
            if clip_dur > max_slot_sec and max_slot_sec > 0.8:
                tempo = min(1.30, max(1.01, clip_dur / max_slot_sec))
                fitted_wav = tmp_dir / f"{utt['id']}_fit.wav"
                subprocess.run([
                    "ffmpeg", "-y", "-loglevel", "error", "-i", str(clip_wav),
                    "-af", f"atempo={tempo:.3f}", str(fitted_wav),
                ], check=True)
                clip_dur = probe_duration(fitted_wav)

            if not words:
                words = _proportional_words(utt["text"], clip_dur)
            elif tempo > 1.001:
                words = [{"word": w["word"], "start": round(w["start"] / tempo, 3), "end": round(w["end"] / tempo, 3)} for w in words]

            abs_voice_start = (utt["start_frame"] / FPS) + utt["voice_offset_sec"]
            speech_windows.append((abs_voice_start, abs_voice_start + clip_dur))
            start_ms = int(abs_voice_start * 1000)
            clip_records.append((fitted_wav, start_ms, clip_dur))

            enriched = dict(utt)
            enriched["speaker_label"] = speaker_cfg["label"]
            enriched["speaker_role"]  = speaker_cfg["role"]
            enriched["speaker_accent"] = speaker_cfg["accent"]
            enriched["voice_duration_sec"] = round(clip_dur, 3)
            enriched["words"] = words
            enriched_utterances.append(enriched)

        bed_wav = tmp_dir / "bed.wav"
        generate_vdrill_score_and_foley(bed_wav, duration_sec=duration_sec,
            speech_windows=speech_windows, whoosh_times=whooshes,
            pop_times=pops, laser_times=lasers, chime_times=chimes)

        inputs = ["-i", str(bed_wav)]
        filter_parts = ["[0:a]volume=0.95[bed]"]
        mix_labels = ["[bed]"]

        for idx, (wav_path, start_ms, _dur) in enumerate(clip_records, start=1):
            inputs.extend(["-i", str(wav_path)])
            lbl = f"v{idx}"
            filter_parts.append(f"[{idx}:a]adelay={start_ms}|{start_ms},volume=1.46[{lbl}]")
            mix_labels.append(f"[{lbl}]")

        amix_count = len(mix_labels)
        filter_parts.append(
            f"{''.join(mix_labels)}amix=inputs={amix_count}:normalize=0,"
            f"loudnorm=I=-14:TP=-1.5:LRA=9,apad,atrim=0:{duration_sec:.3f}[out]"
        )

        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            *inputs,
            "-filter_complex", ";".join(filter_parts),
            "-map", "[out]",
            "-ar", str(SAMPLE_RATE), "-ac", "2",
            str(out_wav),
        ], check=True)

    return used_provider, enriched_utterances


def main() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip() or None

    # Demo foley (absolute seconds in 90.0s timeline):
    # ActShowreel 0..15s: opening whoosh + pop at mid-showreel
    # ActFlyover 15..29.5s: exact coord-spec whooshes at 23.66s, 24.80s, hit at 24.97s
    # Act2Yapp 29.5..37.5s: pop + laser on 99K reveal
    # Remaining acts 37.5..90s: standard spaced foley
    demo_whooshes = [
        0.0, 7.5, 15.0,
        23.66, 24.80,                   # Flyover: match Act2 8.66s and 9.80s internal
        30.0, 37.5, 49.5, 56.0, 64.5, 73.5, 84.5,
    ]
    demo_pops = [
        3.5, 7.5, 12.0,
        24.97,                           # Flyover hit at 9.97s internal
        31.0, 34.0, 38.5, 43.0, 50.0, 57.5, 65.0, 69.0, 74.5, 80.0, 86.0,
    ]
    demo_lasers = [19.6, 36.0, 51.0, 67.5]   # 19.6 = flyover comic-silence cut (15+4.6)
    demo_chimes = [15.0, 29.5, 46.5, 61.0, 73.5, 85.0]

    provider_demo, enriched_demo_utts = build_cut_mix(
        utterances=DEMO_UTTERANCES,
        total_frames=5400,
        out_wav=AUDIO_DIR / "demo-mix.wav",
        whooshes=demo_whooshes,
        pops=demo_pops,
        lasers=demo_lasers,
        chimes=demo_chimes,
        api_key=api_key,
    )

    # Teaser foley (30.0s)
    teaser_whooshes = [0.0, 7.5, 15.0, 23.66, 24.80]
    teaser_pops     = [3.5, 12.0, 24.97]
    teaser_lasers   = [19.6]
    teaser_chimes   = [15.0, 27.5]

    provider_teaser, enriched_teaser_utts = build_cut_mix(
        utterances=TEASER_UTTERANCES,
        total_frames=1800,
        out_wav=AUDIO_DIR / "teaser-mix.wav",
        whooshes=teaser_whooshes,
        pops=teaser_pops,
        lasers=teaser_lasers,
        chimes=teaser_chimes,
        api_key=api_key,
    )

    manifest = {
        "fps": FPS,
        "width": 1920,
        "height": 1080,
        "voice_provider": provider_demo or provider_teaser,
        "score_style": "viet_drill_dan_tranh_808_glide_118bpm",
        "demo_total_frames": 5400,
        "teaser_total_frames": 1800,
        "voices": VOICES,
        "demo_visuals": DEMO_VISUALS,
        "demo_utterances": enriched_demo_utts,
        "teaser_visuals": TEASER_VISUALS,
        "teaser_utterances": enriched_teaser_utts,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"[audio] Phase 6: 3-voice English-only V-Drill demo-mix.wav (90.0s @ -14 LUFS) "
        f"and teaser-mix.wav (30.0s @ -14 LUFS) via {provider_demo}"
    )


if __name__ == "__main__":
    main()
