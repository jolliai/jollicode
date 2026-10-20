import { afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let createSessionStart: typeof import("./submit").createSessionStart
let catalogGeneration: typeof import("@/jolli/catalog").catalogGeneration
let catalogRefreshed: typeof import("@/jolli/catalog").catalogRefreshed

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
  title?: string
}> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
/** Ids handed to the Home session index — what the sidebar list and its search read. */
const indexedSessions: string[] = []
const promoted: Array<{ directory: string; sessionID: string }> = []
let courseBinding: { courseId: string; assistantId: string } | undefined
/** The resolved course behind that binding — its `code` is the prefix a new session is named with. */
let course: { id: string; code: string } | undefined
const coursePromoted: Array<{ directory: string; sessionID: string; binding?: unknown }> = []
/** The order history and the course binding were promoted in, across one submit. */
const promotions: string[] = []
/** What a Start sent to the sidecar, and what the sidecar answers it with. */
const jolliStartInputs: unknown[] = []
/** Every `session.update` the submit sent — only the first message of a started session renames it. */
const sessionUpdates: unknown[] = []
let jolliStartAnswer: () => Promise<{ data: unknown }> = async () => ({ data: { status: "unreachable" } })
/** The draft's Start state, as `session-binding.tsx` keeps it. */
const draftState: {
  starting: boolean
  startError?: string
  startMessage?: string
  task?: { courseId: string; assistantId: string; assignmentId: string; partId: string; label: string }
  startingSeen: boolean[]
} = {
  starting: false,
  startingSeen: [],
}
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
/** Session tabs added without a draft to promote — what a Start answered after its draft closed gets. */
const addedTabs: Array<{ server: string; sessionId: string }> = []
/** The open tabs, when a test sets them; otherwise the draft in the route is the only one open. */
let openTabs: Array<{ type: "draft"; draftID: string; server: string; directory: string }> | undefined
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
/** What the submit put back into an input — a message held back for a session to read its opener first. */
const promptSets: unknown[] = []
/** What the submit did to the input, in order: emptied it, or put a message back into it. */
const promptWrites: string[] = []
/** Every toast the submit showed. */
const toasts: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
/** Flip to walk the paths that leave a submit with no session to hand its history to. */
let worktreeCreateFails = false
/** Every worktree `worktree.create` made, by directory. */
let worktreesCreated = 0
/** Whether `session.create` throws, and with what under `cause` — the SDK puts the HTTP status there. */
let sessionCreateFails: boolean | { status: number } = false
/** The one of those paths that raises instead of returning — nothing downstream gets to clean up. */
let childSyncFails = false
/** Whether promoting the new session throws: a failure after the session already exists. */
let coursePromoteFails = false

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => {
    promptWrites.push("reset")
  },
  set: (value: unknown) => {
    promptWrites.push("set")
    promptSets.push(value)
  },
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          if (sessionCreateFails)
            throw new Error(
              "session create failed",
              typeof sessionCreateFails === "object" ? { cause: sessionCreateFails } : {},
            )
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
      update: async (input: unknown) => {
        sessionUpdates.push(input)
        return { data: undefined }
      },
      jolliStart: async (input: unknown) => {
        jolliStartInputs.push(input)
        draftState.startingSeen.push(draftState.starting)
        return jolliStartAnswer()
      },
    },
    worktree: {
      create: async () => {
        if (worktreeCreateFails) return { data: undefined }
        worktreesCreated++
        return { data: { directory: `${directory}/new` } }
      },
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  // What `submit.ts` actually imports. Without this the real module is loaded, dragging in the
  // Kobalte toaster for no benefit to any assertion here.
  mock.module("@/utils/toast", () => ({
    showToast: (options: unknown) => toasts.push(options),
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  // The course binding is promoted alongside the model/agent selection above. Recorded rather than
  // ignored so a regression that stops binding a new session to its course fails here.
  mock.module("@/jolli/session-binding", () => ({
    useCourseSession: () => ({
      /**
       * The binding travels with `session.create` now, so submitting reads it as well as promoting
       * it. Unbound is the honest default here — these tests are about worktree selection, and a
       * session created without a course is exactly what a bare CLI or an older build produces.
       */
      current: () => courseBinding,
      /** Read for the title a new session is born with — see `jolli/session-title.ts`. */
      course: () => course,
      promote(directory: string, sessionID: string, binding?: unknown) {
        if (coursePromoteFails) throw new Error("promote failed")
        coursePromoted.push({ directory, sessionID, ...(binding ? { binding } : {}) })
        promotions.push("course")
      },
      draft: {
        get starting() {
          return draftState.starting
        },
        setStarting(value: boolean) {
          draftState.starting = value
        },
        get startError() {
          return draftState.startError
        },
        setStartError(key: string | undefined) {
          draftState.startError = key
        },
        get startMessage() {
          return draftState.startMessage
        },
        setStartMessage(message: string | undefined) {
          draftState.startMessage = message
        },
        get task() {
          return draftState.task
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      get store() {
        return (
          openTabs ??
          (search.draftId
            ? [{ type: "draft", draftID: search.draftId, server: "project-server", directory: "/repo/main" }]
            : [])
        )
      },
      addSessionTab: (tab: { server: string; sessionId: string }) => {
        addedTabs.push(tab)
      },
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: () => undefined,
        sync: async () => {
          serverSessionSyncs++
        },
      },
      // The Home session index the sidebar list and its search read — `seed` writes the new
      // session here as well as into the per-directory store.
      homeSessions: {
        add: (session: { id: string }) => {
          indexedSessions.push(session.id)
        },
      },
      child: (directory: string) => {
        if (childSyncFails) throw new Error("sync child failed")
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  createSessionStart = mod.createSessionStart
  const catalog = await import("@/jolli/catalog")
  catalogGeneration = catalog.catalogGeneration
  catalogRefreshed = catalog.catalogRefreshed
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  courseBinding = undefined
  course = undefined
  coursePromoted.length = 0
  promotions.length = 0
  jolliStartInputs.length = 0
  sessionUpdates.length = 0
  jolliStartAnswer = async () => ({ data: { status: "unreachable" } })
  draftState.starting = false
  draftState.startError = undefined
  draftState.startMessage = undefined
  draftState.task = undefined
  draftState.startingSeen.length = 0
  promotedDrafts.length = 0
  addedTabs.length = 0
  openTabs = undefined
  sentPrompts.length = 0
  promptInputs.length = 0
  promptSets.length = 0
  promptWrites.length = 0
  toasts.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  worktreeCreateFails = false
  worktreesCreated = 0
  sessionCreateFails = false
  childSyncFails = false
  coursePromoteFails = false
  serverSessionSyncs = 0
  indexedSessions.length = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    // `title` is the submitted text — these two run in shell mode, so the command is what was typed.
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
        title: "ls",
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
        title: "ls",
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    // Every new session must also carry its course binding forward: a regression that stopped
    // promoting the course would leave these sessions unbound (and, in the UI, unable to send).
    expect(coursePromoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test.each(["review", "course:quiz"])("routes /%s through the appropriate session API", async (name) => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name })
    const content = `/${name} staged changes`
    promptValue = [{ type: "text", content, start: 0, end: content.length }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    if (name === "course:quiz") {
      expect(sentCommands).toEqual([])
      expect(promptInputs).toHaveLength(1)
      expect(JSON.stringify(promptInputs[0])).toContain(content)
      return
    }

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
    // The sidebar reads a different cache from the store above, so seeding one is not seeding both.
    expect(indexedSessions).toEqual(["session-1"])
  })
})

/**
 * WHAT A NEW SESSION IS CALLED BEFORE ANYONE HAS NAMED IT.
 *
 * ⚠ THE ASSERTION IS ON THE CREATE PAYLOAD, NOT ON THE STORE. The server is the only authority on a
 * session's title — `seed` writes back whatever `create` answered with — so a title that is right in
 * this array and wrong on the wire is a title that never reaches a reader. The shim that carries it
 * there is covered separately in `utils/server-compat.test.ts`.
 */
describe("prompt submit session title", () => {
  const titleSubmit = () =>
    createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

  test("names a new session after its course and the first message", async () => {
    course = { id: "1", code: "CS 310" }
    promptValue = [{ type: "text", content: "why does my quicksort go out of bounds", start: 0, end: 38 }]

    await titleSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sessionCreateInputs[0]?.title).toBe("CS 310 · why does my quicksort go out of bounds")
  })

  test("names it after the message alone when the session has no course", async () => {
    promptValue = [{ type: "text", content: "why does my quicksort go out of bounds", start: 0, end: 38 }]

    await titleSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sessionCreateInputs[0]?.title).toBe("why does my quicksort go out of bounds")
  })

  /**
   * ⚠ NO TITLE RATHER THAN THE COURSE CODE ON ITS OWN. Omitting the field leaves the session on the
   * server's default, which is the one case the server's own titler still runs for.
   */
  test("sends no title when the submission carries no text", async () => {
    course = { id: "1", code: "CS 310" }
    promptValue = [{ type: "text", content: "   ", start: 0, end: 3 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      // Images alone are a valid submission; the empty-prompt early return does not apply.
      commentCount: () => 1,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sessionCreateInputs).toHaveLength(1)
    expect(sessionCreateInputs[0]).not.toHaveProperty("title")
  })
})

/**
 * ⚠ THE ENTRY IS STAGED BEFORE THE FIRST AWAIT, SO EVERY EXIT OWES IT AN ANSWER. `addToHistory`
 * runs at the top of the submit, under the bucket of a chat that has no session yet. If the submit
 * then ends without one, nothing moves that bucket anywhere — and the next new chat in the same
 * folder recalls a prompt it never saw. These cover the four ways out.
 */
describe("prompt submit history handoff", () => {
  const history = { promoted: [] as string[], discarded: 0 }

  const submitWithHistory = (
    info: () => { id: string; title?: string; metadata?: Record<string, unknown> } | undefined = () => undefined,
    mode: "normal" | "shell" = "shell",
  ) =>
    createPromptSubmit({
      prompt,
      info,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => mode,
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      promoteHistory: (sessionID) => {
        history.promoted.push(sessionID)
        promotions.push("history")
      },
      discardHistory: () => history.discarded++,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

  const event = () => ({ preventDefault: () => undefined }) as unknown as Event

  beforeEach(() => {
    history.promoted.length = 0
    history.discarded = 0
  })

  test("hands the staged entry to the session the submit created", async () => {
    await submitWithHistory().handleSubmit(event())

    expect(history.promoted).toEqual(["session-1"])
    expect(history.discarded).toBe(0)
  })

  test("drops the staged entry when the worktree never appears", async () => {
    selected = "create"
    worktreeCreateFails = true

    await submitWithHistory().handleSubmit(event())

    // No session was ever reached, so there is nothing to promote it into.
    expect(createdSessions).toEqual([])
    expect(history.promoted).toEqual([])
    expect(history.discarded).toBe(1)
  })

  test("drops the staged entry when the session never appears", async () => {
    sessionCreateFails = true

    await submitWithHistory().handleSubmit(event())

    expect(createdSessions).toEqual([])
    expect(history.promoted).toEqual([])
    expect(history.discarded).toBe(1)
  })

  /**
   * ⚠ THE SERVER JUDGES A NEW BINDING BY A LIST THAT CAN BE NEWER THAN THIS SCREEN'S. An assistant
   * switched to speak first is refused with a bare 400, and only a fresh list puts Start in its place.
   */
  test("a bound create refused as a bad request refreshes the catalogue, and nothing else does", async () => {
    const generation = catalogGeneration()

    sessionCreateFails = { status: 400 }
    await submitWithHistory().handleSubmit(event())
    courseBinding = { courseId: "7", assistantId: "42" }
    sessionCreateFails = { status: 500 }
    await submitWithHistory().handleSubmit(event())
    expect(catalogGeneration()).toBe(generation)

    sessionCreateFails = { status: 400 }
    await submitWithHistory().handleSubmit(event())
    expect(catalogGeneration()).toBe(generation + 1)
    expect(catalogRefreshed(catalogGeneration())).toBe(true)
  })

  /**
   * ⚠ THE WAY OUT THAT RAISES SKIPS BOTH HANDOFFS. The two misses above end in a `return` that
   * discards on its way past. Anything that throws between staging the entry and promoting it —
   * here the per-directory store the worktree path opens — reaches neither, and the bucket would
   * sit on a draft with no session coming for it.
   */
  test("drops the staged entry when the submit throws", async () => {
    childSyncFails = true

    await expect(submitWithHistory().handleSubmit(event())).rejects.toThrow("sync child failed")

    expect(createdSessions).toEqual([])
    expect(history.promoted).toEqual([])
    expect(history.discarded).toBe(1)
  })

  /**
   * Enter is guarded against being held down, not against being pressed twice, and the input is not
   * cleared until the send returns — so the second press arrives mid-flight, reads the same empty
   * `params.id`, and would start a second session carrying a duplicate of the same text.
   */
  test("double-pressing Enter on a new chat creates one session, not two", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const submit = submitWithHistory()
    const first = submit.handleSubmit(event())
    const second = submit.handleSubmit(event())
    release()
    await Promise.all([first, second])

    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(history.promoted).toEqual(["session-1"])
    expect(history.discarded).toBe(0)
  })

  test("a chat that already has a session still accepts back-to-back submits", async () => {
    params.id = "session-existing"

    const submit = submitWithHistory(() => ({ id: "session-existing" }))
    await Promise.all([submit.handleSubmit(event()), submit.handleSubmit(event())])

    // Nothing to create or promote here — the point is that neither submit was swallowed.
    expect(createdSessions).toEqual([])
    expect(sentShell).toHaveLength(2)
  })

  /**
   * ⚠ START MAKES THE SESSION BEFORE ANYTHING IS TYPED, so it is born with the server's default
   * title; the student's first message names it as a typed first message would have.
   */
  test("the first message into a started session names it after the course and the message", async () => {
    params.id = "ses_started"
    course = { id: "7", code: "CS 310" }
    const metadata = { jolli: { courseId: "7", assistantId: "42" }, jolliOpener: { sessionID: "ses_started" } }

    await submitWithHistory(() => ({
      id: "ses_started",
      title: "New session - 2026-10-14T08:00:00.000Z",
      metadata,
    })).handleSubmit(event())
    expect(sessionUpdates).toEqual([{ sessionID: "ses_started", title: "CS 310 · ls" }])

    // Named already, or never started on the gateway: left alone.
    await submitWithHistory(() => ({ id: "ses_started", title: "CS 310 · ls", metadata })).handleSubmit(event())
    await submitWithHistory(() => ({
      id: "ses_started",
      title: "New session - 2026-10-14T08:00:00.000Z",
      metadata: { jolli: metadata.jolli },
    })).handleSubmit(event())
    expect(sessionUpdates).toHaveLength(1)
  })

  /**
   * ⚠ A TASK'S DRAFT TYPED INTO IS STILL OPENED THROUGH THE TASK. Its agent waits for the student, so
   * the draft shows the input; the session must still be the one the gateway opens for the task — a
   * plain `session.create` would make a chat the task could never be handed in from.
   */
  test("a typed first message on a task's draft opens the task's session on the gateway, then sends it", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }
    course = { id: "7", code: "CS 310" }
    draftState.task = { ...courseBinding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => ({
      data: {
        status: "started",
        opener: false,
        session: {
          id: "ses_task",
          directory: "/repo/worktree-a",
          title: "New session - 2026-10-14T08:00:00.000Z",
          time: { created: 1, updated: 1 },
          metadata: { jolli: courseBinding, jolliOpener: { sessionID: "ses_task" } },
        },
      },
    })

    await submitWithHistory().handleSubmit(event())

    expect(jolliStartInputs).toEqual([
      expect.objectContaining({ courseId: "7", assistantId: "42", assignmentId: "40", partId: "41" }),
    ])
    // Named by the typed message only once it is sent, as a started session is: an opener could hold it back.
    expect(jolliStartInputs[0]).not.toHaveProperty("title")
    expect(sessionUpdates).toEqual([{ sessionID: "ses_task", title: "CS 310 · ls" }])
    expect(sessionCreateInputs).toEqual([])
    expect(sentShell).toEqual([expect.objectContaining({ sessionID: "ses_task", command: "ls" })])
    expect(history.promoted).toEqual(["ses_task"])
    // Before the session is shown: its composer reads the history once, as it is made.
    expect(promotions).toEqual(["history", "course"])
    // The composer waited as Start's row does while the gateway opened the session, and came back after.
    expect(draftState.startingSeen).toEqual([true])
    expect(draftState.starting).toBe(false)
  })

  /**
   * ⚠ AN OPENER THE CATALOGUE DID NOT FORESEE HOLDS THE TYPED MESSAGE BACK. The list said the agent does not
   * speak first, but the gateway wrote it an opener; the message goes to the session's input, unsent,
   * and the catalogue is asked again so the next draft shows Start.
   */
  test("a typed first message whose task's agent turns out to open the session is held back for its input", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }
    draftState.task = { ...courseBinding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => ({
      data: {
        status: "started",
        opener: true,
        session: {
          id: "ses_task",
          directory: "/repo/worktree-a",
          title: "New session - 2026-10-14T08:00:00.000Z",
          time: { created: 1, updated: 1 },
          metadata: { jolli: courseBinding, jolliOpener: { sessionID: "ses_task", text: "Hi" } },
        },
      },
    })
    const before = catalogGeneration()

    await submitWithHistory(undefined, "normal").handleSubmit(event())

    expect(coursePromoted).toEqual([expect.objectContaining({ sessionID: "ses_task" })])
    expect(sentPrompts).toEqual([])
    expect(sentShell).toEqual([])
    expect(sessionUpdates).toEqual([])
    expect(promptSets).toEqual([promptValue])
    // Said, since a student who moved on during the wait would otherwise wait on a reply to nothing.
    expect(toasts).toEqual([{ description: "prompt.jolli.start.heldBack" }])
    // The unsent message leaves no history entry behind: promoted, the discard would have had nothing to drop.
    expect(history.promoted).toEqual([])
    expect(history.discarded).toBe(1)
    // Nor does it name the session it was never sent to.
    expect(jolliStartInputs[0]).not.toHaveProperty("title")
    expect(catalogGeneration()).toBe(before + 1)
  })

  /**
   * ⚠ THE INPUT IT WAS TYPED IN IS EMPTIED, AS A SENT MESSAGE'S IS. With no draft tab, that is the New session
   * input; left holding the message, it would send it again, to a plain session, on the next Enter.
   */
  test("a typed first message held back for an opener leaves the input it was typed in empty", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }
    draftState.task = { ...courseBinding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => ({
      data: {
        status: "started",
        opener: true,
        session: {
          id: "ses_task",
          directory: "/repo/worktree-a",
          title: "New session - 2026-10-14T08:00:00.000Z",
          time: { created: 1, updated: 1 },
          metadata: { jolli: courseBinding, jolliOpener: { sessionID: "ses_task", text: "Hi" } },
        },
      },
    })

    await submitWithHistory(undefined, "normal").handleSubmit(event())

    expect(sentPrompts).toEqual([])
    expect(promptSets).toEqual([promptValue])
    // Emptied before the session's input is given the message, so the message is what that input is left with.
    // The input it was typed in is a different one without a draft tab; `clear()` empties both — see its test.
    expect(promptWrites).toEqual(["reset", "set"])
  })

  /** ⚠ A SHELL COMMAND IS RUN THROUGH AN OPENER: it asks the model nothing, so it talks over no one. */
  test("a typed first shell command on a task's draft runs though the gateway wrote an opener", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }
    draftState.task = { ...courseBinding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => ({
      data: {
        status: "started",
        opener: true,
        session: {
          id: "ses_task",
          directory: "/repo/worktree-a",
          title: "New session - 2026-10-14T08:00:00.000Z",
          time: { created: 1, updated: 1 },
          metadata: { jolli: courseBinding, jolliOpener: { sessionID: "ses_task", text: "Hi" } },
        },
      },
    })

    const before = catalogGeneration()

    await submitWithHistory().handleSubmit(event())

    expect(sentShell).toEqual([expect.objectContaining({ sessionID: "ses_task", command: "ls" })])
    expect(promptSets).toEqual([])
    expect(toasts).toEqual([])
    // The catalogue was wrong about the agent all the same.
    expect(catalogGeneration()).toBe(before + 1)
    expect(history.promoted).toEqual(["ses_task"])
  })

  test("a refused task start keeps the typed message, sends nothing, and shows the gateway's sentence", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }
    draftState.task = { ...courseBinding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    const sentence = "Lab 4 stopped taking work at its due date. If you need more time, ask Prof. Okafor."
    jolliStartAnswer = async () => ({ data: { status: "refused", code: "submissions_stopped", message: sentence } })

    await submitWithHistory().handleSubmit(event())

    expect(draftState.startMessage).toBe(sentence)
    expect(sessionCreateInputs).toEqual([])
    expect(sentShell).toEqual([])
    expect(coursePromoted).toEqual([])
    expect(history.discarded).toBe(1)
    expect(draftState.starting).toBe(false)
  })

  /**
   * ⚠ A THROW AFTER THE GATEWAY ANSWERED IS SAID ON THE DRAFT, as Start's is, not left to escape the
   * submit unseen. The session may exist on the gateway, so the next Enter reattaches to its id.
   */
  test("a task start that throws after the gateway answered says so, and the next Enter reattaches", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }
    draftState.task = { ...courseBinding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => ({
      data: {
        status: "started",
        opener: false,
        session: {
          id: "ses_task",
          directory: "/repo/worktree-a",
          title: "New session - 2026-10-14T08:00:00.000Z",
          time: { created: 1, updated: 1 },
          metadata: { jolli: courseBinding, jolliOpener: { sessionID: "ses_task" } },
        },
      },
    })
    coursePromoteFails = true

    await submitWithHistory().handleSubmit(event())

    expect(draftState.startError).toBe("prompt.jolli.start.failed")
    expect(sentShell).toEqual([])
    expect(history.discarded).toBe(1)

    coursePromoteFails = false
    await submitWithHistory().handleSubmit(event())
    const ids = jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
  })

  test("a draft with no task still makes its session with session.create", async () => {
    courseBinding = { courseId: "7", assistantId: "42" }

    await submitWithHistory().handleSubmit(event())

    expect(jolliStartInputs).toEqual([])
    expect(sessionCreateInputs).toHaveLength(1)
  })
})

/**
 * START: THE SHARED NEW-SESSION PATH WITH `session.jolliStart` AS ITS CREATE STEP.
 *
 * What matters is the order — the sidecar answers first, and only a started session is promoted,
 * routed to and bound. A refusal or an unreachable gateway must leave the draft exactly as it was,
 * with a sentence to say why.
 */
describe("session start", () => {
  const binding = { courseId: "7", assistantId: "42" }
  // A Start that throws after it was answered is logged; kept out of the test output, and counted.
  let logged: ReturnType<typeof spyOn<Console, "error">>
  beforeEach(() => {
    logged = spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    logged.mockRestore()
  })
  const startSession = () =>
    createSessionStart({
      newSessionWorktree: () => "main",
      autoAccept: () => false,
    })
  const started = (metadata?: Record<string, unknown>) => ({
    data: {
      status: "started",
      opener: !!metadata?.["jolliOpener"],
      session: { id: "ses_started", directory: "/repo/main", title: "", time: { created: 1, updated: 1 }, metadata },
    },
  })

  /** ⚠ A TASK'S SESSION IS THE TASK'S: the sidecar opens it through the task, so the gateway records it. */
  test("a task's draft starts its session for the task", async () => {
    courseBinding = binding
    draftState.task = { ...binding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => started({ jolli: binding })

    const result = await startSession()()

    expect(jolliStartInputs).toEqual([
      expect.objectContaining({ courseId: "7", assistantId: "42", assignmentId: "40", partId: "41" }),
    ])
    expect(result).toMatchObject({ status: "created" })
  })

  test("a refused task start shows the gateway's sentence", async () => {
    courseBinding = binding
    draftState.task = { ...binding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    const sentence = "Lab 4 stopped taking work at its due date. If you need more time, ask Prof. Okafor."
    jolliStartAnswer = async () => ({ data: { status: "refused", code: "submissions_stopped", message: sentence } })

    const result = await startSession()()

    expect(result).toMatchObject({ status: "not-created" })
    expect(draftState.startMessage).toBe(sentence)
    expect(coursePromoted).toEqual([])
  })

  /** ⚠ ANOTHER TASK WITH THE SAME AGENT IS ANOTHER CONVERSATION, NEVER A RETRY OF THIS ONE. */
  test("an unanswered Start is retried only for the same task", async () => {
    courseBinding = binding
    draftState.task = { ...binding, assignmentId: "40", partId: "41", label: "Lab 4 · Task 2" }
    jolliStartAnswer = async () => ({ data: { status: "unreachable" } })
    await startSession()()
    draftState.task = { ...binding, assignmentId: "40", partId: "43", label: "Lab 4 · Task 3" }
    await startSession()()
    const ids = jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    expect(ids[0]).not.toBe(ids[1])
  })

  test("promotes and routes only once the sidecar answers with a session", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => started({ jolli: binding, jolliOpener: { sessionID: "ses_started", text: "Hi" } })

    const result = await startSession()()

    expect(jolliStartInputs).toEqual([
      {
        directory: "/repo/main",
        courseId: "7",
        assistantId: "42",
        sessionID: expect.stringMatching(/^ses_/),
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
      },
    ])
    expect(result).toMatchObject({ status: "created", session: { id: "ses_started" } })
    expect(promoted).toEqual([{ directory: "/repo/main", sessionID: "ses_started" }])
    // The binding sent is the one promoted, whatever the picker says by the time the answer lands.
    expect(coursePromoted).toEqual([{ directory: "/repo/main", sessionID: "ses_started", binding }])
    expect(indexedSessions).toEqual(["ses_started"])
    expect(draftState.startError).toBeUndefined()
    // The flag the screen reads was up for the whole wait, and is down again.
    expect(draftState.startingSeen).toEqual([true])
    expect(draftState.starting).toBe(false)
  })

  // R16: a started session without an opener is a normal start, not a failure.
  test("a session that came back without an opener is still started", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => started({ jolli: binding })

    const result = await startSession()()

    expect(result).toMatchObject({ status: "created" })
    expect(coursePromoted).toHaveLength(1)
    expect(draftState.startError).toBeUndefined()
  })

  test("a refusal creates nothing, words the code and refreshes the catalogue", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => ({ data: { status: "refused", code: "assistant_closed" } })
    const generation = catalogGeneration()

    const result = await startSession()()

    expect(result).toMatchObject({ status: "not-created" })
    expect(promoted).toEqual([])
    expect(coursePromoted).toEqual([])
    expect(indexedSessions).toEqual([])
    expect(draftState.startError).toBe("prompt.jolli.refusal.closed")
    expect(catalogGeneration()).toBe(generation + 1)
    // Past the server's snapshot, which still lists the assistant that just closed.
    expect(catalogRefreshed(catalogGeneration())).toBe(true)
    expect(draftState.starting).toBe(false)
  })

  /**
   * ⚠ THE WORKTREE EXISTS BEFORE THE GATEWAY ANSWERS. A refusal leaves the draft on the worktree it
   * made, so pressing Start again — or typing instead — uses it rather than making another.
   */
  test("a refused Start into a new worktree leaves the draft on that worktree", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => ({ data: { status: "refused", code: "assistant_closed" } })
    let worktree = "create"
    let resets = 0
    const start = createSessionStart({
      newSessionWorktree: () => worktree,
      onNewSessionWorktreeCreated: (directory) => {
        worktree = directory
      },
      onNewSessionWorktreeReset: () => {
        resets++
        worktree = "main"
      },
      autoAccept: () => false,
    })

    await start()
    await start()
    expect(worktreesCreated).toBe(1)
    expect(worktree).toBe("/repo/main/new")
    expect(resets).toBe(0)

    jolliStartAnswer = async () => started({ jolli: binding })
    expect(await start()).toMatchObject({ status: "created", directory: "/repo/main/new" })
    expect(worktreesCreated).toBe(1)
    expect(resets).toBe(1)
    expect(jolliStartInputs.map((input) => (input as { directory: string }).directory)).toEqual([
      "/repo/main/new",
      "/repo/main/new",
      "/repo/main/new",
    ])
  })

  /** ⚠ THE GATEWAY IS IDEMPOTENT BY ID: AN UNANSWERED START IS RETRIED UNDER THE SAME ONE. */
  test("a Start that got no answer is retried under the same session id, and a refused one is not", async () => {
    courseBinding = binding
    const start = startSession()
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)

    await start()
    await start()
    expect(sent()[0]).toMatch(/^ses_/)
    expect(sent()[1]).toBe(sent()[0])

    jolliStartAnswer = async () => ({ data: { status: "refused", code: "assistant_closed" } })
    await start()
    await start()
    expect(sent()[2]).toBe(sent()[0])
    expect(sent()[3]).not.toBe(sent()[2])
  })

  /**
   * ⚠ A 4XX IS AN ANSWER: the route made nothing, so the next Start owes the id nothing. A dropped
   * connection or a 5xx left the gateway's side unknown and keeps it. The errors are shaped as the
   * SDK's `wrapClientError` throws them, with the status under `cause`.
   */
  test("a Start the sidecar rejected opens under a new id; one it failed on keeps it", async () => {
    courseBinding = binding
    const start = startSession()
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    const failing = (status?: number) => async () => {
      throw new Error("failed", { cause: { body: {}, status } })
    }

    jolliStartAnswer = failing(400)
    await start()
    await start()
    expect(sent()[1]).not.toBe(sent()[0])
    expect(draftState.startError).toBe("prompt.jolli.start.failed")

    jolliStartAnswer = failing(500)
    await start()
    await start()
    expect(sent()[3]).toBe(sent()[2])

    jolliStartAnswer = failing(undefined)
    await start()
    expect(sent()[4]).toBe(sent()[2])
  })

  /**
   * ⚠ THE SESSION CAN EXIST WHEN THE SCREEN FAILS TO MOVE ONTO IT. A Start that was answered and then
   * threw in the promote keeps its id, so the next press reattaches to that session rather than
   * making a second conversation on the gateway; only a Start that ended on its session lets it go.
   */
  test("a Start that throws after it was answered keeps its id until one ends on the session", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => started({ jolli: binding })
    childSyncFails = true
    const start = startSession()
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)

    expect(await start()).toMatchObject({ status: "not-created" })
    expect(draftState.startError).toBe("prompt.jolli.start.failed")
    expect(draftState.starting).toBe(false)
    expect(logged).toHaveBeenCalledTimes(1)

    childSyncFails = false
    expect(await start()).toMatchObject({ status: "created" })
    await start()
    expect(sent()[1]).toBe(sent()[0])
    expect(sent()[2]).not.toBe(sent()[1])
  })

  /**
   * ⚠ THAT SESSION IS ALREADY IN THE SIDEBAR. Another draft handed its id would land in a
   * conversation the student may have carried on with, so only the draft that pressed Start reuses it.
   */
  test("a Start that threw after it was answered is not reused by another draft", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => started({ jolli: binding })
    childSyncFails = true
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    // Each draft has a composer of its own, mounted while that draft is on screen.
    const composerOn = (draftId: string) => {
      search = { draftId }
      return startSession()
    }

    await composerOn("draft-1")()
    await composerOn("draft-1")()
    await composerOn("draft-2")()

    expect(sent()[1]).toBe(sent()[0])
    expect(sent()[2]).not.toBe(sent()[1])
  })

  /**
   * ⚠ A RETRY THAT GOT NO ANSWER HAS NOT UNMADE THE SESSION. Recording it as unanswered handed the
   * id — and the conversation already in the sidebar — to the next draft with the same binding.
   */
  test("an answered Start stays answered when its retry gets no answer", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => started({ jolli: binding })
    childSyncFails = true
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    const composerOn = (draftId: string) => {
      search = { draftId }
      return startSession()
    }

    await composerOn("draft-1")()
    childSyncFails = false
    jolliStartAnswer = async () => ({ data: { status: "unreachable" } })
    await composerOn("draft-1")()
    await composerOn("draft-2")()

    expect(sent()[1]).toBe(sent()[0])
    expect(sent()[2]).not.toBe(sent()[0])
  })

  /**
   * ⚠ THE DRAFT'S WORKTREE CHOICE IS RESET ONCE THE SESSION EXISTS, before the screen moves onto it.
   * A retry that followed the choice asked from the main checkout, and the session the sidecar
   * answered with — made in the worktree — was filed there.
   */
  test("an answered Start is retried in the worktree it was made in", async () => {
    // An assistant no earlier test started, so no retry they left behind is adopted here.
    const fresh = { courseId: "7", assistantId: "44" }
    courseBinding = fresh
    let worktree = "create"
    const start = createSessionStart({
      newSessionWorktree: () => worktree,
      onNewSessionWorktreeCreated: (directory) => {
        worktree = directory
      },
      onNewSessionWorktreeReset: () => {
        worktree = "main"
      },
      autoAccept: () => false,
    })
    // Answered, and then the screen fails to move onto the session.
    jolliStartAnswer = async () => {
      childSyncFails = true
      return started({ jolli: fresh })
    }

    expect(await start()).toMatchObject({ status: "not-created" })
    expect(worktree).toBe("main")

    childSyncFails = false
    jolliStartAnswer = async () => started({ jolli: fresh })
    expect(await start()).toMatchObject({ status: "created", directory: "/repo/main/new" })
    expect(worktreesCreated).toBe(1)
    expect(jolliStartInputs.map((input) => (input as { directory: string }).directory)).toEqual([
      "/repo/main/new",
      "/repo/main/new",
    ])
  })

  /**
   * ⚠ ONE RETRY PER ID. With a single slot per server, another draft's Start took the place of an
   * answered one still waiting on its draft, and that draft's next press made a second conversation.
   */
  test("an answered Start keeps its id while another draft starts", async () => {
    const own = { courseId: "7", assistantId: "45" }
    courseBinding = own
    jolliStartAnswer = async () => started({ jolli: own })
    childSyncFails = true
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    const composerOn = (draftId: string) => {
      search = { draftId }
      return startSession()
    }

    await composerOn("draft-1")()
    childSyncFails = false
    jolliStartAnswer = async () => ({ data: { status: "refused", code: "assistant_closed" } })
    await composerOn("draft-2")()
    jolliStartAnswer = async () => started({ jolli: own })
    await composerOn("draft-1")()

    expect(sent()[1]).not.toBe(sent()[0])
    expect(sent()[2]).toBe(sent()[0])
  })

  /** ⚠ AN UNANSWERED START MADE NOTHING WHERE IT WAS TRIED, so the draft that adopts it decides where. */
  test("an unanswered Start adopted by another draft goes in that draft's directory", async () => {
    const own = { courseId: "7", assistantId: "46" }
    courseBinding = own
    const composerOn = (draftId: string, directory: string) => {
      search = { draftId }
      return createSessionStart({ newSessionWorktree: () => directory, autoAccept: () => false })
    }

    await composerOn("draft-1", "/repo/other")()
    jolliStartAnswer = async () => started({ jolli: own })
    await composerOn("draft-2", "main")()

    const inputs = jolliStartInputs as Array<{ sessionID: string; directory: string }>
    expect(inputs[1]?.sessionID).toBe(inputs[0]?.sessionID)
    expect(inputs.map((input) => input.directory)).toEqual(["/repo/other", "/repo/main"])
  })

  /** ⚠ A START LEFT FOR LONGER THAN THE RETRY WINDOW IS NOT ADOPTED: the next press starts over. */
  test("an unanswered Start is not adopted once its retry window has passed", async () => {
    const own = { courseId: "7", assistantId: "47" }
    courseBinding = own
    const sent = () => jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    const composerOn = (draftId: string) => {
      search = { draftId }
      return startSession()
    }

    await composerOn("draft-1")()
    setSystemTime(new Date(Date.now() + 11 * 60_000))
    try {
      await composerOn("draft-2")()
    } finally {
      setSystemTime()
    }

    expect(sent()[1]).not.toBe(sent()[0])
  })

  test("a different assistant after an unanswered Start opens under a new id", async () => {
    courseBinding = binding
    const start = startSession()
    await start()
    courseBinding = { courseId: "7", assistantId: "43" }
    await start()
    const ids = jolliStartInputs.map((input) => (input as { sessionID: string }).sessionID)
    expect(ids[1]).not.toBe(ids[0])
  })

  test("a refusal with no code we know says try again", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => ({ data: { status: "refused" } })

    await startSession()()

    expect(draftState.startError).toBe("prompt.jolli.start.failed")
    expect(coursePromoted).toEqual([])
  })

  test("an unreachable gateway creates nothing and says try again", async () => {
    courseBinding = binding
    const generation = catalogGeneration()

    await startSession()()

    expect(coursePromoted).toEqual([])
    expect(draftState.startError).toBe("prompt.jolli.start.failed")
    // Only a refusal says something about the catalogue; a network failure does not.
    expect(catalogGeneration()).toBe(generation)
  })

  test("a sidecar that throws is a failure, never a start without an opener", async () => {
    courseBinding = binding
    jolliStartAnswer = async () => {
      throw new Error("socket hang up")
    }

    const result = await startSession()()

    expect(result).toMatchObject({ status: "not-created" })
    expect(coursePromoted).toEqual([])
    expect(draftState.startError).toBe("prompt.jolli.start.failed")
  })

  test("a second press while the first is out does nothing", async () => {
    courseBinding = binding
    draftState.starting = true

    await startSession()()

    expect(jolliStartInputs).toEqual([])
  })

  test("two overlapping presses send one Start", async () => {
    courseBinding = binding
    const answer = Promise.withResolvers<{ data: unknown }>()
    jolliStartAnswer = () => answer.promise
    const start = startSession()

    const first = start()
    await start()
    answer.resolve(started({ jolli: binding }))
    await first

    expect(jolliStartInputs).toHaveLength(1)
    expect(coursePromoted).toHaveLength(1)
  })

  /**
   * ⚠ THE DRAFT IS THE ONE START WAS PRESSED ON, NOT THE ONE ON SCREEN WHEN IT ANSWERS. Read after
   * the wait, the route named whichever draft the student had moved to, and that draft — with
   * whatever was typed in it — became this session.
   */
  test("a Start answered after the student moved to another draft promotes the one it came from", async () => {
    courseBinding = binding
    search = { draftId: "draft-1" }
    jolliStartAnswer = async () => {
      search = { draftId: "draft-2" }
      openTabs = [
        { type: "draft", draftID: "draft-1", server: "project-server", directory: "/repo/main" },
        { type: "draft", draftID: "draft-2", server: "project-server", directory: "/repo/main" },
      ]
      return started({ jolli: binding })
    }

    await startSession()()

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "ses_started" }])
    expect(addedTabs).toEqual([])
  })

  test("a Start answered after its draft was closed opens the session in a tab of its own", async () => {
    courseBinding = binding
    search = { draftId: "draft-1" }
    jolliStartAnswer = async () => {
      search = {}
      openTabs = []
      return started({ jolli: binding })
    }

    const result = await startSession()()

    expect(result).toMatchObject({ status: "created" })
    expect(promotedDrafts).toEqual([])
    expect(addedTabs).toEqual([{ server: "project-server", sessionId: "ses_started" }])
  })

  // The composer is remounted whenever its tab is left; the retry must not start over with it.
  test("a Start that got no answer is retried under the same id from a remounted composer", async () => {
    courseBinding = binding

    await startSession()()
    await startSession()()

    // Everything else about the two Starts is the same, so equal inputs mean the same session id.
    expect(jolliStartInputs).toHaveLength(2)
    expect(jolliStartInputs[1]).toEqual(jolliStartInputs[0])
  })
})
