import { CourseSkillName } from "@opencode-ai/schema/course-skill-name"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs, type DraftTab } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { useCourseSession, type CourseBinding } from "@/jolli/session-binding"
import { sameBinding } from "@opencode-ai/core/jolli/binding"
import { refreshCatalog } from "@/jolli/catalog"
import { startErrorKey } from "@/jolli/start-session"
import { defaultSessionTitle } from "@/jolli/session-title"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { openedOnGateway, settleStart } from "@opencode-ai/core/jolli/opener"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && !CourseSkillName.isCourse(cmd) && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      const messageID = Identifier.ascending("message")
      await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant: input.draft.variant,
        },
        files: await Promise.all(
          images.map(async (attachment) => ({
            uri: await blobDataUrl(attachment.blob, attachment.mime),
            name: attachment.filename,
          })),
        ),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.api.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      agent: input.draft.agent,
      model: input.draft.model,
      variant: input.draft.variant,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

/**
 * WHAT A NEW SESSION NEEDS FROM WHOEVER IS MAKING IT, WITH THE MAKING ITSELF LEFT TO THEM.
 *
 * ⚠ `create` IS THE ONLY STEP THAT DIFFERS. A typed first message makes the session with
 * `session.create`; Start makes it with `session.jolliStart`, which asks the gateway for the agent's
 * opener first and may refuse. Everything around that — which directory, seeding the caches, the
 * promotes, moving the screen — is the same, and lives once in {@link createNewSession}.
 */
export type NewSessionRequest<Failure> = {
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  autoAccept: boolean
  /** The binding the session was made under, for a caller whose draft may change while it waits. */
  binding?: CourseBinding
  /**
   * Makes the session in `target.directory`, or says why it did not. Nothing is promoted without a
   * session, and the reason comes back on the `not-created` result.
   */
  create: (target: {
    directory: string
    client: DirectorySDK["client"]
  }) => Promise<{ session: Session } | { failure: Failure }>
  /** As soon as the session exists, before the screen moves onto it. */
  created?: (session: Session) => void
  /** Inside the transition that moves the screen onto the session, after everything else. */
  promoted?: (session: Session, directory: string) => void
}

export type NewSessionResult<Failure> =
  | { status: "no-directory" }
  | { status: "not-created"; directory: string; failure: Failure }
  | { status: "created"; session: Session; directory: string }

/** Which directory a new session goes in, and the draft's worktree choice it is read from. */
export type NewSessionWorktreeInput = {
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  /**
   * A worktree was made for this draft. The choice becomes that worktree, so a session that then
   * fails to be made — a refused Start — leaves the next try, by either path, using it rather than
   * making another.
   */
  onNewSessionWorktreeCreated?: (directory: string) => void
}

/**
 * MAKE A NEW SESSION AND MOVE THE SCREEN ONTO IT — OR, WHEN `create` MAKES NOTHING, CHANGE NOTHING.
 *
 * ⚠ EVERY PROMOTE WAITS FOR THE SESSION. The draft's model, its course binding, its tab and its
 * route are handed over only once `create` has answered with one; a refused Start leaves the student
 * on the same draft with the same choices, because nothing below `create` has run.
 */
