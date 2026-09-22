import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { serverName } from "@/context/server"
import { displayName } from "@/pages/layout/helpers"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { HomeController } from "./home-controller"
import { homeSessionSearchKey, type HomeSessionRecord, type HomeSessionsController } from "./home-sessions-controller"

type HomeSessionSearchSource = Pick<HomeSessionsController, "data" | "session">

export function createHomeSessionSearchController(home: HomeController, sessions: HomeSessionSearchSource) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const [state, setState] = createStore({ value: "", focused: false, highlighted: "" })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  const query = createMemo(() => state.value.trim())
  const results = createMemo(() => {
    const value = query().toLowerCase()
    if (!value) return []
    return sessions.data
      .searchRecords()
      .filter((record) => `${record.session.title} ${record.projectName}`.toLowerCase().includes(value))
  })
  const active = createMemo(() => {
    const records = results()
    if (records.some((record) => homeSessionSearchKey(record) === state.highlighted)) return state.highlighted
    return records[0] ? homeSessionSearchKey(records[0]) : ""
  })
  const open = createMemo(() => state.focused && query().length > 0)
  const placeholder = createMemo(() => {
    const project = home.project.selected()
    if (project) return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })
    if (home.server.list().length > 1) {
      const conn = home.server.focused()
      if (conn) return language.t("home.sessions.search.placeholder.scoped", { scope: serverName(conn) })
    }
    return language.t("home.sessions.search.placeholder")
  })

  /**
   * ⚠ NO ROOT MEANS NO OUTSIDE, SO THIS DOES NOTHING RATHER THAN CLOSING ON EVERY CLICK. This rule
   * belongs to a combobox: the home page hung a floating result panel off the input and `root`
   * wrapped both, so "pointer landed outside root" genuinely meant "you are done with the panel".
   * The sidebar filters its list in place and never sets `root` — and `root?.contains(...)` on an
   * undefined ref is falsy, which made the FIRST click anywhere wipe a query the student had just
   * typed. An inline filter ends on Escape or on its own clear button, not on the next click.
   */
  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!root || !open()) return
      const target = event.target
      if (!(target instanceof Node) || root.contains(target)) return
      close()
    }),
  )

  command.register("home.search", () => [
    {
      id: "home.sessions.search.focus",
      title: placeholder(),
      keybind: "mod+f",
      hidden: true,
      onSelect: focus,
    },
  ])

  /**
   * ⚠ IT OPENS THE SIDEBAR FIRST, BECAUSE THAT IS WHERE THE INPUT LIVES NOW. A closed sidebar is
   * `width: 0` and `inert`, and `HTMLElement.focus()` on an inert subtree is a silent no-op — so
   * without this `mod+f` would appear to do nothing for anyone who had closed the column.
   */
  function focus() {
    layout.sidebar.open()
    setState("focused", true)
    /**
     * ⚠ ONE TICK LATER, SO THE COLUMN HAS STOPPED BEING `inert` BY THE TIME WE ASK. Outside a batch
     * Solid has already written the attribute by the line above; inside one it has not, and a
     * `focus()` against an inert subtree is a silent no-op with no second chance. A microtask is
     * ahead of paint either way, so nothing is visibly deferred.
     */
    queueMicrotask(() => input?.focus())
  }

  function close() {
    setState({ value: "", focused: false })
  }

  function select(record: HomeSessionRecord, options?: { background?: boolean }) {
    sessions.session.open(record.session, options)
    if (!options?.background) close()
  }

  return {
    query: {
      value: () => state.value,
      placeholder,
      open,
      focus,
      input: (value: string) => setState({ value, highlighted: "" }),
      close,
    },
    result: {
      loading: sessions.data.loading,
      list: results,
      active,
      noResultsLabel: () => language.t("home.sessions.search.noResults", { query: query() }),
      highlight: (record: HomeSessionRecord) => setState("highlighted", homeSessionSearchKey(record)),
      move: (delta: number) => {
        const records = results()
        if (records.length === 0) return
        const index = records.findIndex((record) => homeSessionSearchKey(record) === active())
        const next = ((index === -1 ? 0 : index) + delta + records.length) % records.length
        setState("highlighted", homeSessionSearchKey(records[next]))
        list?.querySelector<HTMLElement>(`[data-key="${state.highlighted}"]`)?.scrollIntoView({ block: "nearest" })
      },
      select,
      selectActive: () => {
        const record = results().find((item) => homeSessionSearchKey(item) === active())
        if (record) select(record)
      },
    },
    element: {
      setRoot: (element: HTMLDivElement) => (root = element),
      setInput: (element: HTMLInputElement) => (input = element),
      setList: (element: HTMLDivElement) => (list = element),
    },
  }
}

export type HomeSessionSearchController = ReturnType<typeof createHomeSessionSearchController>
