// Branded HTML pages for local OAuth callback servers.
//
// These are served by the loopback HTTP servers that finish an OAuth exchange
// (MCP, Codex/ChatGPT, xAI, Snowflake, DigitalOcean, ...). The functions return
// a fully self-contained HTML string with no external assets, so they work
// offline and drop into any transport (`res.end(...)`, Effect `response.end`,
// etc.).
//
// The visual language mirrors the app: the design tokens are a curated subset of
// the OC-2 semantic tokens in `packages/ui/src/styles/theme.css`, and the
// wordmark is the same geometry as `packages/ui/src/components/jolli-brand.tsx`.
// Keep this file in sync with those sources when the brand changes.

import { Brand } from "../brand"

export interface CallbackPageOptions {
  /** Friendly integration name shown as a subtitle, e.g. "xAI", "Snowflake", "MCP". */
  provider?: string
  /** Attempt to close the window shortly after success. Defaults to true. */
  autoClose?: boolean
}

export function success(options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization successful",
    body: renderCard({
      status: "success",
      headline: "Authorization successful",
      message: provider
        ? `${Brand.name} is now connected to ${escapeHtml(provider)}.`
        : `${Brand.name} is now authorized.`,
      footnote: "You can close this window.",
    }),
    script: options?.autoClose === false ? undefined : AUTO_CLOSE_SCRIPT,
  })
}

export function error(detail: string, options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization failed",
    body: renderCard({
      status: "error",
      headline: "Authorization failed",
      message: provider
        ? `${Brand.name} couldn't finish connecting to ${escapeHtml(provider)}.`
        : `${Brand.name} couldn't complete authorization.`,
      detail,
      footnote: `Close this window and try again from ${Brand.name}.`,
    }),
  })
}

export interface BootstrapOptions {
  /** Same-origin path the in-browser script POSTs the parsed callback to. */
  tokenPath: string
  provider?: string
}

// For flows where the credential arrives in the URL fragment (implicit grant),
// the browser must relay it back to the loopback server. This renders a pending
// page whose script reads the fragment, POSTs it to `tokenPath`, then resolves
// to the success or error state in place.
export function bootstrap(options: BootstrapOptions) {
  return renderDocument({
    title: "Finishing sign-in",
    body: renderCard({
      status: "pending",
      headline: "Finishing sign-in",
      message: options.provider
        ? `Completing your ${escapeHtml(options.provider)} authorization.`
        : "Completing authorization.",
      footnote: "You can close this window once sign-in finishes.",
    }),
    script: bootstrapScript(options),
  })
}

export * as OauthCallbackPage from "./page"

type Status = "pending" | "success" | "error"

function renderCard(input: { status: Status; headline: string; message: string; detail?: string; footnote: string }) {
  const detail = input.detail?.trim()
  return `<main class="card" id="oc-card" data-status="${input.status}" role="status" aria-live="polite">
      <div class="brand">${WORDMARK}</div>
      <div class="status" aria-hidden="true">
        <span class="icon icon-pending">${ICON_SPINNER}</span>
        <span class="icon icon-success">${ICON_CHECK}</span>
        <span class="icon icon-error">${ICON_CROSS}</span>
      </div>
      <h1 class="headline" id="oc-headline">${escapeHtml(input.headline)}</h1>
      <p class="message" id="oc-message">${input.message}</p>
      <pre class="detail" id="oc-detail"${detail ? "" : " hidden"}>${detail ? escapeHtml(detail) : ""}</pre>
      <p class="footnote" id="oc-footnote">${escapeHtml(input.footnote)}</p>
    </main>`
}

