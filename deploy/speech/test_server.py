"""The speech server with fake models, so nothing downloads: python3 -m unittest discover -s deploy/speech"""

import http.client
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server

try:
    import numpy as np
except ImportError:
    np = None


class Fake:
    """Models that hear what they are told; `hold` keeps a recording inside Parakeet until it is set."""

    def __init__(self, shares=None, seconds=3, words="oi, tudo bem?", quiet=False):
        self.shares = shares or {"pt": 0.9, "es": 0.06, "ja": 0.04}
        self.samples = range(int(seconds * server.RATE))
        self.said = words
        self.quiet = quiet
        self.inside = threading.Event()
        self.hold = None
        self.guessed = 0
        self.transcribed = 0

    def decode(self, audio):
        return None if audio == b"not audio" else self.samples

    def silent(self, samples):
        return self.quiet

    def guess(self, samples):
        self.guessed += 1
        return self.shares

    def words(self, samples):
        self.inside.set()
        if self.hold:
            self.hold.wait(5)
        if self.shares.get("boom"):
            raise RuntimeError("the model broke")
        self.transcribed += 1
        return self.said


def form(fields):
    boundary = "----agentes-test"
    body = b""
    for name, value in fields.items():
        if name == "file":
            head = 'Content-Disposition: form-data; name="file"; filename="voice.m4a"\r\nContent-Type: audio/mp4'
        else:
            head, value = f'Content-Disposition: form-data; name="{name}"', value.encode()
        body += f"--{boundary}\r\n{head}\r\n\r\n".encode() + value + b"\r\n"
    return body + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


class Server(unittest.TestCase):
    def start(self, models, workers=2, queue=4, wait=3.0, key=""):
        self.models = models
        self.logged = []
        logging = unittest.mock.patch.object(server, "log", lambda **fields: self.logged.append(fields))
        logging.start()
        self.addCleanup(logging.stop)
        self.speech = server.Speech(models, server.Gate(workers, queue, wait), 0.7, key)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.speech = self.speech
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(self, path, fields=None, key=None, method="POST"):
        body, content_type = form(fields) if fields is not None else (None, None)
        headers = {"Content-Type": content_type} if content_type else {}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def transcribe(self, language="en", key=None, audio=b"\x00\x01audio"):
        fields = {"file": audio, "model": "whisper-1", "language": language, "prompt": "Ada, Theo"}
        status, headers, body = self.call("/v1/audio/transcriptions", {**fields, "response_format": "json"}, key)
        return status, json.loads(body) if body else None, headers


class Routing(Server):
    def test_a_european_language_gets_parakeets_words_in_openais_shape(self):
        self.start(Fake())
        status, body, headers = self.transcribe()
        self.assertEqual((status, body), (200, {"text": "oi, tudo bem?"}))
        self.assertEqual(headers["Content-Type"], "application/json")

    def test_another_language_or_an_unsure_guess_is_not_for_me_and_parakeet_never_runs(self):
        for shares in ({"ja": 0.97, "en": 0.02, "zh": 0.01}, {"pt": 0.45, "gl": 0.35, "ca": 0.2}):
            self.start(Fake(shares))
            status, body, _ = self.transcribe()
            self.assertEqual(status, 422)
            self.assertEqual(body["error"]["code"], "unsupported_language")
            self.assertEqual(self.models.transcribed, 0)

    def test_the_apps_language_is_never_taken_for_the_spoken_one(self):
        self.start(Fake({"pt": 0.98, "en": 0.02}))
        self.assertEqual(self.transcribe(language="ja")[0], 200)
        self.start(Fake({"ja": 0.98, "pt": 0.02}))
        self.assertEqual(self.transcribe(language="pt")[0], 422)

    def test_logs_hold_timings_and_the_guessed_language_never_audio_or_words(self):
        self.start(Fake())
        self.transcribe(audio=b"secret-audio")
        self.assertEqual(self.logged[0]["event"], "transcribed")
        self.assertEqual(set(self.logged[0]), {"event", "seconds", "heard", "share", "waited", "took"})
        self.assertNotIn("tudo bem", json.dumps(self.logged))

    def test_the_european_languages_count_together(self):
        # Portuguese heard partly as Spanish is still Parakeet's: it picks the language itself.
        self.start(Fake({"pt": 0.5, "es": 0.3, "gl": 0.2}))
        self.assertEqual(self.transcribe()[0], 200)

    def test_silence_has_no_words_here_and_no_model_runs(self):
        # A muted microphone, or the key test's second of zeros: Whisper's guess on silence is noise.
        self.start(Fake(quiet=True))
        self.assertEqual(self.transcribe()[:2], (200, {"text": ""}))
        self.assertEqual((self.models.guessed, self.models.transcribed), (0, 0))

    def test_no_words_from_a_recording_with_sound_go_to_the_next_engine(self):
        # The core drops a recording whose words are empty as silent: a slip of Parakeet's must not lose a message.
        self.start(Fake(words=""))
        status, body, _ = self.transcribe()
        self.assertEqual((status, body["error"]["code"]), (422, "no_words"))


