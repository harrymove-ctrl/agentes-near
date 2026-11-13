/** An image to load: its absolute URL and the headers it needs (the session, for the backend's own files). */
export interface PhotoSource {
  uri: string;
  headers?: Record<string, string>;
}

/**
 * Where a person's photo loads from. Photos uploaded here are backend paths (`/api/app/avatars/…`) behind
 * the session: they get the API's origin and the app's headers (cookie + `X-Agentes-Client`). Photos from
 * a sign-in provider (Google, GitHub…) are absolute and load as they are, without our cookie. Anything
 * else (empty, `data:`, other schemes) gives null, and the avatar keeps the initial.
 */
export function photoSource(
  url: string | null | undefined,
  apiBase: string,
  headers: Record<string, string>,
): PhotoSource | null {
  const value = url?.trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return { uri: `${apiBase}${value}`, headers };
  if (!/^https?:\/\//i.test(value)) return null;
  const sameOrigin = originOf(value) === originOf(apiBase);
  return sameOrigin ? { uri: value, headers } : { uri: value };
}

function originOf(url: string): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : "";
}
