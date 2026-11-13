"""Speech to text for voice messages (ADR 0100): OpenAI's transcription API in front of NVIDIA Parakeet TDT 0.6B v3 on
ONNX Runtime, for the core's `local` engine (LOCAL_SPEECH_URL=http://speech:8000/v1).

The spoken language comes from the audio, never from the app: Whisper tiny guesses it from the first 30 seconds.
Parakeet knows 25 European languages; when the guess gives them less than SPEECH_LANGUAGE_MIN together, the answer is
422 `unsupported_language`, and a full house answers 503: either way the core's next engine takes the recording at
once. Parakeet hearing no words in a recording that has sound is 422 `no_words` too, since the core drops a recording
whose words are empty as silent. The request's `language`, `prompt` and `model` are ignored. Logs hold timings and the
guessed language, never audio or words.
"""

import hmac
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RATE = 16_000
# -80 dBFS at the loudest: no microphone signal at all (a muted one, or the second of zeros a key test sends).
SILENCE = 1e-4
# The apps record up to 5 minutes, and the core takes 5 s more for the clock's slack.
MAX_SECONDS = 305
# The core's VOICE_MAX_BYTES, and the multipart around it.
MAX_BODY = 25 * 1024 * 1024 + 64 * 1024
# Parakeet TDT 0.6B v3's languages, as Whisper names them.
PARAKEET = frozenset("bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk".split())
MODELS = "/models"


def env(name, default, kind=int):
    return kind(os.environ.get(name) or default)


def log(**fields):
    print(json.dumps(fields), flush=True)


def form_fields(content_type, body):
    """A multipart/form-data body's fields, by name, as bytes."""
    boundary = re.search(r'boundary="?([^";]+)"?', content_type)
    if not content_type.lower().startswith("multipart/form-data") or not boundary:
        return {}
    fields = {}
    for part in body.split(b"--" + boundary.group(1).encode())[1:-1]:
        head, _, value = part.partition(b"\r\n\r\n")
        name = re.search(rb'[\s;]name="([^"]*)"', head)
        if name:
            fields[name.group(1).decode()] = value.removesuffix(b"\r\n")
    return fields


def decode(audio):
    """Whatever ffmpeg reads, as 16 kHz mono float32 samples; None when it can't. From a file, not a pipe: an MP4 may
    keep its index at the end."""
    import numpy as np

    with tempfile.NamedTemporaryFile() as file:
        file.write(audio)
        file.flush()
        command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-threads", "1", "-i", file.name, "-map", "0:a:0"]
        command += ["-t", str(MAX_SECONDS + 1), "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1"]
        try:
            run = subprocess.run(command, capture_output=True, timeout=60, check=False)
        except subprocess.TimeoutExpired:
            return None
    return np.frombuffer(run.stdout, np.float32).copy() if run.returncode == 0 and run.stdout else None


def pieces(samples, low=15 * RATE, high=25 * RATE, step=RATE // 10):
    """Audio longer than `high` samples, cut at its quietest tenth of a second between `low` and `high` into each piece:
    onnx-asr warns past 20 to 30 seconds at once, and memory grows with the length."""
    out, start = [], 0
    while len(samples) - start > high:
        energy = (samples[start + low : start + high].reshape(-1, step) ** 2).sum(axis=1)
        cut = start + low + int(energy.argmin()) * step + step // 2
        out.append(samples[start:cut])
        start = cut
    out.append(samples[start:])
    return out


class Models:
    """Parakeet and the language guess, loaded once for every worker, on one pool of `threads` ONNX Runtime threads: a
    recording alone gets them all, recordings at once share them."""

    def __init__(self, threads):
        import numpy as np
        import onnx_asr
        import onnxruntime as rt
        from onnx_asr.preprocessors.numpy_preprocessor import WhisperPreprocessorNumpy

        options = rt.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        # The machine is shared: idle threads sleep instead of spinning, and a note's memory goes back when it ends.
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.enable_cpu_mem_arena = False
        cpu = ["CPUExecutionProvider"]
        self.np = np
        self.parakeet = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v3", f"{MODELS}/parakeet", quantization="int8", sess_options=options, providers=cpu
        )
        self.features = WhisperPreprocessorNumpy("whisper80")
        self.encoder = rt.InferenceSession(f"{MODELS}/whisper/encoder_model_int8.onnx", options, providers=cpu)
        self.decoder = rt.InferenceSession(f"{MODELS}/whisper/decoder_model_int8.onnx", options, providers=cpu)
        with open(f"{MODELS}/whisper/added_tokens.json", encoding="utf-8") as file:
            tokens = json.load(file)
        self.start = tokens["<|startoftranscript|>"]
        # Whisper's language tokens sit between these two.
        languages = sorted((i, token[2:-2]) for token, i in tokens.items() if self.start < i < tokens["<|translate|>"])
        self.ids = np.array([i for i, _ in languages])
        self.codes = [code for _, code in languages]
        # A second of silence through both: a model that doesn't load or run stops the server here, not a recording.
        silence = np.zeros(RATE, np.float32)
        self.guess(silence)
        self.words(silence)

    decode = staticmethod(decode)

    def silent(self, samples):
        return float(self.np.abs(samples).max()) < SILENCE

    def guess(self, samples):
        """Each language's share of Whisper tiny's first token, over the first 30 seconds."""
        np = self.np
        clip = samples[None, : 30 * RATE]
        features, _ = self.features(clip, np.array([clip.shape[1]]))
        (hidden,) = self.encoder.run(["last_hidden_state"], {"input_features": features})
        start = np.array([[self.start]], np.int64)
        (logits,) = self.decoder.run(["logits"], {"input_ids": start, "encoder_hidden_states": hidden})
        scores = logits[0, -1, self.ids].astype(np.float64)
        shares = np.exp(scores - scores.max())
        return dict(zip(self.codes, (shares / shares.sum()).tolist(), strict=True))

    def words(self, samples):
        return " ".join(text.strip() for text in map(self.parakeet.recognize, pieces(samples)) if text.strip())


