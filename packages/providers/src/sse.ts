/**
 * The `data` of each server-sent event in a response body, its `data:` lines joined, for an API spoken over plain
 * `fetch` (the SDKs read their own streams). Lines may end in LF or CRLF, and an event may span chunks.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (let done = false; !done; ) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (events.pop() ?? "");
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    // A reader that stops early (an error event, a reply it can't read) closes the connection.
    reader.cancel().catch(() => {});
  }
}
