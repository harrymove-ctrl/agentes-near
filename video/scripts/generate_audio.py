#!/usr/bin/env python3
from __future__ import annotations
"""
Agentes NEAR Audio, Word-Boundary Lip/Subtitle Sync, and 6-Scene Studio Score Pipeline (60 FPS, -14 LUFS).

1. Uses ElevenLabs REST API (`with-timestamps`, `eleven_multilingual_v2`) if `ELEVENLABS_API_KEY` is set.
2. Uses Studio Neural TTS (`edge-tts` via `uvx` if needed: `en-US-AndrewMultilingualNeural` + `en-US-AvaMultilingualNeural`)
   with exact millisecond `WordBoundary` timestamps when `ELEVENLABS_API_KEY` is unset.
3. Falls back cleanly to macOS neural `say` (`Reed` + `Samantha`) if completely offline.
4. Synthesizes a 124 BPM A-minor / Glacier-Night 6-scene launch score + Foley SFX bed (transition whooshes,
   UI clicks, solver chimes, OutLayer laser guard pulse, ML-DSA-65 cryptographic chord) mastered via
   `ffmpeg loudnorm=I=-14:TP=-1.5:LRA=9` into `demo-mix.wav` (94.0s) and `teaser-mix.wav` (45.0s).
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
import urllib.request
import wave
from pathlib import Path

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
        "label": "Ada · Host",
        "role": "Systems Lead",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_ALEX", "nPczCjzI2devNBz1zQrb").strip(),
        "edge_voice": "en-US-AndrewMultilingualNeural",
        "edge_rate": "+5%",
        "say_voice": "Reed",
    },
    "maya": {
        "label": "Lia · Co-Host",
        "role": "Protocol Architect",
        "elevenlabs_id": os.environ.get("ELEVENLABS_VOICE_ID_MAYA", "cgSgspJ2msm6clMCkdW9").strip(),
        "edge_voice": "en-US-AvaMultilingualNeural",
        "edge_rate": "+6%",
        "say_voice": "Samantha",
    },
}

# 94.0s (5640 frames @ 60fps) Master Demo
DEMO_SCENES = [
    {
        "id": "d01_hero_dither_ocelli",
        "scene": 1,
        "title": "Dither Horizon & Ocelli Hero",
        "speaker": "alex",
        "start_frame": 0,
        "duration_frames": 720,
        "voice_offset_sec": 0.45,
        "text": "Agentes NEAR brings Slack for teams and NEAR AI agents into one self hosted workspace, framed by a sixty FPS Bayer dither canvas and an interactive Ocelli launch window.",
        "caption": "Agentes NEAR: Slack for teams and NEAR AI agents in one self-hosted workspace.",
    },
    {
        "id": "d02_channels_judge_login",
        "scene": 2,
        "title": "Channels & 1-Click Judge Login",
        "speaker": "maya",
        "start_frame": 720,
        "duration_frames": 1080,
        "voice_offset_sec": 0.35,
        "text": "Judges sign in with one click as Harry Phan and land inside live workspace channels: near intents arena, compute endowment, and outlayer tee vault, where Ada, Theo, Lia, and Kronos collaborate in real time.",
        "caption": "1-click judge login -> #near-intents-arena, #compute-endowment, #outlayer-tee-vault.",
    },
    {
        "id": "d03_terrace_intents_1click",
        "scene": 3,
        "title": "Terrace Conviction & 1Click Intents",
        "speaker": "alex",
        "start_frame": 1800,
        "duration_frames": 1080,
        "voice_offset_sec": 0.35,
        "text": "Inside near intents arena, Terrace Social and Hunch power in chat conviction markets. Stake wrapped NEAR to back or fade agent calls with AGENTES burn on miss, settled via live NEAR Intents One Click multi solver routing.",
        "caption": "Terrace + Hunch conviction markets (wNEAR + $AGENTES burn) via NEAR Intents 1Click.",
    },
    {
        "id": "d04_outlayer_tdx_guard",
        "scene": 4,
        "title": "OutLayer Intel TDX Spend Guard",
        "speaker": "maya",
        "start_frame": 2880,
        "duration_frames": 1080,
        "voice_offset_sec": 0.35,
        "text": "Every agent wallet runs inside an OutLayer Intel TDX hardware enclave. Tune the liquid slosh slider to twenty five dollars per transaction: a twelve dollar intent signs cleanly with NEP four thirteen, while a forty five dollar rogue drain fails closed.",
        "caption": "OutLayer TDX cap $25/tx: $12.00 NEP-413 approved, $45.00 rogue drain blocked.",
    },
    {
        "id": "d05_corpus_kanmani_kyvera",
        "scene": 5,
        "title": "Corpus x402, Kanmani & Kyvera ML-DSA-65",
        "speaker": "alex",
        "start_frame": 3960,
        "duration_frames": 960,
        "voice_offset_sec": 0.35,
        "text": "Corpus x402 streams one dollar eighty four per hour H100 TEE compute with Tab credit and Kanmani slashing escrow. Kyvera ML DSA sixty five signs every receipt, catching a single nibble tamper before exporting a secret free ergo bundle.",
        "caption": "Corpus x402 ($1.84/hr H100 TEE), Tab BNPL, Kanmani escrow, Kyvera ML-DSA-65 proof.",
    },
    {
        "id": "d06_tracks_lockup",
        "scene": 6,
        "title": "13 NEAR Tracks & MIT Lockup",
        "speaker": "maya",
        "start_frame": 4920,
        "duration_frames": 720,
        "voice_offset_sec": 0.30,
        "text": "Engineered across thirteen NEAR hackathon tracks with open MIT code and verifiable receipts. Explore Agentes NEAR on GitHub today.",
        "caption": "13 NEAR Tracks · MIT License · github.com/harrymove-ctrl/agentes-near",
    },
]

# 45.0s (2700 frames @ 60fps) High-Tempo X Launch Teaser
TEASER_SCENES = [
    {
        "id": "t01_hero",
        "scene": 1,
        "title": "Agentes NEAR Hero",
        "speaker": "alex",
        "start_frame": 0,
        "duration_frames": 420,
        "voice_offset_sec": 0.25,
        "text": "Agentes NEAR: Slack for teams and NEAR AI agents in one self hosted workspace.",
        "caption": "Agentes NEAR: Slack for Teams + NEAR AI Agents.",
    },
    {
        "id": "t02_channels",
        "scene": 2,
        "title": "Live Channels & Swarm",
        "speaker": "maya",
        "start_frame": 420,
        "duration_frames": 480,
        "voice_offset_sec": 0.20,
        "text": "Sign in with one click to watch Ada, Theo, Lia, and Kronos coordinate across live channels.",
        "caption": "1-Click Judge Login · @ada @theo @lia @kronos Live Channels.",
    },
    {
        "id": "t03_terrace_intents",
        "scene": 3,
        "title": "Terrace & 1Click Intents",
        "speaker": "alex",
        "start_frame": 900,
        "duration_frames": 480,
        "voice_offset_sec": 0.20,
        "text": "Back or fade in chat conviction markets in wrapped NEAR, settled by NEAR Intents One Click solvers.",
        "caption": "Terrace wNEAR Markets + NEAR Intents 1Click Multi-Solver Settlement.",
    },
    {
        "id": "t04_outlayer_guard",
        "scene": 4,
        "title": "OutLayer TDX Guard",
        "speaker": "maya",
        "start_frame": 1380,
        "duration_frames": 480,
        "voice_offset_sec": 0.20,
        "text": "OutLayer Intel TDX limits approve a twelve dollar intent while blocking a forty five dollar rogue drain.",
        "caption": "OutLayer TDX Guard ($25/tx): $12 NEP-413 Pass vs $45 Rogue Drain Blocked.",
    },
    {
        "id": "t05_corpus_kyvera",
        "scene": 5,
        "title": "Corpus & ML-DSA-65",
        "speaker": "alex",
        "start_frame": 1860,
        "duration_frames": 480,
        "voice_offset_sec": 0.20,
        "text": "Corpus x402 funds H100 TEE compute, Kanmani enforces escrow, and ML DSA sixty five seals every receipt.",
        "caption": "Corpus x402 ($1.84/hr) · Kanmani Escrow · Kyvera ML-DSA-65.",
    },
    {
        "id": "t06_tracks_lockup",
        "scene": 6,
        "title": "13 Tracks & MIT Lockup",
        "speaker": "maya",
        "start_frame": 2340,
        "duration_frames": 360,
        "voice_offset_sec": 0.20,
        "text": "Thirteen NEAR tracks. Open MIT source. Try Agentes NEAR now.",
        "caption": "13 NEAR Tracks · MIT License · github.com/harrymove-ctrl/agentes-near",
    },
]


def probe_duration(path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    ).strip()
    return float(out or "1.0")


def _proportional_words(text: str, total_dur: float) -> list[dict]:
    raw_words = [w for w in text.split() if w.strip()]
    if not raw_words:
        return []
    weights = [max(2.0, len(w) + (2.5 if w[-1] in ".,!?:;" else 0.0)) for w in raw_words]
    total_w = sum(weights)
    cursor = 0.0
    out = []
    for w, wt in zip(raw_words, weights):
        dur = total_dur * (wt / total_w)
        out.append({"word": w, "start": round(cursor, 3), "end": round(cursor + dur, 3)})
        cursor += dur
    return out


def synth_clip_elevenlabs(text: str, out_mp3: Path, api_key: str, voice_id: str) -> tuple[bool, list[dict]]:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    payload = json.dumps(
        {
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.48, "similarity_boost": 0.78, "style": 0.25},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        audio_b64 = data.get("audio_base64")
        if not audio_b64:
            return False, []
        out_mp3.write_bytes(base64.b64decode(audio_b64))
        align = data.get("alignment") or {}
        chars = align.get("characters") or []
        starts = align.get("character_start_times_seconds") or []
        ends = align.get("character_end_times_seconds") or []
        words: list[dict] = []
        buf = ""
        w_start = None
        w_end = 0.0
        for ch, st, en in zip(chars, starts, ends):
            if ch.isspace():
                if buf and w_start is not None:
                    words.append({"word": buf, "start": round(w_start, 3), "end": round(w_end, 3)})
                    buf = ""
                    w_start = None
            else:
                if w_start is None:
                    w_start = float(st)
                w_end = float(en)
                buf += ch
        if buf and w_start is not None:
            words.append({"word": buf, "start": round(w_start, 3), "end": round(w_end, 3)})
        return True, words
    except Exception as exc:
        print(f"[audio] ElevenLabs fallback ({exc})")
        return False, []


async def _edge_tts_async(text: str, mp3_path: Path, voice: str, rate: str) -> list[dict]:
    import edge_tts  # type: ignore

    comm = edge_tts.Communicate(text, voice=voice, rate=rate)
    words: list[dict] = []
    with open(mp3_path, "wb") as fh:
        async for chunk in comm.stream():
            ctype = chunk.get("type")
            if ctype == "audio":
                fh.write(chunk["data"])
            elif ctype == "WordBoundary":
                offset_s = float(chunk["offset"]) / 10_000_000.0
                dur_s = float(chunk["duration"]) / 10_000_000.0
                words.append(
                    {
                        "word": str(chunk["text"]),
                        "start": round(offset_s, 3),
                        "end": round(offset_s + dur_s, 3),
                    }
                )
    return words


def synth_clip_edge_neural(text: str, out_wav: Path, tmp_dir: Path, cfg: dict) -> tuple[bool, list[dict]]:
    try:
        mp3_path = tmp_dir / f"{out_wav.stem}_edge.mp3"
        words = asyncio.run(_edge_tts_async(text, mp3_path, cfg["edge_voice"], cfg["edge_rate"]))
        if not mp3_path.exists() or mp3_path.stat().st_size < 1000:
            return False, []
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(mp3_path),
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                str(out_wav),
            ],
            check=True,
        )
        return True, words
    except Exception as exc:
        print(f"[audio] edge-tts fallback ({exc})")
        return False, []


def synth_clip_macos_say(text: str, out_wav: Path, tmp_dir: Path, cfg: dict) -> list[dict]:
    aiff = tmp_dir / f"{out_wav.stem}.aiff"
    subprocess.run(["say", "-v", cfg["say_voice"], "-r", "188", "-o", str(aiff), text], check=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(aiff),
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "2",
            str(out_wav),
        ],
        check=True,
    )
    dur = probe_duration(out_wav)
    return _proportional_words(text, dur)


def generate_score_and_foley(
    out_wav: Path,
    duration_sec: float,
    speech_windows: list[tuple[float, float]],
    whoosh_times: list[float],
    pop_times: list[float],
    laser_times: list[float],
    chime_times: list[float],
) -> None:
    """
    120 BPM A-Minor / Glacier-Night Cinematic Electronic Score + Foley Bed:
    - Chords: Am9 -> Fmaj7 -> Dm9 -> E7sus4
    - Deep analog sub-bass, detuned stereo glass pad, syncopated 8th marimba/pluck
    - Smooth sidechain speech ducking so hosts remain crisp
    - Foley: transition whooshes, UI tactile pops, OutLayer laser block pulse, ML-DSA-65 chime
    """
    total_samples = int(duration_sec * SAMPLE_RATE)
    bpm = 120.0
    beat_sec = 60.0 / bpm
    eighth_sec = beat_sec / 2.0
    bar_sec = beat_sec * 4.0

    chords = [
        {"bass": 55.00, "pad": [220.00, 261.63, 329.63, 493.88], "arp": [440.00, 523.25, 659.25, 987.77]},
        {"bass": 43.65, "pad": [174.61, 220.00, 261.63, 329.63], "arp": [349.23, 440.00, 523.25, 659.25]},
        {"bass": 73.42, "pad": [146.83, 174.61, 220.00, 329.63], "arp": [293.66, 349.23, 440.00, 659.25]},
        {"bass": 82.41, "pad": [164.81, 220.00, 246.94, 329.63], "arp": [329.63, 440.00, 493.88, 659.25]},
    ]

    rng = random.Random(20261113)
    noise_table = [rng.uniform(-1.0, 1.0) for _ in range(8192)]

    whoosh_idx = [int(t * SAMPLE_RATE) for t in whoosh_times]
    pop_idx = [int(t * SAMPLE_RATE) for t in pop_times]
    laser_idx = [int(t * SAMPLE_RATE) for t in laser_times]
    chime_idx = [int(t * SAMPLE_RATE) for t in chime_times]

    ctrl_rate = 100
    ctrl_len = int(duration_sec * ctrl_rate) + 2
    duck_ctrl = [1.0] * ctrl_len
    for s_start, s_end in speech_windows:
        i0 = max(0, int((s_start - 0.14) * ctrl_rate))
        i1 = min(ctrl_len - 1, int((s_end + 0.18) * ctrl_rate))
        for k in range(i0, i1 + 1):
            duck_ctrl[k] = 0.36
    for _ in range(2):
        smoothed = list(duck_ctrl)
        for k in range(2, ctrl_len - 2):
            smoothed[k] = (
                duck_ctrl[k - 2] + duck_ctrl[k - 1] + duck_ctrl[k] + duck_ctrl[k + 1] + duck_ctrl[k + 2]
            ) / 5.0
        duck_ctrl = smoothed

    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)

        buf = bytearray()
        two_pi = 2.0 * math.pi

        for i in range(total_samples):
            t = i / SAMPLE_RATE
            fade_in = min(1.0, t / 0.8)
            fade_out = min(1.0, (duration_sec - t) / 1.6)
            master_env = max(0.0, min(fade_in, fade_out))

            c_idx = min(ctrl_len - 1, int(t * ctrl_rate))
            duck = duck_ctrl[c_idx]

            bar_num = int(t / bar_sec)
            chord = chords[bar_num % 4]

            beat_phase = (t % beat_sec) / beat_sec
            bass_env = 0.70 + 0.30 * math.exp(-beat_phase * 5.0)
            bass = 0.145 * bass_env * math.sin(two_pi * chord["bass"] * t)

            pad_l = 0.0
            pad_r = 0.0
            lfo = 0.84 + 0.16 * math.sin(two_pi * 0.25 * t)
            for p_i, pf in enumerate(chord["pad"]):
                s1 = math.sin(two_pi * pf * 0.999 * t)
                s2 = math.sin(two_pi * pf * 1.001 * t + 0.4)
                amp = 0.042 / (1.0 + 0.18 * p_i)
                pad_l += amp * s1 * lfo
                pad_r += amp * s2 * lfo

            eighth_num = int(t / eighth_sec)
            eighth_dt = t - eighth_num * eighth_sec
            arp_pattern = (0, 2, 1, 3, 2, 3, 1, 0)
            arp_note = chord["arp"][arp_pattern[eighth_num % 8]]
            play_pluck = (eighth_num % 8) in (0, 2, 3, 5, 6)
            pluck = 0.0
            if play_pluck and eighth_dt < 0.24:
                pluck_env = math.exp(-eighth_dt * 16.0)
                pluck = 0.052 * pluck_env * (
                    math.sin(two_pi * arp_note * eighth_dt)
                    + 0.25 * math.sin(two_pi * arp_note * 2.0 * eighth_dt)
                )
            pan = 0.5 + 0.30 * math.sin(eighth_num * 0.85)

            music_l = (bass + pad_l + pluck * pan) * duck * master_env
            music_r = (bass + pad_r + pluck * (1.0 - pan)) * duck * master_env

            sfx_l = 0.0
            sfx_r = 0.0

            for ws in whoosh_idx:
                dt = (i - ws) / SAMPLE_RATE
                if -0.16 <= dt < 0.32:
                    u = (dt + 0.16) / 0.48
                    w_env = math.sin(math.pi * u) ** 1.6
                    n_val = noise_table[i & 8191]
                    sweep = math.sin(two_pi * (150.0 + 340.0 * u) * (dt + 0.18))
                    pan_w = u
                    sfx_l += 0.12 * w_env * (0.45 * n_val + 0.55 * sweep) * (1.0 - 0.5 * pan_w)
                    sfx_r += 0.12 * w_env * (0.45 * n_val + 0.55 * sweep) * (0.5 + 0.5 * pan_w)

            for ps in pop_idx:
                dt = (i - ps) / SAMPLE_RATE
                if 0.0 <= dt < 0.07:
                    freq = 420.0 + 460.0 * (dt / 0.07)
                    p_val = 0.14 * math.exp(-dt * 44.0) * math.sin(two_pi * freq * dt)
                    sfx_l += p_val
                    sfx_r += p_val

            for ls in laser_idx:
                dt = (i - ls) / SAMPLE_RATE
                if 0.0 <= dt < 0.30:
                    freq = 680.0 - 440.0 * (dt / 0.30)
                    l_val = 0.14 * math.exp(-dt * 10.5) * math.sin(two_pi * freq * dt)
                    sfx_l += l_val * 0.9
                    sfx_r += l_val * 1.1

            for cs in chime_idx:
                dt = (i - cs) / SAMPLE_RATE
                if 0.0 <= dt < 0.03:
                    click_v = 0.16 * math.exp(-dt * 110.0) * math.sin(two_pi * 1760.0 * dt)
                    sfx_l += click_v
                    sfx_r += click_v
                if 0.0 <= dt < 0.55:
                    c_env = math.exp(-dt * 6.0)
                    ch_l = 0.11 * c_env * (
                        math.sin(two_pi * 523.25 * dt)
                        + 0.7 * math.sin(two_pi * 659.25 * dt)
                        + 0.5 * math.sin(two_pi * 987.77 * dt)
                    )
                    ch_r = 0.11 * c_env * (
                        math.sin(two_pi * 523.25 * dt)
                        + 0.7 * math.sin(two_pi * 783.99 * dt)
                        + 0.5 * math.sin(two_pi * 1174.66 * dt)
                    )
                    sfx_l += ch_l
                    sfx_r += ch_r

            out_l = max(-0.95, min(0.95, music_l + sfx_l))
            out_r = max(-0.95, min(0.95, music_r + sfx_r))
            buf.extend(struct.pack("<hh", int(out_l * 32767), int(out_r * 32767)))

        wf.writeframes(bytes(buf))


def build_cut_mix(
    scenes: list[dict],
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
    enriched_scenes: list[dict] = []

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp_dir = Path(tmp_str)
        clip_records: list[tuple[Path, int, float]] = []
        speech_windows: list[tuple[float, float]] = []

        for sc in scenes:
            speaker_key = sc["speaker"]
            speaker_cfg = VOICES[speaker_key]
            clip_wav = tmp_dir / f"{sc['id']}.wav"
            max_slot_sec = (sc["duration_frames"] / FPS) - sc["voice_offset_sec"] - 0.18
            words: list[dict] = []

            if api_key:
                mp3_path = tmp_dir / f"{sc['id']}_el.mp3"
                ok, el_words = synth_clip_elevenlabs(
                    sc["text"], mp3_path, api_key, speaker_cfg["elevenlabs_id"]
                )
                if ok:
                    used_provider = "elevenlabs_multilingual_v2_dual_host"
                    words = el_words
                    subprocess.run(
                        [
                            "ffmpeg",
                            "-y",
                            "-loglevel",
                            "error",
                            "-i",
                            str(mp3_path),
                            "-ar",
                            str(SAMPLE_RATE),
                            "-ac",
                            "2",
                            str(clip_wav),
                        ],
                        check=True,
                    )

            if not clip_wav.exists():
                ok_edge, edge_words = synth_clip_edge_neural(sc["text"], clip_wav, tmp_dir, speaker_cfg)
                if ok_edge:
                    if used_provider == "macos_neural_say":
                        used_provider = "studio_neural_dual_host_edge_tts"
                    words = edge_words

            if not clip_wav.exists():
                words = synth_clip_macos_say(sc["text"], clip_wav, tmp_dir, speaker_cfg)

            clip_dur = probe_duration(clip_wav)
            tempo = 1.0
            fitted_wav = clip_wav
            if clip_dur > max_slot_sec and max_slot_sec > 1.0:
                tempo = min(1.30, max(1.01, clip_dur / max_slot_sec))
                fitted_wav = tmp_dir / f"{sc['id']}_fit.wav"
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-loglevel",
                        "error",
                        "-i",
                        str(clip_wav),
                        "-af",
                        f"atempo={tempo:.3f}",
                        str(fitted_wav),
                    ],
                    check=True,
                )
                clip_dur = probe_duration(fitted_wav)

            if not words:
                words = _proportional_words(sc["text"], clip_dur)
            elif tempo > 1.001:
                words = [
                    {
                        "word": w["word"],
                        "start": round(w["start"] / tempo, 3),
                        "end": round(w["end"] / tempo, 3),
                    }
                    for w in words
                ]

            scene_abs_voice_start = (sc["start_frame"] / FPS) + sc["voice_offset_sec"]
            speech_windows.append((scene_abs_voice_start, scene_abs_voice_start + clip_dur))
            start_ms = int(scene_abs_voice_start * 1000)
            clip_records.append((fitted_wav, start_ms, clip_dur))

            enriched = dict(sc)
            enriched["speaker_label"] = speaker_cfg["label"]
            enriched["speaker_role"] = speaker_cfg["role"]
            enriched["voice_duration_sec"] = round(clip_dur, 3)
            enriched["words"] = words
            enriched_scenes.append(enriched)

        bed_wav = tmp_dir / "bed.wav"
        generate_score_and_foley(
            bed_wav,
            duration_sec=duration_sec,
            speech_windows=speech_windows,
            whoosh_times=whooshes,
            pop_times=pops,
            laser_times=lasers,
            chime_times=chimes,
        )

        inputs = ["-i", str(bed_wav)]
        filter_parts = ["[0:a]volume=0.95[bed]"]
        mix_labels = ["[bed]"]

        for idx, (wav_path, start_ms, _dur) in enumerate(clip_records, start=1):
            inputs.extend(["-i", str(wav_path)])
            lbl = f"v{idx}"
            filter_parts.append(f"[{idx}:a]adelay={start_ms}|{start_ms},volume=1.45[{lbl}]")
            mix_labels.append(f"[{lbl}]")

        amix_count = len(mix_labels)
        filter_parts.append(
            f"{''.join(mix_labels)}amix=inputs={amix_count}:normalize=0,"
            f"loudnorm=I=-14:TP=-1.5:LRA=9,apad,atrim=0:{duration_sec:.3f}[out]"
        )

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                *inputs,
                "-filter_complex",
                ";".join(filter_parts),
                "-map",
                "[out]",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                str(out_wav),
            ],
            check=True,
        )

    return used_provider, enriched_scenes


def main() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip() or None

    demo_provider, demo_enriched = build_cut_mix(
        scenes=DEMO_SCENES,
        total_frames=5640,
        out_wav=AUDIO_DIR / "demo-mix.wav",
        whooshes=[12.0, 30.0, 48.0, 66.0, 82.0],
        pops=[1.2, 13.0, 18.5, 31.0, 49.0, 67.0, 82.5],
        lasers=[58.5],
        chimes=[40.5, 53.0, 74.5, 84.0],
        api_key=api_key,
    )

    teaser_provider, teaser_enriched = build_cut_mix(
        scenes=TEASER_SCENES,
        total_frames=2700,
        out_wav=AUDIO_DIR / "teaser-mix.wav",
        whooshes=[7.0, 15.0, 23.0, 31.0, 39.0],
        pops=[0.8, 7.6, 15.5, 23.5, 31.5, 39.5],
        lasers=[27.5],
        chimes=[19.5, 35.5, 40.5],
        api_key=api_key,
    )

    manifest = {
        "fps": FPS,
        "width": 1920,
        "height": 1080,
        "demo_voice_provider": demo_provider,
        "teaser_voice_provider": teaser_provider,
        "voices": {
            "alex": {"label": "Ada · Host", "role": "Systems Lead", "accent": "#5aa8ff"},
            "maya": {"label": "Lia · Co-Host", "role": "Protocol Architect", "accent": "#5fc48a"},
        },
        "demo_total_frames": 5640,
        "teaser_total_frames": 2700,
        "demo_scenes": demo_enriched,
        "teaser_scenes": teaser_enriched,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"[audio] Built demo-mix.wav (94.0s @ 60fps via {demo_provider}) and teaser-mix.wav (45.0s @ 60fps via {teaser_provider})"
    )


if __name__ == "__main__":
    main()
