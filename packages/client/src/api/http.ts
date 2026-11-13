/**
 * Fetch wrapper for the private app API. The web app calls it on the same
 * origin with its cookie session; the phone app passes `baseUrl` and sends its
 * own session headers (`headers`). Errors come back as
 * `{ error: { code, message } }` and are thrown as `ApiError`. Writes are
 * always JSON: the API refuses anything else (CSRF).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Details for the translated text (`{ error: { params } }`), e.g. who can't see a range. */
  readonly params?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, params?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (params) this.params = params;
  }
}

/**
 * A request that got no answer at all: `fetch` threw (no network, the address out of reach, the connection cut).
 * Still the `TypeError` that `fetch` throws, so what reads one as "no network" keeps working.
 */
export class NetworkError extends TypeError {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "NetworkError";
  }
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: Method;
  json?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** This request's own, such as the bot check's token. */
  headers?: Record<string, string>;
}

/** Headers added to every request (the phone app's session cookie and client marker). */
export type HeadersSource = () => Record<string, string> | Promise<Record<string, string>>;

/**
 * How long a read (`GET`) waits for its whole answer. A browser can keep a request on a dead connection for minutes
 * (after a sleep or a network change): the screen waiting on it stayed old and its loading bar never ended. Past this
 * it fails as a `NetworkError`, which the query client tries again.
 */
export const READ_TIMEOUT_MS = 30_000;

/** Where requests go and how. Defaults: same origin, the global `fetch`, the browser's cookie. */
export interface TransportOptions {
  /** e.g. "https://app.agentes.chat" (no trailing slash needed); "" or absent = same origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  headers?: HeadersSource;
  /** `READ_TIMEOUT_MS` unless given. */
  readTimeoutMs?: number;
}

interface Transport {
  fetch: FetchLike;
  base: string;
  /** Same origin sends the browser cookie; another origin sends only what `headers` gives. */
  credentials: "omit" | "same-origin";
  /** The caller's headers; absent on the web (no extra tick before `fetch`). */
  headers?: HeadersSource;
}

function transport(options: TransportOptions): Transport {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    fetch: async (input, init) => {
      try {
        return await send(input, init);
      } catch (error) {
        throw error instanceof TypeError ? new NetworkError(error) : error;
      }
    },
    base,
    credentials: base ? "omit" : "same-origin",
    headers: options.headers,
  };
}

export function createRequester(options: TransportOptions = {}) {
  const t = transport(options);
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? (options.json === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {
      ...(t.headers ? await t.headers() : {}),
      ...options.headers,
      accept: "application/json",
    };
    // A DELETE goes bare unless it carries something (the proof that deletes an account).
    const hasBody = method !== "GET" && (method !== "DELETE" || options.json !== undefined);
    if (hasBody) headers["content-type"] = "application/json";
    let url = t.base + path;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) if (v !== undefined && v !== null) params.set(k, String(v));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    // Only reads: a write cut short may still have happened on the server.
    const deadline = method === "GET" ? new AbortController() : null;
    const timer = deadline ? setTimeout(() => deadline.abort(), readTimeoutMs) : null;
    try {
      const res = await t.fetch(url, {
        method,
        headers,
        credentials: t.credentials,
        body: hasBody ? JSON.stringify(options.json ?? {}) : undefined,
        ...(deadline ? { signal: deadline.signal } : {}),
      });
      return await parseResponse<T>(res);
    } catch (error) {
      if (deadline?.signal.aborted && !(error instanceof ApiError || error instanceof NetworkError))
        throw new NetworkError(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** JSON body, or `ApiError` from `{ error: { code, message } }`. */
async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const raw = (
      data as { error?: string | { code?: string; message?: string; params?: Record<string, unknown> } } | undefined
    )?.error;
    // Some routes answer `{ error: "auth" }`: the string is the code.
    const error = typeof raw === "string" ? { code: raw, message: raw, params: undefined } : raw;
    throw new ApiError(
      res.status,
      error?.code ?? `http_${res.status}`,
      error?.message ?? (res.statusText || `HTTP ${res.status}`),
      error?.params && typeof error.params === "object" ? error.params : undefined,
    );
  }
  return data as T;
}

export type Requester = ReturnType<typeof createRequester>;

/**
 * Multipart uploads (only the Drive's two file routes accept them) and raw
 * downloads (file previews). Same origin, cookie and headers as the JSON requests.
 */
export function createFileRequester(options: TransportOptions = {}) {
  const t = transport(options);
  return {
    /** `POST` a form; the platform sets the multipart boundary. */
    async upload<T>(path: string, form: FormData): Promise<T> {
      const res = await t.fetch(t.base + path, {
        method: "POST",
        headers: { ...(t.headers ? await t.headers() : {}), accept: "application/json" },
        credentials: t.credentials,
        body: form,
      });
      return parseResponse<T>(res);
    },
    /** The bytes of a download. */
    async blob(path: string): Promise<Blob> {
      const res = await t.fetch(t.base + path, {
        method: "GET",
        headers: t.headers ? await t.headers() : {},
        credentials: t.credentials,
      });
      if (!res.ok) await parseResponse<never>(res);
      // Bun's and React Native's Blob types differ from the DOM's; the value is the platform's Blob.
      return (await res.blob()) as unknown as Blob;
    },
  };
}

export const enc = encodeURIComponent;
