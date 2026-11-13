#!/usr/bin/env python3
from __future__ import annotations
"""
Verifies rendered 30 FPS Agentes NEAR Phase 5 MP4s (240.0s Master + 60.0s X Teaser)
via ffprobe + loudnorm and builds 16-frame 4x4 QA contact sheets sampling all 7 chapters.
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
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate",
            "-of",
            "json",
            str(mp4),
        ],
        text=True,
    )
    data = json.loads(raw)
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(mp4), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    m = re.search(r"\{\s*\"input_i\"[\s\S]*?\}", proc.stderr)
    loud = json.loads(m.group(0)) if m else {}
    return {"ffprobe": data, "loudnorm": loud}


def build_contact_sheet(mp4: Path, out_png: Path, timestamps: list[float]) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        extracted: list[Path] = []
        for idx, ts in enumerate(timestamps):
            fp = tmp_dir / f"frame_{idx:02d}.png"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{ts:.2f}",
                    "-i",
                    str(mp4),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=480:270",
                    str(fp),
                ],
                check=True,
            )
            extracted.append(fp)

        inputs: list[str] = []
        for fp in extracted:
            inputs.extend(["-i", str(fp)])

        layout_parts: list[str] = []
        for k in range(16):
            col = k % 4
            row = k // 4
            layout_parts.append(f"{col * 480}_{row * 270}")
        in_labels = "".join(f"[{k}:v]" for k in range(16))
        flt = f"{in_labels}xstack=inputs=16:layout={'|'.join(layout_parts)}[v]"

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                *inputs,
                "-filter_complex",
                flt,
                "-map",
                "[v]",
                str(out_png),
            ],
            check=True,
        )


def main() -> None:
    demo = OUT_DIR / "agentes-near-demo.mp4"
    teaser = OUT_DIR / "agentes-near-x-teaser.mp4"

    d_info = probe_mp4(demo)
    t_info = probe_mp4(teaser)

    # Sample all 7 chapters (both signature Acts and StepByStepShowcases) across 240.0s demo
    demo_ts = [
        3.5, 16.0, 29.5, 42.0,     # Ch1 Act1Moving, Ch1 3-Problems Showcase, Ch1 99K Act2, Ch2 Act4Fitting
        58.0, 73.5, 92.0, 104.0,   # Ch2 3-Col Showcase, Ch3 Act3Cutline, Ch3 1Click Step 2, Ch3 1Click Step 3
        114.0, 128.0, 142.0, 155.0,# Ch4 Act6Molote S-A-F-E, Ch4 OutLayer Step 1, Ch4 OutLayer Step 3, Ch5 Act5Graph
        172.0, 208.0, 227.0, 236.5,# Ch5 Winner Mechanics, Ch6 @mira Studio Showcase, Ch7 Quickstart, Ch7 ONE Lockup
    ]
    # Sample all 7 chapters across 60.0s teaser
    teaser_ts = [
        1.5, 5.5, 10.5, 14.5,
        18.0, 21.5, 24.5, 28.5,
        32.5, 37.5, 41.5, 46.0,
        49.5, 53.5, 56.0, 58.5,
    ]

    cs_demo = OUT_DIR / "contact-sheet.png"
    cs_teaser = OUT_DIR / "contact-sheet-teaser.png"
    build_contact_sheet(demo, cs_demo, demo_ts)
    build_contact_sheet(teaser, cs_teaser, teaser_ts)

    summary = {
        "demo": {
            "path": str(demo),
            "duration": d_info["ffprobe"]["format"]["duration"],
            "size_bytes": int(d_info["ffprobe"]["format"]["size"]),
            "streams": d_info["ffprobe"]["streams"],
            "input_i_lufs": d_info["loudnorm"].get("input_i"),
            "input_tp_dbtp": d_info["loudnorm"].get("input_tp"),
        },
        "teaser": {
            "path": str(teaser),
            "duration": t_info["ffprobe"]["format"]["duration"],
            "size_bytes": int(t_info["ffprobe"]["format"]["size"]),
            "streams": t_info["ffprobe"]["streams"],
            "input_i_lufs": t_info["loudnorm"].get("input_i"),
            "input_tp_dbtp": t_info["loudnorm"].get("input_tp"),
        },
        "contact_sheets": [str(cs_demo), str(cs_teaser)],
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
