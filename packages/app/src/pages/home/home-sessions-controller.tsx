import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, createEffect, createMemo, createRoot, type JSX, startTransition } from "solid-js"
import { produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { archiveHomeSession } from "../home-session-archive"
import { courseById } from "@/jolli/catalog"
import { HomeCourseSelection } from "@/jolli/home-selection"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import type { Course } from "@/jolli/types"
import type { HomeController } from "./home-controller"

const HOME_SESSION_LIMIT = 64
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
  /**
   * ⚠ OPTIONAL, AND WILL OFTEN BE ABSENT. Sessions created before a course existed — or outside one
   * entirely — have no binding, and a row for one is an ordinary row rather than a broken one.
   */
  course?: Course
}

export type HomeSessionGroup = {
  id: "recent"
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const projectDirectories = createMemo(() => {
    const project = home.project.selected()
    if (!project) return home.project.list().flatMap(directories)
    return directories(project)
  })
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => home.server.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => ctx.sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      homeSessions().sessions(sessionLoad.data, sessionEventLoad.data),
      HOME_SESSION_LIMIT,
      Date.now(),
    ),
  )
  /**
   * ⚠ ONE RECORD OBJECT PER SESSION, REUSED UNTIL THAT SESSION ACTUALLY CHANGES, AND IT IS LOAD
   * BEARING RATHER THAN AN OPTIMISATION. `<For>` keys by reference, so a rebuilt record is a
   * destroyed and re-created row — which closes the row's open menu (it clears it in `onCleanup`),
   * drops a rename editor mid-edit, and re-runs every row's avatar state. This memo re-runs on every
   * `session.updated` the server sends, and one arrives after each turn's token accounting, so
   * allocating fresh records each time meant the list flickered through a whole rebuild while you
   * were reading it.
   *
   * ⚠ THE MAP IS REPLACED RATHER THAN MUTATED, so a session that leaves the list takes its entry
   * with it instead of accumulating for the life of the renderer.
   */
  let records_ = new Map<string, HomeSessionRecord>()
  const allRecords = createMemo(() => {
    const next = new Map<string, HomeSessionRecord>()
    const result = buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
      projectByID,
      reuse: (record) => {
        const previous = records_.get(record.session.id)
        const keep =
          previous &&
          previous.session === record.session &&
          previous.project === record.project &&
          previous.projectName === record.projectName &&
          previous.course === record.course
        const resolved = keep ? previous : record
        next.set(record.session.id, resolved)
        return resolved
      },
    })
    records_ = next
    return result
  })
  /**
   * ⚠ THE COURSE FILTER IS APPLIED BEFORE THE LIMIT, so selecting a course cannot show fewer than a
   * full page of its sessions just because busier courses filled the first 64.
   *
   * ⚠ AND IT IS EXCLUSIVE WITH THE PROJECT FILTER RATHER THAN COMBINED WITH IT — see
   * `jolli/home-selection.ts`. Selecting a course already cleared the project selection, so the
   * directory filter upstream of this is a no-op whenever this one is active.
   */
  const courseFiltered = createMemo(() => {
    const courseId = HomeCourseSelection.courseId()
    if (!courseId) return allRecords()
    return allRecords().filter((record) => record.course?.id === courseId)
  })
  const records = createMemo(() => courseFiltered().slice(0, HOME_SESSION_LIMIT))
  const groups = createMemo(() => groupSessions(records(), language))
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() =>
                Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id)
                    }),
                  ),
                ),
              )
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  /**
   * ⚠ THE KEY IS SHARED WITH THE OTHER TWO PALETTE REGISTRATIONS, AND THAT IS LOAD-BEARING.
   * `activeCommandRegistrations` keeps one registration per key and drops the rest, while the id
   * de-duping one layer up only warns and keeps whichever came first. This controller now lives at
   * application scope, so it is mounted at the same time as the session and draft routes; giving
   * all three the key `"palette"` makes the most recently mounted surface own the palette outright
   * and hand it back on unmount. Three different keys would leave two live registrations of id
   * `command.palette` and a DEV warning on every route change.
   */
  command.register("palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = home.server.focused()
        if (!conn) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
        void dialog.show(() => (
          <DialogHomeCommandPaletteV2
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
  ])

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isLoading,
      searchRecords: allRecords,
    },
    session: {
      showProjectName: () => !home.project.selected(),
      /**
       * ⚠ THE ROW SHOWS THE AXIS YOU ARE NOT FILTERING BY. Standing in a course, the useful
       * secondary fact is which repository the work happened in; standing in a project — or nowhere
       * — it is which course the session belongs to. Showing both would put two breadcrumbs on
       * every row, one of which the reader already knows.
       */
      showCourseCode: () => !HomeCourseSelection.courseId(),
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      create: home.project.openNewSession,
      open: (session: Session, options?: OpenSessionOptions) => {
        const directoryKey = pathKey(session.directory)
        const project =
          home.project
            .list()
            .find(
              (item) =>
                pathKey(item.worktree) === directoryKey ||
                item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
            ) ?? projectForSession(session, home.project.list(), projectByID())
        const conn = home.server.focused()
        if (!conn) return
        const directory = project?.worktree ?? session.directory
        const ctx = home.server.focusedContext()
        if (!ctx) return
        ctx.projects.open(directory)
        if (options?.background) {
          tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          return
        }
        ctx.projects.touch(directory)
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          tabs.select(tab)
        })
      },
      /**
       * RENAME A SESSION FROM ITS ROW.
       *
       * ⚠ THIS REPLACES A PATH THAT THE TAB STRIP OWNED. Renaming used to be reachable by
       * right-clicking a tab, including an INACTIVE one — the only way to retitle a session you
       * were not currently reading. Deleting the strip took that with it; the session heading in
       * the timeline only ever renames the session on screen.
       *
       * ⚠ THE OPTIMISTIC WRITE IS THE SERVER EVENT, NOT A LOCAL PATCH. `session.renamed` comes back
       * over sync and `server-session.ts` folds it into the store, so there is nothing to reconcile
       * here — which is also why a failure only has to say so.
       */
      rename: async (session: Session, title: string) => {
        const next = title.trim()
        if (!next || next === session.title) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        await ctx.sdk.client.session
          .update({ sessionID: session.id, directory: session.directory, title: next })
          .catch((cause: unknown) =>
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
          )
      },
      /**
       * ⚠ "CLOSE" MEANS THE REGISTRY ENTRY, NOT THE SESSION — the session keeps existing and stays
       * in this list. It is what `mod+w` does, and `closeTab` already handles the parts that are
       * easy to get wrong: recording it for reopen, disposing the unsent prompt, and navigating on
       * if you were standing in it.
       */
      close: (session: Session) => {
        const server = home.selection.value().server
        const index = tabs.store.findIndex(
          (tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id,
        )
        if (index !== -1) tabs.closeTab(index)
      },
      archive: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        if ((await ctx.sdk.protocol) !== "v1") return
        await archiveHomeSession({
          server: ServerConnection.key(conn),
          session,
          archive: (sessionID) =>
            ctx.sdk.client.session.update({
              sessionID,
              directory: session.directory,
              time: { archived: Date.now() },
            }),
          remove: () => {
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, session.id, (item) => item.id)
                if (match.found) draft.session.splice(match.index, 1)
              }),
            )
            homeSessions().remove(session.id)
          },
          onError: (cause) =>
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
        })
      },
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
  /** Hands each freshly built record to the caller, which may swap in an equal one it already had. */
  reuse?: (record: HomeSessionRecord) => HomeSessionRecord
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      const record: HomeSessionRecord = {
        session,
        project,
        projectName: displayName(project),
        course: courseById(courseBindingOf(session)?.courseId),
      }
      return input.reuse ? input.reuse(record) : record
    })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

