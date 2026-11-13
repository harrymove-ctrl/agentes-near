#!/usr/bin/env python3
from __future__ import annotations
"""
Verifies rendered 60 FPS Agentes NEAR Phase 6 MP4s (90.0s Master + 30.0s X Teaser)
via ffprobe + loudnorm and builds 16-frame 4x4 QA contact sheets.

Also generates flyover-stills.png: 7 stills from ActLandingFlyover3D segment
(Act 2 in the 90s demo) at internal timestamps 0, 1.6, 2.5, 5, 6.5, 9.3, 11s
which map to absolute seconds 15+0=15.0, 15+1.6=16.6, 15+2.5=17.5, 15+5=20.0,
15+6.5=21.5, 15+9.3=24.3, 15+11=26.0 in the 90s demo.
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path

VIDEO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = VIDEO_ROOT / "out"


def probe_mp4(mp4: Path) -> dict:
    raw = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate",
            "-of", "json", str(mp4),
        ],
        text=True,
    )
    data = json.loads(raw)
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(mp4), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    m = re.search(r"\{\s*\"input_i\"[\s\S]*?\}", proc.stderr)
    loud = json.loads(m.group(0)) if m else {}
    return {"ffprobe": data, "loudnorm": loud}


def build_contact_sheet(mp4: Path, out_png: Path, timestamps: list[float]) -> None:
    n = len(timestamps)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        extracted: list[Path] = []
        for idx, ts in enumerate(timestamps):
            fp = tmp_dir / f"frame_{idx:02d}.png"
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error",
                "-ss", f"{ts:.2f}", "-i", str(mp4),
                "-frames:v", "1", "-vf", "scale=480:270", str(fp),
            ], check=True)
            extracted.append(fp)

        inputs: list[str] = []
        for fp in extracted:
            inputs.extend(["-i", str(fp)])

        cols = 4
        rows = (n + cols - 1) // cols
        layout_parts: list[str] = []
        for k in range(n):
            col = k % cols
            row = k // cols
            layout_parts.append(f"{col * 480}_{row * 270}")
        in_labels = "".join(f"[{k}:v]" for k in range(n))
        flt = f"{in_labels}xstack=inputs={n}:layout={'|'.join(layout_parts)}[v]"

        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            *inputs,
            "-filter_complex", flt,
            "-map", "[v]", str(out_png),
        ], check=True)


def build_flyover_stills(mp4: Path, out_png: Path) -> None:
    """
    7 stills from ActLandingFlyover3D (Act 2, 15..29.5s in 90s demo).
    Internal Act2 timestamps: 0, 1.6, 2.5, 5, 6.5, 9.3, 11s.
    Absolute timestamps in 90s demo: +15s offset.
    """
    act2_internal = [0.0, 1.6, 2.5, 5.0, 6.5, 9.3, 11.0]
    abs_ts = [15.0 + t for t in act2_internal]
    build_contact_sheet(mp4, out_png, abs_ts)


def main() -> None:
    demo = OUT_DIR / "agentes-near-demo.mp4"
    teaser = OUT_DIR / "agentes-near-x-teaser.mp4"

    d_info = probe_mp4(demo)
    t_info = probe_mp4(teaser)

    # 16-frame contact sheet: sample all 8 acts across 90.0s demo
    # Act1 Showreel (0..15s), Act2 Flyover (15..29.5s), Act3-8 (29.5..90s)
    demo_ts = [
        1.5, 5.0, 9.5, 13.5,         # Act1 Showreel (kinetic, rings, beat-snap, lockup)
        16.0, 19.5, 23.5, 27.0,       # Act2 Flyover (approach, pan, overhead, dive)
        31.0, 35.0, 39.0, 44.0,       # Act3 Yapp99K, Act4 Cutline, Act5 Fitting early, mid
        55.0, 67.0, 76.5, 87.5,       # Act5 Fitting late, Act6 Graph, Act7 Molote, Act8 Lockup
    ]
    # 16-frame contact sheet across 30.0s teaser
    teaser_ts = [
        1.5, 4.5, 7.5, 10.5,
        13.5, 16.0, 19.0, 22.0,
        24.0, 25.5, 27.0, 28.5,
        # (pad to 16 with final flyover stills if teaser is 30s only)
        29.0, 29.3, 29.6, 29.8,
    ]

    cs_demo   = OUT_DIR / "contact-sheet.png"
    cs_teaser = OUT_DIR / "contact-sheet-teaser.png"
    cs_flyover = OUT_DIR / "flyover-stills.png"

    build_contact_sheet(demo, cs_demo, demo_ts)
    build_contact_sheet(teaser, cs_teaser, teaser_ts)
    build_flyover_stills(demo, cs_flyover)

    summary = {
        "phase": 6,
        "fps": 60,
        "demo": {
            "path": str(demo),
            "expected_duration_sec": 90.0,
            "expected_frames": 5400,
            "duration": d_info["ffprobe"]["format"]["duration"],
            "size_bytes": int(d_info["ffprobe"]["format"]["size"]),
            "streams": d_info["ffprobe"]["streams"],
            "input_i_lufs": d_info["loudnorm"].get("input_i"),
            "input_tp_dbtp": d_info["loudnorm"].get("input_tp"),
        },
        "teaser": {
            "path": str(teaser),
            "expected_duration_sec": 30.0,
            "expected_frames": 1800,
            "duration": t_info["ffprobe"]["format"]["duration"],
            "size_bytes": int(t_info["ffprobe"]["format"]["size"]),
            "streams": t_info["ffprobe"]["streams"],
            "input_i_lufs": t_info["loudnorm"].get("input_i"),
            "input_tp_dbtp": t_info["loudnorm"].get("input_tp"),
        },
        "contact_sheets": [str(cs_demo), str(cs_teaser), str(cs_flyover)],
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
