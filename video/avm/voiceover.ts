/**
 * The voice-over of one video, from its slots: each slot's `voice` line starts just after the slot does.
 *   bun voiceover.ts --video <id> → videos/<id>/.build/voice.{f32,json}, videos/<id>/out/<product>-<id>.srt
 * Lines are cached in /.cache/tts; only changed lines (and their neighbours) are billed. Fix every overrun
 * (shorten the line or give the slot another bar) before building scenes on the timing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { voiceCli } from "../../libs/film-kit/src/product/product.ts";
import { videoArg, videoDir } from "../../libs/film-kit/src/product/project.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
await voiceCli(HERE);

const pcmPath = join(videoDir(HERE, videoArg(HERE)), ".build", "voice.f32");
if (existsSync(pcmPath)) {
  const raw = readFileSync(pcmPath);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const SR = 48_000;
  const look = Math.round(0.002 * SR);
  const ceil = 0.26;
  const release = Math.exp(-1 / (0.025 * SR));
  let env = 0;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let localMax = 0;
    const end = Math.min(samples.length, i + look);
    for (let j = i; j < end; j++) {
      const a = Math.abs(samples[j]!);
      if (a > localMax) localMax = a;
    }
    env = localMax > env ? localMax : env * release + localMax * (1 - release);
    const gain = env > ceil ? ceil / env : 1;
    out[i] = samples[i]! * gain;
  }
  writeFileSync(pcmPath, Buffer.from(out.buffer));
  console.log(`tamed plosive peaks in ${pcmPath} (ceil=${ceil})`);
}
