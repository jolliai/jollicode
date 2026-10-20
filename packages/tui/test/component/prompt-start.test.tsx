/** @jsxImportSource @opentui/solid */
/**
 * THE TUI'S START: SUBMITTING AN EMPTY PROMPT UNDER AN ASSISTANT THAT OPENS THE CONVERSATION.
 *
 * ⚠ THE REAL PROMPT IS RENDERED, BECAUSE `start()` IS A CLOSURE INSIDE IT. What is under test is which
 * session id each Start sends: an unanswered one — no response, a 5xx, `unreachable` — is retried
 * under the same id, since the gateway may have made the conversation all the same; a rejected or
 * refused one made nothing and the next takes a fresh id. The sidecar is a fake `fetch`.
 */
import { afterAll, expect, setSystemTime, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { ExitProvider } from "../../src/context/exit"
import { JolliProvider, useJolli } from "../../src/context/jolli"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider, useLocal } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider } from "../../src/context/prompt"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { FrecencyProvider } from "../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../src/component/prompt/history"
import { PromptStashProvider } from "../../src/component/prompt/stash"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/** The flag the shipped entry point sets. */
const originalLockdown = process.env["JOLLICODE_LOCKDOWN"]
process.env["JOLLICODE_LOCKDOWN"] = "1"
afterAll(() => {
  if (originalLockdown === undefined) delete process.env["JOLLICODE_LOCKDOWN"]
  else process.env["JOLLICODE_LOCKDOWN"] = originalLockdown
})

/** ⚠ `Flock` REFUSES UNTIL A STATE DIRECTORY IS SET, and importing `Global` is what sets it. */
void Global.Path.state

const PROVIDER = providerIdFor("anthropic")
const MODEL_KEY = `${PROVIDER}/opus`

/** One course with one assistant, so it is pre-selected and an empty submit means Start. */
const catalog = {
  status: "ok",
  courses: [
    {
      id: "101",
      code: "C 101",
      title: "C 101",
      kind: "code",
      accent: 1,
      assistantIds: ["1"],
      status: "published",
      entryState: "open",
      endsOn: null,
    },
  ],
  assistants: [
    {
      id: "1",
      courseId: "101",
      name: "Opener",
      kind: "code",
      blurb: "",
      accent: 1,
      isDefault: true,
      instructions: "",
      allowedModelIds: [MODEL_KEY],
      modelId: MODEL_KEY,
      guardrails: {
        neverGiveDirectAnswers: false,
        restrictToMaterials: false,
        showCitations: false,
        weeklyTokenCap: 0,
      },
      coaching: { coachTheQuestion: false, coachTheProcess: false, coachTheModelChoice: false, instructions: "" },
      skills: [],
      status: "live",
      brief: "",
      startsAt: null,
      endsAt: null,
      directChatEnabled: true,
      opensConversation: true,
    },
  ],
  modelTiers: {},
  account: "student-a",
}

const model = {
  id: "opus",
  providerID: PROVIDER,
  api: { id: "opus", url: "", npm: "" },
  name: "Opus",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 8_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
  variants: {},
}

/** How the fake sidecar answers one Start; `opened` is started with an opener. */
type Answer = "rejected" | "failed" | "dropped" | "refused" | "unreachable" | "started" | "opened"

function answer(kind: Answer) {
  if (kind === "started" || kind === "opened")
    return json({
      status: "started",
      opener: kind === "opened",
      session: { id: "ses_started", directory, title: "", time: { created: 1, updated: 1 } },
    })
  if (kind === "rejected") return json({ name: "BadRequest", data: {} }, { status: 400 })
  if (kind === "failed") return new Response("boom", { status: 500 })
  if (kind === "dropped") throw new TypeError("fetch failed")
  if (kind === "refused") return json({ status: "refused", code: "assistant_closed" })
  return json({ status: "unreachable" })
}

/** A second course, for a draft moved from one course to another. */
const secondCourse = {
  course: { ...catalog.courses[0], id: "102", code: "C 102", title: "C 102", assistantIds: ["2"] },
  assistant: { ...catalog.assistants[0], id: "2", courseId: "102", name: "Second" },
}

