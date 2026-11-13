/**
 * Copies apps/web/public/unavailable.html into docker-compose.yml's `unavailable-page` config, which the https
 * profile's Caddy serves while the app is down: self-hosters download the compose file alone. Run after every
 * change to the page (`bun run sync:unavailable`). packages/setup's tests fail while the two differ.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const page = readFileSync(new URL("apps/web/public/unavailable.html", root), "utf8");
if (page.includes("$"))
  throw new Error("apps/web/public/unavailable.html has a $: Compose would read it as a variable");

const file = new URL("docker-compose.yml", root);
const compose = readFileSync(file, "utf8");
// The block scalar: its lines indented under `content: |`, and the blank lines inside it.
const block = /(\n {2}unavailable-page:\n {4}content: \|\n)((?: {6}.*\n|\n(?= {6}))*)/;
if (!block.test(compose)) throw new Error("docker-compose.yml has no unavailable-page config");
const indented = page
  .replace(/\n$/, "")
  .split("\n")
  .map((line) => (line ? `      ${line}\n` : "\n"))
  .join("");
writeFileSync(
  file,
  compose.replace(block, (_, head: string) => head + indented),
);
