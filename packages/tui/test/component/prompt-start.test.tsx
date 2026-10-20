/** @jsxImportSource @opentui/solid */
/**
 * THE TUI'S START: SUBMITTING AN EMPTY PROMPT UNDER AN ASSISTANT THAT OPENS THE CONVERSATION.
 *
 * ⚠ THE REAL PROMPT IS RENDERED, BECAUSE `start()` IS A CLOSURE INSIDE IT. What is under test is which
 * session id each Start sends: an unanswered one — no response, a 5xx, `unreachable` — is retried
 * under the same id, since the gateway may have made the conversation all the same; a rejected or
 * refused one made nothing and the next takes a fresh id. The sidecar is a fake `fetch`.
 */
import { afterAll, expect, test } from "bun:test"
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

/** How the fake sidecar answers one Start. */
type Answer = "rejected" | "failed" | "dropped" | "refused" | "unreachable" | "started"

function answer(kind: Answer) {
  if (kind === "started")
    return json({
      status: "started",
      opener: false,
      session: { id: "ses_started", directory, title: "", time: { created: 1, updated: 1 } },
    })
  if (kind === "rejected") return json({ name: "BadRequest", data: {} }, { status: 400 })
  if (kind === "failed") return new Response("boom", { status: 500 })
  if (kind === "dropped") throw new TypeError("fetch failed")
  if (kind === "refused") return json({ status: "refused", code: "assistant_closed" })
  return json({ status: "unreachable" })
}

async function mount(options: { opensConversation?: boolean } = {}) {
  const opensConversation = options.opensConversation ?? true
  const state = (await tmpdir()).path
  await Bun.write(`${state}/kv.json`, "{}")
  const queue: Answer[] = []
  const sent: string[] = []
  /** Every Start's body, for what it was opened for. */
  const starts: Array<Record<string, unknown>> = []
  /** The sessions a message was sent to. */
  const prompted: string[] = []
  /** Plain `session.create` calls — what a Start must never fall back to. */
  const created: unknown[] = []
  /** When set, the sidecar holds every Start until it resolves. */
  let held: PromiseWithResolvers<void> | undefined
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/jolli/course")
      return json({ ...catalog, assistants: catalog.assistants.map((item) => ({ ...item, opensConversation })) })
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
    if (pathname === "/session" && request.method === "POST") created.push(await request.clone().json())
    const message = /^\/session\/([^/]+)\/message$/.exec(pathname)
    if (message && request.method === "POST") {
      prompted.push(message[1]!)
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
  let prompt: PromptRef | undefined
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
        <Prompt ref={(ref) => (prompt = ref)} />
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
  // The pre-selected course, an agent and a model: everything a Start needs before it is sent.
  await app.waitFor(
    () =>
      jolli.assistant()?.opensConversation === opensConversation && !!local.agent.current() && !!local.model.current(),
  )

  return {
    sent,
    starts,
    prompted,
    created,
    app,
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
    /** Hold every Start at the sidecar until the returned handle is resolved. */
    hold() {
      held = Promise.withResolvers<void>()
      return held
    },
    /** Unmount the composer and mount a fresh one, as leaving home and coming back does. */
    remount() {
      setShown(false)
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

/** ⚠ NOR DOES A TASK'S TYPED FIRST LINE: ITS SESSION IS OPENED, BUT THE STUDENT IS NOT PULLED INTO IT. */
test("a typed first line answered after the student left home sends nothing and leaves them where they are", async () => {
  const view = await mount({ opensConversation: false })
  try {
    view.jolli.draft.setTask({ courseId: "101", assistantId: "1", assignmentId: "40", partId: "41", label: "Lab 4" })
    const held = view.hold()
    view.queue("started")
    view.prompt.set({ input: "what does this task ask?", parts: [] })
    view.prompt.submit()
    await view.app.waitFor(() => view.jolli.starting())
    view.route.navigate({ type: "session", sessionID: "ses_other" })
    held.resolve()
    await view.app.waitFor(() => !view.jolli.starting())
    await Bun.sleep(80)
    expect(view.prompted).toEqual([])
    expect(view.route.data).toEqual({ type: "session", sessionID: "ses_other" })
  } finally {
    view.prompt.reset()
    view.close()
  }
})
