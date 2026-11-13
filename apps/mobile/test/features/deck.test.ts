import { describe, expect, test } from "bun:test";
import { effortReach, effortStep } from "../../src/features/ai/effort";
import { deckCard, deckIndex, deckTarget, wrapPlace } from "../../src/features/files/deck";

const WIDTH = 286;

describe("a deck of pictures", () => {
  test("at rest, the picture on top is flat and in front of the rest", () => {
    const top = deckCard(0, 0, 4, WIDTH);
    expect(top).toMatchObject({ x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 });
    expect(top.z).toBeGreaterThan(deckCard(1, 0, 4, WIDTH).z);
    expect(deckCard(1, 0, 4, WIDTH).z).toBeGreaterThan(deckCard(2, 0, 4, WIDTH).z);
  });

  test("two lean out from behind; a fourth waits unseen", () => {
    expect(deckCard(1, 0, 4, WIDTH).rotate).toBeLessThan(0);
    expect(deckCard(2, 0, 4, WIDTH).rotate).toBeGreaterThan(0);
    expect(deckCard(3, 0, 4, WIDTH).opacity).toBe(0);
  });

  test("a card leaves past the side, changes layers off the screen and ends behind the others", () => {
    const halfway = deckCard(0, 0.5, 4, WIDTH);
    expect(halfway.x).toBeLessThan(-WIDTH);
    expect(deckCard(0, 0.49, 4, WIDTH).z).toBeGreaterThan(deckCard(1, 0.49, 4, WIDTH).z);
    expect(deckCard(0, 0.51, 4, WIDTH).z).toBeLessThan(deckCard(1, 0.51, 4, WIDTH).z);
    expect(deckCard(0, 1, 4, WIDTH)).toEqual(deckCard(3, 0, 4, WIDTH));
  });

  test("the next card takes the top as the first one leaves", () => {
    expect(deckCard(1, 1, 4, WIDTH)).toEqual(deckCard(0, 0, 4, WIDTH));
    expect(deckCard(1, 0.5, 4, WIDTH).scale).toBeGreaterThan(deckCard(1, 0, 4, WIDTH).scale);
  });

  test("the deck loops both ways, and two pictures work", () => {
    expect(deckCard(2, 5, 3, WIDTH)).toEqual(deckCard(2, 2, 3, WIDTH));
    expect(deckCard(0, -1, 3, WIDTH)).toEqual(deckCard(0, 2, 3, WIDTH));
    expect(deckCard(1, 0, 2, WIDTH).opacity).toBe(1);
    expect(deckCard(0, 1, 2, WIDTH)).toEqual(deckCard(1, 0, 2, WIDTH));
  });

  test("the place wraps to a picture", () => {
    expect(wrapPlace(-1, 4)).toBe(3);
    expect(wrapPlace(9, 4)).toBe(1);
    expect(deckIndex(0.4, 4)).toBe(0);
    expect(deckIndex(0.6, 4)).toBe(1);
    expect(deckIndex(-0.6, 4)).toBe(3);
  });

  test("letting go: a flick turns the deck, a short drag goes back", () => {
    expect(deckTarget(0, 0.01, -900)).toBe(1); // flick left: the next one
    expect(deckTarget(0, -0.01, 900)).toBe(-1); // flick right: the last one back
    expect(deckTarget(2, 2.1, 0)).toBe(3);
    expect(deckTarget(2, 1.9, 0)).toBe(1);
    expect(deckTarget(2, 2.01, 0)).toBe(2);
  });
});

describe("the effort ramp", () => {
  test("the fill follows the finger, and never empties", () => {
    expect(effortReach(164, 328, 4)).toBe(2);
    expect(effortReach(-20, 328, 4)).toBe(0.3);
    expect(effortReach(400, 328, 4)).toBe(4);
    expect(effortReach(10, 0, 4)).toBe(0.3);
  });

  test("the step is the one the fill has entered", () => {
    expect(effortStep(0.3, 4)).toBe(0);
    expect(effortStep(1, 4)).toBe(0);
    expect(effortStep(1.01, 4)).toBe(1);
    expect(effortStep(4, 4)).toBe(3);
  });
});
