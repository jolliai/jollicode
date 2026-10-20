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
import { startErrorKey, type StartErrorKey } from "@/jolli/start-session"
import { refreshAssignments } from "@/jolli/assignment-refresh"
import type { TaskDraft } from "@/jolli/assignment-intent"
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
  /** Where an earlier try already made the session, in place of the draft's worktree choice. */
  directory?: string
  /**
   * Makes the session in `target.directory`, or says why it did not. Nothing is promoted without a
   * session, and the reason comes back on the `not-created` result. A session the gateway opened says
   * whether it came with an opener.
   */
  create: (target: {
    directory: string
    client: DirectorySDK["client"]
  }) => Promise<{ session: Session; opener?: boolean } | { failure: Failure }>
  /** As soon as the session exists, before the screen moves onto it. */
  created?: (session: Session, opener: boolean) => void
  /** Inside the transition that moves the screen onto the session, after everything else. */
  promoted?: (session: Session, directory: string) => void
}

export type NewSessionResult<Failure> =
  | { status: "no-directory" }
  | { status: "not-created"; directory: string; failure: Failure }
  | { status: "created"; session: Session; directory: string; opener: boolean }

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
    const worktreeSelection = request.directory ?? (input.newSessionWorktree?.() || "main")
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
    request.created?.(session, !!made.opener)
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
    return { status: "created", session, directory: sessionDirectory, opener: !!made.opener }
  }
}

/**
 * ⚠ A START NOT SEEN THROUGH IS RETRIED UNDER THE SAME ID. One that got no answer may have made the
 * conversation on the gateway all the same, and one that was answered may have made the session and
 * then failed to move the screen onto it; asked again under that id, the sidecar answers with what
 * it already made, where a fresh id would make a second conversation beside it. A refusal or a
 * rejected request made nothing, and a different binding is a different conversation, so each starts
 * over with a new one — see `settleStart`. Only a Start that ended on its session lets the id go.
 *
 * ⚠ AN ANSWERED ONE IS RETRIED ONLY FROM THE DRAFT THAT PRESSED IT. Its session is already in the
 * sidebar, where the student may open it and carry on; another draft — a second tab, or a new chat
 * later — handed that id would land in the old conversation instead of a new one. An unanswered one
 * made nothing the student can see, so any draft with the same binding may adopt it. Once answered,
 * an id stays answered: a retry that then got no answer has not unmade the session.
 *
 * ⚠ AND AN ANSWERED ONE IN THE DIRECTORY IT WAS MADE IN. The sidecar answers a known id with the
 * session it already made, wherever that lives, and a draft's worktree choice is reset once a session
 * exists — so a retry that followed the choice would file a worktree's session under the main
 * checkout. An unanswered one follows the draft that adopts it, which may be in another project.
 *
 * ⚠ ONE PER ID, NOT ONE PER SERVER. A draft whose answered Start awaits its retry keeps its id when
 * another draft presses Start meanwhile; a single slot handed that id's place to the other draft.
 *
 * ⚠ KEPT PER SERVER AT MODULE SCOPE, NOT IN THE COMPOSER. A composer is remounted whenever its tab
 * is left and reopened, and a retry from the remounted one under a fresh id was exactly the orphan
 * this exists to prevent.
 *
 * ⚠ AND FOR {@link RETRY_TTL_MS} AFTER THE LAST TRY. Nothing else retires an id whose draft was closed,
 * and an unanswered one left for hours would be adopted by a new chat long after anyone pressed
 * Start for it. Past that a press starts over: at worst one more conversation on the gateway.
 *
 * ⚠ TWO MISSING DRAFT IDS NEVER MEET, SO THEY ARE NOT GUARDED AGAINST. Start is only ever on a draft
 * at `/new-session?draftId=…`; the old interface, whose `/:dir/session` had none, is pinned off
 * (`newLayoutDesigns` in context/settings.tsx) and that route redirects to a draft. Should it come
 * back, "the draft that pressed it" needs a key of its own there.
 */
const unfinished = new Map<
  string,
  Array<
    CourseBinding & {
      sessionID: string
      answered: boolean
      draftID?: string
      directory: string
      at: number
      /** The task the Start was for; a Start for another task, or none, is another conversation. */
      partId?: string
    }
  >
>()

/** How long a Start not seen through is kept for a retry. */
const RETRY_TTL_MS = 10 * 60_000