function renderDocument(input: { title: string; body: string; script?: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} · ${escapeHtml(Brand.name)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${input.body}${input.script ? `\n    <script>${input.script}</script>` : ""}
  </body>
</html>`
}

const AUTO_CLOSE_SCRIPT = `setTimeout(function(){try{window.close()}catch(e){}},2500)`

function bootstrapScript(options: BootstrapOptions) {
  return `var PROVIDER=${scriptString(options.provider ?? "")};
var BRAND=${scriptString(Brand.name)};
var TOKEN_URL=new URL(${scriptString(options.tokenPath)},window.location.origin).href;
(function(){
  var card=document.getElementById("oc-card"),headline=document.getElementById("oc-headline"),message=document.getElementById("oc-message"),detail=document.getElementById("oc-detail"),footnote=document.getElementById("oc-footnote");
  function fail(text){card.dataset.status="error";headline.textContent="Authorization failed";message.textContent=PROVIDER?(BRAND+" couldn't finish connecting to "+PROVIDER+"."):(BRAND+" couldn't complete authorization.");if(text){detail.textContent=text;detail.hidden=false}footnote.textContent="Close this window and try again from "+BRAND+"."}
  function ok(){card.dataset.status="success";headline.textContent="Authorization successful";message.textContent=PROVIDER?(BRAND+" is now connected to "+PROVIDER+"."):(BRAND+" is now authorized.");detail.hidden=true;footnote.textContent="You can close this window.";setTimeout(function(){try{window.close()}catch(e){}},2500)}
  try{
    var hash=new URLSearchParams((window.location.hash||"").slice(1));
    var search=new URLSearchParams(window.location.search||"");
    var err=hash.get("error")||search.get("error");
    var errDescription=hash.get("error_description")||search.get("error_description");
    var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
    fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
      if(!res.ok)return res.text().catch(function(){return""}).then(function(t){throw new Error(t||("callback failed ("+res.status+")"))});
      if(err){fail(errDescription||err);return}
      ok();
    }).catch(function(e){fail(String(e&&e.message?e.message:e))});
  }catch(e){fail(String(e&&e.message?e.message:e))}
})()`
}

function scriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// Curated subset of OC-2 tokens (packages/ui/src/styles/theme.css). Default is
// light; dark applies via prefers-color-scheme. The [data-theme] selectors let a
// host force a scheme without changing the default.
const LIGHT_VARS = `
    --oc-bg: #f8f8f8;
    --oc-card: #fcfcfc;
    --oc-text-strong: #171717;
    --oc-text-base: #6f6f6f;
    --oc-text-weak: #8f8f8f;
    --oc-border-weak: #e5e5e5;
    --oc-success: #2dba26;
    --oc-error: #ed4831;
    --oc-detail-bg: #fff8f6;
    --oc-detail-border: #fdc3b7;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.10), 0 6px 12px -2px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06);`

const DARK_VARS = `
    --oc-bg: #101010;
    --oc-card: #161616;
    --oc-text-strong: rgba(255,255,255,.936);
    --oc-text-base: rgba(255,255,255,.618);
    --oc-text-weak: rgba(255,255,255,.422);
    --oc-border-weak: #282828;
    --oc-success: #12c905;
    --oc-error: #fc533a;
    --oc-detail-bg: #28110c;
    --oc-detail-border: #6a1206;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.55), 0 6px 12px -2px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4);`

const STYLES = `
  :root { color-scheme: light dark;${LIGHT_VARS}
    --oc-font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --oc-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
  :root[data-theme="dark"] {${DARK_VARS} }
  :root[data-theme="light"] {${LIGHT_VARS} }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--oc-bg);
    color: var(--oc-text-base);
    font-family: var(--oc-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .card {
    width: min(100%, 28rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--oc-card);
    border: 1px solid var(--oc-border-weak);
    border-radius: 14px;
    box-shadow: var(--oc-shadow);
    text-align: center;
  }
  .brand { display: flex; justify-content: center; margin-bottom: 1.75rem; color: var(--oc-text-strong); }
  /* Taller than the 19px the old wordmark used: this viewBox carries the mark's
     full height, so the logotype only reads at a comparable size around 24px. */
  .brand svg { height: 24px; width: auto; }
  .status { display: flex; justify-content: center; margin-bottom: 1.125rem; }
  .icon { display: none; line-height: 0; }
  .icon svg { display: block; }
  .card[data-status="pending"] .icon-pending,
  .card[data-status="success"] .icon-success,
  .card[data-status="error"] .icon-error { display: block; }
  .icon-success { color: var(--oc-success); }
  .icon-error { color: var(--oc-error); }
  .icon-pending { color: var(--oc-text-weak); }
  .headline { margin: 0; font-size: 1.1875rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em; color: var(--oc-text-strong); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; color: var(--oc-text-base); }
  .detail {
    margin: 1.25rem 0 0;
    padding: 0.75rem 0.875rem;
    text-align: left;
    font-family: var(--oc-font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--oc-text-strong);
    background: var(--oc-detail-bg);
    border: 1px solid var(--oc-detail-border);
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9.5rem;
    overflow: auto;
  }
  .detail[hidden] { display: none; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--oc-text-weak); }
  .spinner { animation: oc-spin 0.8s linear infinite; transform-origin: center; }
  @keyframes oc-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`

