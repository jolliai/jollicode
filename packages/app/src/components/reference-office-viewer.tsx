import { createEffect, createResource, For, onCleanup, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { renderAsync } from "docx-preview"
import { useLanguage } from "@/context/language"
import { readReferenceBytes } from "@/jolli/reference-preview"
import { ExcelSheetReadError, openExcelMaterial } from "@/jolli/reference-excel-loader"
import { prepareDocxPackage } from "@/jolli/reference-docx-package"
import { READER_DOCX_BYTES, READER_EXCEL_BYTES } from "@/jolli/reference-reader-limits"
import { guardExternalLinks } from "@/jolli/external-link"
import { ReferenceTable } from "./reference-file-viewer"
import { useExternalLinkConfirm } from "./external-link-confirm"

export default function OfficeReferenceViewer(props: { url: string; title: string; kind: "docx" | "excel" }) {
  const language = useLanguage()
  const openLink = useExternalLinkConfirm()
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  const [state, setState] = createStore({ partial: false, failed: false, selected: "" })
  const [bytes] = createResource(async () => {
    const result = await readReferenceBytes(
      props.url,
      props.kind === "docx" ? READER_DOCX_BYTES : READER_EXCEL_BYTES,
      abort.signal,
    )
    if (result.truncated) throw new Error("Office reference exceeds the preview limit")
    return result.bytes
  })
  const [workbook] = createResource(
    () => (props.kind === "excel" ? bytes() : undefined),
    async (data) => {
      const session = await openExcelMaterial(data, abort.signal)
      if (abort.signal.aborted) {
        session.close()
        throw new Error("Workbook preview closed")
      }
      setState({ selected: session.sheetNames[0] ?? "", partial: session.partial })
      return session
    },
  )
  onCleanup(() => {
    if (!workbook.error) workbook()?.close()
  })
  const [sheet] = createResource(
    () => ({ workbook: workbook(), selected: state.selected }),
    async (input) => {
      if (!input.workbook || !input.selected) return undefined
      const result = await input.workbook.readSheet(input.selected)
      if (result.truncated) setState("partial", true)
      return [result.columns, ...result.rows.map((row) => row.cells)]
    },
  )
  let frame: HTMLIFrameElement | undefined
  const [frameState, setFrameState] = createStore({ ready: false })
  createEffect(() => {
    const data = bytes()
    if (props.kind !== "docx" || !data || !frameState.ready || !frame?.contentDocument) return
    const document = frame.contentDocument
    const body = document.getElementById("document")
    const styles = document.getElementById("styles")
    if (!body || !styles) return
    let current = true
    // The document's hyperlinks are the author's; each one shows its full address before it opens.
    const release = guardExternalLinks(document, {
      open: (url) => void openLink(url),
      fragment: (id) => document.getElementById(id)?.scrollIntoView(),
    })
    void (async () => {
      const prepared = await prepareDocxPackage(data)
      if (!current) return
      setState("partial", prepared.unsupported.size > 0)
      await renderAsync(prepared.bytes, body, styles, {
        inWrapper: true,
        ignoreWidth: true,
        breakPages: false,
        useBase64URL: true,
        // An imported document (`w:altChunk`) would be drawn in a nested frame the link guard never reaches.
        renderAltChunks: false,
      })
      if (!current || !frame) return
      const observe = new ResizeObserver(() => {
        if (frame) frame.style.height = `${Math.max(300, body.scrollHeight)}px`
      })
      observe.observe(body)
      abort.signal.addEventListener("abort", () => observe.disconnect(), { once: true })
    })().catch(() => {
      if (current) setState("failed", true)
    })
    onCleanup(() => {
      current = false
      release()
    })
  })
  return (
    <Show
      when={
        !bytes.error &&
        !state.failed &&
        !workbook.error &&
        // One sheet the parser could not read is told in its own place, so the others stay reachable.
        (sheet.state !== "errored" || sheet.error instanceof ExcelSheetReadError)
      }
      fallback={
        <p class="reference-notice" role="alert">
          {language.t("groupChat.preview.failed")}
        </p>
      }
    >
      <Show when={state.partial}>
        <p class="reference-notice">{language.t("groupChat.preview.partial")}</p>
      </Show>
      <Show when={!bytes.loading} fallback={<p class="reference-notice">{language.t("groupChat.preview.loading")}</p>}>
        <Switch>
          <Match when={props.kind === "docx"}>
            <iframe
              ref={frame}
              title={props.title}
              class="reference-docx"
              sandbox="allow-same-origin"
              srcdoc={
                '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data: blob:"><style>html,body{margin:0;background:white;overflow:hidden}#document>.docx-wrapper{padding:0;background:transparent}section.docx{box-shadow:none!important;padding:16px!important;max-width:100%;box-sizing:border-box}img,svg{max-width:100%;height:auto}table{display:block;max-width:100%;overflow:auto}</style></head><body><div id="styles" hidden></div><div id="document"></div></body></html>'
              }
              onLoad={() => setFrameState("ready", true)}
            />
          </Match>
          <Match when={props.kind === "excel"}>
            <div class="reference-sheet-tabs" role="tablist" aria-label={props.title}>
              <For each={workbook()?.sheetNames ?? []}>
                {(name) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={state.selected === name}
                    onClick={() => setState("selected", name)}
                  >
                    {name}
                  </button>
                )}
              </For>
            </div>
            <Switch fallback={<p class="reference-notice">{language.t("groupChat.preview.loading")}</p>}>
              <Match when={workbook()?.sheetNames.length === 0}>
                <p class="reference-notice">{language.t("groupChat.preview.downloadOnly")}</p>
              </Match>
              <Match when={sheet.state === "errored"}>
                <p class="reference-notice" role="alert">
                  {language.t("groupChat.preview.failed")}
                </p>
              </Match>
              <Match when={sheet()}>{(rows) => <ReferenceTable rows={rows()} />}</Match>
            </Switch>
          </Match>
        </Switch>
      </Show>
    </Show>
  )
}
