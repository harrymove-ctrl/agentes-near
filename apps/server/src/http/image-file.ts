/**
 * A stored image (a photo, a logo, an icon) as its file: named by its content hash, so cached for good; never run as a
 * page. `headers` adds to or replaces these.
 */
export const imageFile = (file: { body: Uint8Array; contentType: string }, headers: Record<string, string> = {}) =>
  new Response(file.body, {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, max-age=31536000, immutable",
      ...headers,
    },
  });
