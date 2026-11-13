import { describe, expect, test } from "bun:test";
import { keepWhole } from "../src/lib/format";
import { storageUsageLine } from "../src/lib/storage";

describe("keepWhole", () => {
  test("a fact's spaces don't break, so a line of facts breaks between them, never inside one", () => {
    expect(keepWhole("há 40 min")).toBe("há 40 min");
    expect(keepWhole("245 kB")).toBe("245 kB");
    expect(keepWhole("Arquivo")).toBe("Arquivo");
    expect(keepWhole("")).toBe("");
  });

  test("the storage line keeps each size whole", () => {
    const t = ((key: string, o?: Record<string, string>) => `${key} ${o?.size ?? ""}`.trim()) as never;
    const line = storageUsageLine(t, "pt-BR", {
      kind: "agentes",
      usage: { platformBytes: 2048, ownBucketBytes: 0, disk: null },
    } as never);
    expect(line).toMatch(/\d \S/);
    expect(line?.split("storage.usage.files ")[1]).not.toContain(" ");
  });
});
