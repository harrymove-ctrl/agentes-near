import { expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { leaves } from "./leaves";

/** Product decision: no provider, executor or feature is labelled as still in testing. */
test("no copy says a feature is still being tested", () => {
  const said = [...leaves(en), ...leaves(ptBR)].filter(
    ([, v]) => typeof v === "string" && /still being tested|in testing|ainda em teste|em testes?\b(?!…)/i.test(v),
  );
  expect(said).toEqual([]);
});