export function createNewSession(input: NewSessionWorktreeInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const local = useLocal()
  const courseSession = useCourseSession()
  const permission = usePermission()
  const layout = useLayout()
  const language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()
  const location = useLocation()
  const tabs = useTabs()

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    /**
     * ⚠ THE SIDEBAR READS A DIFFERENT CACHE FROM THE THREE LINES BELOW, AND SEEDING ONLY THOSE IS
     * WHY A NEW SESSION WAS INVISIBLE UNTIL A RELOAD. The session registry and the per-directory
     * store feed the session route; the sidebar's list and its search read the Home session index
     * (`global-sync/home-session-index.ts`), which until now was only ever written by its own fetch
     * and by `session.created` arriving over the event stream. Writing all three here is the same
     * shape `archive` already has — it removes from the store AND from the index.
     */
    serverSync().homeSessions.add(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  return async <Failure>(request: NewSessionRequest<Failure>): Promise<NewSessionResult<Failure>> => {
    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const worktreeSelection = input.newSessionWorktree?.() || "main"
    /**
     * ⚠ THE SCREEN THE REQUEST CAME FROM IS READ NOW, BEFORE ANYTHING IS AWAITED. A Start can wait
     * up to 45 seconds on the gateway; read afterwards, the route answers with wherever the student
     * went meanwhile — and another draft promoted into this session loses what was typed in it.
     */
    const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    const from = location.pathname

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (worktreeSelection === "create") {
      const createdWorktree = await client.worktree
        .create({ directory: projectDirectory })
        .then((x) => x.data)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: errorText(err, language.t("common.requestFailed")),
          })
          return undefined
        })

      if (!createdWorktree?.directory) {
        showToast({
          title: language.t("prompt.toast.worktreeCreateFailed.title"),
          description: language.t("common.requestFailed"),
        })
        return { status: "no-directory" }
      }
      WorktreeState.pending(sdk().scope, createdWorktree.directory)
      sessionDirectory = createdWorktree.directory
      input.onNewSessionWorktreeCreated?.(createdWorktree.directory)
    }

    if (worktreeSelection !== "main" && worktreeSelection !== "create") {
      sessionDirectory = worktreeSelection
    }

    if (sessionDirectory !== projectDirectory) {
      client = sdk().createClient({
        directory: sessionDirectory,
        throwOnError: true,
      })
      serverSync().child(sessionDirectory)
    }

    const made = await request.create({ directory: sessionDirectory, client })
    if (!("session" in made)) return { status: "not-created", directory: sessionDirectory, failure: made.failure }
    const session = made.session

    // ⚠ ONLY ONCE THERE IS A SESSION: a refused Start leaves the draft's worktree choice standing.
    input.onNewSessionWorktreeReset?.()

    seed(sessionDirectory, session)
    request.created?.(session)
    await startTransition(() => {
      if (request.autoAccept) permissionState.enableAutoAccept(session.id, sessionDirectory)
      local.session.promote(sessionDirectory, session.id, {
        agent: request.agent,
        model: request.model,
        variant: request.variant ?? null,
      })
      // The course and assistant chosen on the new-session screen become facts about this
      // session here, and are never offered for change again.
      courseSession.promote(sessionDirectory, session.id, request.binding)
      layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
      /**
       * ⚠ `promoteDraft` NAVIGATES ONLY WHEN ITS DRAFT IS STILL THE ONE ON SCREEN, so a student who
       * moved on is not pulled back. A draft closed meanwhile still gets its session as a tab: the
       * conversation exists, and a Start may already hold an opener nobody has read.
       */
      if (draft) {
        if (tabs.store.some((tab) => tab.type === "draft" && tab.draftID === draft.draftID))
          tabs.promoteDraft(draft.draftID, { server: draft.server, sessionId: session.id })
        else tabs.addSessionTab({ server: draft.server, sessionId: session.id })
      }
      if (!draft && location.pathname === from) navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      request.promoted?.(session, sessionDirectory)
    })
    return { status: "created", session, directory: sessionDirectory }
  }
}

/**
 * ⚠ A START THAT GOT NO ANSWER IS RETRIED UNDER THE SAME ID. The gateway may have made the
 * conversation all the same, and asked again under that id it answers with it; a fresh id would
 * leave that one orphaned. A refusal or a rejected request made nothing, and a different binding is
 * a different conversation, so each starts over with a new one — see `settleStart`.
 *
 * ⚠ KEPT PER SERVER AT MODULE SCOPE, NOT IN THE COMPOSER. A composer is remounted whenever its tab
 * is left and reopened, and a retry from the remounted one under a fresh id was exactly the orphan
 * this exists to prevent.
 */
const unanswered = new Map<string, CourseBinding & { sessionID: string }>()

/**
 * START A CHAT WHOSE AGENT SPEAKS FIRST: WHAT THE COMPOSER'S START BUTTON DOES.
 *
 * ⚠ THE SIDECAR'S START ROUTE OPENS THE CONVERSATION ON THE GATEWAY BEFORE IT CREATES ANYTHING
 * LOCALLY. So a refusal or an unreachable gateway leaves nothing behind — no session, no promote, no
 * route change — and the draft is left to say why through `courseSession.draft.startError`. A
 * failure is never taken for "no opener": the gateway may have stored one the student never saw.
 *
 * ⚠ `starting` IS A STORE FLAG ON THE BINDING, NOT A LATCH IN HERE, because the screen has to react
 * to it: the Start row turns into "The agent is writing…" and the course row stops being a picker
 * until the answer is in. It also refuses a second press while the first is outstanding.
 *
 * ⚠ A REFUSAL REFRESHES THE CATALOGUE. The gateway refuses what it knows has closed or gone, while
 * the catalogue on screen can be minutes old; asking again is what lets the picker re-pick.
 */
