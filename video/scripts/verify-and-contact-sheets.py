#!/usr/bin/env python3
from __future__ import annotations
"""
Verifies rendered 60 FPS Agentes NEAR MP4s (ffprobe + loudnorm) and builds
a 16-frame 4x4 QA contact sheet at video/out/contact-sheet.png (plus teaser sheet).
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

    # 16 evenly spaced & scene-keyed timestamps across 94.0s demo
    demo_ts = [
        1.5, 5.5, 9.5, 14.5,
        20.0, 26.5, 33.0, 39.5,
        45.5, 51.5, 57.5, 63.0,
        69.5, 76.5, 84.5, 91.0,
    ]
    teaser_ts = [
        1.2, 3.8, 6.2, 8.8,
        11.5, 13.8, 16.5, 19.5,
        21.8, 24.5, 27.5, 29.8,
        32.5, 36.0, 40.5, 43.2,
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
