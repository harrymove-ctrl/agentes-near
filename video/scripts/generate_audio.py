#!/usr/bin/env python3
from __future__ import annotations
"""
Agentes NEAR Phase 3 Melodic Drill & Bounce Score + Surgical Foley SFX Engine (-14 LUFS).

Generates two pure, beat-synced, melodic-drill-inspired masters:
1. demo-mix.wav (80.0s = 4800 frames @ 60fps) spanning all 7 Choreographed Agentes NEAR Acts:
   - Act 1 (0.0..12.0s): Things Are Moving · Agentes NEAR @ 97 BPM (808 sub glides + kinetic wave punches)
   - Act 2 (12.0..20.0s): Agentes NEAR 99K Intents @ 104 BPM (bouncy 808 octave slide, typing ticks,
     4.6s hard silence cut, 4.8s slam, 5.1s plucky 2-note sting, 5.4s ding)
   - Act 3 (20.0..30.0s): Agentes 2.0 Intent Engine @ 116 BPM (drill triplet hats, rising node ticks,
     4.2s sub-bass dive, timeline clip snaps, 8.4s logo hit)
   - Act 4 (30.0..45.0s): Agentes Studio Showcase @ 120 BPM (bright Rhodes chords, 808 bounce, whip-pans)
   - Act 5 (45.0..55.0s): @ada Tool Hub Graph @ 118 BPM (glass synth plucks, node burst pops, data pulses)
   - Act 6 (55.0..67.0s): OutLayer TDX Vault Collage @ 120 BPM (punchy breakbeat + 808, paper rips, label clicks)
   - Act 7 (67.0..80.0s): ONE Workspace · Agentes NEAR @ 108 BPM (clicky groove, 0.1s silence at 70.2s,
     3.3s impact chord at 70.3s, luminous Agentes NEAR lockup sustain)
2. teaser-mix.wav (45.0s = 2700 frames @ 60fps) high-energy reel sampling all 7 hooks.
Mastered via ffmpeg `loudnorm=I=-14:TP=-1.5:LRA=9`.
"""