export function createSessionStart(
  input: NewSessionWorktreeInput & {
    autoAccept: Accessor<boolean>
    model?: ModelSelection
  },
) {
  const local = useLocal()
  const courseSession = useCourseSession()
  const language = useLanguage()
  const sdk = useSDK()
  const newSession = createNewSession(input)

  return async () => {
    const binding = courseSession.current()
    if (!binding || courseSession.draft.starting) return
    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    courseSession.draft.setStartError(undefined)
    courseSession.draft.setStarting(true)
    const scope = sdk().scope
    const retry = unanswered.get(scope)
    const sessionID = sameBinding(retry, binding) ? retry.sessionID : Identifier.descending("session")
    const result = await newSession({
      agent: currentAgent.name,
      model: { providerID: currentModel.provider.id, modelID: currentModel.id },
      variant,
      autoAccept: input.autoAccept(),
      binding,
      create: async (target) => {
        const answer = await settleStart(
          target.client.session.jolliStart({
            directory: target.directory,
            courseId: binding.courseId,
            assistantId: binding.assistantId,
            sessionID,
            agent: currentAgent.name,
            model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          }),
        )
        if (answer.unanswered) unanswered.set(scope, { ...binding, sessionID })
        else unanswered.delete(scope)
        if (answer.result?.status === "started") return { session: normalizeSessionInfo(answer.result.session) }
        if (answer.result?.status === "refused") refreshCatalog()
        return { failure: startErrorKey(answer.result?.status === "refused" ? answer.result.code : undefined) }
      },
    })
      /**
       * ⚠ A THROW AFTER THE SIDECAR ANSWERED IS STILL A FAILED START ON SCREEN. `settleStart` catches
       * the request itself; this catches the promote around it, which otherwise only reset
       * `starting` and left the student looking at a Start row that had silently done nothing.
       */
      .catch(() => ({ status: "not-created" as const, directory: sdk().directory, failure: startErrorKey(undefined) }))
      .finally(() => courseSession.draft.setStarting(false))
    if (result.status === "not-created") courseSession.draft.setStartError(result.failure)
    return result
  }
}

