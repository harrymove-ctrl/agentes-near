import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VoicePlayer, type VoicePlayerProps } from "../src/components/VoicePlayer";
import { peaksOf } from "../src/components/voice-recorder";

afterEach(() => cleanup());

const labels: VoicePlayerProps["labels"] = {
  play: "Ouvir",
  pause: "Pausar",
  seek: "Posição",
  speed: (s) => `Velocidade ${s}`,
  expired: "Áudio expirado",
  showText: "Ver texto",
  hideText: "Ocultar texto",
};
const player = (props: Partial<VoicePlayerProps> = {}) =>
  render(<VoicePlayer src="/a" peaks={[0.2, 0.8]} durationMs={12_000} labels={labels} {...props} />);

describe("VoicePlayer", () => {
  test("one line of the words under the wave, opened in place and closed again", () => {
    player({ words: "as palavras" });
    expect(screen.getByRole("button", { name: "Ver texto" }).textContent).toBe("as palavras");
    fireEvent.click(screen.getByRole("button", { name: "Ver texto" }));
    expect(screen.queryByRole("button", { name: "Ver texto" })).toBeNull();
    expect(document.querySelector(".ac-voice__words p")?.textContent).toBe("as palavras");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar texto" }));
    expect(screen.getByRole("button", { name: "Ver texto" })).toBeTruthy();
  });

  test("no words, no button", () => {
    player({ words: null });
    expect(screen.queryByRole("button", { name: "Ver texto" })).toBeNull();
  });

  test("expired: no play, no seek, says so, and the words still open", () => {
    player({ expired: true, words: "as palavras" });
    expect(screen.queryByRole("button", { name: "Ouvir" })).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(document.body.textContent).toContain("Áudio expirado");
    expect(screen.getByRole("button", { name: "Ver texto" })).toBeTruthy();
  });
});

describe("peaksOf", () => {
  test("at most 48 bars, scaled to the loudest", () => {
    const peaks = peaksOf(Array.from({ length: 500 }, (_, i) => (i % 100) / 200));
    expect(peaks.length).toBe(48);
    expect(Math.max(...peaks)).toBe(1);
  });
  test("a short recording keeps what it has", () => {
    expect(peaksOf([0.1, 0.2]).length).toBe(2);
    expect(peaksOf([])).toEqual([]);
  });
});