/** Let `sessionID` go: it ended on its session, or made nothing to come back to. */
function settled(scope: string, sessionID: string) {
  unfinished.set(
    scope,
    (unfinished.get(scope) ?? []).filter((entry) => entry.sessionID !== sessionID),
  )
}

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
  const [search] = useSearchParams<{ draftId?: string }>()
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

    const task = courseSession.draft.task
    showStartFailure(courseSession, undefined)
    courseSession.draft.setStarting(true)
    const opening = openOnGateway({
      scope: sdk().scope,
      draftID: search.draftId,
      binding,
      task,
      agent: currentAgent.name,
      model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
    })
    const result = await newSession({
      agent: currentAgent.name,
      model: { providerID: currentModel.provider.id, modelID: currentModel.id },
      variant,
      autoAccept: input.autoAccept(),
      binding,
      directory: opening.directory,
      create: opening.create,
    })
      .then((result) => {
        opening.settle(result)
        return result
      })
      /**
       * ⚠ A THROW AFTER THE SIDECAR ANSWERED IS STILL A FAILED START ON SCREEN. `settleStart` catches
       * the request itself; this catches the promote around it, which otherwise only reset
       * `starting` and left the student looking at a Start row that had silently done nothing. The
       * session may exist by then, which is why its id is still kept: the next press reattaches to
       * it rather than making another.
       */
      .catch((err) => {
        console.error("Starting the chat failed", err)
        return {
          status: "not-created" as const,
          directory: sdk().directory,
          failure: { key: startErrorKey(undefined) },
        }
      })
      .finally(() => courseSession.draft.setStarting(false))
    if (result.status === "not-created") showStartFailure(courseSession, result.failure)
    return result
  }
}

/**
 * OPENING A SESSION ON THE GATEWAY: THE `create` OF START, AND OF A TASK DRAFT'S FIRST TYPED MESSAGE.
 *
 * ⚠ ONE WAY FOR BOTH. A task's session is the one the gateway opens for the task, recording its
 * attempt, however the student begins it — with Start, or by typing to an agent that does not speak
 * first; made with `session.create` instead it would be a plain chat the task could never be handed in
 * from. The retry of a Start not seen through (`unfinished`) holds for either.
 *
 * `settle` is handed the result once the screen has moved, or not: only a Start that ended on its
 * session lets its id go.
 *
 * ⚠ IT SAYS WHY IT FAILED, AND THE CALLER SAYS IT ON THE DRAFT — see {@link showStartFailure}.
 */
function openOnGateway(input: {
  scope: string
  draftID: string | undefined
  binding: CourseBinding
  task: TaskDraft | undefined
  agent: string
  model: { id: string; providerID: string; variant?: string }
}) {
  const now = Date.now()
  const retries = (unfinished.get(input.scope) ?? []).filter((entry) => now - entry.at < RETRY_TTL_MS)
  unfinished.set(input.scope, retries)
  const same = (entry: (typeof retries)[number]) =>
    sameBinding(entry, input.binding) && entry.partId === input.task?.partId
  const reused =
    retries.find((entry) => entry.draftID === input.draftID && same(entry)) ??
    retries.find((entry) => !entry.answered && same(entry))
  const sessionID = reused?.sessionID ?? Identifier.descending("session")
  return {
    directory: reused?.answered ? reused.directory : undefined,
    create: async (target: { directory: string; client: DirectorySDK["client"] }) => {
      const answer = await settleStart(
        target.client.session.jolliStart({
          directory: target.directory,
          courseId: input.binding.courseId,
          assistantId: input.binding.assistantId,
          ...(input.task ? { assignmentId: input.task.assignmentId, partId: input.task.partId } : {}),
          sessionID,
          agent: input.agent,
          model: input.model,
        }),
      )
      const before = (unfinished.get(input.scope) ?? []).find((entry) => entry.sessionID === sessionID)
      settled(input.scope, sessionID)
      if (answer.unanswered || answer.result?.status === "started")
        unfinished.get(input.scope)?.push({
          ...input.binding,
          ...(input.task ? { partId: input.task.partId } : {}),
          sessionID,
          answered: !answer.unanswered || !!before?.answered,
          draftID: input.draftID,
          directory: target.directory,
          at: Date.now(),
        })
      // The opener, which a typed first message must not talk over.
      if (answer.result?.status === "started")
        return { session: normalizeSessionInfo(answer.result.session), opener: answer.result.opener }
      if (answer.result?.status !== "refused") return { failure: { key: startErrorKey(undefined) } }
      refreshCatalog()
      // A task's refusal is the assignment's to word; the list it was started from may be stale too.
      if (input.task) refreshAssignments()
      return {
        failure: {
          key: startErrorKey(answer.result.code),
          ...(input.task && answer.result.message ? { message: answer.result.message } : {}),
        },
      }
    },
    settle: (result: NewSessionResult<unknown>) => {
      if (result.status !== "created") return
      settled(input.scope, sessionID)
      // The task now has a session here, which its dialog offers to continue.
      if (input.task) refreshAssignments()
    },
  }
}

/** Why opening on the gateway failed: what the draft words it as, and for a task the gateway's own sentence. */
type StartFailure = { key: StartErrorKey; message?: string }

/** Say on the draft why opening on the gateway failed; undefined clears what was said before. */
function showStartFailure(courseSession: ReturnType<typeof useCourseSession>, failure: StartFailure | undefined) {
  courseSession.draft.setStartError(failure?.key)
  courseSession.draft.setStartMessage(failure?.message)
}