class Busy(Server):
    def test_past_the_workers_one_waits_then_hears_busy_and_past_the_queue_at_once(self):
        fake = Fake()
        fake.hold = threading.Event()
        self.start(fake, workers=1, queue=1, wait=0.5)
        first = {}
        running = threading.Thread(target=lambda: first.update(answer=self.transcribe()))
        running.start()
        self.assertTrue(fake.inside.wait(5))
        second = {}
        waiting = threading.Thread(target=lambda: second.update(answer=self.transcribe()))
        waiting.start()
        while self.speech.gate.waiting == 0:
            time.sleep(0.01)
        began = time.monotonic()
        status, body, headers = self.transcribe()
        self.assertEqual((status, body["error"]["code"]), (503, "busy"))
        self.assertLess(time.monotonic() - began, 0.4)
        self.assertEqual(headers["Retry-After"], "1")
        waiting.join()
        self.assertEqual(second["answer"][0], 503)
        fake.hold.set()
        running.join()
        self.assertEqual(first["answer"][0], 200)

    def test_a_waiting_one_starts_when_a_worker_frees_up_in_time(self):
        fake = Fake()
        fake.hold = threading.Event()
        self.start(fake, workers=1, queue=1, wait=5)
        threading.Thread(target=self.transcribe).start()
        self.assertTrue(fake.inside.wait(5))
        second = {}
        waiting = threading.Thread(target=lambda: second.update(answer=self.transcribe()))
        waiting.start()
        while self.speech.gate.waiting == 0:
            time.sleep(0.01)
        fake.hold.set()
        waiting.join()
        self.assertEqual(second["answer"][0], 200)

    def test_a_failure_answers_500_and_frees_its_worker(self):
        fake = Fake({"pt": 0.9, "boom": 0.1})
        self.start(fake, workers=1, queue=0)
        self.assertEqual(self.transcribe()[0], 500)
        fake.shares = {"pt": 1.0}
        self.assertEqual(self.transcribe()[0], 200)

    def test_while_the_models_load_health_and_recordings_say_so(self):
        self.start(None)
        status, _, body = self.call("/health", method="GET")
        self.assertEqual((status, json.loads(body)), (503, {"status": "loading"}))
        self.assertEqual(self.transcribe()[0], 503)
        self.speech.models = Fake()
        self.assertEqual(self.call("/health", method="GET")[0], 200)

    def test_models_that_dont_load_leave_it_up_and_unhealthy_instead_of_restarting(self):
        self.start(None)
        with (
            unittest.mock.patch.object(server, "Models", side_effect=RuntimeError("Invalid input name")),
            unittest.mock.patch.object(server.traceback, "print_exc"),
        ):
            server.load(self.speech, 4)
        self.assertIsNone(self.speech.models)
        self.assertEqual(self.logged[-1], {"event": "load_failed"})
        self.assertEqual(self.call("/health", method="GET")[0], 503)
        self.assertEqual(self.transcribe()[0], 503)


