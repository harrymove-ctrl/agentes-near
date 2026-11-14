#!/usr/bin/env python3
from __future__ import annotations
"""
Synthesize a clean, crisp 120 BPM instrumental V-Drill groove WAV for AI Video Maker.

No speech or foley clicks are baked into this track because AI Video Maker
mixes voiceover + scene SFX and sidechain-ducks this music bed cleanly to -14 LUFS.
"""

import math
import os
import random
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 48000
DURATION_SEC = 96.0
BPM = 120.0


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def synthesize_vdrill_wav(out_path: Path, duration_sec: float = DURATION_SEC, bpm: float = BPM) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    total_samples = int(duration_sec * SAMPLE_RATE)
    beat_sec = 60.0 / bpm
    sixteenth_sec = beat_sec / 4.0
    triplet_sec = beat_sec / 3.0
    bar_sec = beat_sec * 4.0

    # D minor pentatonic / Dorian Vietnamese Dan Tranh motif over V-Drill 808s
    progression = [
        {"bass_midi": 38.0, "pad": [50, 57, 60, 65], "dan_tranh": [62, 65, 67, 69, 72, 74, 69, 65]},
        {"bass_midi": 34.0, "pad": [46, 53, 57, 62], "dan_tranh": [65, 69, 72, 74, 72, 69, 67, 65]},
        {"bass_midi": 43.0, "pad": [55, 58, 62, 65], "dan_tranh": [67, 69, 72, 74, 77, 74, 72, 69]},
        {"bass_midi": 33.0, "pad": [45, 52, 57, 60], "dan_tranh": [69, 72, 69, 67, 65, 62, 65, 69]},
    ]

    rng = random.Random(20261114)
    noise_table = [rng.uniform(-1.0, 1.0) for _ in range(16384)]
    two_pi = 2.0 * math.pi
    bass_phase = 0.0

    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)

        buf = bytearray()
        for i in range(total_samples):
            t = i / SAMPLE_RATE
            fade_in = min(1.0, t / 0.45)
            fade_out = min(1.0, (duration_sec - t) / 1.5)
            master_env = max(0.0, min(fade_in, fade_out))

            bar_num = int(t / bar_sec)
            chord = progression[bar_num % 4]
            beat_num = int(t / beat_sec)
            beat_dt = t - beat_num * beat_sec
            sixteenth_num = int(t / sixteenth_sec)
            sixteenth_dt = t - sixteenth_num * sixteenth_sec
            triplet_num = int(t / triplet_sec)
            triplet_dt = t - triplet_num * triplet_sec
            step16 = sixteenth_num % 16

            # 1. Punchy drill kick on tresillo syncopation
            kick = 0.0
            if step16 in (0, 6, 10, 12) and sixteenth_dt < 0.145:
                pitch = 148.0 * math.exp(-sixteenth_dt * 37.0) + 46.0
                kick = 0.27 * math.exp(-sixteenth_dt * 18.5) * math.sin(two_pi * pitch * sixteenth_dt)

            # 2. Sliding 808 sub bass portamento
            root_midi = chord["bass_midi"]
            glide_semitones = 0.0
            if step16 in (6, 7):
                u_g = min(1.0, sixteenth_dt / 0.105)
                glide_semitones = 7.0 * (1.0 - math.exp(-u_g * 4.6))
            elif step16 in (14, 15):
                u_g = min(1.0, sixteenth_dt / 0.105)
                glide_semitones = 12.0 * (1.0 - math.exp(-u_g * 5.0))
            bass_hz = midi_to_hz(root_midi + glide_semitones)
            bass_phase = (bass_phase + two_pi * bass_hz / SAMPLE_RATE) % two_pi
            bass_pump = 0.54 + 0.46 * (1.0 - math.exp(-beat_dt * 11.5))
            bass = 0.22 * bass_pump * math.tanh(1.6 * math.sin(bass_phase))

            # 3. Crisp tresillo hi-hats and bar-4 triplet ratchets
            hat = 0.0
            if (beat_num % 4 == 3) and triplet_dt < 0.038:
                n = noise_table[(i * 5) & 16383]
                hat = 0.070 * math.exp(-triplet_dt * 82.0) * n
            elif step16 in (0, 3, 6, 8, 11, 14) and sixteenth_dt < 0.045:
                n = noise_table[(i * 3) & 16383]
                hat = 0.056 * math.exp(-sixteenth_dt * 74.0) * n

            # 4. Tight snare / rimshot backbeat
            snare = 0.0
            if step16 in (4, 8, 15) and sixteenth_dt < 0.115:
                n = noise_table[(i * 7) & 16383]
                rim = math.sin(two_pi * 324.0 * sixteenth_dt) * math.exp(-sixteenth_dt * 42.0)
                amp_s = 0.14 if step16 == 8 else 0.08
                snare = amp_s * (0.62 * n * math.exp(-sixteenth_dt * 28.0) + 0.54 * rim)

            # 5. Dan Tranh crystalline zither plucks
            dan_l = 0.0
            dan_r = 0.0
            if step16 in (0, 2, 3, 6, 8, 10, 11, 14) and sixteenth_dt < 0.23:
                note_midi = chord["dan_tranh"][(sixteenth_num // 2) % 8]
                vib_semi = 0.14 * math.sin(two_pi * 6.0 * sixteenth_dt) * min(1.0, sixteenth_dt / 0.06)
                dt_hz = midi_to_hz(note_midi + vib_semi)
                env_1 = math.exp(-sixteenth_dt * 14.0)
                env_2 = math.exp(-sixteenth_dt * 22.0)
                env_3 = math.exp(-sixteenth_dt * 34.0)
                pluck = 0.11 * (
                    env_1 * math.sin(two_pi * dt_hz * sixteenth_dt)
                    + 0.48 * env_2 * math.sin(two_pi * dt_hz * 2.0 * sixteenth_dt)
                    + 0.26 * env_3 * math.sin(two_pi * dt_hz * 3.0 * sixteenth_dt)
                    + 0.12 * env_3 * math.sin(two_pi * dt_hz * 4.0 * sixteenth_dt)
                )
                pan = 0.5 + 0.36 * math.sin(sixteenth_num * 0.95)
                dan_l = pluck * pan
                dan_r = pluck * (1.0 - pan)

            # 6. Sao Truc bamboo breath shimmer + warm dark pad
            pad_l = 0.0
            pad_r = 0.0
            flute_vib = 1.0 + 0.0025 * math.sin(two_pi * 5.4 * t)
            flute_hz = midi_to_hz(chord["dan_tranh"][0] + 12) * flute_vib
            flute_gate = 0.5 + 0.5 * math.sin(two_pi * (t / (bar_sec * 2.0)))
            flute = 0.024 * flute_gate * (
                math.sin(two_pi * flute_hz * t) + 0.24 * math.sin(two_pi * flute_hz * 2.0 * t)
            )
            pad_l += flute * 0.65
            pad_r += flute * 0.35
            for p_i, m in enumerate(chord["pad"]):
                hz = midi_to_hz(m)
                s1 = math.sin(two_pi * hz * 0.999 * t)
                s2 = math.sin(two_pi * hz * 1.001 * t + 0.4)
                amp = 0.036 / (1.0 + 0.2 * p_i)
                pad_l += amp * s1
                pad_r += amp * s2

            sig_l = max(-0.96, min(0.96, (kick + bass + hat + snare + dan_l + pad_l) * master_env))
            sig_r = max(-0.96, min(0.96, (kick + bass + hat + snare + dan_r + pad_r) * master_env))
            buf.extend(struct.pack("<hh", int(sig_l * 32767.0), int(sig_r * 32767.0)))
            if len(buf) >= 65536:
                wf.writeframes(buf)
                buf.clear()

        if buf:
            wf.writeframes(buf)


def main() -> None:
    project_dir = Path(os.environ.get("AVM_PROJECT_DIR", str(Path(__file__).resolve().parents[1] / "avm")))
    out_wav = project_dir / "assets" / "vdrill-120bpm.wav"
    synthesize_vdrill_wav(out_wav)
    print(f"wrote {out_wav} ({out_wav.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
