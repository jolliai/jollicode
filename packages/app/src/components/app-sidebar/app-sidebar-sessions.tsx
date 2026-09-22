/**
 * THE SESSION LIST, AS THE SIDEBAR'S SCROLLING SECTION.
 *
 * ⚠ A NEW VIEW RATHER THAN A REUSE OF `HomeSessionsView`, AND THE CONTROLLER IS WHAT IS SHARED. That
 * view is measured in the home page's container-query units — `h-[calc(100cqh-84px)]`,
 * `top-[108px]`, `-mr-3`, all resolved against the `[container-type:size]` on the page's scroller —
 * so none of its geometry means anything in a 300px column. The rows, the grouping and the search
 * all come from `createHomeSessionsController` and `createHomeSessionSearchController`, which is
 * where the behaviour that must not diverge actually lives.
 *
 * ⚠ SEARCH FILTERS IN PLACE INSTEAD OF OPENING A COMBOBOX. The home page hangs a floating result
 * panel off its input, with arrow-key navigation and `aria-activedescendant`; a 300px column has
 * nowhere to float it to, and the list it would cover is the list you are searching. So this shares
 * the controller's query and results and swaps its own body.
 *
 * ⚠ IT CLAIMS `search.element.setInput` AND NOTHING ELSE, AND AN EARLIER VERSION OF THIS NOTE
 * CLAIMED NOTHING AT ALL. The reasoning then was that these three refs are single-valued — last
 * caller wins — so taking them would break the home page's search while both surfaces were mounted.
 * There is no longer a second surface: `HomeSessionsView` was deleted in the same change, which left
 * `mod+f` (`home.sessions.search.focus`) calling `input?.focus()` on a ref nobody set. The box this
 * renders is the only session search in the application, so it has to be the one the keybind finds.
 *
 * ⚠ `setList` AND `setRoot` STAY UNCLAIMED, WHICH IS NOT THE SAME OMISSION. Both serve the combobox
 * this body does not have: `setList` is what arrow-keys scroll, and `setRoot` is what the
 * outside-click rule measures against — a rule that would clear the filter on the next click
 * anywhere. See the guard on that listener in `home-session-search-controller.ts`.
 */

import { createMemo, For, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { SessionProgressIndicatorV2 } from "@opencode-ai/session-ui/v2/session-progress-indicator-v2"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createInlineEditorController } from "@/pages/layout/inline-editor"
import {
  HomeSessionStatusController,
  type HomeSessionRecord,
  type HomeSessionsController,
} from "@/pages/home/home-sessions-controller"
import type { HomeSessionSearchController } from "@/pages/home/home-session-search-controller"
import { sessionTitle } from "@/utils/session-title"
import { APP_SIDEBAR_ROW_LABEL, AppSidebarRow } from "./app-sidebar-row"

export type InlineEditorController = ReturnType<typeof createInlineEditorController>

