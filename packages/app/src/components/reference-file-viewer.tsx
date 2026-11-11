import { createMemo, createResource, For, Match, onCleanup, Show, Suspense, Switch, lazy } from "solid-js"
import { ReferenceMarkdown } from "./reference-markdown"
import { useLanguage } from "@/context/language"
import type { GroupChatLocator } from "@/jolli/group-chat-sources"
import { materialViewerKind } from "@/jolli/reference-viewer-kind"
import { readReferenceBytes, safeReferenceUrl } from "@/jolli/reference-preview"
import { parseCsv } from "@/jolli/parse-reference-csv"
import { decodeMaterialText } from "@/jolli/reference-material-encoding"

const PdfReferenceViewer = lazy(() => import("./reference-pdf-viewer"))
const OfficeReferenceViewer = lazy(() => import("./reference-office-viewer"))

export function ReferenceFileViewer(props: {
  url: string
  title: string
  mimeType: string | null
  sizeBytes?: number | null
  locator?: GroupChatLocator
}) {
  const language = useLanguage()
  const kind = () => materialViewerKind(props.mimeType)
  return (
    <Suspense fallback={<p class="reference-notice">{language.t("groupChat.preview.loading")}</p>}>
      <Switch fallback={<p class="reference-notice">{language.t("groupChat.preview.downloadOnly")}</p>}>
        <Match when={kind() === "pdf"}>
          <PdfReferenceViewer url={props.url} title={props.title} locator={props.locator} />
        </Match>
        <Match when={kind() === "docx" || kind() === "excel"}>
          <OfficeReferenceViewer url={props.url} title={props.title} kind={kind() === "docx" ? "docx" : "excel"} />
        </Match>
        <Match when={kind() === "image"}>
          <img
            class="reference-image"
            src={safeReferenceUrl(props.url)}
            alt={props.title}
            referrerPolicy="no-referrer"
          />
        </Match>
        <Match when={kind() === "text" || kind() === "markdown" || kind() === "csv"}>
          <ReferenceTextViewer url={props.url} kind={kind()} locator={props.locator} />
        </Match>
      </Switch>
    </Suspense>
  )
}

function ReferenceTextViewer(props: { url: string; kind: string; locator?: GroupChatLocator }) {
  const language = useLanguage()
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  const [content] = createResource(async () => {
    const result = await readReferenceBytes(props.url, (props.kind === "csv" ? 10 : 5) * 1024 * 1024, abort.signal)
    return { text: decodeMaterialText(result.bytes, { truncated: result.truncated }), truncated: result.truncated }
  })
  const records = createMemo(() => {
    const text = content()?.text
    if (!text || props.kind !== "csv") return []
    const records = parseCsv(text)
    return content()?.truncated ? records.slice(0, -1) : records
  })
  const rows = createMemo(() => records().slice(0, 5001))
  const lines = createMemo(() => (props.kind === "text" ? (content()?.text.split(/\r?\n/) ?? []) : []))
  return (
    <Show when={!content.loading} fallback={<p class="reference-notice">{language.t("groupChat.preview.loading")}</p>}>
      <Show
        when={!content.error}
        fallback={
          <p class="reference-notice" role="alert">
            {language.t("groupChat.preview.failed")}
          </p>
        }
      >
        <Show when={content()?.truncated || records().length > 5001 || lines().length > 20_000}>
          <p class="reference-notice">{language.t("groupChat.preview.partial")}</p>
        </Show>
        <Switch>
          <Match when={props.kind === "markdown"}>
            <div class="reference-markdown">
              <ReferenceMarkdown text={content()?.text ?? ""} locator={props.locator} />
            </div>
          </Match>
          <Match when={props.kind === "csv"}>
            <ReferenceTable rows={rows()} />
          </Match>
          <Match when={props.kind === "text"}>
            <pre class="reference-plain-text">{lines().slice(0, 20_000).join("\n")}</pre>
          </Match>
        </Switch>
      </Show>
    </Show>
  )
}

export function ReferenceTable(props: { rows: readonly (readonly string[])[] }) {
  return (
    <div class="reference-table-scroll" tabIndex={0}>
      <table class="reference-table">
        <thead>
          <tr>
            <For each={props.rows[0] ?? []}>{(cell) => <th scope="col">{cell}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows.slice(1)}>
            {(row) => (
              <tr>
                <For each={row}>{(cell) => <td>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