class Gate:
    """`workers` recordings at once and `queue` waiting; one that can't start within `wait` seconds is told busy."""

    def __init__(self, workers, queue, wait):
        self.slots = threading.BoundedSemaphore(workers)
        self.lock = threading.Lock()
        self.waiting = 0
        self.queue = queue
        self.wait = wait

    def enter(self):
        if self.slots.acquire(blocking=False):
            return True
        with self.lock:
            if self.waiting >= self.queue:
                return False
            self.waiting += 1
        try:
            return self.slots.acquire(timeout=self.wait)
        finally:
            with self.lock:
                self.waiting -= 1

    def leave(self):
        self.slots.release()


def failure(status, code, message):
    kind = "server_error" if status >= 500 else "invalid_request_error"
    return status, {"error": {"message": message, "type": kind, "code": code}}


class Speech:
    def __init__(self, models, gate, language_min, key=""):
        self.models = models
        self.gate = gate
        self.language_min = language_min
        self.key = key

    def transcribe(self, audio):
        asked = time.monotonic()
        if self.models is None or not self.gate.enter():
            log(event="busy")
            return failure(503, "busy", "Busy or still loading: the next engine should take this one")
        try:
            started = time.monotonic()
            samples = self.models.decode(audio)
            if samples is None:
                return failure(400, "unreadable_audio", "ffmpeg can't read this recording")
            seconds = round(len(samples) / RATE, 1)
            if seconds > MAX_SECONDS:
                return failure(413, "too_long", f"Recordings go up to {MAX_SECONDS} seconds")
            if self.models.silent(samples):
                log(event="silent", seconds=seconds)
                return 200, {"text": ""}
            shares = self.models.guess(samples)
            heard = max(shares, key=shares.get)
            share = round(sum(p for code, p in shares.items() if code in PARAKEET), 3)
            if share < self.language_min:
                log(event="not_for_me", seconds=seconds, heard=heard, share=share)
                return failure(422, "unsupported_language", f"Parakeet doesn't know this language (it heard {heard})")
            text = self.models.words(samples)
            if not text:
                log(event="no_words", seconds=seconds, heard=heard, share=share)
                return failure(422, "no_words", "Parakeet heard no words: the next engine should try this one")
            waited, took = round(started - asked, 2), round(time.monotonic() - started, 2)
            log(event="transcribed", seconds=seconds, heard=heard, share=share, waited=waited, took=took)
            return 200, {"text": text}
        except Exception as error:  # Any failure is the next engine's turn; the server stays up.
            log(event="failed", error=type(error).__name__)
            return failure(500, "failed", "The recording couldn't be transcribed here")
        finally:
            self.gate.leave()


class Handler(BaseHTTPRequestHandler):
    server_version = "agentes-speech"
    # A client that stops sending halfway frees its thread.
    timeout = 30

    def log_message(self, *args):
        pass

    def send(self, status, body=None, headers=()):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.send(*failure(404, "not_found", "Not found"))
        if self.server.speech.models is None:
            return self.send(503, {"status": "loading"})
        return self.send(200, {"status": "ok"})

    def do_POST(self):
        speech = self.server.speech
        if self.path not in ("/v1/audio/transcriptions", "/v1/warm"):
            return self.send(*failure(404, "not_found", "Not found"))
        given = self.headers.get("Authorization", "").encode("latin-1")
        if speech.key and not hmac.compare_digest(given, f"Bearer {speech.key}".encode()):
            return self.send(*failure(401, "invalid_api_key", "Wrong or missing key"))
        if self.path == "/v1/warm":
            # The models stay loaded: there is nothing to warm.
            return self.send(204)
        length = self.headers.get("Content-Length", "")
        if not length.isdigit():
            return self.send(*failure(411, "length_required", "Send the body with its Content-Length"))
        if int(length) > MAX_BODY:
            return self.send(*failure(413, "too_large", "The recording is too large"))
        fields = form_fields(self.headers.get("Content-Type", ""), self.rfile.read(int(length)))
        if not fields.get("file"):
            return self.send(*failure(400, "no_file", "Send the recording in the field file"))
        if fields.get("response_format", b"json") != b"json":
            return self.send(*failure(400, "json_only", "This server answers response_format json only"))
        status, body = speech.transcribe(fields["file"])
        return self.send(status, body, [("Retry-After", "1")] if status == 503 else [])


def load(speech, threads):
    """The models into `speech`. Ones that don't load leave it answering 503 and unhealthy, but up: a restart would load
    the same files again, taking the shared machine's CPU each time for nothing."""
    started = time.monotonic()
    try:
        speech.models = Models(threads)
    except Exception:
        traceback.print_exc()
        log(event="load_failed")
        return
    log(event="ready", threads=threads, took=round(time.monotonic() - started, 1))


def main():
    workers = env("SPEECH_WORKERS", 2)
    gate = Gate(workers, env("SPEECH_QUEUE", 4), env("SPEECH_WAIT_SECONDS", 3, float))
    speech = Speech(None, gate, env("SPEECH_LANGUAGE_MIN", 0.7, float), os.environ.get("SPEECH_API_KEY", ""))
    server = ThreadingHTTPServer(("", 8000), Handler)
    server.speech = speech
    # As PID 1 without an init, Python would ignore SIGTERM.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    load(speech, workers * env("SPEECH_THREADS", 2))
    threading.Event().wait()


if __name__ == "__main__":
    main()