async function mount(
  options: { opensConversation?: boolean; secondCourse?: boolean; createFails?: boolean; promptFails?: boolean } = {},
) {
  const opensConversation = options.opensConversation ?? true
  const courses = options.secondCourse ? [...catalog.courses, secondCourse.course] : catalog.courses
  const assistants = options.secondCourse ? [...catalog.assistants, secondCourse.assistant] : catalog.assistants
  const state = (await tmpdir()).path
  await Bun.write(`${state}/kv.json`, "{}")
  const queue: Answer[] = []
  const sent: string[] = []
  /** Every Start's body, for what it was opened for. */
  const starts: Array<Record<string, unknown>> = []
  /** The sessions a message was sent to, and what each message said. */
  const prompted: string[] = []
  const said: string[] = []
  /** The sessions a shell command was run in, and how often the catalogue was read. */
  const shelled: string[] = []
  const catalogs = { read: 0 }
  /** Plain `session.create` calls — what a Start must never fall back to. */
  const created: unknown[] = []
  /** When set, the sidecar holds every Start and plain `session.create` until it resolves. */
  let held: PromiseWithResolvers<void> | undefined
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/jolli/course") {
      catalogs.read++
      return json({ ...catalog, courses, assistants: assistants.map((item) => ({ ...item, opensConversation })) })
    }
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [PROVIDER] })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: PROVIDER, name: "Jolli", source: "api", env: [], options: {}, models: { opus: model } }],
        default: {},
      })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/project/proj_test/directories") return json([{ directory }])
    return undefined
  }, events)
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun's `fetch` type also carries `preconnect`, which nothing here calls.
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const pathname = new URL(request.url).pathname
    if (pathname === "/session" && request.method === "POST") {
      created.push(await request.clone().json())
      await held?.promise
      if (options.createFails) return new Response("boom", { status: 500 })
      return json({ id: "ses_plain", directory, title: "", time: { created: 1, updated: 1 } })
    }
    const message = /^\/session\/([^/]+)\/message$/.exec(pathname)
    const shell = /^\/session\/([^/]+)\/shell$/.exec(pathname)
    if (shell && request.method === "POST") {
      shelled.push(shell[1])
      return json({})
    }
    if (message && request.method === "POST") {
      if (options.promptFails) return new Response("boom", { status: 500 })
      prompted.push(message[1]!)
      const body = await request.clone().json()
      said.push(
        body.parts
          .flatMap((part: { type: string; text?: string }) => (part.type === "text" ? [part.text] : []))
          .join(""),
      )
      return json({})
    }
    if (pathname !== "/session/jolli/start") return calls.fetch(request)
    const body = await request.clone().json()
    starts.push(body)
    sent.push(body.sessionID)
    await held?.promise
    return answer(queue.shift() ?? "unreachable")
  }) as typeof globalThis.fetch
  const config = createTuiResolvedConfig()

  let jolli!: ReturnType<typeof useJolli>
  let local!: ReturnType<typeof useLocal>
  let route!: ReturnType<typeof useRoute>
  const [shown, setShown] = createSignal(true)
  const [sessionID, setSessionID] = createSignal<string>()
  let prompt: PromptRef | undefined
  /** How often the composer told its page a prompt was submitted. */
  const submits = { count: 0 }
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const capturedJolli = useJolli()
    const capturedLocal = useLocal()
    const capturedRoute = useRoute()
    onMount(() => {
      jolli = capturedJolli
      local = capturedLocal
      route = capturedRoute
      mounted()
    })
    return (
      <Show when={shown()}>
        <Prompt ref={(ref) => (prompt = ref)} sessionID={sessionID()} onSubmit={() => submits.count++} />
      </Show>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state }}>
        <ClipboardProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <TuiConfigProvider config={config}>
                    <RouteProvider initialRoute={{ type: "home" }}>
                      <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <JolliProvider>
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider>
                                                    <LocationProvider>
                                                      <Probe />
                                                    </LocationProvider>
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                    </JolliProvider>
                                  </ThemeProvider>
                                </DataProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </RouteProvider>
                  </TuiConfigProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  await ready
  // Two courses are a choice, so nothing is pre-selected: the first is picked as a student would pick it.
  if (options.secondCourse) {
    await app.waitFor(() => jolli.courses().length === 2)
    jolli.draft.setCourse("101")
  }
  // The pre-selected course, an agent and a model: everything a Start needs before it is sent.
  await app.waitFor(
    () =>
      jolli.assistant()?.opensConversation === opensConversation && !!local.agent.current() && !!local.model.current(),
  )

  return {
    sent,
    starts,
    prompted,
    said,
    shelled,
    catalogs,
    created,
    submits,
    app,
    /** What the prompt history holds on disk, oldest first. */
    async history() {
      const file = Bun.file(`${state}/prompt-history.jsonl`)
      if (!(await file.exists())) return []
      return (await file.text())
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
    },
    get jolli() {
      return jolli
    },
    get route() {
      return route
    },
    get prompt() {
      return prompt!
    },
    /** Answer the next Start with `kind`, without submitting. */
    queue(kind: Answer) {
      queue.push(kind)
    },
    /** Hold every Start and plain `session.create` at the sidecar until the returned handle is resolved. */
    hold() {
      held = Promise.withResolvers<void>()
      return held
    },
    /** Unmount the composer and mount a fresh one: home's, or the session's when one is named. */
    remount(session?: string) {
      setShown(false)
      setSessionID(session)
      setShown(true)
    },
    /** Submit once, answering the Start it sends with `kind`, and wait for the answer to land. */
    async start(kind: Answer) {
      queue.push(kind)
      const before = sent.length
      prompt?.submit()
      await app.waitFor(() => sent.length > before && !jolli.starting())
    },
    close() {
      app.renderer.destroy()
    },
  }
}

