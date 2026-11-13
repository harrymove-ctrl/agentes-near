/** Read a public webhook's raw bytes without buffering more than its allowed wire size; null past it. */
export async function readWebhookBytes(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null;
  }
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read a public webhook as text without buffering more than its allowed wire size. */
export async function readWebhookText(req: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readWebhookBytes(req, maxBytes);
  return bytes && new TextDecoder().decode(bytes);
}
