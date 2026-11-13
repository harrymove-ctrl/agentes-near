import { isolatedPage, PAGE_SANDBOX } from "@agenteschat/client/lib/isolated-page";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Agent-made HTML, isolated: a blob URL in a sandboxed iframe, behind a policy that cuts it off from the network
 * (`isolatedPage`). Without `allow-same-origin` the page gets an opaque origin: no cookies, storage or DOM of ours.
 * Never inlined into our DOM.
 */
export const HTML_SANDBOX = PAGE_SANDBOX;

/** How long the page has to say it started before we try the next way to load it. */
const READY_MS = 4000;

/**
 * Runs first inside the page. In an opaque origin `localStorage`,
 * `sessionStorage` and `document.cookie` throw, and a page that touches them
 * dies before drawing anything (a blank frame): give it in-memory stand-ins.
 * It also tells us the page started (so a load the browser refused can be
 * retried) and passes on its errors, as plain text. Its style gives the page
 * our scrollbars (the kit's, in `packages/ui` components.css) in a grey that
 * reads on any page's colours. The track takes its element's background: Chrome
 * styles the page's own scrollbar from its `<body>`, and a clear one would show
 * the frame's white beside a dark page. The page's own rules come after it and win.
 */
const SHIM = `<script>(function(){
function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{void document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}
function post(m){try{parent.postMessage(m,"*")}catch(_){}}
window.addEventListener("error",function(e){post({agentesHtml:"error",message:String(e&&e.message||"").slice(0,300)})});
post({agentesHtml:"ready"});
})();</script><style>@media (hover:hover) and (pointer:fine){
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background-color:inherit}
::-webkit-scrollbar-button{display:none}
::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:999px;background:rgba(128,128,128,.4) padding-box}
::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{border-width:1px;background-color:rgba(128,128,128,.65)}
@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.4) transparent}}
}</style>`;

/** The page behind its policy, with the shim first. */
export function withShim(html: string): string {
  return isolatedPage(html, SHIM);
}

type Load = "blob" | "data" | "failed";

/** How a page gets into its frame: a blob URL, a data URL where that is refused, and `failed` if neither started. */
export function usePageUrl(page: string, ready: boolean) {
  const [load, setLoad] = useState<Load>("blob");
  const [url, setUrl] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts over from a blob URL
  useEffect(() => {
    setLoad("blob");
  }, [page]);

  useEffect(() => {
    if (load === "failed" || !page) return;
    if (load === "data" || typeof URL.createObjectURL !== "function") {
      setUrl(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      return;
    }
    const next = URL.createObjectURL(new Blob([page], { type: "text/html" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [page, load]);

  // Some browsers refuse a blob page in a sandboxed frame: try a data URL, then say so.
  useEffect(() => {
    if (ready || load === "failed" || !url) return;
    const timer = setTimeout(() => setLoad(load === "blob" ? "data" : "failed"), READY_MS);
    return () => clearTimeout(timer);
  }, [ready, load, url]);

  return { url: load === "failed" ? null : url, failed: load === "failed" };
}

export function HtmlFrame({
  html,
  title,
  className,
  thumbnail = false,
}: {
  html: string;
  title: string;
  className?: string;
  /** A small non-interactive picture of the page (message cards): no notes, no scrollbar, out of the tab order. */
  thumbnail?: boolean;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = useMemo(() => withShim(html), [html]);
  const { url, failed } = usePageUrl(page, ready);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts over
  useEffect(() => {
    setReady(false);
    setError(null);
  }, [page]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { agentesHtml?: unknown; message?: unknown } | null;
      if (m?.agentesHtml === "ready") setReady(true);
      else if (m?.agentesHtml === "error" && typeof m.message === "string") setError(m.message.slice(0, 300));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const iframe = url ? (
    <iframe
      ref={frame}
      className={className ?? "artifact-html"}
      src={url}
      title={title}
      sandbox={HTML_SANDBOX}
      referrerPolicy="no-referrer"
      tabIndex={thumbnail ? -1 : undefined}
      aria-hidden={thumbnail || undefined}
      scrolling={thumbnail ? "no" : undefined}
    />
  ) : null;
  if (thumbnail) return iframe;
  return (
    <>
      {iframe}
      {failed && <p className="small muted">{t("artifacts.htmlFailed")}</p>}
      {error && !failed && <p className="small muted">{t("artifacts.htmlError", { message: error })}</p>}
    </>
  );
}
