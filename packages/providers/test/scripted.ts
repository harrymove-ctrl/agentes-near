/** An SSE body of Anthropic stream events, plus an optional raw tail (e.g. an `error` event). */
export const sse = (events: Record<string, unknown>[], tail?: string) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + (tail ?? "");

/** A fetch that records the request body and answers with a scripted SSE stream. No network. */
export function scripted(body: string, status = 200) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}
