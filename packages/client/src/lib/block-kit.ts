/**
 * The kit a live block runs on (ADR 0113): the controls, numbers and charts every block gets, inside its sandboxed
 * frame, on the web and in the phone's web view alike. Only this runs before the agent's code, and it holds no secret:
 * a page can read or replace it, and nothing outside trusts what it says. It is text here because it never runs in
 * the app. Parts and how to use them: `BLOCK_MANUAL` in `packages/engine/src/blocks.ts`.
 *
 * A plain button is the app's button (the control ruler, the same shadows and press). The only one showing in a block
 * is its main action, so it takes the primary look (`data-lead`): an agent needn't say so, and blocks already in a
 * conversation get it too. One stacked tight under what comes before it gets room (`data-air`), measured, because a
 * block written by hand often leaves none.
 *
 * Plain HTML wears the app's look too (titles, fields, lists, tables, progress): an agent needn't know our design to
 * follow it, and blocks already sent get it. Those rules have no weight (`:where`), so an agent's CSS always wins.
 * Its tones for categories are `--s1` to `--s6`, the agent's own. The shared tokens match the app's, kept by a test.
 */

/** What the app tells the page before the kit starts. `json` is already safe inside a script. */
export const blockBoot = (json: string) => `window.__block=${json}`;

export const BLOCK_KIT_CSS = `:root{--ink:#151514;--ink2:#2a2a28;--muted:#5c5c58;--faint:#6f6f6a;--line:rgba(23,23,22,.07);--line2:rgba(23,23,22,.12);--raised:#fff;--sunken:#f3f3f0;--well:#fbfbf9;--plate:rgba(127,127,127,.1);--plate2:rgba(127,127,127,.06);--ok:#1f7a45;--warn:#9a5b00;--danger:#b42a20;--cut:4px;--on-s:#fff;--focus:rgba(75,140,245,.35);--e1:0 1px 1px rgba(23,23,22,.04),0 2px 4px -1px rgba(23,23,22,.05),0 0 0 1px var(--line);--e2:0 1px 1px rgba(23,23,22,.04),0 6px 16px -4px rgba(23,23,22,.1),0 0 0 1px var(--line);--top:inset 0 1px 0 rgba(255,255,255,.9);--lit:rgba(255,255,255,.18);color-scheme:light}
html[data-theme=dark]{--ink:#efefec;--ink2:#d6d6d2;--muted:#a3a39e;--faint:#8f8f89;--line:rgba(255,255,255,.1);--line2:rgba(255,255,255,.15);--raised:#1c1c1b;--sunken:#0a0a09;--well:#141413;--plate:rgba(127,127,127,.14);--plate2:rgba(127,127,127,.08);--ok:#5fc48a;--warn:#e0a84a;--danger:#f08a80;--focus:rgba(75,140,245,.45);--e1:0 1px 2px rgba(0,0,0,.5),0 0 0 1px var(--line);--e2:0 8px 20px -6px rgba(0,0,0,.6),0 0 0 1px var(--line);--top:inset 0 1px 0 rgba(255,255,255,.08);--lit:rgba(255,255,255,.12);color-scheme:dark}
*{box-sizing:border-box}
html{overflow:hidden auto;-webkit-text-size-adjust:100%;text-size-adjust:100%}
html,body{margin:0;background:transparent}
body{display:flex;flex-direction:column;gap:14px;padding:6px 16px 16px;color:var(--ink);font:400 14px/1.5 var(--font,Onest),"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
:where(body>*){min-width:0;max-width:100%}
:where(button){font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}
:where(button:not([class]):not(.ac-seg button)){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:6px 16px;border-radius:12px;font-size:14px;font-weight:600;line-height:1.25;letter-spacing:-.005em;background:var(--raised);box-shadow:var(--e1),var(--top);transition:transform .18s cubic-bezier(.34,1.4,.5,1),box-shadow .18s cubic-bezier(.2,.8,.2,1),filter .15s}
:where(button:not([class]):not(.ac-seg button):not([disabled]):hover){box-shadow:var(--e2),var(--top)}
:where(button:not([class]):not(.ac-seg button):not([disabled]):active){transform:scale(.97) translateY(.5px)}
:where(button[data-air]:not([class])){margin-top:12px}
:where(button[data-lead]:not([class])){color:var(--raised);background:linear-gradient(180deg,color-mix(in srgb,var(--ink) 82%,var(--raised)),var(--ink));box-shadow:inset 0 1px 0 var(--lit),inset 0 -1px 0 rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.18),0 6px 14px -6px rgba(0,0,0,.45)}
:where(button[data-lead]:not([class]):not([disabled]):hover){filter:brightness(1.08);box-shadow:inset 0 1px 0 var(--lit),inset 0 -1px 0 rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.18),0 10px 22px -8px rgba(0,0,0,.5)}
button[disabled]{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus)}
h1,h2,h3,p{margin:0}
[hidden],[data-off]{display:none!important}
ac-slider,ac-choice,ac-field,ac-check,ac-stat,ac-chart,ac-table,ac-more{display:block;min-width:0}
ac-note{display:block;font-size:12.5px;line-height:18px;color:var(--faint);text-wrap:pretty}
ac-row,ac-stats{display:grid;gap:14px 16px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
ac-stats{gap:10px;grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}
@media (max-width:440px){ac-row{grid-template-columns:minmax(0,1fr)}.ac-stat{padding:8px 10px}.ac-stat b{font-size:17px;line-height:23px}.ac-stat small{font-size:11.5px;line-height:15px}}
ac-text{display:inline}
ac-send{display:none}
.ac-l{display:flex;justify-content:space-between;gap:12px;margin-bottom:6px;font-size:13px;font-weight:550;color:var(--muted)}
.ac-l b{font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums}
input[type=range]{--p:50%;appearance:none;-webkit-appearance:none;display:block;width:100%;height:22px;margin:0;background:none;cursor:pointer;border-radius:6px}
input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--ink) var(--p),var(--line2) var(--p))}
input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--ink) var(--p),var(--line2) var(--p))}
input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:20px;height:20px;margin-top:-7px;border-radius:7px 7px 7px 3px;background:linear-gradient(180deg,#fff,#f1f1ee);box-shadow:0 0 0 1px rgba(23,23,22,.14),0 2px 5px rgba(23,23,22,.2),inset 0 1px 0 #fff;transition:transform .12s cubic-bezier(.34,1.36,.5,1)}
input[type=range]::-moz-range-thumb{width:20px;height:20px;border:0;border-radius:7px 7px 7px 3px;background:#fff;box-shadow:0 0 0 1px rgba(23,23,22,.14),0 2px 5px rgba(23,23,22,.2)}
input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}
.ac-seg{display:inline-flex;flex-wrap:wrap;gap:2px;max-width:100%;padding:3px;border-radius:12px;background:var(--plate)}
.ac-seg button{min-height:30px;padding:3px 12px;border-radius:9px;font-size:13px;font-weight:550;color:var(--muted);white-space:nowrap}
.ac-seg button[aria-pressed=true]{background:var(--raised);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.1),0 0 0 1px var(--line)}
.ac-in{display:block;width:100%;height:38px;padding:0 12px;border:0;border-radius:10px;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line2);color:var(--ink);font:500 14px var(--font,Onest),system-ui,sans-serif}
textarea.ac-in{height:auto;min-height:70px;padding:8px 12px;resize:vertical;line-height:1.45}
.ac-in::placeholder{color:var(--faint);font-weight:400}
.ac-sw{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:30px;font-size:13.5px;font-weight:550;color:var(--ink2);text-align:left}
.ac-sw i{position:relative;flex:none;width:34px;height:20px;border-radius:999px;background:var(--line2);transition:background .15s}
.ac-sw i::after{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.ac-sw[aria-checked=true] i{background:var(--ok)}.ac-sw[aria-checked=true] i::after{transform:translateX(14px)}
.ac-stat{height:100%;padding:10px 12px;border-radius:12px 12px 12px 4px;background:var(--well);box-shadow:inset 0 0 0 1px var(--line)}
.ac-stat span{display:block;font-size:12.5px;color:var(--muted)}
.ac-stat b{display:block;margin-top:1px;font-size:21px;line-height:27px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.ac-stat small{display:block;min-height:17px;font-size:12px;line-height:17px;color:var(--faint);font-variant-numeric:tabular-nums}
.ac-stat[data-tone=up] small{color:var(--ok)}.ac-stat[data-tone=down] small{color:var(--danger)}
.ac-title{margin-bottom:6px;font-size:13px;font-weight:550;color:var(--muted)}
.ac-bars{display:grid;grid-template-columns:minmax(64px,auto) minmax(0,1fr) auto;column-gap:10px}
.ac-bar{display:grid;grid-column:1/-1;grid-template-columns:minmax(64px,auto) minmax(0,1fr) auto;grid-template-columns:subgrid;align-items:center;gap:10px;width:100%;min-height:26px;padding:2px 0;border-radius:7px;text-align:left}
.ac-bar[data-click]{cursor:pointer}.ac-bar[data-click]:hover .ac-bar__l{color:var(--ink)}
.ac-bars[data-sel] .ac-bar:not([data-on]) .ac-bar__f{opacity:.45}
.ac-bar__l{font-size:13px;color:var(--ink2);white-space:nowrap}
.ac-bars{--lw:64px}
.ac-bar__r{display:block;height:14px;border-radius:5px;background:var(--plate2)}
.ac-bar__f{display:block;height:100%;overflow:hidden;border-radius:5px;transition:width .24s cubic-bezier(.2,.8,.2,1),opacity .15s}
.ac-bar__f canvas{display:block;height:14px;image-rendering:pixelated}
.ac-bar__v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.ac-line{position:relative;height:130px;touch-action:pan-y}
.ac-line canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
.ac-line svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ac-line path{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}
.ac-axis{display:flex;justify-content:space-between;margin-top:4px;font-size:12px;color:var(--faint)}
.ac-tip{position:absolute;z-index:2;transform:translate(-50%,-120%);padding:3px 8px;border-radius:8px 8px 8px 3px;background:var(--ink);color:var(--raised);font-size:12px;font-weight:600;white-space:nowrap;pointer-events:none}
.ac-dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:3px;background:var(--raised);box-shadow:0 0 0 2px var(--cink);pointer-events:none}
ac-table{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.ac-t{width:100%;border-collapse:collapse;font-size:13px}
.ac-t th{padding:0 8px 6px 0;text-align:left;font-weight:550;color:var(--muted)}
.ac-t td{padding:6px 8px 6px 0;border-top:1px solid var(--line);color:var(--ink2);font-variant-numeric:tabular-nums}
details.ac-more summary{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;list-style:none;border-radius:6px}
details.ac-more summary::-webkit-details-marker{display:none}
details.ac-more summary::before{content:"";width:6px;height:6px;border-right:1.6px solid;border-bottom:1.6px solid;transform:rotate(-45deg);transition:transform .15s}
details.ac-more[open] summary::before{transform:rotate(45deg)}
details.ac-more > div{margin-top:6px;font-size:12.5px;line-height:18px;color:var(--muted)}
:where(h1,h2,h3){color:var(--ink);font-weight:650;letter-spacing:-.01em;text-wrap:balance}
:where(h1){font-size:17px;line-height:24px}:where(h2){font-size:15.5px;line-height:22px}:where(h3){font-size:14px;line-height:20px}
:where(p){color:var(--ink2);text-wrap:pretty}
:where(small){font-size:12.5px;color:var(--faint)}
:where(strong,b){font-weight:650}
:where(a){color:inherit;text-decoration-color:var(--line2);text-underline-offset:3px}
:where(a:hover){text-decoration-color:currentColor}
:where(ul,ol){margin:0;padding-left:20px;color:var(--ink2)}:where(li){margin:2px 0}:where(li)::marker{color:var(--faint)}
:where(hr){width:100%;height:1px;margin:2px 0;border:0;background:var(--line)}
:where(code,kbd){padding:1px 5px;border-radius:6px;background:var(--plate);font:500 .9em ui-monospace,SFMono-Regular,Menlo,monospace}
:where(pre){margin:0;padding:10px 12px;overflow:auto;border-radius:12px 12px 12px var(--cut);background:var(--well);box-shadow:inset 0 0 0 1px var(--line);font:500 12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
:where(pre code){padding:0;background:none}
:where(blockquote){margin:0;padding:8px 12px;border-radius:12px 12px 12px var(--cut);background:var(--well);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted)}
:where(label){font-size:13px;font-weight:550;color:var(--ink2)}
:where(label:has(>input[type=checkbox],>input[type=radio])){display:inline-flex;align-items:center;gap:8px;min-height:28px;margin-right:10px;vertical-align:top}
.ac-stat small:empty{display:none}
:where(img,svg,canvas,video){max-width:100%}
:where(input:not([type=range],[type=checkbox],[type=radio],[class]),textarea:not([class]),select:not([class])){display:block;width:100%;height:40px;padding:0 12px;border:0;border-radius:12px;outline:0;background:var(--raised);box-shadow:inset 0 0 0 1px var(--line2);color:var(--ink);font:500 14px var(--font,Onest),system-ui,sans-serif}
:where(textarea:not([class])){height:auto;min-height:76px;padding:9px 12px;line-height:1.45;resize:vertical}
:where(select:not([class])){appearance:none;-webkit-appearance:none;padding-right:34px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23807f7a' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 8 4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;background-size:18px}
:where(input[type=checkbox],input[type=radio]){appearance:none;-webkit-appearance:none;display:inline-grid;place-items:center;flex:none;width:18px;height:18px;margin:0;border-radius:6px 6px 6px 2px;background:var(--raised);box-shadow:inset 0 0 0 1.6px var(--faint);cursor:pointer}
:where(input[type=radio]){border-radius:50%}
:where(input[type=checkbox]:checked,input[type=radio]:checked){background:var(--ink);box-shadow:none}
:where(input[type=checkbox]:checked)::after{content:"";width:9px;height:5px;margin-top:-2px;border-left:1.8px solid var(--raised);border-bottom:1.8px solid var(--raised);transform:rotate(-45deg)}
:where(input[type=radio]:checked)::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--raised)}
:where(table:not([class])){width:100%;border-collapse:collapse;font-size:13px}
:where(table:not([class]) th){padding:0 8px 6px 0;color:var(--muted);font-weight:550;text-align:left}
:where(table:not([class]) td){padding:6px 8px 6px 0;border-top:1px solid var(--line);color:var(--ink2);font-variant-numeric:tabular-nums}
:where(progress,meter){appearance:none;-webkit-appearance:none;display:block;width:100%;height:8px;overflow:hidden;border:0;border-radius:999px;background:var(--plate)}
:where(progress)::-webkit-progress-bar{background:var(--plate)}
:where(progress)::-webkit-progress-value{background:var(--ink);border-radius:999px}
:where(progress)::-moz-progress-bar{background:var(--ink);border-radius:999px}
:where(meter)::-webkit-meter-bar{height:8px;border:0;background:var(--plate)}
:where(meter)::-webkit-meter-optimum-value{background:var(--ink)}
ac-card,ac-result{display:block;min-width:0}
ac-result{width:100%}
ac-card{padding:12px 14px;border-radius:14px 14px 14px var(--cut);background:var(--raised);box-shadow:0 0 0 1px var(--line2)}
ac-card[data-on]{box-shadow:0 0 0 1.6px var(--ink)}
ac-card[name]{cursor:pointer;transition:box-shadow .15s}
ac-card[name]:not([data-on]):hover{box-shadow:0 0 0 1px var(--faint)}
ac-card:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus)}
.ac-card__head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:0 10px;margin-bottom:8px}
.ac-card__head b{font-size:14px;font-weight:650}.ac-card__head small{font-size:12.5px;line-height:17px;color:var(--faint)}
.ac-result{padding:10px 14px 12px;text-align:center;border-radius:14px 14px 14px var(--cut);background:var(--well);box-shadow:inset 0 0 0 1px var(--line)}
.ac-result span{display:block;font-size:12.5px;color:var(--muted)}
.ac-result b{display:block;font-size:20px;line-height:28px;font-weight:650;letter-spacing:-.01em}
ac-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
ac-result + ac-actions,ac-actions[align=center]{justify-content:center}
ac-actions[align=start]{justify-content:flex-start}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}`;