class Requests(Server):
    def test_the_key_guards_recordings_and_warm_ups_not_health(self):
        self.start(Fake(), key="own-key")
        self.assertEqual(self.transcribe()[0], 401)
        self.assertEqual(self.transcribe(key="other")[0], 401)
        self.assertEqual(self.transcribe(key="own-key")[0], 200)
        self.assertEqual(self.call("/v1/warm", key=None)[0], 401)
        self.assertEqual(self.call("/v1/warm", key="own-key")[0], 204)
        self.assertEqual(self.call("/health", method="GET")[0], 200)

    def test_unreadable_too_long_and_malformed_recordings_are_refused_before_parakeet(self):
        self.start(Fake())
        self.assertEqual(self.transcribe(audio=b"not audio")[1]["error"]["code"], "unreadable_audio")
        self.start(Fake(seconds=server.MAX_SECONDS + 1))
        self.assertEqual(self.transcribe()[:1], (413,))
        self.assertEqual(self.call("/v1/audio/transcriptions", {"model": "whisper-1"})[0], 400)
        fields = {"file": b"audio", "response_format": "srt"}
        self.assertEqual(self.call("/v1/audio/transcriptions", fields)[0], 400)
        self.assertEqual(self.models.transcribed, 0)

    def test_a_body_over_the_limit_is_refused_unread(self):
        self.start(Fake())
        connection = http.client.HTTPConnection(self.base.removeprefix("http://"), timeout=10)
        connection.putrequest("POST", "/v1/audio/transcriptions")
        connection.putheader("Content-Type", "multipart/form-data; boundary=x")
        connection.putheader("Content-Length", str(server.MAX_BODY + 1))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()

    def test_form_fields_keep_a_recordings_bytes_exactly(self):
        audio = os.urandom(4096) + b"\r\n\r\n--\r\nname=\"x\"\r\n" + bytes(range(256)) + b"\r"
        body, content_type = form({"file": audio, "language": "pt"})
        self.assertEqual(server.form_fields(content_type, body), {"file": audio, "language": b"pt"})
        self.assertEqual(server.form_fields("application/json", body), {})


@unittest.skipIf(np is None, "needs numpy")
class Audio(unittest.TestCase):
    def test_long_audio_is_cut_at_its_quiet_moments_and_nothing_is_lost(self):
        rate = server.RATE
        samples = np.ones(60 * rate, np.float32)
        for second in (20, 40):
            samples[second * rate : second * rate + rate // 10] = 0
        parts = server.pieces(samples)
        self.assertEqual([len(p) / rate for p in parts], [20.05, 19.95, 20.0])
        self.assertTrue(np.array_equal(np.concatenate(parts), samples))
        self.assertEqual(len(server.pieces(samples[: 25 * rate])), 1)

    def test_silence_is_no_signal_at_all_and_a_quiet_voice_is_still_sound(self):
        models = server.Models.__new__(server.Models)
        models.np = np
        self.assertTrue(models.silent(np.zeros(server.RATE, np.float32)))
        quiet = (0.001 * np.sin(np.arange(server.RATE) / 5)).astype(np.float32)
        self.assertFalse(models.silent(quiet))

    def test_the_guess_shares_out_whispers_language_tokens_alone(self):
        class Session:
            def __init__(self, answer):
                self.answer = answer

            def run(self, names, feeds):
                return [self.answer(names, feeds)]

        logits = np.zeros((1, 1, 51865), np.float32)
        logits[0, 0, 50260] = 4.0
        logits[0, 0, 7] = 50.0  # a word, never a language
        models = server.Models.__new__(server.Models)
        models.np, models.start = np, 50258
        models.features = lambda clip, lens: (np.zeros((1, 80, 3000), np.float32), lens)
        models.encoder = Session(lambda names, feeds: np.zeros((1, 1500, 384), np.float32))
        models.decoder = Session(lambda names, feeds: logits if feeds["input_ids"].tolist() == [[50258]] else None)
        models.ids, models.codes = np.array([50259, 50260, 50261]), ["en", "pt", "ja"]
        shares = models.guess(np.zeros(server.RATE, np.float32))
        self.assertEqual(list(shares), ["en", "pt", "ja"])
        self.assertAlmostEqual(sum(shares.values()), 1.0)
        self.assertGreater(shares["pt"], 0.96)

    @unittest.skipIf(shutil.which("ffmpeg") is None, "needs ffmpeg")
    def test_ffmpeg_reads_the_apps_recordings_as_16_khz_mono(self):
        tone = ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
        # The phone's m4a keeps its index at the end; the web records WebM with Opus.
        recordings = {"voice.m4a": ["-c:a", "aac", "-ar", "22050"], "voice.webm": ["-c:a", "libopus", "-ar", "48000"]}
        with tempfile.TemporaryDirectory() as folder:
            for name, codec in recordings.items():
                path = os.path.join(folder, name)
                subprocess.run([*tone, *codec, path], check=True)
                with open(path, "rb") as file:
                    samples = server.decode(file.read())
                self.assertAlmostEqual(len(samples) / server.RATE, 2, delta=0.1)
        self.assertIsNone(server.decode(b"not audio"))


if __name__ == "__main__":
    unittest.main()