/** The message on whatever was thrown, or `fallback` when it carries none. */
function errorText(err: unknown, fallback: string) {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string; title?: string; metadata?: Record<string, unknown> } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  /** Hands the just-sent prompt to the session this submit created, so ↑ still finds it there. */
  promoteHistory?: (sessionID: string) => void
  /** No session to hand it to: drop the entry instead of leaving it for the next new chat to replay. */
  discardHistory?: () => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  onNewSessionWorktreeCreated?: (directory: string) => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const courseSession = useCourseSession()
  const prompt = input.prompt
  const language = useLanguage()
  const params = useParams()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => errorText(err, language.t("common.requestFailed"))
  const newSession = createNewSession(input)

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .api.session.interrupt({ sessionID })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  /**
   * ⚠ ONE SESSION PER CHAT, HOWEVER FAST ENTER IS PRESSED. `handleSubmit` is async and the composer
   * only guards held keys (`event.repeat`), so a second press lands while the first is still
   * awaiting `session.create`. Both read `params.id` as empty, both decide they are starting a new
   * chat, and the conversation forks into two sessions — the second carrying a duplicate of the
   * same text, since the input is not cleared until the send returns.
   *
   * Only the sessionless path is gated. Submitting repeatedly inside a live chat is ordinary use
   * (it is how followups queue), and must stay untouched.
   */
  let starting: Promise<void> | undefined
  /**
   * ⚠ THE ONE WAIT INSIDE A LIVE CHAT: A STARTED SESSION'S FIRST MESSAGE NAMING IT. The title is
   * awaited before the send and the input is cleared only after it, so a second press inside that
   * wait would send the same text twice. Held per session for the length of the rename only.
   */
  const titling = new Set<string>()

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    if (starting) return starting
    if (params.id && titling.has(params.id)) return
    if (params.id) return submit()

    starting = submit()
      /**
       * ⚠ AN EXCEPTION ESCAPES BOTH HALVES OF THE HISTORY HANDOFF. Every path that ends in a session
       * promotes the pending bucket into it, and every path that fails to create one discards it —
       * but a throw in between (worktree client, the transition, the draft promotion) reaches
       * neither, parking the entry on a draft that will never claim it. A failed submit has no
       * session to hand it to, so it is discarded on the way out and the error still propagates.
       */
      .catch((err) => {
        input.discardHistory?.()
        throw err
      })
      .finally(() => {
        starting = undefined
      })
    return starting
  }

  const submit = async () => {
    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const isNewSession = !params.id

    let sessionDirectory = projectDirectory
    let session = input.info()
    if (isNewSession) {
      /**
       * ⚠ THE TITLE IS DECIDED HERE BECAUSE THIS IS THE ONLY PLACE THAT HAS BOTH HALVES OF IT. The
       * sidebar's list reads the Home session index, which carries no messages — so "the first
       * thing the student typed" is free exactly once, on the frame that creates the session, and
       * unreachable everywhere it would later be rendered. See `jolli/session-title.ts` for what
       * this costs (the server stops generating a title of its own).
       */
      const title = defaultSessionTitle({ course: courseSession.course()?.code, text })
      const result = await newSession({
        agent: currentAgent.name,
        model: { providerID: currentModel.provider.id, modelID: currentModel.id },
        variant,
        autoAccept: input.autoAccept(),
        create: (target) =>
          sdk()
            .api.session.create({
              agent: currentAgent.name,
              model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
              location: { directory: target.directory },
              ...(title ? { title } : {}),
              /**
               * ⚠ THE BINDING IS WRITTEN AS THE SESSION IS CREATED, NOT PATCHED ON AFTERWARDS. Which
               * course a session belongs to decides which models may run in it and who may read it,
               * so a window where the session exists without one is a window where those questions
               * have no answer. Creating it atomically also means the server can refuse to change it
               * later without having to allow one write first.
               */
              ...(courseSession.current()
                ? { metadata: { jolli: courseSession.current() as unknown as Record<string, unknown> } }
                : {}),
            })
            .then((info) => ({ session: normalizeSessionInfo(info) }))
            .catch((err) => {
              showToast({
                title: language.t("prompt.toast.sessionCreateFailed.title"),
                description: errorMessage(err),
              })
              return { failure: undefined }
            }),
        created: (created) => input.promoteHistory?.(created.id),
        promoted: (created, directory) =>
          submission.retarget(prompt.capture({ dir: base64Encode(directory), id: created.id })),
      })
      if (result.status === "no-directory") {
        input.discardHistory?.()
        return
      }
      sessionDirectory = result.directory
      if (result.status === "created") session = result.session
    }
    if (!session) {
      input.discardHistory?.()
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    /**
     * ⚠ A STARTED SESSION IS NAMED BY ITS FIRST MESSAGE, AS A TYPED ONE IS. Start makes the session
     * before the student has written anything, so it is born with the server's default title and its
     * first message is the first moment the course-and-message title can be written. Awaited, so the
     * server sees a real title before the turn begins and does not generate one of its own; once it is
     * written the title is no longer the default, which is what keeps this to the first message.
     */
    const startedTitle =
      !isNewSession && openedOnGateway(session) && SessionTitle.isDefault(session.title ?? "")
        ? defaultSessionTitle({ course: courseSession.course()?.code, text })
        : undefined
    if (startedTitle) {
      const sessionID = session.id
      titling.add(sessionID)
      await sdk()
        .client.session.update({ sessionID, title: startedTitle })
        .catch(() => undefined)
        .finally(() => titling.delete(sessionID))
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      const eventID = Event.ID.create()
      sdk()
        .api.session.shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand =
        !CourseSkillName.isCourse(commandName) && sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        serverSync().session.set("session_status", session.id, { type: "busy" })
        sdk()
          .api.session.command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: { id: model.modelID, providerID: model.providerID, variant },
            files: await Promise.all(
              images.map(async (attachment) => ({
                uri: await blobDataUrl(attachment.blob, attachment.mime),
                name: attachment.filename,
              })),
            ),
          })
          .catch((err) => {
            serverSync().session.set("session_status", session.id, { type: "idle" })
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