export function AppSidebarSessions(props: { sessions: HomeSessionsController; search: HomeSessionSearchController }) {
  const language = useLanguage()
  const filtering = () => props.search.query.value().trim().length > 0
  /**
   * ⚠ ONE EDITOR AND ONE OPEN MENU FOR THE WHOLE LIST, HELD HERE RATHER THAN PER ROW. Both are
   * invariants across the section — two rows in edit mode at once, or two menus open, would each be
   * a bug — and the project rows hold their menu state the same way, one level above the rows.
   */
  const editor = createInlineEditorController()
  const [menu, setMenu] = createStore({ open: undefined as string | undefined })
  const rowProps = {
    editor,
    menuOpen: (id: string) => menu.open === id,
    onSetMenuOpen: (id: string, open: boolean) => setMenu("open", open ? id : undefined),
  }

  /**
   * THE LIST, KEYED BY SESSION ID RATHER THAN BY RECORD IDENTITY.
   *
   * ⚠ `<For>` KEYS BY REFERENCE AND THE CONTROLLER REBUILDS ITS RECORDS WHENEVER THE HOME INDEX
   * DOES — which is now every `session.updated` the server sends. Handing it records tore down every
   * row each time: an open row menu closes itself in `onCleanup`, a rename in progress loses its
   * field, and each row's avatar state starts again. Ids are primitives, so an unchanged list is an
   * unchanged `<For>`, and each row reads its record through a signal that updates in place.
   *
   * ⚠ AND THESE MEMOS LIVE HERE RATHER THAN INSIDE THE `<Show>` BELOW, WHICH IS NOT A STYLE CHOICE.
   * A memo created inside `<Show>`'s callback that depends on the same source as its condition can
   * be re-run after the condition turns falsy and before the branch is disposed, and reading the
   * callback's accessor then throws `Stale read from <Show>` — which took the whole renderer down
   * when the last session in the list was deleted. Reading the controller directly has no such
   * window.
   */
  const rows = createMemo(() => props.sessions.data.groups()[0]?.sessions ?? [])
  const rowTitle = () => props.sessions.data.groups()[0]?.title ?? ""
  const rowByID = createMemo(() => new Map(rows().map((record) => [record.session.id, record] as const)))
  const rowIDs = createMemo(() => rows().map((record) => record.session.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
  })

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      <label
        class={`
          mx-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2
          bg-v2-background-bg-layer-02/60 text-v2-icon-icon-muted transition-[background-color]
          duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-02 focus-within:bg-v2-background-bg-layer-02
        `}
      >
        <IconV2 name="magnifying-glass" size="small" class="shrink-0" />
        <input
          /**
           * ⚠ THIS IS WHAT `mod+f` FOCUSES. `home.sessions.search.focus` calls `input?.focus()` on
           * the controller's single ref, so a box that does not hand itself over is a box the
           * keybind cannot reach — which is what the header note explains at length.
           */
          ref={props.search.element.setInput}
          data-action="app-sidebar-session-search"
          class={`
            min-w-0 flex-1 border-0 bg-transparent outline-0
            text-v2-text-text-base [font-weight:440] placeholder:text-v2-text-text-faint
          `}
          value={props.search.query.value()}
          placeholder={props.search.query.placeholder()}
          aria-label={props.search.query.placeholder()}
          onInput={(event) => props.search.query.input(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            event.preventDefault()
            props.search.query.close()
            event.currentTarget.blur()
          }}
        />
        <Show when={props.search.query.value()}>
          {/*
           * ⚠ ITS OWN NAME, NOT THE INPUT'S. Reusing the placeholder here called this button
           * "Search sessions", so a screen reader announced the control that EMPTIES the box in the
           * same words as the box itself — two different things under one name.
           *
           * ⚠ AND IT IS THE EXISTING `common.clear` RATHER THAN A NEW "Clear search". Every string
           * this file adds has to be translated into sixty other locales before `i18n/parity.test`
           * will pass, and "Clear" beside a search field it is visually inside is unambiguous — an
           * already-translated correct name beats a slightly better one that ships in English.
           */}
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            class="shrink-0"
            icon={<IconV2 name="xmark-small" class="text-v2-icon-icon-muted" />}
            aria-label={language.t("common.clear")}
            onClick={() => props.search.query.close()}
          />
        </Show>
      </label>

      <ScrollView class="min-h-0 min-w-0 flex-1">
        <div class="flex min-w-0 flex-col pb-1 pr-1">
          <Show
            when={filtering()}
            fallback={
              /*
               * ⚠ A BOOLEAN `Show` WITH PLAIN CHILDREN, NOT A `For` OVER THE GROUPS AND NOT AN
               * ACCESSOR CALLBACK. `groupSessions` returns a single "Recent sessions" group (see its
               * note), and `<For>` keys by reference: the controller rebuilds that group object on
               * every recompute, so a `For` here tore the whole list down on every `session.updated`.
               * The callback form of `Show` is no good either — see the note on `rows` above, whose
               * memos used to live in it and crashed the renderer with `Stale read from <Show>` the
               * moment the last session was deleted. A boolean condition has neither problem.
               */
              <Show when={rows().length > 0}>
                {/*
                 * ⚠ STICKY WITHOUT THE HOME PAGE'S FADE. That fade is what
                 * `createHomeScrollController` exists to compute — it measures each header's offset
                 * against a sticky top — and it is not worth porting a controller into a narrow
                 * column to cross-fade a five-character date.
                 */}
                <div
                  class={`
                    sticky top-0 z-10 flex h-6 min-w-0 items-center bg-v2-background-bg-deep pl-1.5
                    text-v2-text-text-faint [font-weight:530]
                  `}
                >
                  {rowTitle()}
                </div>
                <For each={rowIDs()}>
                  {(id) => {
                    /**
                     * ⚠ THE LAST KNOWN RECORD IS HELD, BECAUSE A ROW OUTLIVES ITS SESSION BY A
                     * FRACTION OF A FRAME. Deleting a session updates `rowByID` before `<For>` has
                     * disposed the row built for that id, and the row's own memos — its title, its
                     * active state — re-run in that window. Falling back to the previous record lets
                     * them read a whole session on the way out instead of crashing on `undefined`.
                     */
                    const record = createMemo<HomeSessionRecord>(
                      (previous) => rowByID().get(id) ?? previous,
                      untrack(() => rowByID().get(id)!),
                    )
                    return <AppSidebarSessionRow {...rowProps} sessions={props.sessions} record={record()} />
                  }}
                </For>
              </Show>
            }
          >
            <For
              each={props.search.result.list()}
              fallback={<div class="px-1.5 py-2 text-v2-text-text-faint">{props.search.result.noResultsLabel()}</div>}
            >
              {(record) => <AppSidebarSessionRow {...rowProps} sessions={props.sessions} record={record} />}
            </For>
          </Show>
          <Show when={!filtering() && props.sessions.data.groups().length === 0}>
            <div class="px-1.5 py-2 text-v2-text-text-faint">{language.t("home.sessions.empty")}</div>
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}

