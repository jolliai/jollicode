/**
 * WHICH COURSE AND WHICH ASSISTANT THE SESSION IN THE TERMINAL BELONGS TO.
 *
 * ⚠ THIS IS THE TUI'S HALF OF WHAT `packages/app/src/jolli/session-binding.tsx` DOES, AND THE TWO
 * DELIBERATELY SHARE THEIR ANSWERS RATHER THAN THEIR CODE. Everything that decides something —
 * which assistants a course has, whether it can be started, what a grant permits, who reads a new
 * session — lives in `@opencode-ai/core/jolli/*` and is called from both. What is left here is the
 * part that is genuinely this renderer's: a fetch, a store, and the shape a dialog can read.
 *
 * ⚠ IT DOES NOT EXPOSE A FIELD CALLED `ready`, AND THAT IS NOT A NAMING PREFERENCE.
 * `createSimpleContext` gates its children on `init.ready` — a context that reports `ready: false`
 * renders NOTHING below it. A catalogue that has not arrived yet would blank the entire TUI, so the
 * flag is called {@link loaded} and every consumer treats "not loaded" as an empty list.
 *
 * ⚠ THE GRANT CROSSES TO `context/local.tsx` AS A MODULE SIGNAL RATHER THAN THROUGH THIS CONTEXT,
 * for the reason `packages/app/src/jolli/model-grant.ts` gives at length: `local.tsx` is upstream's
 * file and carries its own validation machinery, so every line this fork adds there is a line that
 * conflicts on the next rebase. One signal keeps that diff to the single call site that reads it.
 */

import { Flag } from "@opencode-ai/core/flag/flag"
import { courseBindingOf, type CourseBinding } from "@opencode-ai/core/jolli/binding"
import { isJolliConnected } from "@opencode-ai/core/jolli/gateway-config"
import { Lookup } from "@opencode-ai/core/jolli/lookup"
import { defaultSessionSharing } from "@opencode-ai/core/jolli/sharing"
import { Jolli } from "@opencode-ai/schema/jolli"
import { createEffect, createMemo, createSignal, on } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useRoute } from "./route"
import { useKV } from "./kv"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

export type { CourseBinding }

/** Re-exported so `context/local.tsx` takes one fork import rather than two. */
export const parseModelKey = Lookup.parseModelKey

/**
 * THE FIVE REFUSALS, IN WORDS. `Lookup.blockedReason` answers with a code precisely so that each
 * renderer can word them itself; this one has no i18n dictionary anywhere in it, so English is the
 * whole vocabulary and it lives here rather than in a module the desktop shares.
 *
 * ⚠ EACH REASON GETS ITS OWN SENTENCE. They lead to different next actions — wait for the teacher,
 * wait for term, ask the teacher, nothing — so collapsing them into one "unavailable" would throw
 * away the only useful part.
 */
const BLOCKED_REASON: Record<Lookup.CourseBlockedReason, string> = {
  draft: "not published yet",
  "not-yet": "not started yet",
  ended: "ended",
  archived: "archived",
  "no-assistants": "no assistants yet",
}

const [allowed, setAllowed] = createSignal<readonly string[]>([])
const [preferred, setPreferred] = createSignal<string | undefined>(undefined)

/**
 * WHAT THE ASSISTANT IN FORCE PERMITS, READ BY `context/local.tsx` AND THE MODEL DIALOG.
 *
 * ⚠ AN EMPTY LIST MEANS UNRESTRICTED, NOT "NOTHING ALLOWED" — see `Lookup.isModelAllowed`. That is
 * also what an unbound TUI sees, which is what keeps a session started before this existed working.
 */
export const ModelGrant = {
  allowed,
  /** The model the professor pinned on this assistant, if any. See `Jolli.Assistant.modelId`. */
  preferred,
  isAllowed(providerID: string, modelID: string) {
    return Lookup.isModelAllowed(allowed(), providerID, modelID)
  },
}

/**
 * ⚠ THE SAME HANDOFF TRICK THE APP USES, AND FOR THE SAME REASON. `submit()` creates the session and
 * navigates to it before that session has come back over sync, so for a frame or two there is no row
 * to read the binding off. This carries it across that gap and is dropped the moment the server's
 * copy lands.
 */
const handoff = new Map<string, CourseBinding>()

