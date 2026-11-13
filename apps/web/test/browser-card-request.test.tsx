import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

// @ts-expect-error @babel/core ships no types
import { transformSync } from "@babel/core";
import { act, cleanup, render } from "@testing-library/react";
import reactCompiler from "babel-plugin-react-compiler";
import { requestBrowserCard, useBrowserCardRequest } from "@/components/browser/open";

function Card({ agentId, handoffId }: { agentId?: string; handoffId?: string }) {
  return <output>{useBrowserCardRequest({ agentId, handoffId }) ? "open" : "closed"}</output>;
}

describe("a request to open a browser card", () => {
  afterEach(cleanup);

  test("reaches a card already drawn, once", () => {
    const one = render(<Card agentId="a" />);
    act(() => requestBrowserCard({ agentId: "a" }));
    expect(one.container.textContent).toBe("open");
    expect(render(<Card agentId="a" />).container.textContent).toBe("closed");
  });

  test("waits for the card that matches it", () => {
    requestBrowserCard({ handoffId: "h" });
    expect(render(<Card handoffId="other" />).container.textContent).toBe("closed");
    expect(render(<Card handoffId="h" />).container.textContent).toBe("open");
  });

  test("as built, the request is read before it's cleared", async () => {
    const path = new URL("../src/components/browser/open.ts", import.meta.url).pathname;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
    const built = transformSync(js, {
      filename: path.replace(/\.ts$/, ".js"),
      babelrc: false,
      configFile: false,
      plugins: [[reactCompiler, {}]],
    })?.code;
    expect(built).toContain("pending.at");
    expect(built).not.toMatch(/pending = null;\s+setHit\(pending\.at\)/);
  });
});