export const BLOCK_KIT_JS = String.raw`(function(){
var R=window.__block||{};
function mem(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}}}}
["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{void document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}
var L=R.labels||{send:"Send",more:"More",thousand:"k"},LOC=R.locale||"en";
var post=function(m){m.agentes=1;try{var n=window.ReactNativeWebView;if(n)n.postMessage(JSON.stringify(m));else parent.postMessage(m,"*")}catch(_){}};
var state=Object.assign({},R.state||{}),who=R.who||{},used=false,calc=[],subs=[],derived={},queued=false;
var json=function(v){try{return JSON.stringify(v)}catch(_){return null}},seen={},posted=null,flushing=false,cascade=0,stuck=false,MAX_CASCADE=50;
Object.keys(state).forEach(function(k){seen[k]=json(state[k])});
["pointerdown","keydown","input","change"].forEach(function(t){addEventListener(t,function(){used=true;stuck=false},true)});
var view=function(){return Object.assign({},state,derived)};
function flush(){queued=false;flushing=true;derived={};calc.forEach(function(f){try{Object.assign(derived,f(view())||{})}catch(e){post({type:"error",message:String(e.message||e).slice(0,200)})}});
  var v=view();subs.forEach(function(f){try{f(v)}catch(e){post({type:"error",message:String(e.message||e).slice(0,200)})}});flushing=false;
  document.querySelectorAll("[when]").forEach(function(el){var m=/^(.+?)(!?=)(.*)$/.exec(el.getAttribute("when"));if(!m)return;var on=String(v[m[1]])===m[3];if(m[2]==="!=")on=!on;on?el.removeAttribute("data-off"):el.setAttribute("data-off","")});
  lead();var now=json(state);if(now===null||now!==posted){posted=now;post({type:"state",state:state,used:used})}}
function lead(){var all=Array.prototype.slice.call(document.querySelectorAll("button:not([class]):not(.ac-seg button)")),live=all.filter(function(b){return!b.closest("[hidden],[data-off]")});all.forEach(function(b){b.toggleAttribute("data-lead",live.length===1&&live[0]===b);var p=b.previousElementSibling;if(!p||b.hasAttribute("data-air")||!b.offsetParent)return;var gap=b.getBoundingClientRect().top-p.getBoundingClientRect().bottom;if(gap>-1&&gap<8)b.setAttribute("data-air","")})}
var touch=function(){if(queued||stuck)return;if(!flushing)cascade=0;else if(++cascade>MAX_CASCADE){stuck=true;post({type:"error",message:"agentes.set inside agentes.on keeps changing the state; the block stopped redrawing"});return}
  queued=true;queueMicrotask(flush)};
var fmt=function(v,f,u){if(v===undefined||v===null||v!==v)return"–";var n=Number(v),pt=function(x,d){return x.toLocaleString(LOC,{maximumFractionDigits:d===undefined?1:d})};
  if(f==="brl")return"R$ "+pt(n,0);if(f==="mil")return"R$ "+pt(n,1)+(L.thousand==="k"?"k":" "+L.thousand);if(f==="pct")return pt(n,1)+"%";if(f==="int")return pt(n,0);if(typeof v==="number")return pt(n)+(u?" "+u:"");return String(v)};
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var opts=function(s){return String(s||"").split("|").map(function(x){return x.trim()}).filter(Boolean)};
var fill=function(t,v){return t.replace(/\{(\w+)(?::(\w+))?\}/g,function(_,k,f){return fmt(v[k],f)})};
var agentes=window.agentes={get state(){return view()},set:function(k,v){var j=json(v);if(j!==null&&k in state&&seen[k]===j)return;seen[k]=j;state[k]=v;touch()},compute:function(f){calc.push(f);touch()},on:function(f){subs.push(f);touch()},fmt:fmt,
  send:function(text,label,ready){post({type:"draft",text:text,label:label||L.send,ready:ready!==false})},
  draw:function(name,options){post({type:"draw",name:String(name),options:Array.prototype.slice.call(options||[]),used:used})},
  who:function(name){var c=who[name];return c?{name:c.name,at:c.at,drawn:!!c.drawn}:null}};
var ramp=function(){return R.ramp||["#cfe2ff","#9ec5ff","#5aa8ff","#3d8bff","#0063d1","#00408a"]};
function theme(t){var d=document.documentElement,r=ramp();d.dataset.theme=t;(t==="dark"?[r[3],r[5],r[4],r[2],r[1],r[0]]:[r[4],r[3],r[5],r[2],r[1],r[0]]).forEach(function(c,i){if(c)d.style.setProperty("--s"+(i+1),c)})}
theme(R.theme||"light");
if(R.ramp)document.documentElement.style.setProperty("--c",R.ramp[4]);
var ink=function(){return document.documentElement.dataset.theme==="dark"?ramp()[2]:ramp()[4]};
var B=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(function(v){return(v+.5)/16}),bay=function(x,y){return B[((y&3)<<2)|(x&3)]};
var repaint=[];
function E(name,cls){customElements.define(name,cls)}
class Base extends HTMLElement{a(n,d){var v=this.getAttribute(n);return v===null?d:v}connectedCallback(){if(this._up)return;this._up=true;this.build();var f=this.sync.bind(this);subs.push(f);if(!flushing)return touch();try{f(view())}catch(e){post({type:"error",message:String(e.message||e).slice(0,200)})}}build(){}sync(){}}
E("ac-slider",class extends Base{build(){var n=this.a("name"),self=this;if(state[n]===undefined)state[n]=+this.a("value",this.a("min",0));this.innerHTML='<label><span class="ac-l"><span>'+esc(this.a("label",""))+'</span><b></b></span><input type="range" min="'+this.a("min",0)+'" max="'+this.a("max",100)+'" step="'+this.a("step",1)+'" aria-label="'+esc(this.a("label",""))+'"></label>';this.input=this.querySelector("input");this.out=this.querySelector("b");this.input.value=state[n];this.input.addEventListener("input",function(){agentes.set(n,+self.input.value)})}
  sync(v){var n=this.a("name"),i=this.input,x=v[n];i.value=x;i.style.setProperty("--p",((x-i.min)/(i.max-i.min)*100)+"%");this.out.textContent=fmt(x,this.a("format"),this.a("unit"))}});
E("ac-choice",class extends Base{build(){var n=this.a("name"),self=this,o=opts(this.a("options"));if(state[n]===undefined)state[n]=this.a("value",o[0]);this.innerHTML=(this.a("label")?'<div class="ac-title">'+esc(this.a("label"))+'</div>':"")+'<div class="ac-seg" role="group">'+o.map(function(x){return'<button type="button" data-v="'+esc(x)+'">'+esc(x)+'</button>'}).join("")+'</div>';this.querySelectorAll("button").forEach(function(b){b.addEventListener("click",function(){agentes.set(n,b.dataset.v)})})}
  sync(v){var x=v[this.a("name")];this.querySelectorAll("button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.v===String(x))})}});
E("ac-field",class extends Base{build(){var n=this.a("name"),t=this.a("type","text"),ph=esc(this.a("placeholder","")),big=t==="textarea";if(state[n]===undefined)state[n]=this.a("value","");this.innerHTML='<label><span class="ac-l"><span>'+esc(this.a("label",""))+'</span></span>'+(big?'<textarea class="ac-in" placeholder="'+ph+'"></textarea>':'<input class="ac-in" type="'+esc(t)+'" placeholder="'+ph+'">')+'</label>';var i=this.querySelector(".ac-in");i.value=state[n];i.addEventListener("input",function(){agentes.set(n,i.value)})}});
E("ac-check",class extends Base{build(){var n=this.a("name"),b;if(state[n]===undefined)state[n]=this.hasAttribute("checked");this.innerHTML='<button type="button" class="ac-sw" role="switch"><span>'+esc(this.a("label",""))+'</span><i></i></button>';b=this.querySelector("button");b.addEventListener("click",function(){agentes.set(n,!state[n])})}sync(v){this.querySelector("button").setAttribute("aria-checked",!!v[this.a("name")])}});
E("ac-stat",class extends Base{build(){this.innerHTML='<div class="ac-stat"><span>'+esc(this.a("label",""))+'</span><b></b><small></small></div>'}
  sync(v){var x=this.a("bind")?v[this.a("bind")]:this.a("value");this.querySelector("b").textContent=fmt(x,this.a("format"),this.a("unit"));var s=this.a("sub-bind")?v[this.a("sub-bind")]:this.a("sub","");this.querySelector("small").textContent=s===undefined?"":s;var t=this.a("tone-bind");if(t)this.firstChild.dataset.tone=v[t]||""}});
E("ac-text",class extends Base{sync(v){this.textContent=fmt(v[this.a("bind")],this.a("format"))}});
E("ac-send",class extends Base{sync(v){var need=opts((this.a("needs")||"").replace(/,/g,"|"));var ok=need.every(function(k){return v[k]});post({type:"draft",text:fill(this.a("text",""),v),label:this.a("label",L.send),ready:ok,hint:ok?"":this.a("hint","")})}});
E("ac-more",class extends HTMLElement{connectedCallback(){var s=this;setTimeout(function(){if(s._up)return;s._up=true;s.innerHTML='<details class="ac-more"><summary>'+esc(s.getAttribute("label")||L.more)+'</summary><div>'+s.innerHTML+'</div></details>'})}});
E("ac-chart",class extends Base{build(){this.innerHTML=(this.a("label")?'<div class="ac-title">'+esc(this.a("label"))+'</div>':"")+'<div class="ac-body"></div>';this.body=this.lastChild;var me=this;repaint.push(function(){me.key=null;me.sync(view())})}
  sync(v){var d=v[this.a("bind")]||[];if(this.a("type")==="line")this.line(d);else this.bars(d,v)}
  bars(d,v){var f=this.a("format"),u=this.a("unit"),sel=this.a("select"),max=Math.max.apply(null,d.map(function(x){return x.value}).concat(1e-9)),key=d.map(function(x){return x.label}).join("|")+document.documentElement.dataset.theme,me=this;
    if(this.key!==key){this.key=key;this.body.innerHTML='<div class="ac-bars">'+d.map(function(x){return'<'+(sel?'button type="button" data-click':'div')+' class="ac-bar" data-l="'+esc(x.label)+'"><span class="ac-bar__l">'+esc(x.label)+'</span><span class="ac-bar__r"><span class="ac-bar__f" style="width:0"><canvas></canvas></span></span><span class="ac-bar__v"></span></'+(sel?'button':'div')+'>'}).join("")+'</div>';
      if(sel)this.body.querySelectorAll("[data-click]").forEach(function(b){b.addEventListener("click",function(){var cur=state[sel],all=me.a("all");agentes.set(sel,cur===b.dataset.l&&all?all:b.dataset.l)})});
      var w=this.body.querySelector(".ac-bar__r");var W=w?w.clientWidth||300:300;this.body.querySelectorAll("canvas").forEach(function(c,i){var cols=Math.ceil(W/2),rows=7,g,r=ramp();c.width=cols;c.height=rows;c.style.width=W+"px";g=c.getContext("2d");for(var y=0;y<rows;y++)for(var x=0;x<cols;x++){var q=(.12+x/(cols-1)*(i===0?.8:.55))*5,lo=Math.floor(q),t=Math.min(5,lo+(q-lo>bay(x,y)?1:0));g.fillStyle=r[t];g.fillRect(x,y,1,1)}})}
    var cur=sel?state[sel]:null,hit=false;var rows=this.body.querySelectorAll(".ac-bar");d.forEach(function(x,i){var r=rows[i];if(!r)return;r.querySelector(".ac-bar__f").style.width=Math.max(0,x.value/max*100)+"%";r.querySelector(".ac-bar__v").textContent=fmt(x.value,f,u);if(cur===x.label){r.dataset.on="";hit=true}else delete r.dataset.on});
    var box=this.body.querySelector(".ac-bars");if(box){if(hit)box.dataset.sel="";else delete box.dataset.sel}}
  line(d){if(!d.length)return;var me=this,f=this.a("format"),u=this.a("unit"),box=this.body;var dark=document.documentElement.dataset.theme==="dark";if(!box.querySelector(".ac-line")){box.innerHTML='<div class="ac-line"><canvas></canvas><svg preserveAspectRatio="none"><path></path></svg></div><div class="ac-axis"></div>';var L=box.firstChild;L.addEventListener("pointermove",function(e){me.hover(e)});L.addEventListener("pointerleave",function(){me.hover(null)})}
    this.pts=d;var L2=box.querySelector(".ac-line"),W=L2.clientWidth||300,H=130,top=8,bot=H-6,vals=d.map(function(x){return x.value}),mx=Math.max.apply(null,vals),lo=Math.min.apply(null,vals),pad=(mx-lo)*.35||mx*.1||1,mn=lo<0?lo-pad:Math.max(0,lo-pad),sp=(mx-mn)||1;
    var P=d.map(function(x,i){return[d.length>1?i/(d.length-1)*W:W/2,bot-(x.value-mn)/sp*(bot-top)]});this.P=P;var path="";P.forEach(function(p,i){if(!i){path="M"+p[0]+" "+p[1];return}var a=P[i-1],c=(p[0]-a[0])/2;path+=" C"+(a[0]+c)+" "+a[1]+" "+(p[0]-c)+" "+p[1]+" "+p[0]+" "+p[1]});
    var svg=L2.querySelector("svg");svg.setAttribute("viewBox","0 0 "+W+" "+H);var pe=L2.querySelector("path");pe.setAttribute("d",path);pe.style.stroke=ink();L2.style.setProperty("--cink",ink());
    var cv=L2.querySelector("canvas"),cols=Math.ceil(W/2),rows=H/2,g;cv.width=cols;cv.height=rows;g=cv.getContext("2d");var r=ramp(),t1=dark?r[4]:r[1],t2=dark?r[5]:r[0];
    var yAt=function(px){var i=0;while(i<P.length-2&&P[i+1][0]<px)i++;var a=P[i],b=P[i+1]||a,k=b[0]===a[0]?0:(px-a[0])/(b[0]-a[0]);k=k*k*(3-2*k);return a[1]+(b[1]-a[1])*k};
    for(var x=0;x<cols;x++){var y0=Math.round(yAt(x*2)/2)+2;for(var y=y0;y<rows;y++){var q=1-(y-y0)/(rows-y0+1);if(q*.85>bay(x,y)+.1){g.fillStyle=q>.6?t1:t2;g.fillRect(x,y,1,1)}}}
    var ax=box.querySelector(".ac-axis"),n=d.length;ax.innerHTML=(n?[d[0],d[Math.floor((n-1)/2)],d[n-1]]:[]).map(function(x){return'<span>'+esc(x.label)+'</span>'}).join("");this.lf=function(v){return fmt(v,f,u)}}
  hover(e){var L=this.body.querySelector(".ac-line"),t=L.querySelector(".ac-tip"),o=L.querySelector(".ac-dot");if(!e){if(t)t.remove();if(o)o.remove();return}var r=L.getBoundingClientRect(),x=e.clientX-r.left,best=0;this.P.forEach(function(p,i){if(Math.abs(p[0]-x)<Math.abs(this.P[best][0]-x))best=i},this);var p=this.P[best],d=this.pts[best];if(!t){t=document.createElement("div");t.className="ac-tip";L.appendChild(t);o=document.createElement("div");o.className="ac-dot";L.appendChild(o)}t.textContent=d.label+": "+this.lf(d.value);t.style.left=Math.min(r.width-50,Math.max(50,p[0]))+"px";t.style.top=p[1]+"px";o.style.left=p[0]+"px";o.style.top=p[1]+"px"}});
E("ac-card",class extends Base{build(){var n=this.a("name"),self=this;if(this.a("label")){var h=document.createElement("div");h.className="ac-card__head";h.innerHTML='<b>'+esc(this.a("label"))+'</b>'+(this.a("sub")?'<small>'+esc(this.a("sub"))+'</small>':"");this.prepend(h)}if(!n){if(this.hasAttribute("selected"))this.dataset.on="";return}this.setAttribute("role","button");this.tabIndex=0;var pick=function(){agentes.set(n,self.a("value"))};this.addEventListener("click",pick);this.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();pick()}})}
  sync(v){var n=this.a("name");if(!n)return;var on=String(v[n])===this.a("value");on?this.dataset.on="":delete this.dataset.on;this.setAttribute("aria-pressed",on)}});
E("ac-result",class extends Base{build(){this.innerHTML='<div class="ac-result"><span>'+esc(this.a("label",""))+'</span><b></b></div>'}sync(v){var x=this.a("bind")?v[this.a("bind")]:this.a("value");this.querySelector("b").textContent=fmt(x,this.a("format"),this.a("unit"))}});
E("ac-table",class extends Base{sync(v){var c=opts(this.a("columns")).map(function(x){var p=x.split(":");return{t:p[0],k:p[1],f:p[2]}}),d=v[this.a("bind")]||[];this.innerHTML='<table class="ac-t"><thead><tr>'+c.map(function(x){return'<th>'+esc(x.t)+'</th>'}).join("")+'</tr></thead><tbody>'+d.map(function(r){return'<tr>'+c.map(function(x){return'<td>'+esc(fmt(r[x.k],x.f))+'</td>'}).join("")+'</tr>'}).join("")+'</tbody></table>'}});
function height(){post({type:"height",height:Math.ceil(document.body.getBoundingClientRect().height)})}
function host(m){if(!m)return;if(m.theme){theme(m.theme);repaint.forEach(function(f){f()})}if(m.state&&typeof m.state==="object"){Object.assign(state,m.state);Object.keys(m.state).forEach(function(k){seen[k]=json(m.state[k])});if(m.who)who=m.who;touch()}}
window.__agentesHost=host;
addEventListener("message",function(e){if(e.source===parent&&e.source!==window)host(e.data)});
addEventListener("error",function(e){post({type:"error",message:String(e.message||"").slice(0,200)})});
addEventListener("DOMContentLoaded",function(){touch();if(window.ResizeObserver)new ResizeObserver(height).observe(document.body);height();post({type:"ready"})});
})();`;