export const { use: useJolli, provider: JolliProvider } = createSimpleContext({
  name: "Jolli",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const route = useRoute()
    const kv = useKV()

    /**
     * ⚠ A COUNTER SO A RETRY HAS SOMETHING TO PUSH AGAINST. The fetch below tracks whether a Jolli
     * credential is held, and "check again" changes neither that nor the server's URL — without a
     * value of its own to bump, the button would be inert.
     */
    const [generation, setGeneration] = createSignal(0)

    const [store, setStore] = createStore<{
      courses: readonly Jolli.Course[]
      assistants: readonly Jolli.Assistant[]
      loaded: boolean
      /** What the server said about its own answer — see `Jolli.CatalogStatus`. */
      status: Jolli.CatalogStatus
      draft?: CourseBinding
    }>({ courses: [], assistants: [], loaded: false, status: "unreachable" })

    /**
     * ⚠ RE-ASKED WHENEVER THE JOLLI CREDENTIAL APPEARS OR GOES AWAY, NOT FETCHED ONCE ON MOUNT. The
     * TUI can be launched signed out, sign in through `/login` and keep running; the empty
     * catalogue answered before that would otherwise stand for the life of the process. The
     * connected set is the one thing in sync that changes exactly when this answer would.
     *
     * ⚠ AND IT IS FETCHED WHILE SIGNED OUT TOO, which is why this tracks the flag rather than
     * guarding on it. `/jolli/course` answers an empty catalogue rather than an error with no
     * credential, and it is that answer landing which lets {@link submissionBlocker} say "no
     * courses yet, sign in" instead of "still loading" forever.
     *
     * ⚠ CHECKS ANY OF THE PER-PROTOCOL PROVIDER IDS (`jolli-anthropic`, `jolli-openai`,
     * `jolli-google`), NOT THE BARE `jolli` SLUG. The gateway config emits one opencode provider
     * per wire protocol (see `providerIdFor`), and none of them is called `"jolli"` — so a check
     * that only asked about the bare slug would report "signed out" for a student who had actually
     * signed in, and the course dialog would sit on its empty view forever.
     */
    const signedIn = createMemo(() => isJolliConnected(sync.data.provider_next.connected))

    /** The kv key holding the last course this student chose. See the restore effect below. */
    const REMEMBERED = "jolli_last_course"

    createEffect(
      on(
        () => [signedIn(), generation()] as const,
        () => {
          void sdk.client.jolli
            .course()
            .then((response) => {
              const catalog = response.data
              if (!catalog) return
              setStore(
                produce((draft) => {
                  draft.courses = catalog.courses as readonly Jolli.Course[]
                  draft.assistants = catalog.assistants as readonly Jolli.Assistant[]
                  draft.status = catalog.status
                  draft.loaded = true
                }),
              )
            })
            /**
             * ⚠ A FAILED FETCH LEAVES `loaded` ALONE RATHER THAN SETTING IT. The flag means "the
             * server answered", and it is what turns into "you have no courses yet" downstream — a
             * request that never landed must not be reported as an empty enrolment.
             */
            .catch(() => undefined)
        },
      ),
    )

    /**
     * SIGNING OUT DROPS THE COURSE, IN MEMORY AND IN WHAT IS REMEMBERED.
     *
     * ⚠ THE CREDENTIAL GOING AWAY DOES NOT ON ITS OWN CLEAR ANYTHING HERE, which is how a signed-out
     * composer kept reporting `CS 101/Tutor` in its footer — a course the student was no longer
     * signed in to, over a gate correctly saying there were none. The catalogue empties by itself
     * because it is refetched; the DRAFT is local state and had nothing to empty it.
     *
     * ⚠ AND THE REMEMBERED COURSE GOES WITH IT, because the button that reaches here is "use a
     * different account". Restoring the previous student's course for the next one is the same
     * mistake `clearCatalogCache` exists to prevent on disk, one layer up.
     */
    createEffect(
      on(signedIn, (isIn, was) => {
        if (isIn || was === undefined || !was) return
        setStore("draft", undefined)
        kv.set(REMEMBERED, undefined)
      }),
    )

    const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

    /**
     * THE BINDING IN FORCE RIGHT NOW: the open session's, or the draft being composed.
     *
     * ⚠ THE SERVER'S COPY IS THE AUTHORITY AND THE HANDOFF IS ONLY THE GAP. Without a session id we
     * are composing a new one and the draft is all there is.
     */
    const current = createMemo<CourseBinding | undefined>(() => {
      const id = sessionID()
      if (!id) return store.draft
      const bound = courseBindingOf(sync.data.session.find((item) => item.id === id))
      if (bound) {
        handoff.delete(id)
        return bound
      }
      return handoff.get(id)
    })

    /**
     * THE COURSES A STUDENT MAY ACTUALLY WORK IN, AND THE ONLY ONES ANY SCREEN LISTS.
     *
     * ⚠ A COURSE THAT CANNOT BE STARTED IS NOT SHOWN AT ALL ON THIS SURFACE, which is the opposite
     * of what the desktop picker does. The desktop lists drafts and says "your instructor hasn't
     * published this yet" beside them; here a row that refuses when you press it is worse than no
     * row, because a terminal list has no hover, no disabled styling and no second column to carry
     * the excuse. What the desktop says per row, this surface says once, in the gate.
     */
    const startable = createMemo(() => store.courses.filter((item) => Lookup.canStartSession(store, item.id)))

    const course = createMemo(() => Lookup.courseById(store, current()?.courseId))
    const assistant = createMemo(() => Lookup.assistantById(store, current()?.assistantId))

    /**
     * ⚠ PICKING A COURSE PICKS ITS DEFAULT ASSISTANT TOO. One decision, not two — and changing the
     * course RESETS the assistant rather than carrying it, because an assistant belongs to exactly
     * one course and a carried selection would name one the new course has never heard of.
     */
    const draftFor = (courseId: string, assistantId?: string) => {
      const next = Lookup.courseById(store, courseId)
      if (!next) return undefined
      const chosen =
        (assistantId ? Lookup.assistantById(store, assistantId) : undefined) ??
        Lookup.defaultAssistantFor(store, courseId)
      if (!chosen) return undefined
      return { courseId, assistantId: chosen.id, sharing: defaultSessionSharing(next, [chosen]) }
    }

    /**
     * THE LAST COURSE THIS STUDENT CHOSE, SO THEY ARE NOT ASKED AGAIN EVERY LAUNCH.
     *
     * ⚠ A NEW TUI SESSION HAS NO BINDING, WHICH IS NOT THE SAME AS HAVING NO ANSWER. Binding lives
     * on the session and a fresh process has none, so without something remembered the picker met
     * the student on every single launch — a modal in front of a decision they had already made,
     * usually the same way, every time.
     *
     * ⚠ IT IS REMEMBERED PER MACHINE, NOT PER PROJECT. A course is a property of the student, not
     * of the directory they happen to open; `session.metadata` is what records where a particular
     * conversation belongs, and that is already durable.
     *
     * ⚠ AND IT IS RE-VALIDATED, NEVER TRUSTED. Term ends, a professor unpublishes, an assistant is
     * retired — `draftFor` resolves against today's catalogue and returns nothing if the remembered
     * course can no longer be started, which puts the student back in front of the picker.
     */
    const remember = (binding: CourseBinding | undefined) => {
      if (!binding) return
      kv.set(REMEMBERED, { courseId: binding.courseId, assistantId: binding.assistantId })
    }

    /**
     * NOTHING IS PRE-SELECTED WHEN THERE IS A CHOICE — AND A SINGLE CANDIDATE IS NOT A CHOICE.
     *
     * ⚠ THE RULE IS THE DESKTOP'S, AND IT MATTERS MORE HERE. A course decides who may answer, on
     * which models, and who may read the result, so where a student has several, picking one FOR
     * them by array order would make all three choices silently. But where exactly one can be
     * started there is no order to be at the mercy of and no second option to be denied — and this
     * surface REFUSES THE FIRST PROMPT until something is bound, so leaving it blank would make
     * every single-course student meet a refusal and then click the only row on the menu.
     *
     * ⚠ IT WAITS FOR `loaded`, WHICH IS THE WHOLE REASON THAT FLAG EXISTS. "No courses yet" and
     * "one course, still in flight" are the same empty list; acting on the second would select
     * nothing and never revisit it.
     *
     * ⚠ AND IT FIRES ONCE. A student who picks a different course would otherwise have this put it
     * straight back, and the picker would appear broken.
     */
    let autoSelected = false
    createEffect(() => {
      /**
       * ⚠ `signedIn()` IS CHECKED THOUGH THE CATALOGUE WOULD BE EMPTY ANYWAY. Signed out, no course
       * may be shown at all — and relying on the list being empty to enforce that makes the rule an
       * accident of another layer's behaviour rather than something this file states.
       */
      if (autoSelected || !signedIn() || !store.loaded || !kv.ready || sessionID() || store.draft) return
      /**
       * ⚠ THE REMEMBERED COURSE COMES FIRST AND A SOLE CANDIDATE SECOND. Both end in the same
       * place — a binding the student did not have to make again — but one is their own previous
       * answer and the other is the absence of a question.
       */
      const last = kv.get(REMEMBERED) as { courseId?: unknown; assistantId?: unknown } | undefined
      if (typeof last?.courseId === "string") {
        const restored = draftFor(last.courseId, typeof last.assistantId === "string" ? last.assistantId : undefined)
        if (restored && Lookup.canStartSession(store, restored.courseId)) {
          autoSelected = true
          setStore("draft", restored)
          return
        }
      }
      if (startable().length !== 1) return
      /**
       * ⚠ THE LATCH CLOSES ONLY IF THE DRAFT WAS ACTUALLY BUILT, so a course `canStartSession` just
       * called startable but whose default assistant will not resolve does not become a permanent
       * refusal to pre-select.
       */
      const draft = draftFor(startable()[0].id)
      if (!draft) return
      autoSelected = true
      setStore("draft", draft)
    })

    /**
     * PUBLISH WHAT THE ASSISTANT DECIDES ABOUT MODELS, so the picker can narrow and the selection
     * chain can honour the professor's default.
     */
    createEffect(() => {
      const item = assistant()
      setAllowed(item?.allowedModelIds ?? [])
      setPreferred(item?.modelId)
    })

    return {
      loaded: () => store.loaded,
      /** Whether a Jolli credential is held. The honest signal on both surfaces — see `connectAction`. */
      signedIn,
      /** Ask the server again. The catalogue is the only thing "check again" can change. */
      refresh: () => setGeneration((value) => value + 1),
      /**
       * SIGNED IN AND ENROLLED IN NOTHING THIS PRODUCT CAN START.
       *
       * ⚠ IT REQUIRES A CREDENTIAL, because signed out produces the same empty list and the answer
       * there is "sign in", not "your instructor has not set one up". {@link submissionBlocker}
       * makes the same distinction for the same reason.
       *
       * ⚠ IT COUNTS STARTABLE COURSES, NOT COURSES, AND THAT IS THE OTHER HALF OF HIDING THE REST.
       * Once a draft is not listed, a student whose only course is a draft would meet an EMPTY
       * picker and no gate — stuck between two screens, neither of which can say why. Keying the
       * gate on what the picker would actually show keeps exactly one of them in front of them.
       */
      noCourses: () =>
        Flag.JOLLICODE_LOCKDOWN && signedIn() && store.loaded && store.status === "ok" && startable().length === 0,
      /** Whether anything is enrolled at all, which decides WHICH sentence the gate uses. */
      enrolled: () => store.courses.length > 0,
      /**
       * SIGNED IN, AND THE GATEWAY DID NOT ANSWER.
       *
       * ⚠ IT IS A SEPARATE QUESTION FROM {@link noCourses} AND MUST STAY ONE. Both arrive as an
       * empty list, and reporting a dropped connection as "none of your courses use Jolli Code"
       * sends a student to their registrar over a Wi-Fi problem — the desktop gate has always drawn
       * this line, and `Jolli.CatalogStatus` is what carries it to this surface.
       */
      unreachable: () => Flag.JOLLICODE_LOCKDOWN && signedIn() && store.loaded && store.status === "unreachable",
      /**
       * THE CATALOGUE HAS COURSES AND THE PROVIDER HAS NO MODELS, WHICH CANNOT BOTH BE RIGHT.
       *
       * ⚠ THE TWO ARE BUILT FROM THE SAME ANSWER AT DIFFERENT TIMES, AND ONLY ONE OF THEM RETRIES.
       * `jolliLockdownConfig` loads the catalogue while assembling the provider block and swallows
       * a failure as an empty model list — deliberately, because a server must start over a list
       * of models. But config is built once per instance, so a catalogue that arrives a moment
       * later (this context asks again, and the cache is shared) leaves a student looking at their
       * course list and at "No provider selected" at once, with nothing that would reconcile them.
       *
       * ⚠ IT IS A SYMPTOM OF A SERVER-SIDE ORDERING PROBLEM AND HEALING IT HERE IS THE NARROW FIX.
       * `app.tsx` disposes the instance so config is assembled again, now against a warm cache. The
       * durable answer is for config assembly not to keep a failed catalogue load.
       */
      modelsMissing: () =>
        Flag.JOLLICODE_LOCKDOWN &&
        store.loaded &&
        store.status === "ok" &&
        startable().length > 0 &&
        sync.data.provider.length === 0,
      course,
      assistant,
      current,
      /** ⚠ ONLY THE STARTABLE ONES — see {@link startable}. Nothing renders a course it would refuse. */
      courses: () => [...startable()],
      assistantsFor: (courseId: string | undefined) => Lookup.assistantsForCourse(store, courseId),
      canStart: (courseId: string | undefined) => Lookup.canStartSession(store, courseId),
      blockedReason: (item: Jolli.Course) => {
        const reason = Lookup.blockedReason(store, item)
        return reason && BLOCKED_REASON[reason]
      },

      /** True once a session exists, which is what makes the binding unchangeable. */
      locked: () => !!sessionID(),

      /**
       * Whether a course still has to be picked AND picking it is a real choice. See
       * {@link needsCourseChoice} — `app.tsx` turns this into the picker opening by itself.
       */
      needsChoice: () =>
        needsCourseChoice({
          lockdown: Flag.JOLLICODE_LOCKDOWN,
          signedIn: signedIn(),
          started: !!sessionID(),
          bound: !!current(),
          loaded: store.loaded,
          startable: startable().length,
        }),

      /** Why the first prompt cannot be sent yet, or nothing when it can. See {@link submissionBlocker}. */
      blocked: () =>
        submissionBlocker({
          lockdown: Flag.JOLLICODE_LOCKDOWN,
          signedIn: signedIn(),
          started: !!sessionID(),
          bound: !!current(),
          loaded: store.loaded,
          courses: store.courses.length,
          startable: startable().length,
        }),

      draft: {
        get value() {
          return store.draft
        },
        setCourse(courseId: string) {
          const next = draftFor(courseId)
          setStore("draft", next)
          remember(next)
        },
        setAssistant(assistantId: string) {
          const courseId = store.draft?.courseId ?? Lookup.assistantById(store, assistantId)?.courseId
          if (!courseId) return
          const next = draftFor(courseId, assistantId)
          setStore("draft", next)
          remember(next)
        },
      },

      /**
       * CARRY THE DRAFT ONTO THE SESSION THAT WAS JUST CREATED.
       *
       * ⚠ IT WRITES NOTHING ANYWHERE — `submit()` sends the binding as part of `session.create` so
       * that the session never exists unbound. All this covers is the frame between that call and
       * the new session arriving over sync.
       *
       * ⚠ AND IT LEAVES THE DRAFT ALONE, WHICH IS NOT AN OVERSIGHT. `handoff` is keyed by the new
       * session id, and {@link current} can only reach it once `sessionID()` reports that id — which
       * is route state, and `prompt/index.tsx` defers the navigation by 50ms behind a `setTimeout`.
       * Clearing the draft here opened a window in which the route still says "composing" while the
       * draft is already gone: `started` and `bound` both false, `needsChoice()` flips true, and
       * `app.tsx` puts the course picker back in front of a student who had just chosen one and
       * pressed enter. Fifty milliseconds is an age to a reactive graph.
       *
       * Keeping it costs nothing: the draft is only ever read while there is no session id, and the
       * remembered course would restore the same value on the next new session anyway.
       */
      promote(session: string) {
        const next = store.draft
        if (!next) return
        handoff.set(session, { ...next })
      },
    }
  },
})

