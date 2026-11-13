/** Files the runner embeds as text (`with { type: "text" }`: Bun inlines them in the bundle). */
declare module "*.py" {
  const source: string;
  export default source;
}

/** Images as base64 text (`assets/*.png.b64`). */
declare module "*.b64" {
  const base64: string;
  export default base64;
}

/** Offline browser assets embedded verbatim. */
declare module "*.txt" {
  const source: string;
  export default source;
}