/**
 * ⚠ EXPORTED FOR THE COURSE TREE, WHICH IS THE ONLY OTHER PLACE A SESSION IS LISTED. Its rows carry
 * the avatar's unread and loading state, the rename editor and the right-click menu; a second
 * hand-written row would be the same three behaviours maintained twice, and the one that drifts is
 * always the copy. See `app-sidebar-courses.tsx` — it owns its own editor and menu state, so the two
 * lists keep their "one open editor, one open menu" invariant separately.
 */
export function AppSidebarSessionRow(props: {
  sessions: HomeSessionsController
  record: HomeSessionRecord
  editor: InlineEditorController
  menuOpen: (id: string) => boolean
  onSetMenuOpen: (id: string, open: boolean) => void
}) {
  const layout = useLayout()
  const language = useLanguage()
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const rowID = () => `session:${props.record.session.id}`
  onCleanup(() => {
    if (props.menuOpen(rowID())) props.onSetMenuOpen(rowID(), false)
  })
  /**
   * WHICH SESSION IS OPEN, READ OFF THE ROUTE RATHER THAN OUT OF A STORE.
   *
   * ⚠ THIS IS THE JOB THE TAB STRIP USED TO DO. The row once had an "is in the open-tab registry"
   * marker in the leading avatar it no longer draws, but with no visible tabs, "open" and "the one
   * you are looking at" had already stopped being the same fact. The route is the only authority on
   * the second one, and `data-selected` on the row is the whole of how it is said.
   */
  const active = createMemo(() => {
    const route = layout.route()
    return route.type === "session" && route.sessionId === props.record.session.id
  })

  return (
    <HomeSessionStatusController
      server={props.sessions.session.server}
      record={props.record}
      isOpenTab={props.sessions.tab.isOpen}
      render={(state) => (
        /**
         * ⚠ THE MENU IS A SIBLING-OF-THE-ROW ARRANGEMENT, LIKE THE PROJECT ROWS'. It opens on
         * right-click of the wrapper rather than from a visible trigger, because a 300px row has no
         * width to spare for one and the strip's menu was right-click too.
         */
        <div
          class="group/session relative flex min-w-0 items-center"
          onContextMenu={(event) => {
            event.preventDefault()
            props.onSetMenuOpen(rowID(), true)
          }}
        >
          <AppSidebarRow
            type="button"
            data-component="app-sidebar-session-row"
            /**
             * ⚠ THE SESSION ID IS IN THE DOM SO AUTOMATION CAN ADDRESS A ROW. The tab strip this
             * replaced was a list of `<a href>`, which meant a test could point at a session by URL;
             * a row is a `<button>` and carries no href, so without this the only handle is the
             * title — which several tests deliberately change while running. See `e2e/utils/nav.ts`.
             */
            data-session-id={props.record.session.id}
            data-selected={active() ? "" : undefined}
            aria-current={active() ? "page" : undefined}
            title={title()}
            onClick={() => props.sessions.session.open(props.record.session)}
          >
            {/*
             * ⚠ THE TITLE IS AN INLINE EDITOR RATHER THAN PLAIN TEXT, so "Rename" can turn this row
             * into a field in place. `createInlineEditorController` allows one open editor at a time
             * and commits on Enter, discards on Escape or blur — the same component the legacy
             * sidebar used, so renaming feels the same wherever it is reached from.
             *
             * ⚠ `openOnDblClick={false}` DELIBERATELY. A double-click on a session row is two
             * ordinary clicks, and the second one would arrive as "navigate" — turning a mis-click
             * into an edit. The menu is the only way in.
             *
             * ⚠ WHICH ALSO MEANS `stopPropagation` APPLIES ONLY WHILE RENAMING. The two props are
             * read together in `inline-editor.tsx`: a label that cannot be opened by double-click
             * lets clicks through to the row, so the title — the widest part of a 300px row — opens
             * the session, while an open field still keeps its clicks.
             */}
            <props.editor.InlineEditor
              id={rowID()}
              value={title}
              openOnDblClick={false}
              stopPropagation
              class="min-w-0 flex-1"
              displayClass={APP_SIDEBAR_ROW_LABEL}
              onSave={(next) => void props.sessions.session.rename(props.record.session, next)}
            />
            {/*
             * RUNNING, OR UNREAD — AT THE TRAILING EDGE, WHERE A TITLE STARTS AT THE MARGIN.
             *
             * ⚠ THE LEADING PROJECT AVATAR IS GONE FROM THIS ROW, AND THESE TWO ARE WHAT IT WAS
             * ACTUALLY CARRYING. It drew three things at once — the project's coloured initial, an
             * unread dot hung off its corner, and a spinner that replaced the whole tile while the
             * session was working. Only the first was decoration; deleting the component outright
             * would have taken a session's "still going" and "something new here" with it, which is
             * the sort of removal that is only noticed a week later when nobody can tell which
             * session is running.
             *
             * ⚠ TRAILING RATHER THAN A BLANK SLOT WHERE THE TILE WAS. Reserving 16px of leading
             * space that is empty on almost every row is the same indent the avatar was, minus the
             * information — the titles would still start inset. At the trailing edge the text sits
             * flush against the row's padding, which is the point.
             *
             * ⚠ AND THEY ARE MUTUALLY EXCLUSIVE, SPINNER WINNING. A session that is working is
             * about to produce the very thing the unread dot would be announcing, so showing both
             * is one state described twice.
             */}
            <Show when={state.loading()}>
              <span class="relative block size-4 shrink-0">
                <SessionProgressIndicatorV2 class="absolute inset-0" />
              </span>
            </Show>
            <Show when={!state.loading() && state.unread()}>
              <span
                aria-hidden="true"
                class="size-1.5 shrink-0 rounded-full bg-v2-background-bg-accent"
                data-slot="app-sidebar-session-unread"
              />
            </Show>
          </AppSidebarRow>
          <MenuV2
            gutter={6}
            modal={false}
            placement="bottom-start"
            open={props.menuOpen(rowID())}
            onOpenChange={(open) => props.onSetMenuOpen(rowID(), open)}
          >
            {/*
             * ⚠ A ZERO-SIZE ANCHOR, NOT A BUTTON. The menu is opened by right-clicking the row, so
             * the trigger exists only to give the popover somewhere to attach; rendering a visible
             * control would put a second affordance on every row for no reason.
             */}
            <MenuV2.Trigger as="span" aria-hidden="true" class="absolute bottom-0 left-2 h-0 w-0" />
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuV2.Item
                  data-action="sidebar-session-rename"
                  onSelect={() => props.editor.openEditor(rowID(), title())}
                >
                  {language.t("common.rename")}
                </MenuV2.Item>
                <MenuV2.Item
                  data-action="sidebar-session-close"
                  onSelect={() => props.sessions.session.close(props.record.session)}
                >
                  {language.t("command.tab.close")}
                </MenuV2.Item>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </div>
      )}
    />
  )
}