/** The HTTP status the SDK put under `cause` when it threw, or undefined when it got no answer. */
function httpStatus(err: unknown) {
  if (!(err instanceof Error) || typeof err.cause !== "object" || err.cause === null) return undefined
  return "status" in err.cause && typeof err.cause.status === "number" ? err.cause.status : undefined
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
  const [search] = useSearchParams<{ draftId?: string }>()

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
      /**
       * ⚠ A TASK'S DRAFT IS OPENED ON THE GATEWAY EVEN WHEN ITS FIRST MESSAGE IS TYPED. Its agent does not
       * speak first, or the draft would be showing Start; the session is still the task's, made the way
       * Start makes it, and the typed message then goes to it as its first turn. Named by that message
       * below, as a started session is, and only once it is sent: an opener can still hold it back.
       */
      const binding = courseSession.current()
      const task = binding ? courseSession.draft.task : undefined
      const opening =
        binding && task
          ? openOnGateway({
              scope: sdk().scope,
              draftID: search.draftId,
              binding,
              task,
              agent: currentAgent.name,
              model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
            })
          : undefined
      const heldBack = (opener: boolean) => opener && mode !== "shell"
      /**
       * ⚠ THE COMPOSER WAITS AS START'S ROW DOES. Opening on the gateway can take as long as Start, and
       * anything typed meanwhile would go with the `clear()` that follows the send, never sent.
       */
      if (opening) {
        showStartFailure(courseSession, undefined)
        courseSession.draft.setStarting(true)
      }
      const result = await newSession({
        agent: currentAgent.name,
        model: { providerID: currentModel.provider.id, modelID: currentModel.id },
        variant,
        autoAccept: input.autoAccept(),
        ...(opening ? { binding, directory: opening.directory } : {}),
        /**
         * ⚠ PROMOTED HERE, BEFORE THE TRANSITION THAT SHOWS THE SESSION. Its composer reads the history from
         * storage as it is made and writes it back whole, so an entry promoted after that is lost to it. A
         * message held back for an opener is the exception: it was not sent, and is discarded below.
         */
        created: (created, opener) => {
          if (!heldBack(opener)) input.promoteHistory?.(created.id)
        },
        promoted: (created, directory) =>
          submission.retarget(prompt.capture({ dir: base64Encode(directory), id: created.id })),
        create: opening
          ? opening.create
          : (target) =>
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
                  /**
                   * ⚠ A BOUND CREATE REFUSED AS A BAD REQUEST REFRESHES THE CATALOGUE. The server judges a
                   * new binding by the snapshot on disk, which can be newer than the list on screen: an
                   * assistant switched to speak first is refused here, and only a fresh list puts Start
                   * where this composer is. The 400 carries no reason (`HttpApiError.BadRequest` has no
                   * body), so any 400 for a bound create is taken as that — a spare refresh at worst.
                   */
                  if (courseSession.current() && httpStatus(err) === 400) refreshCatalog()
                  showToast({
                    title: language.t("prompt.toast.sessionCreateFailed.title"),
                    description: errorMessage(err),
                  })
                  return { failure: undefined as StartFailure | undefined }
                }),
      }).catch((err) => {
        /**
         * ⚠ A THROW AFTER THE GATEWAY ANSWERED IS A FAILED START ON SCREEN, as Start's is. The session
         * may exist there by then, which is why its id is still kept: the next Enter reattaches to it.
         * A plain session's create keeps throwing as it always has.
         */
        if (!opening) throw err
        console.error("Starting the task's session failed", err)
        return {
          status: "not-created" as const,
          directory: sdk().directory,
          failure: { key: startErrorKey(undefined) } as StartFailure | undefined,
        }
      }).finally(() => {
        if (opening) courseSession.draft.setStarting(false)
      })
      opening?.settle(result)
      if (result.status === "no-directory") {
        input.discardHistory?.()
        return
      }
      // A refused or unreachable start is said where Start's is, above the composer, and the typed
      // message stays in it for the next Enter.
      if (opening && result.status === "not-created") {
        showStartFailure(courseSession, result.failure)
        input.discardHistory?.()
        return
      }
      // The list said the agent does not speak first; a fresh one puts Start on the next draft.
      if (result.status === "created" && result.opener) refreshCatalog()
      /**
       * ⚠ AN OPENER THE CATALOGUE DID NOT FORESEE HOLDS THE MESSAGE BACK. The list on screen said the agent
       * does not speak first, but the gateway wrote it an opener: sent now, the message would talk over a
       * turn the student has not read. The message is put in the session's input instead — the draft's
       * went with the draft when it was promoted — to send once they have. A shell command is run all the
       * same: it asks the model nothing, so it talks over no one, and the session's composer would not
       * come back in shell mode to run it.
       */
      if (result.status === "created" && heldBack(result.opener)) {
        input.discardHistory?.()
        /**
         * ⚠ THE COMPOSER IT WAS TYPED IN IS EMPTIED AS A SENT ONE IS. Without a draft tab to promote, that is
         * the directory's New session input, and the message left there would go out again, to a plain
         * session, the next time Enter is pressed in it.
         */
        submission.clear()
        submission.target().set(submission.prompt, input.promptLength(submission.prompt))
        // Said out loud: a student who moved on during the wait would otherwise wait on a reply to nothing.
        showToast({ description: language.t("prompt.jolli.start.heldBack") })
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
      openedOnGateway(session) && SessionTitle.isDefault(session.title ?? "")
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
