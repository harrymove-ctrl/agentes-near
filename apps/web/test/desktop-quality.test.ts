import { expect, test } from "bun:test";
import { desktopEncoding } from "../src/components/desktop/quality";

test("desktop encoding preserves detail on normal links and reduces bytes on constrained links", () => {
  expect(desktopEncoding(false)).toEqual({ quality: 3, compression: 2 });
  expect(desktopEncoding(true)).toEqual({ quality: 6, compression: 2 });
  for (const link of [{ saveData: true }, { effectiveType: "2g" }, { downlink: 0.5 }, { rtt: 400 }]) {
    expect(desktopEncoding(false, link)).toEqual({ quality: 1, compression: 6 });
    expect(desktopEncoding(true, link)).toEqual({ quality: 3, compression: 6 });
  }
  expect(desktopEncoding(true, { downlink: 20, rtt: 40 })).toEqual({ quality: 6, compression: 2 });
});