test("a Start is retried under the same id only when it got no answer", async () => {
  const view = await mount()
  try {
    // Rejected by the sidecar: an answer, so the next Start opens under a new id.
    await view.start("rejected")
    await view.start("failed")
    expect(view.sent[1]).not.toBe(view.sent[0])

    // A 5xx, a dropped connection and `unreachable` all leave the gateway's side unknown.
    await view.start("dropped")
    await view.start("unreachable")
    await view.start("refused")
    expect(view.sent[2]).toBe(view.sent[1])
    expect(view.sent[3]).toBe(view.sent[1])
    expect(view.sent[4]).toBe(view.sent[1])

    // Refused: the gateway made nothing, so the id is not kept.
    await view.start("unreachable")
    expect(view.sent[5]).not.toBe(view.sent[4])
    expect(view.sent.every((id) => id.startsWith("ses_"))).toBe(true)
  } finally {
    view.close()
  }
})

/** ⚠ THE COMPOSER IS UNMOUNTED WHENEVER THE STUDENT LEAVES HOME; THE RETRY MUST NOT GO WITH IT. */
test("a Start that got no answer is retried under the same id from a remounted composer", async () => {
  const view = await mount()
  try {
    await view.start("unreachable")
    view.remount()
    await view.start("unreachable")
    expect(view.sent[1]).toBe(view.sent[0])
  } finally {
    view.close()
  }
})

/**
 * ⚠ WHAT WAS DECIDED BEFORE THE DIRECTORY WAS RESOLVED IS CHECKED AGAIN AFTER IT. Text typed during
 * that wait used to fall through to a plain `session.create` — a chat the agent never opened, the
 * bypass Start exists to close.
 */