/**
 * WHY THE FIRST PROMPT CANNOT BE SENT YET, OR nothing when it can.
 *
 * ⚠ IT ONLY EVER SPEAKS UNDER LOCKDOWN. A bare `opencode` build has no courses and must keep
 * behaving exactly as it always has; the shipped `jollicode` entry point is what sets that flag, so
 * this is on for the product and off for everything else.
 *
 * ⚠ AND IT ONLY GUARDS SESSIONS BEING CREATED, WHICH IS THE POINT OF `started`. The server refuses
 * to bind a course once the first message has landed, so a session that already ran unbound can
 * NEVER acquire one — refusing to prompt in it would protect nothing and would permanently brick
 * every transcript written before courses existed. A session yet to be created is the only place
 * the decision is still available to make.
 *
 * ⚠ "NOT LOADED" REFUSES RATHER THAN PERMITS, and says so in its own words. An empty catalogue and
 * one that has not arrived are indistinguishable, and letting the second through would create
 * exactly the unbound session this exists to prevent.
 *
 * ⚠ EACH REFUSAL NAMES THE NEXT ACTION, because they are different ones — wait a moment, sign in,
 * pick a course. A single "choose a course" shown to a student who has none would send them looking
 * for a control that would be empty when they found it.
 */
export function submissionBlocker(input: {
  lockdown: boolean
  signedIn: boolean
  started: boolean
  bound: boolean
  loaded: boolean
  courses: number
  startable: number
}) {
  if (!input.lockdown) return undefined
  /**
   * ⚠ AHEAD OF `started`, AND THAT ORDER IS THE WHOLE POINT OF THIS CHECK. Every case below is
   * about which course a prompt belongs to, and a session that already ran is exempt from those
   * because the server will not bind one to it any more. A missing credential is a different kind
   * of fact: the request cannot succeed at all. Checked after `started`, a session whose credential
   * was revoked mid-conversation would keep sending and keep failing at the gateway with a 401 the
   * student cannot act on — which is exactly what this surface looked like before.
   *
   * ⚠ IT BECAME REACHABLE WHEN RENEWAL DID. A credential used to be a 34-day JWT that nothing
   * could retire, so "signed in at launch" and "signed in now" were the same claim. They are not
   * any more: `jolli/session.ts` deletes the row when the backend refuses a renewal.
   */
  if (!input.signedIn) return "Signed out. Press /login to sign in again."
  if (input.started) return undefined
  if (input.bound) return undefined
  if (!input.loaded) return "Still loading your courses — try again in a moment."
  if (input.courses === 0) return "No courses yet. Sign in with /login, or ask your instructor."
  if (input.startable === 0) return "None of your courses can be started yet — press /course to see why."
  return "Choose a course before you start — press /course."
}

