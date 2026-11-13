#!/usr/bin/env python3
from __future__ import annotations
"""
Agentes NEAR Phase 2 Frame-Accurate Multi-BPM Score & Surgical Foley SFX Engine (-14 LUFS).

Generates two pure, beat-synced, zero-narration-clutter masters:
1. demo-mix.wav (80.0s = 4800 frames @ 60fps) spanning all 7 Choreographed Acts:
   - Act 1 (0.0..12.0s): Things Are Moving @ 97 BPM (kinetic wave punches)
   - Act 2 (12.0..20.0s): Yapp 99K @ 104 BPM (bouncy bass, typing ticks, 4.6s hard silence cut,
     4.8s slam, 5.1s plucky 2-note sting, 5.4s ding)
   - Act 3 (20.0..30.0s): Cutline 1.0 @ 116 BPM (pulsing synth, rising node ticks, 4.2s sub-bass dive,
     timeline clip snaps, 8.4s logo hit)
   - Act 4 (30.0..45.0s): Fitting Lookbook @ 120 BPM (bright Rhodes, spring pops, whip-pans, ripple)
   - Act 5 (45.0..55.0s): AI Tool Graph @ 118 BPM (glass synth, node burst pops, data-pulse plucks)
   - Act 6 (55.0..67.0s): Molote Parche 2 @ 120 BPM (lo-fi breakbeat, paper rips, label-maker clicks)
   - Act 7 (67.0..80.0s): ONE design Sting @ 108 BPM (clicky minimal groove, 0.1s silence at 70.2s,
     3.3s impact chord at 70.3s, luminous Agentes NEAR lockup sustain)
2. teaser-mix.wav (45.0s = 2700 frames @ 60fps) high-energy reel sampling the best hooks.
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
    rng = random.Random(20261114)
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

    # Map every act cleanly
    def find_act(t: float) -> dict:
        for a in acts:
            if a["start_sec"] <= t < a["end_sec"]:
                return a
        return acts[-1]

    # Precompute harmonic chord progressions per act
    palettes = {
        "wave": [
            [45, 57, 60, 64, 67],   # Am7
            [43, 55, 59, 62, 67],   # G6
            [41, 53, 57, 60, 64],   # Fmaj7
            [40, 52, 55, 59, 62],   # Em7
        ],
        "yapp": [
            [38, 50, 57, 62, 65],   # Dm9
            [36, 48, 55, 60, 64],   # Cmaj7
            [41, 53, 60, 65, 69],   # Fmaj9
            [43, 55, 59, 62, 67],   # G6
        ],
        "cutline": [
            [40, 52, 59, 64, 67],   # Em9
            [45, 57, 64, 67, 71],   # Am9
            [48, 60, 67, 71, 74],   # Cmaj9
            [47, 59, 66, 69, 74],   # Bm7
        ],
        "fitting": [
            [48, 60, 64, 67, 71],   # Cmaj7
            [45, 57, 60, 64, 69],   # Am9
            [41, 53, 57, 60, 64],   # Fmaj7
            [43, 55, 59, 62, 67],   # G6
        ],
        "graph": [
            [42, 54, 61, 64, 69],   # F#m7
            [40, 52, 59, 64, 68],   # Emaj9
            [45, 57, 64, 68, 71],   # Amaj9
            [47, 59, 66, 69, 73],   # B9sus4
        ],
        "molote": [
            [43, 55, 58, 62, 65],   # Gm7 (lofi warm)
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

            for i in range(total_samples):
                t = i / SAMPLE_RATE

                # Hard silence gates (e.g. 4.6s Yapp silence & 0.1s ONE silence)
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

                beat_num = int(local_t / beat_sec)
                beat_dt = local_t - beat_num * beat_sec
                eighth_num = int(local_t / eighth_sec)
                eighth_dt = local_t - eighth_num * eighth_sec
                sixteenth_num = int(local_t / sixteenth_sec)
                sixteenth_dt = local_t - sixteenth_num * sixteenth_sec

                prog = palettes[act["style"]]
                chord_midi = prog[(beat_num // 2) % len(prog)]

                fade_in = min(1.0, t / 0.25)
                fade_out = min(1.0, (duration_sec - t) / 1.4)
                master_env = max(0.0, min(fade_in, fade_out))

                # 1. Beat-locked Kick / Bass Punch
                kick = 0.0
                if act["style"] in ("wave", "yapp", "cutline", "fitting", "molote"):
                    # Four-on-the-floor or breakbeat kick
                    is_kick = (
                        (beat_num % 1 == 0)
                        if act["style"] != "molote"
                        else (eighth_num % 8 in (0, 3, 4))
                    )
                    kick_dt = beat_dt if act["style"] != "molote" else eighth_dt
                    if is_kick and kick_dt < 0.16:
                        pitch = 135.0 * math.exp(-kick_dt * 34.0) + 46.0
                        kick = 0.24 * math.exp(-kick_dt * 18.0) * math.sin(two_pi * pitch * kick_dt)

                # Crisp closed hi-hat / lo-fi brush on off-beats
                hat = 0.0
                if act["style"] in ("yapp", "cutline", "fitting", "molote", "one"):
                    if (eighth_num % 2 == 1) and eighth_dt < 0.055:
                        n = noise_table[(i * 3) & 16383]
                        amp_h = 0.07 if act["style"] == "molote" else 0.045
                        hat = amp_h * math.exp(-eighth_dt * 65.0) * n

                # Snare / clap on beats 2 & 4
                snare = 0.0
                if act["style"] in ("yapp", "molote", "fitting") and (beat_num % 2 == 1) and beat_dt < 0.14:
                    n = noise_table[(i * 7) & 16383]
                    body = math.sin(two_pi * 185.0 * beat_dt) * math.exp(-beat_dt * 28.0)
                    snare = (0.11 * n * math.exp(-beat_dt * 22.0) + 0.08 * body)

                # 2. Sub-bass & rhythmic groove
                bass_hz = midi_to_hz(chord_midi[0])
                bass_pump = 0.45 + 0.55 * (1.0 - math.exp(-beat_dt * 12.0))
                if act["style"] == "yapp":
                    # Bouncy octave bass
                    b_hz = bass_hz * (2.0 if (eighth_num % 4 == 2) else 1.0)
                    bass = 0.19 * bass_pump * math.sin(two_pi * b_hz * t)
                elif act["style"] == "molote":
                    # Warm lo-fi saturation bass
                    bass = 0.18 * bass_pump * math.tanh(1.5 * math.sin(two_pi * bass_hz * t))
                else:
                    bass = 0.16 * bass_pump * math.sin(two_pi * bass_hz * t)

                # 3. Stereo Pad & Syncopated Pluck/Arp
                pad_l = 0.0
                pad_r = 0.0
                for p_i, m in enumerate(chord_midi[1:]):
                    hz = midi_to_hz(m)
                    s1 = math.sin(two_pi * hz * 0.9985 * t)
                    s2 = math.sin(two_pi * hz * 1.0015 * t + 0.35)
                    amp = (0.048 if act["style"] != "one" else 0.055) / (1.0 + 0.18 * p_i)
                    pad_l += amp * s1
                    pad_r += amp * s2

                # Syncopated synth / marimba / Rhodes pluck
                pluck_l = 0.0
                pluck_r = 0.0
                arp_seq = (0, 2, 1, 3, 2, 1, 3, 0)
                arp_hz = midi_to_hz(chord_midi[1 + (arp_seq[sixteenth_num % 8] % 4)] + 12)
                play_arp = (sixteenth_num % 4 in (0, 2, 3)) if act["style"] in ("cutline", "graph", "wave") else (eighth_num % 8 in (0, 2, 3, 5, 6))
                arp_dt = sixteenth_dt if act["style"] in ("cutline", "graph", "wave") else eighth_dt
                if play_arp and arp_dt < 0.20:
                    p_env = math.exp(-arp_dt * 18.0)
                    tone = 0.075 * p_env * (
                        math.sin(two_pi * arp_hz * arp_dt)
                        + 0.3 * math.sin(two_pi * arp_hz * 2.0 * arp_dt)
                    )
                    pan = 0.5 + 0.35 * math.sin(sixteenth_num * 0.9)
                    pluck_l = tone * pan
                    pluck_r = tone * (1.0 - pan)

                bed_l = (kick + hat + snare + bass + pad_l + pluck_l) * master_env
                bed_r = (kick + hat + snare + bass + pad_r + pluck_r) * master_env

                # 4. Surgical Foley SFX Layer
                sfx_l = 0.0
                sfx_r = 0.0

                # Slam (4.8s Yapp reply slam / drop)
                for si in slam_idx:
                    dt = (i - si) / SAMPLE_RATE
                    if 0.0 <= dt < 0.32:
                        pitch = 160.0 * math.exp(-dt * 22.0) + 42.0
                        n = noise_table[(i * 11) & 16383]
                        val = 0.36 * math.exp(-dt * 11.0) * math.sin(two_pi * pitch * dt) + 0.16 * math.exp(-dt * 24.0) * n
                        sfx_l += val
                        sfx_r += val

                # Plucky 2-note sting (5.1s Yapp)
                for ti in sting_idx:
                    dt = (i - ti) / SAMPLE_RATE
                    if 0.0 <= dt < 0.34:
                        hz = 587.33 if dt < 0.12 else 880.00
                        ndt = dt if dt < 0.12 else (dt - 0.12)
                        val = 0.22 * math.exp(-ndt * 16.0) * (math.sin(two_pi * hz * ndt) + 0.35 * math.sin(two_pi * hz * 2 * ndt))
                        sfx_l += val * 1.1
                        sfx_r += val * 0.9

                # Crisp Ding (5.4s Yapp Top Reply stamp)
                for di in ding_idx:
                    dt = (i - di) / SAMPLE_RATE
                    if 0.0 <= dt < 0.45:
                        val = 0.22 * math.exp(-dt * 9.5) * (math.sin(two_pi * 1318.51 * dt) + 0.4 * math.sin(two_pi * 2637.02 * dt))
                        sfx_l += val * 0.9
                        sfx_r += val * 1.1

                # Sub-bass dive (4.2s Cutline push-through)
                for dv in dive_idx:
                    dt = (i - dv) / SAMPLE_RATE
                    if 0.0 <= dt < 0.65:
                        hz = 190.0 * math.exp(-dt * 3.8) + 34.0
                        val = 0.34 * math.sin(math.pi * min(1.0, dt / 0.65)) * math.sin(two_pi * hz * dt)
                        sfx_l += val
                        sfx_r += val

                # Paper tear / rip (Molote 3s switches)
                for rp in rip_idx:
                    dt = (i - rp) / SAMPLE_RATE
                    if 0.0 <= dt < 0.24:
                        env = math.sin(math.pi * (dt / 0.24)) ** 0.8
                        n = noise_table[(i * 13 + int(dt * 1200)) & 16383]
                        grit = 0.6 + 0.4 * math.sin(two_pi * 62.0 * dt)
                        val = 0.26 * env * n * grit
                        sfx_l += val * (1.0 - 0.4 * (dt / 0.24))
                        sfx_r += val * (0.6 + 0.4 * (dt / 0.24))

                # Mechanical typing / label-maker / timeline snap / node tick
                for ci in click_idx:
                    dt = (i - ci) / SAMPLE_RATE
                    if 0.0 <= dt < 0.045:
                        val = 0.19 * math.exp(-dt * 95.0) * math.sin(two_pi * 1850.0 * dt) + 0.08 * math.exp(-dt * 120.0) * noise_table[i & 16383]
                        sfx_l += val
                        sfx_r += val

                # Whip-pan / burst whoosh
                for wi in whoosh_idx:
                    dt = (i - wi) / SAMPLE_RATE
                    if -0.14 <= dt < 0.26:
                        u = (dt + 0.14) / 0.40
                        w_env = math.sin(math.pi * u) ** 1.5
                        n = noise_table[i & 16383]
                        sweep = math.sin(two_pi * (170.0 + 380.0 * u) * (dt + 0.16))
                        sfx_l += 0.16 * w_env * (0.45 * n + 0.55 * sweep) * (1.0 - 0.45 * u)
                        sfx_r += 0.16 * w_env * (0.45 * n + 0.55 * sweep) * (0.55 + 0.45 * u)

                # Impact Chord (Cutline 8.4s logo hit & ONE 3.3s tomato wipe)
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

        # Master cleanly to -14 LUFS, -1.5 dBTP
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
    # 80.0s (4800 frames @ 60fps) across 7 acts
    acts = [
        {"id": "act1_moving", "act": 1, "name": "Things Are Moving", "style": "wave", "bpm": 97.0, "start_sec": 0.0, "end_sec": 12.0, "start_frame": 0, "duration_frames": 720},
        {"id": "act2_yapp", "act": 2, "name": "Yapp 99K Counter", "style": "yapp", "bpm": 104.0, "start_sec": 12.0, "end_sec": 20.0, "start_frame": 720, "duration_frames": 480},
        {"id": "act3_cutline", "act": 3, "name": "Cutline 1.0", "style": "cutline", "bpm": 116.0, "start_sec": 20.0, "end_sec": 30.0, "start_frame": 1200, "duration_frames": 600},
        {"id": "act4_fitting", "act": 4, "name": "Fitting Lookbook", "style": "fitting", "bpm": 120.0, "start_sec": 30.0, "end_sec": 45.0, "start_frame": 1800, "duration_frames": 900},
        {"id": "act5_graph", "act": 5, "name": "AI Assistant Tool Graph", "style": "graph", "bpm": 118.0, "start_sec": 45.0, "end_sec": 55.0, "start_frame": 2700, "duration_frames": 600},
        {"id": "act6_molote", "act": 6, "name": "Molote Parche 2", "style": "molote", "bpm": 120.0, "start_sec": 55.0, "end_sec": 67.0, "start_frame": 3300, "duration_frames": 720},
        {"id": "act7_one_lockup", "act": 7, "name": "ONE design & Agentes NEAR", "style": "one", "bpm": 108.0, "start_sec": 67.0, "end_sec": 80.0, "start_frame": 4020, "duration_frames": 780},
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
            (16.60, 16.80),  # Act 2 Yapp hard silence cut at 4.6s rel
            (70.20, 70.30),  # Act 7 ONE 0.1s silence before 3.3s hit
        ],
        slams=[12.4, 16.80, 31.2, 65.4],
        two_note_stings=[17.10],  # 5.1s rel in Act 2
        dings=[17.40, 38.4, 52.2],  # 5.4s rel in Act 2 + Create lookbook + Preview open
        sub_dives=[24.20],  # 4.2s rel in Act 3
        paper_rips=[55.0, 58.0, 61.0, 64.0],  # Molote 3s paper tears
        clicks=[*typing_ticks, *node_ticks, *timeline_snaps, *label_clicks, *one_clicks, 21.6, 35.8, 37.3],
        whooshes=[12.0, 20.0, 30.0, 37.0, 41.0, 45.0, 47.0, 72.0],
        impact_chords=[28.40, 70.30],  # 8.4s rel Cutline logo hit + 3.3s rel ONE tomato wipe
    )
    return acts


def build_teaser_audio() -> list[dict]:
    # 45.0s (2700 frames @ 60fps) high-energy reel sampling all 7 hooks
    acts = [
        {"id": "t1_moving", "act": 1, "name": "Things Are Moving", "style": "wave", "bpm": 97.0, "start_sec": 0.0, "end_sec": 6.5, "start_frame": 0, "duration_frames": 390},
        {"id": "t2_yapp", "act": 2, "name": "Yapp 99K", "style": "yapp", "bpm": 104.0, "start_sec": 6.5, "end_sec": 13.0, "start_frame": 390, "duration_frames": 390},
        {"id": "t3_cutline", "act": 3, "name": "Cutline 1.0", "style": "cutline", "bpm": 116.0, "start_sec": 13.0, "end_sec": 19.5, "start_frame": 780, "duration_frames": 390},
        {"id": "t4_fitting", "act": 4, "name": "Fitting Lookbook", "style": "fitting", "bpm": 120.0, "start_sec": 19.5, "end_sec": 26.0, "start_frame": 1170, "duration_frames": 390},
        {"id": "t5_graph", "act": 5, "name": "AI Tool Graph", "style": "graph", "bpm": 118.0, "start_sec": 26.0, "end_sec": 31.5, "start_frame": 1560, "duration_frames": 330},
        {"id": "t6_molote", "act": 6, "name": "Molote Parche 2", "style": "molote", "bpm": 120.0, "start_sec": 31.5, "end_sec": 38.0, "start_frame": 1890, "duration_frames": 390},
        {"id": "t7_one", "act": 7, "name": "ONE & Agentes NEAR", "style": "one", "bpm": 108.0, "start_sec": 38.0, "end_sec": 45.0, "start_frame": 2280, "duration_frames": 420},
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
    print("[audio] Built Phase 2 beat-synced demo-mix.wav (80.0s @ -14 LUFS) and teaser-mix.wav (45.0s @ -14 LUFS)")


if __name__ == "__main__":
    main()
