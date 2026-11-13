import { expect, test } from "bun:test";
import { licenseProblem } from "./check-licenses";

test("permissive and weak copyleft licenses pass", () => {
  const ok = ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "0BSD", "(MIT OR CC0-1.0)", "Unlicense", "BlueOak-1.0.0"];
  for (const license of [...ok, "MPL-2.0", "LGPL-3.0-or-later", "BSL-1.0", "CC-BY-4.0", "OFL-1.1", "Python-2.0"]) {
    expect(licenseProblem({ name: "dep", license })).toBeNull();
  }
});

test("copyleft, source-available, proprietary and unknown licenses fail, dual licenses with GPL included", () => {
  const denied = ["GPL-3.0-only", "GPL-2.0+", "GPLv2", "AGPL-3.0", "(MIT OR GPL-3.0)", "SSPL-1.0", "BUSL-1.1"];
  for (const license of [...denied, "BSL 1.1", "Elastic-2.0", "Apache-2.0 WITH Commons-Clause", "UNLICENSED"]) {
    expect(licenseProblem({ name: "dep", license })).toBe(license);
  }
  expect(licenseProblem({ name: "dep", license: "SEE LICENSE IN LICENSE.md" })).toBe("SEE LICENSE IN LICENSE.md");
  const unknown = ["Commercial", "Proprietary", "LicenseRef-Proprietary", "https://example.com/license", "OSL-3.0"];
  for (const license of [...unknown, "CC-BY-NC-4.0", "PolyForm-Noncommercial-1.0.0", "(MIT OR EUPL-1.1+)", "()"]) {
    expect(licenseProblem({ name: "dep", license })).toBe(license);
  }
});

test("a missing or non-SPDX license field fails", () => {
  expect(licenseProblem({ name: "dep" })).toBe("no SPDX license field");
  expect(licenseProblem({ name: "dep", license: " " })).toBe("no SPDX license field");
  expect(licenseProblem({ name: "dep", license: { type: "MIT" } })).toBe("no SPDX license field");
  expect(licenseProblem({})).toBe("no SPDX license field");
});

test("reviewed packages pass", () => {
  expect(licenseProblem({ name: "khroma" })).toBeNull();
  expect(licenseProblem({ name: "node-forge", license: "(BSD-3-Clause OR GPL-2.0)" })).toBeNull();
  expect(licenseProblem({ name: "@zone-eu/mailsplit", license: "(MIT OR EUPL-1.1+)" })).toBeNull();
  expect(licenseProblem({ name: "khroma-fork" })).toBe("no SPDX license field");
});
