// The favicon from the agent engine: `node packages/ui/scripts/favicon.mjs`.
import { writeFileSync } from "node:fs";
import { bodyPath, bodySvg, eyeShapes } from "../src/agent/engine.js";

const n = 10;
const inner = bodySvg("sky", n)
  .replace(/^<svg[^>]*>/, "")
  .replace(/<\/svg>$/, "");
const eyes = eyeShapes("round")
  .map(
    (e) =>
      `<rect x="${(2 + e.x * 28).toFixed(2)}" y="${(2 + e.y * 28).toFixed(2)}" width="${(e.w * 28).toFixed(2)}" height="${(e.h * 28).toFixed(2)}" rx="${((e.w * 28) / 2).toFixed(2)}"/>`,
  )
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><title>agentes</title><defs><clipPath id="b"><path d="${bodyPath(2, 2, 28)}"/></clipPath></defs><g clip-path="url(#b)" shape-rendering="crispEdges"><g transform="translate(2 2) scale(${28 / n})">${inner}</g></g><g fill="#ffffff">${eyes}</g></svg>\n`;
writeFileSync(new URL("../../../apps/web/public/favicon.svg", import.meta.url), svg);
console.log(svg.length);
