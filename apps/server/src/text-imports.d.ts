/** Shell scripts imported as text (`with { type: "text" }`), like the installer `app.ts` serves. */
declare module "*.sh" {
  const text: string;
  export default text;
}

/** The compose file, served as text next to the installer. */
declare module "*.yml" {
  const text: string;
  export default text;
}
