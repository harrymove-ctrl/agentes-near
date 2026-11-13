/**
 * A browser DOM (happy-dom) for unit tests, shared by `packages/ui` and
 * `apps/web`.
 *
 * Backend tests run in the same `bun test` process, and some of their
 * dependencies change behaviour when they see a browser (PGlite looks for
 * `window`). So the DOM is attached only while a DOM test file runs:
 *
 * - the root `bunfig.toml` preloads `testing/preload.ts`, which attaches the
 *   DOM, evaluates the DOM-sensitive libraries once (React DOM, Radix,
 *   Testing Library, TanStack Router read `window`/`document` when they load),
 *   then detaches it again (`testing/preload-done.ts`);
 * - each DOM test file calls `setupDom()`, which attaches it in `beforeAll` and
 *   detaches it in `afterAll`.
 *
 * Bun's own networking, streams, timers, crypto and encoding globals are
 * never replaced.
 */
import { afterAll, beforeAll } from "bun:test";
import { Duplex } from "node:stream";
import { createGunzip, createInflate, createInflateRaw } from "node:zlib";
import { Window } from "happy-dom";

const KEEP_NATIVE = new Set([
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "WebSocket",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "crypto",
  "performance",
  "console",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "Worker",
  "WebAssembly",
]);

/** Globals that Bun also defines (or that backend code probes) and that must be happy-dom's during a DOM test. */
const SWAPPED = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageEvent",
  "ErrorEvent",
  "CloseEvent",
] as const;

type Store = Record<string, unknown>;
const g = globalThis as unknown as Store;

interface DomState {
  window: Window;
  native: Map<string, PropertyDescriptor | undefined>;
  attached: boolean;
}

const INFLATE: Record<string, () => Duplex> = {
  gzip: createGunzip,
  deflate: createInflate,
  "deflate-raw": createInflateRaw,
};

/** The browser's `DecompressionStream` on node:zlib: it streams, and a corrupt input errors it. */
class ZlibDecompressionStream {
  constructor(format: string) {
    const inflate = INFLATE[format];
    if (!inflate) throw new TypeError(`Unsupported compression format: '${format}'`);
    // Its `readable` and `writable` sides: all that `pipeThrough` takes.
    Object.assign(this, Duplex.toWeb(inflate()));
  }
}

/**
 * Two things a browser does and happy-dom doesn't, which DOMPurify (mermaid's sanitizer) relies on. Without them it
 * drops the first element and keeps the rest as is, `<script>` and `onclick` included. Installed before any library
 * loads: DOMPurify takes both when it does.
 *
 * - `Node.prototype`'s `nodeName` getter names every kind of node (DOMPurify reads names through it, so markup can't
 *   clobber them). happy-dom's returns "".
 * - A NodeIterator keeps its place when the node it returned last is removed. happy-dom's stops there.
 */
function traverseLikeABrowser(window: Window) {
  const nodeProto = window.Node.prototype;
  const ownName = Object.getOwnPropertyDescriptor(nodeProto, "nodeName")?.get;
  Object.defineProperty(nodeProto, "nodeName", {
    configurable: true,
    get(this: Node) {
      for (let p = Object.getPrototypeOf(this); p && p !== nodeProto; p = Object.getPrototypeOf(p)) {
        const get = Object.getOwnPropertyDescriptor(p, "nodeName")?.get;
        if (get) return get.call(this);
      }
      return ownName?.call(this) ?? "";
    },
  });
  // Not `window.Document.prototype`: that's a subclass made for this window, and documents don't inherit from it.
  let documentProto: object = window.document;
  while (!Object.hasOwn(documentProto, "createNodeIterator")) documentProto = Object.getPrototypeOf(documentProto);
  Object.defineProperty(documentProto, "createNodeIterator", {
    configurable: true,
    writable: true,
    value(root: Node, whatToShow = 0xffffffff, filter: NodeFilter | null = null) {
      const accepts = (node: Node) =>
        (whatToShow & (1 << (node.nodeType - 1))) !== 0 &&
        (typeof filter === "function" ? filter(node) : (filter?.acceptNode(node) ?? 1)) === 1;
      const following = (node: Node) => {
        // A <template>'s content isn't in the tree (happy-dom lists it as the template's children).
        if (node.firstChild?.parentNode === node) return node.firstChild;
        for (let n: Node | null = node; n && n !== root; n = n.parentNode) if (n.nextSibling) return n.nextSibling;
        return null;
      };
      // The node returned last, and the last one returned that was still in place: where to go on from if it's gone.
      let last: Node | null = null;
      let kept: Node | null = null;
      return {
        root,
        whatToShow,
        filter,
        nextNode() {
          let next = last === null ? root : root.contains(last) ? following(last) : kept && following(kept);
          while (next && !accepts(next)) next = following(next);
          if (!next) return null;
          if (last && root.contains(last)) kept = last;
          last = next;
          return next;
        },
        detach() {},
      };
    },
  });
}

function state(): DomState {
  const existing = g.__agentesDom as DomState | undefined;
  if (existing) return existing;
  const window = new Window({ url: "http://localhost:3000/", width: 1280, height: 900 });
  traverseLikeABrowser(window);
  const w = window as unknown as Store;
  // DOM classes and helpers Bun doesn't have are installed once and stay
  // (harmless for backend code, which never looks for them).
  for (const key of Object.getOwnPropertyNames(window)) {
    if (KEEP_NATIVE.has(key) || key.startsWith("_") || key in globalThis) continue;
    if ((SWAPPED as readonly string[]).includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
    } catch {
      // Ignore properties the runtime refuses.
    }
  }
  // Layout APIs happy-dom lacks and Radix calls.
  const proto = window.HTMLElement.prototype as unknown as Store;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  w.ResizeObserver ??= NoopResizeObserver;
  g.ResizeObserver ??= w.ResizeObserver;
  // Every browser has it; older Bun releases (and happy-dom) don't.
  g.DecompressionStream ??= ZlibDecompressionStream;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const native = new Map<string, PropertyDescriptor | undefined>();
  for (const key of SWAPPED) native.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const created: DomState = { window, native, attached: false };
  g.__agentesDom = created;
  return created;
}

/** The happy-dom window used by every DOM test. */
export const domWindow = () => state().window;

export function attachDom() {
  const s = state();
  if (s.attached) return;
  const w = s.window as unknown as Store;
  for (const key of SWAPPED) {
    const value = key === "window" ? s.window : w[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  s.attached = true;
}

export function detachDom() {
  const s = state();
  if (!s.attached) return;
  for (const key of SWAPPED) {
    const descriptor = s.native.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete g[key];
  }
  s.attached = false;
}

/** Call at the top level of every DOM test file. */
export function setupDom() {
  beforeAll(attachDom);
  afterAll(async () => {
    // Unmount what the file rendered first: a mounted component's timer (a highlight, a poll) would
    // fire after the DOM is gone and set state with no `window` ("Unhandled error between tests").
    const { cleanup } = await import("@testing-library/react");
    cleanup();
    s().window.document.body.innerHTML = "";
    // Let React's scheduler finish work queued by the file's last test (it runs on a MessageChannel
    // task and reads `window.event`); detaching first made it throw "window is not defined" between
    // files, now and then.
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    detachDom();
  });
}

const s = state;