// Jolli logo — same geometry as packages/ui/src/components/jolli-brand.tsx
// (JolliMarkBody + JolliLogotypeBody). Duplicated as a raw string because this
// file renders standalone HTML and cannot import a Solid component; keep the two
// in sync. Per the brand note in that file the node colours are the brand's own
// hex and are deliberately not themed, while the logotype rides on currentColor.
const WORDMARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 332.23 108.72" fill="none" aria-label="${escapeHtml(Brand.name)}" role="img">
        <g stroke="#d1d2fa" stroke-width="2" stroke-miterlimit="10">
          <line x1="58.74" y1="15.04" x2="58.74" y2="53.84" />
          <line x1="99.45" y1="36.93" x2="65.84" y2="56.33" />
          <line x1="100.43" y1="78.03" x2="64.86" y2="62.51" />
          <line x1="53.59" y1="65.92" x2="27.42" y2="94.58" />
          <line x1="9.66" y1="50.52" x2="25.01" y2="99.19" />
          <line x1="49.95" y1="58.01" x2="11.6" y2="52.08" />
          <line x1="60.27" y1="11.38" x2="9.66" y2="50.52" />
          <line x1="99.45" y1="37.84" x2="58.61" y2="11.8" />
          <line x1="106.51" y1="82.1" x2="101.51" y2="33.92" />
          <line x1="28.51" y1="97.04" x2="109.37" y2="80.25" />
        </g>
        <circle cx="58.74" cy="59.95" r="14.57" fill="#7e3dec" />
        <circle cx="100.6" cy="35.63" r="9.75" fill="#06b6d5" />
        <circle cx="107.57" cy="80.25" r="12.86" fill="#6466f1" />
        <circle cx="23.97" cy="97.73" r="11" fill="#ae95fb" />
        <circle cx="9.43" cy="50.52" r="9.43" fill="#61a6fb" />
        <circle cx="58.74" cy="12.94" r="12.94" fill="#3b83f6" />
        <g fill="currentColor">
          <path d="M172.7,91.67c-10.35.54-18.1-3.05-22.79-10.1l10.65-9.12c3.62,3.96,7.62,6.22,11.97,5.21,4.11-.95,7.45-5.08,7.51-10.1l.51-49.05c6.34-1.23,8.94-1.23,14.72-.03l-.53,51.46c-.12,12-9.45,21.06-22.03,21.72Z" />
          <path d="M256.57,65.86c0,14.56-11.8,26.36-26.36,26.36s-26.36-11.8-26.36-26.36,11.8-26.36,26.36-26.36,26.36,11.8,26.36,26.36ZM242.32,65.92c0-6.7-5.43-12.14-12.14-12.14s-12.14,5.43-12.14,12.14,5.43,12.14,12.14,12.14,12.14-5.43,12.14-12.14Z" />
          <path d="M279.61,90.16c-3.89.92-8.35.65-14.23.43l-.06-73.6c5.04-.67,9.58-.61,14.26-.04l.03,73.22Z" />
          <path d="M305.61,90.16c-3.89.92-8.35.65-14.23.43l-.06-73.6c5.04-.67,9.58-.61,14.26-.04l.03,73.22Z" />
          <rect x="317.01" y="41.09" width="14.11" height="49.61" />
          <circle cx="324.08" cy="26.21" r="8.15" />
        </g>
      </svg>`

const ICON_CHECK = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>`

const ICON_CROSS = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>`

const ICON_SPINNER = `<svg class="spinner" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>`
