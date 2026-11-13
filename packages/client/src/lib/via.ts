/** `message.meta.via` (ADR 0119, server-made): the person sent it through a connected AI app. */
export interface AppVia {
  name: string;
  brand: string | null;
}

/** The app a person's message came through, or null; read-only, the server writes it. */
export function appVia(meta: Record<string, unknown> | null | undefined): AppVia | null {
  const via = meta?.via;
  if (!via || typeof via !== "object") return null;
  const { kind, name, brand } = via as Record<string, unknown>;
  if (kind !== "app" || typeof name !== "string" || !name.trim()) return null;
  return { name: name.trim(), brand: typeof brand === "string" ? brand : null };
}
