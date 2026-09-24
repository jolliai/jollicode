/**
 * THE SIDEBAR'S SESSION SEARCH, AS A CENTRED DIALOG.
 *
 * ⚠ A DIALOG RATHER THAN A FIELD IN THE COLUMN. An always-visible box between the section header
 * and its rows read as a second heading, and a 300px column leaves a query no room for its results.
 * The header now carries an icon, the way the other sections carry theirs, and the search happens
 * here at a width where a title and its project both fit.
 *
 * ⚠ IT BORROWS THE COMMAND PALETTE'S LOOK, NOT ITS MODEL. The palette mixes commands and files into
 * its results; this lists sessions only, from the same controllers the sidebar rows come from, so
 * the two lists cannot disagree about what a session is called or which course it belongs to.
 *
 * ⚠ THE QUERY IS THE SEARCH CONTROLLER'S AND IS CLEARED ON CLOSE. The sidebar's previous/next
 * arrows step through the search results while a query is set; a query surviving the dialog would
 * leave them stepping through a list nobody can see.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Dialog, DialogBody } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useHomeData } from "@/context/home-data"
import { useLanguage } from "@/context/language"
import type { HomeSessionRecord } from "@/pages/home/home-sessions-controller"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import "@/components/dialog-command-palette-v2.css"

export function DialogSessionSearch() {
  const dialog = useDialog()
  const language = useLanguage()
  const { sessions, search } = useHomeData()
  const [active, setActive] = createSignal(0)
  const filtering = () => search.query.value().trim().length > 0
  const rows = createMemo(() => (filtering() ? search.result.list() : (sessions.data.groups()[0]?.sessions ?? [])))
  let results: HTMLDivElement | undefined

  createEffect(() => {
    rows()
    setActive(0)
  })
  onCleanup(() => search.query.close())

  const open = (record: HomeSessionRecord | undefined) => {
    if (!record) return
    dialog.close()
    sessions.session.open(record.session)
  }
  const move = (delta: number) => {
    const count = rows().length
    if (count === 0) return
    setActive((index) => (index + delta + count) % count)
    requestAnimationFrame(() => results?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }))
  }

  /**
   * ⚠ THE `--columns` MODIFIER IS WHAT KEEPS THIS OFF THE COMMAND PALETTE, which shares every class
   * below. A session's title already carries its course, so a description that starts wherever the
   * title ends reads as one run-on string ("CS 201 · hi  CS 201 · jollicode"). Splitting the row
   * into two columns puts every location at the same x, which is what makes the list scannable.
   * The palette's rows are a command and its hint — a pair that reads as one phrase, and is right
   * to stay unsplit.
   */
  return (
    <Dialog class="command-palette-v2 command-palette-v2--columns" size="large">
      <DialogBody class="command-palette-v2-body">
        <div class="command-palette-v2-search">
          <TextInputV2
            data-action="app-sidebar-session-search"
            value={search.query.value()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            appearance="large"
            placeholder={search.query.placeholder()}
            aria-label={search.query.placeholder()}
            leadingIcon={<Icon name="magnifying-glass" />}
            onInput={(event) => search.query.input(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                move(event.key === "ArrowDown" ? 1 : -1)
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                open(rows()[active()])
                return
              }
              if (event.key !== "Escape") return
              event.preventDefault()
              dialog.close()
            }}
          />
        </div>
        <ScrollView class="command-palette-v2-scroll" viewportRef={(element) => (results = element)}>
          <div class="command-palette-v2-results" role="listbox">
            <Show
              when={rows().length > 0}
              fallback={
                <div class="command-palette-v2-state">
                  {filtering() ? search.result.noResultsLabel() : language.t("home.sessions.empty")}
                </div>
              }
            >
              <div class="command-palette-v2-group">
                <div class="command-palette-v2-group-title">
                  {filtering()
                    ? language.t("home.sessions.search.sessions")
                    : language.t("sidebar.project.recentSessions")}
                </div>
                <For each={rows()}>
                  {(record, index) => (
                    <button
                      type="button"
                      class="command-palette-v2-row group"
                      role="option"
                      data-session-id={record.session.id}
                      aria-selected={index() === active()}
                      data-active={index() === active() ? "" : undefined}
                      onMouseMove={(event) => {
                        // Ignore hover from a static cursor when keyboard scrolling moves rows underneath it.
                        if (event.movementX === 0 && event.movementY === 0) return
                        setActive(index())
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => open(record)}
                    >
                      <div class="command-palette-v2-row-main">
                        <div class="command-palette-v2-row-text">
                          <span class="command-palette-v2-title">
                            {sessionTitle(record.session.title) || record.session.id}
                          </span>
                          <span class="command-palette-v2-description">
                            {[record.course?.code, record.projectName].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                      </div>
                      <span class="command-palette-v2-meta">
                        {getRelativeTime(new Date(record.session.time.updated).toISOString(), language.t)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </ScrollView>
      </DialogBody>
    </Dialog>
  )
}