test("text typed while the directory is resolved stops the Start instead of making a plain session", async () => {
  const view = await mount()
  try {
    view.prompt.submit()
    view.prompt.set({ input: "hi", parts: [] })
    await Bun.sleep(100)
    expect(view.sent).toEqual([])
    expect(view.created).toEqual([])
  } finally {
    // The composer stashes what is left in it on unmount, and the next test's composer would restore it.
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ A START ANSWERED AFTER THE STUDENT WENT ELSEWHERE DOES NOT PULL THEM BACK. */
test("a Start answered after the student left home leaves them where they are", async () => {
  const view = await mount()
  try {
    const held = view.hold()
    view.queue("started")
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(20)
    expect(view.route.data).toEqual({ type: "session", sessionID: "ses_other" })
  } finally {
    view.close()
  }
})

/**
 * ⚠ A TASK'S DRAFT TAKES A TYPED FIRST LINE WHEN ITS AGENT WAITS FOR THE STUDENT, and is still opened
 * through the task: a plain `session.create` would make a chat the task could never be handed in from.
 */
test("a typed first line on a task's draft opens the task's session on the gateway, then sends it", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.queue("started")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.prompted.length > 0)
    expect(view.starts).toEqual([expect.objectContaining({ courseId: "101", assignmentId: "40", partId: "41" })])
    expect(view.created).toEqual([])
    expect(view.prompted).toEqual(["ses_started"])
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ WHETHER AN AGENT THE CATALOGUE CANNOT NAME SPEAKS FIRST IS UNKNOWN, AND START CANNOT RACE AN OPENER. */
test("a task's agent the catalogue does not hold gets Start, not a typed first line", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "999", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.queue("started")
    view.prompt.submit()
    await view.app.waitFor(() => view.starts.length > 0 && !view.jolli.starting())
    expect(view.starts).toEqual([expect.objectContaining({ assistantId: "999", assignmentId: "40", partId: "41" })])
    expect(view.created).toEqual([])
  } finally {
    view.close()
  }
})

test("a refused task start sends nothing and keeps the typed line", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.queue("refused")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.sent.length > 0 && !view.jolli.starting())
    await Bun.sleep(20)
    expect(view.created).toEqual([])
    expect(view.prompted).toEqual([])
    expect(view.prompt.current.input).toBe("what does this task ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ NOR DOES A TASK'S TYPED FIRST LINE, WHICH IS STILL SENT TO THE TASK'S SESSION. Home's composer goes with
 * the student; the line must not be restored into the input they reach, where Enter would send it elsewhere.
 * A paste in it is still sent whole, though the composer's extmarks went with it.
 */
test("a typed first line answered after the student left home is sent to the task's session, not restored elsewhere", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("started")
    const pasted = "[Pasted ~2 lines]"
    view.prompt.set({
      input: `${pasted} what does this ask?`,
      parts: [
        { type: "text", text: "line one\nline two", source: { text: { start: 0, end: pasted.length, value: pasted } } },
      ],
    })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount()
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => view.prompted.length > 0)
    await Bun.sleep(80)
    expect(view.prompted).toEqual(["ses_started"])
    expect(view.said).toEqual(["line one\nline two what does this ask?"])
    expect(view.route.data).toEqual({ type: "session", sessionID: "ses_other" })
    expect(view.prompt.current.input).toBe("")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ AN OPENER THE CATALOGUE DID NOT FORESEE HOLDS THE TYPED LINE BACK. The student is taken to the session
 * to read it, and the line goes with them to the session's input rather than talking over it.
 */
test("a typed first line whose task's agent turns out to open the session is held back for its input", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.queue("opened")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.route.data.type === "session")
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])
    expect(view.route.data).toEqual({ type: "session", sessionID: "ses_started" })
    // Not home's to restore: only the session's composer takes the line.
    view.remount()
    expect(view.prompt.current.input).toBe("")
    view.remount("ses_started")
    await view.app.waitFor(() => view.prompt.current.input === "what does this task ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A LINE HELD BACK FOR AN OPENER WAITS FOR THE TASK'S SESSION WHEREVER THE STUDENT WENT. The composer it
 * was typed in is gone, and the one they came back to must not have it either.
 */
test("a typed first line held back for an opener after the student came back home waits for the task's session", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("opened")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.remount()
    held.resolve()
    await view.app.waitFor(() => view.route.data.type === "session")
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])
    expect(view.prompt.current.input).toBe("")
    view.remount("ses_started")
    await view.app.waitFor(() => view.prompt.current.input === "what does this task ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

test("a typed first line held back for an opener while the student is away is not restored where they are", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("opened")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])
    expect(view.route.data).toEqual({ type: "session", sessionID: "ses_other" })
    view.remount("ses_other")
    expect(view.prompt.current.input).toBe("")
    view.remount("ses_started")
    await view.app.waitFor(() => view.prompt.current.input === "what does this task ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A LINE THAT WAS NOT SENT AT ALL GOES BACK TO HOME'S DRAFT OF ITS TASK, AND NOWHERE ELSE. The session the
 * student went to must not get it, and neither may home while its draft is another task's.
 */
test("a refused typed first line answered after the student left home goes back to its task's draft only", async () => {
  const view = await mount({ opensConversation: false })
  const task = { courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" }
  try {
    view.jolli.draft.setTask(task)
    const held = view.hold()
    view.queue("refused")
    view.prompt.set({ input: "这道题问什么", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])
    expect(view.created).toEqual([])
    view.remount("ses_other")
    expect(view.prompt.current.input).toBe("")

    view.jolli.draft.setTask({ ...task, partId: "42", label: "Lab 5" })
    view.remount()
    expect(view.prompt.current.input).toBe("")

    // Home's draft becomes the task again without the composer remounting.
    view.jolli.draft.setTask(task)
    await view.app.waitFor(() => view.prompt.current.input === "这道题问什么")
    // The cursor is at the end of the line as the composer measures it, so typing appends.
    view.prompt.focus()
    await view.app.mockInput.typeText("?")
    await view.app.waitFor(() => view.prompt.current.input === "这道题问什么?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ THE COMPOSER THE LINE WAS TYPED IN MAY BE DESTROYED BEFORE THE GATEWAY ANSWERS. Sending from it must not
 * touch its buffer, and the line it sent must not come back to the task's draft to be sent again.
 */
test("a typed first line answered after its composer was destroyed is sent once and not held", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("started")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    // Long enough for the renderer to destroy the unmounted composer.
    await Bun.sleep(50)
    held.resolve()
    await view.app.waitFor(() => view.prompted.length > 0)
    await Bun.sleep(80)
    expect(view.prompted).toEqual(["ses_started"])
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.remount()
    await Bun.sleep(20)
    expect(view.prompt.current.input).toBe("")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

test("a refused typed first line comes back to home's draft the student already returned to", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("refused")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.remount()
    expect(view.prompt.current.input).toBe("")
    held.resolve()
    await view.app.waitFor(() => view.prompt.current.input === "what does this ask?")
    expect(view.prompted).toEqual([])
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ NOT ONLY A TASK'S LINE IS THE SUBMIT'S ONCE TAKEN. A plain session's `session.create` can take as long,
 * and a line stashed for the next composer while it is also sent would go out twice on the next Enter.
 */
test("a plain first line answered after its composer unmounted is sent once and not restored", async () => {
  const view = await mount({ opensConversation: false })
  try {
    const held = view.hold()
    view.prompt.set({ input: "hello there", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.created.length > 0)
    view.remount()
    expect(view.prompt.current.input).toBe("")
    held.resolve()
    await view.app.waitFor(() => view.prompted.length > 0)
    await Bun.sleep(80)
    expect(view.prompted).toEqual(["ses_plain"])
    expect(view.said).toEqual(["hello there"])
    expect(view.prompt.current.input).toBe("")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ A SHELL COMMAND IS RUN THROUGH AN OPENER, as the desktop runs it: it asks the model nothing. */
test("a typed first shell command on a task's draft runs though the gateway wrote an opener", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.prompt.focus()
    await view.app.mockInput.typeText("!")
    view.prompt.set({ input: "ls", parts: [] })
    view.queue("opened")
    const before = view.catalogs.read
    view.prompt.submit()
    // Polled by time: the command goes out after the gateway answers, with nothing redrawn meanwhile.
    const deadline = Date.now() + 2000
    while (view.shelled.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(view.shelled).toEqual(["ses_started"])
    expect(view.prompted).toEqual([])
    // The catalogue was wrong about the agent all the same.
    expect(view.catalogs.read).toBeGreaterThan(before)
    while (view.route.data.type !== "session" && Date.now() < deadline) await Bun.sleep(10)
    expect(view.route.data).toEqual({ type: "session", sessionID: "ses_started" })
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A START'S `clearTask` DOES NOT RESTORE HOME'S HELD LINE INTO THE COMPOSER IT IS LEAVING. The draft turns
 * plain before the Start ends; filled then, the composer would go with the student and take the line along.
 */
test("a plain line held for home survives a task's Start and comes back to home's plain draft", async () => {
  const view = await mount({ opensConversation: false, createFails: true })
  try {
    const held = view.hold()
    view.prompt.set({ input: "hello there", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.created.length > 0)
    view.remount("ses_other")
    held.resolve()
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])

    // An agent the catalogue cannot name gets Start, which an empty composer sends.
    view.jolli.draft.setTask({ courseId: "101", assistantId: "999", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.remount()
    expect(view.prompt.current.input).toBe("")
    await view.start("started")
    await Bun.sleep(20)
    expect(view.jolli.draft.task).toBeUndefined()
    expect(view.prompt.current.input).toBe("")

    view.remount()
    await view.app.waitFor(() => view.prompt.current.input === "hello there")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A HELD LINE IS NOT CROWDED OUT BY A STASH. Restored second, it would stay held and fill some later mount
 * of the session, long after. Nor does the stash go on to whichever composer mounts next, skipping this one
 * unseen: it goes back to the session it was typed in.
 */
test("a line held for a session is restored before a stash, and the stash goes back to its own session", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("opened")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    view.prompt.set({ input: "typed elsewhere", parts: [] })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)

    view.remount("ses_started")
    await view.app.waitFor(() => view.prompt.current.input === "what does this task ask?")
    view.prompt.reset()
    view.remount("ses_third")
    await Bun.sleep(20)
    expect(view.prompt.current.input).toBe("")
    view.remount("ses_other")
    await view.app.waitFor(() => view.prompt.current.input === "typed elsewhere")
    view.prompt.reset()
    view.remount("ses_started")
    await Bun.sleep(20)
    expect(view.prompt.current.input).toBe("")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ HOME'S PLAIN LINE IS HELD FOR ITS COURSE: restored into another course's draft, Enter would send it there. */
test("a plain line held for home comes back to its course's draft only", async () => {
  const view = await mount({ opensConversation: false, secondCourse: true, createFails: true })
  try {
    const held = view.hold()
    view.prompt.set({ input: "hello there", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.created.length > 0)
    view.remount("ses_other")
    held.resolve()
    await Bun.sleep(80)

    view.jolli.draft.setCourse("102")
    view.remount()
    await Bun.sleep(20)
    expect(view.prompt.current.input).toBe("")

    // Home's draft goes back to the course without the composer remounting.
    view.jolli.draft.setCourse("101")
    await view.app.waitFor(() => view.prompt.current.input === "hello there")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ WHAT IS LEFT TYPED IN A COMPOSER STILL GOES TO THE NEXT ONE, as it did before lines were held. */
test("a line left typed in one composer is restored into the next, whatever its owner", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.prompt.set({ input: "half a thought", parts: [] })
    view.remount("ses_other")
    await view.app.waitFor(() => view.prompt.current.input === "half a thought")
    view.remount()
    await view.app.waitFor(() => view.prompt.current.input === "half a thought")
    view.prompt.reset()
    view.remount("ses_other")
    await Bun.sleep(20)
    expect(view.prompt.current.input).toBe("")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ A LINE HELD FOR A COMPOSER THAT HAS SOMETHING TYPED IN IT DOES NOT OVERWRITE IT, and waits for the next mount. */
test("a line held for a composer already holding typed text waits for its next mount", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("refused")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.remount()
    view.prompt.set({ input: "typed meanwhile", parts: [] })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompt.current.input).toBe("typed meanwhile")
    view.prompt.reset()
    view.remount()
    await view.app.waitFor(() => view.prompt.current.input === "what does this ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ THE PAGE HEARS OF A SUBMIT ONLY WHILE ITS COMPOSER IS THE ONE ON SCREEN. */
test("the page is told of a sent line, but not of one sent after the student left home", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.prompt.set({ input: "hello there", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.prompted.length === 1)
    expect(view.submits.count).toBe(1)

    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("started")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => view.prompted.length === 2)
    await Bun.sleep(80)
    expect(view.prompted).toEqual(["ses_plain", "ses_started"])
    expect(view.submits.count).toBe(1)
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/** ⚠ A HELD LINE OUTLIVES `held` IN THE HISTORY: it is dropped there after `HELD_FOR`, and with the TUI. */
test("a typed first line held back for an opener is also kept in the prompt history", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.queue("opened")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.route.data.type === "session")
    expect(view.prompted).toEqual([])
    const deadline = Date.now() + 2000
    while ((await view.history()).length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(await view.history()).toEqual([expect.objectContaining({ input: "what does this task ask?" })])
    // Taken by the session's composer, so the line held for it does not outlast this test.
    view.remount("ses_started")
    await view.app.waitFor(() => view.prompt.current.input === "what does this task ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A LINE SENT AFTER THE STUDENT LEFT HOME THAT FAILS IS NOT PUT BACK IN THE TASK'S SESSION. The request lasts
 * the whole turn and can fail after the message was recorded; put back, one Enter would send it twice. The
 * prompt history has it.
 */
test("a typed first line that fails to send after the student left home is kept in the history, not the session's input", async () => {
  const view = await mount({ opensConversation: false, promptFails: true })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("started")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])
    expect(view.prompt.current.input).toBe("")
    view.remount("ses_started")
    await Bun.sleep(20)
    expect(view.prompt.current.input).toBe("")
    expect(await view.history()).toEqual([expect.objectContaining({ input: "what does this ask?" })])
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A COMPOSER THAT ONLY REMOUNTS GETS BACK WHAT WAS BEING TYPED IN IT, a line held for it notwithstanding. The
 * held line waits for a later mount, as it does when it arrives while something is typed.
 */
test("a composer remounted with typed text keeps it over a line held for it, which comes back later", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("refused")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.remount()
    view.prompt.set({ input: "typed meanwhile", parts: [] })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompt.current.input).toBe("typed meanwhile")

    view.remount()
    await view.app.waitFor(() => view.prompt.current.input === "typed meanwhile")
    view.prompt.reset()
    view.remount()
    await view.app.waitFor(() => view.prompt.current.input === "what does this ask?")
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A STASH CARRIED INTO ANOTHER OWNER'S COMPOSER COMES BACK AS TEXT. A shell command typed on home and carried
 * into a session would otherwise run in that session on one Enter.
 */
test("a shell line stashed on home comes back into another session's composer as text", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.prompt.focus()
    await view.app.mockInput.typeText("!")
    view.prompt.set({ input: "ls", parts: [] })
    view.remount("ses_b")
    await view.app.waitFor(() => view.prompt.current.input === "ls")
    view.prompt.submit()
    const deadline = Date.now() + 2000
    while (view.prompted.length + view.shelled.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(view.prompted).toEqual(["ses_b"])
    expect(view.shelled).toEqual([])
  } finally {
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A LINE ONLY TYPED, NEVER SUBMITTED, DOES NOT EXPIRE WHEN IT IS HELD. Put aside so a held line can take its
 * composer, it is a draft the student knows was not sent, and it is nowhere else to find.
 */
test("a draft put aside for a held line is still there after the held lines expire", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    view.queue("opened")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.route.data.type === "session")
    // Typed in another session, then the task's session is opened: its held line takes the composer.
    view.remount("ses_a")
    view.prompt.set({ input: "half a thought", parts: [] })
    view.remount("ses_started")
    await view.app.waitFor(() => view.prompt.current.input === "what does this task ask?")
    view.prompt.reset()
    setSystemTime(new Date(Date.now() + 31 * 60 * 1000))
    view.remount("ses_a")
    await view.app.waitFor(() => view.prompt.current.input === "half a thought")
  } finally {
    setSystemTime()
    view.prompt.reset()
    view.close()
  }
})

/**
 * ⚠ A HELD LINE LEFT WAITING IS NOT RESTORED BY A NEW DRAFT OBJECT FOR THE SAME OWNER. A catalogue refresh
 * replaces the draft without changing whose composer this is; filling it then would put a line into a
 * composer the student just cleared, at a moment of nobody's choosing.
 */
test("a held line left waiting is not restored when the draft is replaced for the same owner", async () => {
  const view = await mount({ opensConversation: false })
  const task = { courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" }
  try {
    view.jolli.draft.setTask(task)
    const held = view.hold()
    view.queue("refused")
    view.prompt.set({ input: "what does this ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.remount("ses_other")
    view.remount()
    // Typing in home's composer again, so the refused line is held rather than restored.
    view.prompt.set({ input: "something else", parts: [] })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompt.current.input).toBe("something else")
    view.prompt.reset()
    view.jolli.draft.setTask({ ...task })
    await Bun.sleep(80)
    expect(view.prompt.current.input).toBe("")
  } finally {
    view.prompt.reset()
    view.close()
  }
})