import json
import math
import random
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "public" / "audio"
MANIFEST_PATH = ROOT / "src" / "scene-manifest.json"
FPS = 60
SAMPLE_RATE = 44100


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def synthesize_mix(
    out_wav: Path,
    duration_sec: float,
    acts: list[dict],
    silence_windows: list[tuple[float, float]],
    slams: list[float],
    two_note_stings: list[float],
    dings: list[float],
    sub_dives: list[float],
    paper_rips: list[float],
    clicks: list[float],
    whooshes: list[float],
    impact_chords: list[float],
) -> None:
    total_samples = int(duration_sec * SAMPLE_RATE)
    rng = random.Random(20261115)
    noise_table = [rng.uniform(-1.0, 1.0) for _ in range(16384)]

    def to_idx(times: list[float]) -> list[int]:
        return [int(t * SAMPLE_RATE) for t in times]

    slam_idx = to_idx(slams)
    sting_idx = to_idx(two_note_stings)
    ding_idx = to_idx(dings)
    dive_idx = to_idx(sub_dives)
    rip_idx = to_idx(paper_rips)
    click_idx = to_idx(clicks)
    whoosh_idx = to_idx(whooshes)
    chord_idx = to_idx(impact_chords)
    sil_idx = [(int(a * SAMPLE_RATE), int(b * SAMPLE_RATE)) for a, b in silence_windows]

    def find_act(t: float) -> dict:
        for a in acts:
            if a["start_sec"] <= t < a["end_sec"]:
                return a
        return acts[-1]

    # Harmonic minor / melodic drill + warm neo-soul chord palettes per act
    palettes = {
        "wave": [
            [45, 57, 60, 64, 69],   # Am9
            [41, 53, 57, 60, 64],   # Fmaj7
            [48, 60, 64, 67, 71],   # Cmaj7
            [40, 52, 56, 59, 64],   # E7
        ],
        "yapp": [
            [38, 50, 57, 62, 65],   # Dm9
            [46, 58, 62, 65, 69],   # Bbmaj7
            [43, 55, 58, 62, 67],   # Gm9
            [45, 57, 61, 64, 69],   # A7sus4
        ],
        "cutline": [
            [40, 52, 59, 64, 67],   # Em9
            [48, 60, 67, 71, 74],   # Cmaj9
            [45, 57, 64, 67, 71],   # Am9
            [47, 59, 66, 69, 74],   # Bm7
        ],
        "fitting": [
            [48, 60, 64, 67, 71],   # Cmaj7
            [45, 57, 60, 64, 69],   # Am9
            [41, 53, 57, 60, 64],   # Fmaj7
            [43, 55, 59, 62, 67],   # G6
        ],
        "graph": [
            [42, 54, 61, 64, 69],   # F#m9
            [38, 50, 57, 61, 66],   # Dmaj9
            [45, 57, 64, 68, 71],   # Amaj9
            [40, 52, 59, 64, 68],   # E6
        ],
        "molote": [
            [43, 55, 58, 62, 65],   # Gm7
            [48, 60, 63, 67, 70],   # Cm7
            [41, 53, 57, 60, 65],   # F7sus4
            [46, 58, 62, 65, 69],   # Bbmaj7
        ],
        "one": [
            [45, 57, 64, 67, 71],   # Am9
            [48, 60, 67, 71, 74],   # Cmaj9
            [41, 53, 60, 64, 69],   # Fmaj9
            [43, 55, 62, 67, 71],   # Gmaj7
        ],
    }

    with tempfile.TemporaryDirectory() as tmp:
        raw_wav = Path(tmp) / "raw.wav"
        with wave.open(str(raw_wav), "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)

            buf = bytearray()
            two_pi = 2.0 * math.pi
            bass_phase = 0.0

            for i in range(total_samples):
                t = i / SAMPLE_RATE

                # Hard silence gates (e.g. 4.6s Act 2 silence & 0.1s Act 7 silence)
                in_silence = False
                for sa, sb in sil_idx:
                    if sa <= i < sb:
                        in_silence = True
                        break

                if in_silence:
                    buf.extend(b"\x00\x00\x00\x00")
                    continue

                act = find_act(t)
                local_t = t - act["start_sec"]
                bpm = act["bpm"]
                beat_sec = 60.0 / bpm
                eighth_sec = beat_sec / 2.0
                sixteenth_sec = beat_sec / 4.0
                triplet_sec = beat_sec / 3.0

                beat_num = int(local_t / beat_sec)
                beat_dt = local_t - beat_num * beat_sec
                eighth_num = int(local_t / eighth_sec)
                eighth_dt = local_t - eighth_num * eighth_sec
                sixteenth_num = int(local_t / sixteenth_sec)
                sixteenth_dt = local_t - sixteenth_num * sixteenth_sec
                triplet_num = int(local_t / triplet_sec)
                triplet_dt = local_t - triplet_num * triplet_sec

                prog = palettes[act["style"]]
                chord_midi = prog[(beat_num // 2) % len(prog)]

                fade_in = min(1.0, t / 0.25)
                fade_out = min(1.0, (duration_sec - t) / 1.4)
                master_env = max(0.0, min(fade_in, fade_out))

                # 1. Punchy Drill / Bounce Kick
                kick = 0.0
                # Syncopated drill kick pattern: beats 0, 1.5 (sixteenth 6), 2.5 (sixteenth 10), 3
                step16 = sixteenth_num % 16
                is_kick_step = step16 in (0, 6, 10, 12) if act["style"] != "one" else step16 in (0, 8)
                if is_kick_step and sixteenth_dt < 0.15:
                    pitch = 148.0 * math.exp(-sixteenth_dt * 36.0) + 45.0
                    kick = 0.26 * math.exp(-sixteenth_dt * 18.5) * math.sin(two_pi * pitch * sixteenth_dt)

                # 2. Melodic Drill Sliding 808 Sub-Bass (phase-continuous portamento glide!)
                root_midi = float(chord_midi[0])
                # On the last 16th of a 2-beat phrase, glide smoothly up to the fifth (+7) or octave (+12)!
                target_offset = 0.0
                if step16 in (6, 7):
                    slide_u = min(1.0, sixteenth_dt / 0.11)
                    target_offset = 7.0 * (1.0 - math.exp(-slide_u * 4.5))
                elif step16 in (14, 15):
                    slide_u = min(1.0, sixteenth_dt / 0.11)
                    target_offset = 12.0 * (1.0 - math.exp(-slide_u * 5.0))
                bass_hz = midi_to_hz(root_midi + target_offset)
                bass_phase = (bass_phase + two_pi * bass_hz / SAMPLE_RATE) % two_pi
                bass_pump = 0.50 + 0.50 * (1.0 - math.exp(-beat_dt * 11.0))
                # Warm harmonic 808 saturation so it translates on laptop & phone speakers
                bass = 0.20 * bass_pump * math.tanh(1.65 * math.sin(bass_phase))

                # 3. Crisp UK-Drill Triplet Hi-Hat Counter-Rhythm & Rolls
                hat = 0.0
                # Standard drill counter-rhythm (sixteenth steps 0, 3, 6, 8, 11, 14) + triplet roll on beat 3
                if (beat_num % 4 == 3) and triplet_dt < 0.042:
                    n = noise_table[(i * 5) & 16383]
                    hat = 0.068 * math.exp(-triplet_dt * 78.0) * n
                elif (step16 in (0, 3, 6, 8, 11, 14)) and sixteenth_dt < 0.048:
                    n = noise_table[(i * 3) & 16383]
                    hat = 0.056 * math.exp(-sixteenth_dt * 70.0) * n

                # 4. Snappy Rimshot / Clap on Beat 2 & Syncopated Beat 3.5
                snare = 0.0
                if step16 in (4, 12, 15) and sixteenth_dt < 0.12:
                    n = noise_table[(i * 7) & 16383]
                    rim_body = math.sin(two_pi * 310.0 * sixteenth_dt) * math.exp(-sixteenth_dt * 42.0)
                    amp_s = 0.13 if step16 in (4, 12) else 0.075
                    snare = amp_s * (0.65 * n * math.exp(-sixteenth_dt * 28.0) + 0.55 * rim_body)

                # 5. Warm Rhodes / Glass Chord Pad & Catchy Melodic Pluck Hook
                pad_l = 0.0
                pad_r = 0.0
                for p_i, m in enumerate(chord_midi[1:]):
                    hz = midi_to_hz(m)
                    s1 = math.sin(two_pi * hz * 0.9988 * t)
                    s2 = math.sin(two_pi * hz * 1.0012 * t + 0.35)
                    amp = 0.046 / (1.0 + 0.18 * p_i)
                    pad_l += amp * s1
                    pad_r += amp * s2

                pluck_l = 0.0
                pluck_r = 0.0
                arp_seq = (0, 2, 3, 1, 2, 3, 1, 0)
                arp_note = chord_midi[1 + (arp_seq[sixteenth_num % 8] % 4)] + 12
                arp_hz = midi_to_hz(arp_note)
                play_arp = step16 in (0, 3, 6, 8, 10, 12, 14)
                if play_arp and sixteenth_dt < 0.19:
                    p_env = math.exp(-sixteenth_dt * 17.0)
                    tone = 0.082 * p_env * (
                        math.sin(two_pi * arp_hz * sixteenth_dt)
                        + 0.35 * math.sin(two_pi * arp_hz * 2.0 * sixteenth_dt)
                    )
                    pan = 0.5 + 0.36 * math.sin(sixteenth_num * 0.85)
                    pluck_l = tone * pan
                    pluck_r = tone * (1.0 - pan)

                bed_l = (kick + hat + snare + bass + pad_l + pluck_l) * master_env
                bed_r = (kick + hat + snare + bass + pad_r + pluck_r) * master_env

                # 6. Surgical Foley SFX Layer
                sfx_l = 0.0
                sfx_r = 0.0

                for si in slam_idx:
                    dt = (i - si) / SAMPLE_RATE
                    if 0.0 <= dt < 0.32:
                        pitch = 160.0 * math.exp(-dt * 22.0) + 42.0
                        n = noise_table[(i * 11) & 16383]
                        val = 0.36 * math.exp(-dt * 11.0) * math.sin(two_pi * pitch * dt) + 0.16 * math.exp(-dt * 24.0) * n
                        sfx_l += val
                        sfx_r += val

                for ti in sting_idx:
                    dt = (i - ti) / SAMPLE_RATE
                    if 0.0 <= dt < 0.34:
                        hz = 587.33 if dt < 0.12 else 880.00
                        ndt = dt if dt < 0.12 else (dt - 0.12)
                        val = 0.22 * math.exp(-ndt * 16.0) * (math.sin(two_pi * hz * ndt) + 0.35 * math.sin(two_pi * hz * 2 * ndt))
                        sfx_l += val * 1.1
                        sfx_r += val * 0.9

                for di in ding_idx:
                    dt = (i - di) / SAMPLE_RATE
                    if 0.0 <= dt < 0.45:
                        val = 0.22 * math.exp(-dt * 9.5) * (math.sin(two_pi * 1318.51 * dt) + 0.4 * math.sin(two_pi * 2637.02 * dt))
                        sfx_l += val * 0.9
                        sfx_r += val * 1.1

                for dv in dive_idx:
                    dt = (i - dv) / SAMPLE_RATE
                    if 0.0 <= dt < 0.65:
                        hz = 190.0 * math.exp(-dt * 3.8) + 34.0
                        val = 0.34 * math.sin(math.pi * min(1.0, dt / 0.65)) * math.sin(two_pi * hz * dt)
                        sfx_l += val
                        sfx_r += val

                for rp in rip_idx:
                    dt = (i - rp) / SAMPLE_RATE
                    if 0.0 <= dt < 0.24:
                        env = math.sin(math.pi * (dt / 0.24)) ** 0.8
                        n = noise_table[(i * 13 + int(dt * 1200)) & 16383]
                        grit = 0.6 + 0.4 * math.sin(two_pi * 62.0 * dt)
                        val = 0.26 * env * n * grit
                        sfx_l += val * (1.0 - 0.4 * (dt / 0.24))
                        sfx_r += val * (0.6 + 0.4 * (dt / 0.24))

                for ci in click_idx:
                    dt = (i - ci) / SAMPLE_RATE
                    if 0.0 <= dt < 0.045:
                        val = 0.19 * math.exp(-dt * 95.0) * math.sin(two_pi * 1850.0 * dt) + 0.08 * math.exp(-dt * 120.0) * noise_table[i & 16383]
                        sfx_l += val
                        sfx_r += val

                for wi in whoosh_idx:
                    dt = (i - wi) / SAMPLE_RATE
                    if -0.14 <= dt < 0.26:
                        u = (dt + 0.14) / 0.40
                        w_env = math.sin(math.pi * u) ** 1.5
                        n = noise_table[i & 16383]
                        sweep = math.sin(two_pi * (170.0 + 380.0 * u) * (dt + 0.16))
                        sfx_l += 0.16 * w_env * (0.45 * n + 0.55 * sweep) * (1.0 - 0.45 * u)
                        sfx_r += 0.16 * w_env * (0.45 * n + 0.55 * sweep) * (0.55 + 0.45 * u)

                for chi in chord_idx:
                    dt = (i - chi) / SAMPLE_RATE
                    if 0.0 <= dt < 1.1:
                        c_env = math.exp(-dt * 3.6)
                        sub = 0.22 * math.exp(-dt * 8.0) * math.sin(two_pi * 55.0 * dt)
                        ch_l = sub + 0.13 * c_env * (
                            math.sin(two_pi * 440.0 * dt)
                            + 0.75 * math.sin(two_pi * 523.25 * dt)
                            + 0.60 * math.sin(two_pi * 659.25 * dt)
                        )
                        ch_r = sub + 0.13 * c_env * (
                            math.sin(two_pi * 440.0 * dt)
                            + 0.75 * math.sin(two_pi * 587.33 * dt)
                            + 0.60 * math.sin(two_pi * 783.99 * dt)
                        )
                        sfx_l += ch_l
                        sfx_r += ch_r

                out_l = max(-0.96, min(0.96, bed_l + sfx_l))
                out_r = max(-0.96, min(0.96, bed_r + sfx_r))
                buf.extend(struct.pack("<hh", int(out_l * 32767), int(out_r * 32767)))

            wf.writeframes(bytes(buf))

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(raw_wav),
                "-af",
                f"loudnorm=I=-14:TP=-1.5:LRA=9,apad,atrim=0:{duration_sec:.3f}",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                str(out_wav),
            ],
            check=True,
        )


def build_demo_audio() -> list[dict]:
    acts = [
        {"id": "act1_moving", "act": 1, "name": "Things Are Moving · Agentes NEAR", "style": "wave", "bpm": 97.0, "start_sec": 0.0, "end_sec": 12.0, "start_frame": 0, "duration_frames": 720},
        {"id": "act2_yapp", "act": 2, "name": "Agentes NEAR · 99K Intents", "style": "yapp", "bpm": 104.0, "start_sec": 12.0, "end_sec": 20.0, "start_frame": 720, "duration_frames": 480},
        {"id": "act3_cutline", "act": 3, "name": "Agentes 2.0 · Intent Engine", "style": "cutline", "bpm": 116.0, "start_sec": 20.0, "end_sec": 30.0, "start_frame": 1200, "duration_frames": 600},
        {"id": "act4_fitting", "act": 4, "name": "Agentes Studio · 5 Surfaces", "style": "fitting", "bpm": 120.0, "start_sec": 30.0, "end_sec": 45.0, "start_frame": 1800, "duration_frames": 900},
        {"id": "act5_graph", "act": 5, "name": "@ada Tool Hub · 5 Tools", "style": "graph", "bpm": 118.0, "start_sec": 45.0, "end_sec": 55.0, "start_frame": 2700, "duration_frames": 600},
        {"id": "act6_molote", "act": 6, "name": "OutLayer TDX · Stop-Motion", "style": "molote", "bpm": 120.0, "start_sec": 55.0, "end_sec": 67.0, "start_frame": 3300, "duration_frames": 720},
        {"id": "act7_one_lockup", "act": 7, "name": "ONE Workspace · Agentes NEAR", "style": "one", "bpm": 108.0, "start_sec": 67.0, "end_sec": 80.0, "start_frame": 4020, "duration_frames": 780},
    ]

    typing_ticks = [13.5 + k * 0.065 for k in range(22)]
    node_ticks = [22.0 + k * 0.35 for k in range(6)]
    timeline_snaps = [26.1, 26.5, 26.9, 27.3]
    label_clicks = [
        *[55.9 + k * 0.08 for k in range(12)],
        *[59.1 + k * 0.09 for k in range(8)],
        *[62.1 + k * 0.08 for k in range(12)],
        *[64.9 + k * 0.08 for k in range(10)],
    ]
    one_clicks = [67.8, 68.4, 69.0, 69.8]

    synthesize_mix(
        out_wav=AUDIO_DIR / "demo-mix.wav",
        duration_sec=80.0,
        acts=acts,
        silence_windows=[
            (16.60, 16.80),  # Act 2 hard silence cut at 4.6s rel
            (70.20, 70.30),  # Act 7 0.1s silence before 3.3s hit
        ],
        slams=[12.4, 16.80, 31.2, 65.4],
        two_note_stings=[17.10],
        dings=[17.40, 38.4, 52.2],
        sub_dives=[24.20],
        paper_rips=[55.0, 58.0, 61.0, 64.0],
        clicks=[*typing_ticks, *node_ticks, *timeline_snaps, *label_clicks, *one_clicks, 21.6, 35.8, 37.3],
        whooshes=[12.0, 20.0, 30.0, 37.0, 41.0, 45.0, 47.0, 72.0],
        impact_chords=[28.40, 70.30],
    )
    return acts


def build_teaser_audio() -> list[dict]:
    acts = [
        {"id": "t1_moving", "act": 1, "name": "Things Are Moving · Agentes NEAR", "style": "wave", "bpm": 97.0, "start_sec": 0.0, "end_sec": 6.5, "start_frame": 0, "duration_frames": 390},
        {"id": "t2_yapp", "act": 2, "name": "Agentes NEAR · 99K Intents", "style": "yapp", "bpm": 104.0, "start_sec": 6.5, "end_sec": 13.0, "start_frame": 390, "duration_frames": 390},
        {"id": "t3_cutline", "act": 3, "name": "Agentes 2.0 · Intent Engine", "style": "cutline", "bpm": 116.0, "start_sec": 13.0, "end_sec": 19.5, "start_frame": 780, "duration_frames": 390},
        {"id": "t4_fitting", "act": 4, "name": "Agentes Studio · 5 Surfaces", "style": "fitting", "bpm": 120.0, "start_sec": 19.5, "end_sec": 26.0, "start_frame": 1170, "duration_frames": 390},
        {"id": "t5_graph", "act": 5, "name": "@ada Tool Hub · 5 Tools", "style": "graph", "bpm": 118.0, "start_sec": 26.0, "end_sec": 31.5, "start_frame": 1560, "duration_frames": 330},
        {"id": "t6_molote", "act": 6, "name": "OutLayer TDX · Stop-Motion", "style": "molote", "bpm": 120.0, "start_sec": 31.5, "end_sec": 38.0, "start_frame": 1890, "duration_frames": 390},
        {"id": "t7_one", "act": 7, "name": "ONE Workspace · Agentes NEAR", "style": "one", "bpm": 108.0, "start_sec": 38.0, "end_sec": 45.0, "start_frame": 2280, "duration_frames": 420},
    ]

    synthesize_mix(
        out_wav=AUDIO_DIR / "teaser-mix.wav",
        duration_sec=45.0,
        acts=acts,
        silence_windows=[
            (10.20, 10.35),
            (40.20, 40.30),
        ],
        slams=[6.8, 10.35, 20.4],
        two_note_stings=[10.65],
        dings=[10.95, 23.2, 29.5],
        sub_dives=[15.8],
        paper_rips=[31.5, 34.7],
        clicks=[
            *[7.4 + k * 0.06 for k in range(14)],
            *[14.2 + k * 0.25 for k in range(5)],
            *[32.3 + k * 0.08 for k in range(10)],
            38.8, 39.4,
        ],
        whooshes=[6.5, 13.0, 19.5, 26.0, 38.0, 42.0],
        impact_chords=[18.2, 40.30],
    )
    return acts


def main() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    demo_acts = build_demo_audio()
    teaser_acts = build_teaser_audio()

    manifest = {
        "fps": FPS,
        "width": 1920,
        "height": 1080,
        "demo_total_frames": 4800,
        "teaser_total_frames": 2700,
        "demo_acts": demo_acts,
        "teaser_acts": teaser_acts,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("[audio] Built Phase 3 melodic-drill demo-mix.wav (80.0s @ -14 LUFS) and teaser-mix.wav (45.0s @ -14 LUFS)")


if __name__ == "__main__":
    main()
