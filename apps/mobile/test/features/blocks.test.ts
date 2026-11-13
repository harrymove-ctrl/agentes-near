import { describe, expect, test } from "bun:test";
import {
  blockMayLoad,
  faceOverlap,
  hostScript,
  MAX_LIVE_BLOCKS,
  themeScript,
  withLiveBlock,
} from "../../src/features/blocks/logic";

describe("live blocks on the phone", () => {
  test("a block never leaves its page", () => {
    expect(blockMayLoad("about:blank")).toBe(true);
    for (const url of [
      "https://example.com/?d=1",
      "http://x.test",
      "tel:123",
      "intent://x",
      "file:///etc",
      "data:text/html,a",
    ]) {
      expect(blockMayLoad(url)).toBe(false);
    }
  });

  test("only the newest frames run", () => {
    let live: string[] = [];
    for (const key of ["a", "b", "c", "d"]) live = withLiveBlock(live, key);
    expect(live).toEqual(["b", "c", "d"]);
    expect(live).toHaveLength(MAX_LIVE_BLOCKS);
    expect(withLiveBlock(live, "b")).toEqual(["c", "d", "b"]);
  });

  test("a theme reaches the page without a reload", () => {
    expect(themeScript("dark")).toBe('window.__agentesHost&&window.__agentesHost({"theme":"dark"});true;');
  });

  test("everyone's state reaches the running page the same way", () => {
    expect(hostScript({ state: { nome: "Bento" }, who: {} })).toBe(
      'window.__agentesHost&&window.__agentesHost({"state":{"nome":"Bento"},"who":{}});true;',
    );
  });
});

test("a vote's voters stack as the web's do: 6 under a photo, past initials only the rings over each other", () => {
  expect(faceOverlap(true)).toEqual({ marginLeft: -6 });
  expect(faceOverlap(false)).toEqual({ marginLeft: -4 });
});
