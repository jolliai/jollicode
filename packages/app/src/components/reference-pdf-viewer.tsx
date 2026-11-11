import { createEffect, createResource, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { getDocument, GlobalWorkerOptions, PDFWorker, version, type RenderTask } from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { useLanguage } from "@/context/language"
import type { GroupChatLocator } from "@/jolli/group-chat-sources"
import { safeReferenceUrl } from "@/jolli/external-link"

GlobalWorkerOptions.workerSrc = workerUrl
let worker: PDFWorker | undefined

function readerWorker() {
  if (!worker || worker.destroyed) {
    const next = new PDFWorker()
    worker = next
    void next.promise.catch(() => {
      if (worker === next) worker = undefined
      next.destroy()
    })
  }
  return worker
}

export default function PdfReferenceViewer(props: { url: string; title: string; locator?: GroupChatLocator }) {
  const language = useLanguage()
  const [state, setState] = createStore<{
    page: number
    zoom: number
    failed: boolean
    width: number
    surface?: HTMLCanvasElement
  }>({
    page: props.locator?.kind === "page" ? props.locator.page : 1,
    zoom: 1,
    failed: false,
    width: 0,
  })
  let loading: ReturnType<typeof getDocument> | undefined
  onCleanup(() => {
    void loading?.destroy()
  })
  const [document] = createResource(async () => {
    const assets = `${import.meta.env.BASE_URL}assets/pdfjs/${version}/`
    const task = getDocument({
      url: safeReferenceUrl(props.url),
      worker: readerWorker(),
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      enableXfa: false,
    })
    loading = task
    const result = await task.promise
    setState("page", Math.min(state.page, result.numPages))
    return result
  })
  let paint = Promise.resolve()
  createEffect(() => {
    const surface = state.surface
    if (!surface?.parentElement) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setState("width", Math.max(200, entry.contentRect.width))
    })
    observer.observe(surface.parentElement)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    const pdf = document()
    const page = state.page
    const zoom = state.zoom
    const surface = state.surface
    const width = state.width
    if (!pdf || !surface || width <= 0) return
    let cancelled = false
    let render: RenderTask | undefined
    paint = paint
      .then(async () => {
        if (cancelled) return
        const sheet = await pdf.getPage(page)
        if (cancelled) return
        setState("failed", false)
        const natural = sheet.getViewport({ scale: 1 })
        const scale = Math.min(1.5, (width - 32) / natural.width) * zoom
        const viewport = sheet.getViewport({ scale })
        const ratio = window.devicePixelRatio || 1
        surface.width = Math.ceil(viewport.width * ratio)
        surface.height = Math.ceil(viewport.height * ratio)
        surface.style.width = `${viewport.width}px`
        surface.style.height = `${viewport.height}px`
        render = sheet.render({ canvas: surface, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        await render.promise
      })
      .catch(() => {
        if (!cancelled) setState("failed", true)
      })
    onCleanup(() => {
      cancelled = true
      render?.cancel()
    })
  })
  return (
    <Show
      when={document()}
      fallback={
        <p class="reference-notice">
          {language.t(document.error ? "groupChat.preview.failed" : "groupChat.preview.loading")}
        </p>
      }
    >
      {(pdf) => (
        <div class="reference-pdf">
          <div class="reference-viewer-toolbar">
            <button
              type="button"
              disabled={state.page <= 1}
              onClick={() => setState("page", state.page - 1)}
              aria-label={language.t("groupChat.preview.previous")}
            >
              ‹
            </button>
            <span>
              {state.page} / {pdf().numPages}
            </span>
            <button
              type="button"
              disabled={state.page >= pdf().numPages}
              onClick={() => setState("page", state.page + 1)}
              aria-label={language.t("groupChat.preview.next")}
            >
              ›
            </button>
            <button
              type="button"
              disabled={state.zoom <= 0.5}
              onClick={() => setState("zoom", state.zoom / 1.25)}
              aria-label={language.t("groupChat.preview.zoomOut")}
            >
              −
            </button>
            <button
              type="button"
              disabled={state.zoom >= 4}
              onClick={() => setState("zoom", state.zoom * 1.25)}
              aria-label={language.t("groupChat.preview.zoomIn")}
            >
              +
            </button>
          </div>
          <Show when={state.failed}>
            <p class="reference-notice" role="alert">
              {language.t("groupChat.preview.failed")}
            </p>
          </Show>
          <div class="reference-pdf-page">
            <canvas ref={(surface) => setState("surface", surface)} aria-label={props.title} />
          </div>
        </div>
      )}
    </Show>
  )
}