/**
 * WHETHER TO PUT THE COURSE PICKER IN FRONT OF SOMEBODY WHO HAS NOT ASKED FOR IT.
 *
 * ⚠ IT IS NOT THE SAME QUESTION AS {@link submissionBlocker}, AND THE DIFFERENCE IS THE ONLY REASON
 * BOTH EXIST. That one answers "may this prompt go" and must refuse every unbound case, including
 * the ones a picker cannot help with — no courses at all, none startable, catalogue still in
 * flight. This one answers "is there a decision waiting", and opening a dialog whose every row is
 * greyed, or which is still loading, is worse than saying nothing.
 *
 * ⚠ EXACTLY ONE STARTABLE COURSE IS NOT A DECISION. The context has already bound it by the time
 * this could fire — see the auto-select effect — so `bound` covers that case; `startable > 1` is
 * what is left, and it is the only case where the student's answer is needed.
 */
export function needsCourseChoice(input: {
  lockdown: boolean
  signedIn: boolean
  started: boolean
  bound: boolean
  loaded: boolean
  startable: number
}) {
  if (!input.lockdown) return false
  /**
   * ⚠ SIGNED OUT, NO COURSE MAY BE SHOWN AT ALL — and the window this closes is real rather than
   * theoretical. Signing out clears the binding immediately while the catalogue is only emptied by
   * the refetch that follows, so for a moment there is no binding AND several startable courses:
   * exactly the shape of "ask them to choose". The picker opened over a student who had just
   * signed out, then sat there reading "you are not enrolled in any course" once the answer landed.
   */
  if (!input.signedIn) return false
  if (input.started || input.bound) return false
  if (!input.loaded) return false
  return input.startable > 1
}