/**
 * ONE LIST, MOST RECENT FIRST — NOT TODAY / YESTERDAY / OLDER.
 *
 * ⚠ THE DATE HEADERS WERE A HOME-PAGE IDEA AND THE HOME PAGE IS GONE. They were worth their line of
 * vertical space across a 720px column where a day's work was several rows; the only surface left
 * reading `groups()` is the 300px sidebar, where three sticky headers over a 64-row list spent a
 * quarter of the visible column saying what the order already says.
 *
 * ⚠ THE ORDER IS UNCHANGED AND IT IS WHAT MAKES THIS SAFE. `records()` is already sorted by
 * `compareSessionTime` and capped at `HOME_SESSION_LIMIT` upstream, so flattening the groups drops
 * the headers and nothing else — the rows come out in exactly the sequence the three buckets used
 * to present them in. Anything past the fold is reached by scrolling.
 *
 * ⚠ AND IT STAYS A GROUP ARRAY RATHER THAN BECOMING A BARE LIST, so the one caller keeps its
 * heading, its empty check and its `<For>` shape. A single group is the smaller change than
 * rewriting the section around a different contract.
 */
function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  if (records.length === 0) return []
  return [{ id: "recent" as const, title: language.t("sidebar.project.recentSessions"), sessions: records }]
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
