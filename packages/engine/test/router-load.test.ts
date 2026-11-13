import { expect, test } from "bun:test";
// First, before anything else of the engine: router.ts loads router-jev.ts back through messages.ts and judge.ts,
// so router-jev.ts may read nothing of router.ts while it loads.
import { withAddressee } from "../src/router";

test("router.ts loads before the rest of the engine", () => {
  expect(withAddressee({ agents: [] }, new Map())).toEqual({ agents: [] });
});
