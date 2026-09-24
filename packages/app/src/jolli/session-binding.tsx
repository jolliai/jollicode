/**
 * WHICH COURSE AND WHICH ASSISTANT THE SESSION ON SCREEN BELONGS TO.
 *
 * This is the route-aware view of `@opencode-ai/core/jolli/binding`: that module reads a binding off
 * any session, and this context answers "the one in force right now" plus the draft a student is
 * still deciding on.
 *
 * ⚠ WHO CAN READ A SESSION IS NOT HERE ANY MORE. It used to be a two-switch `sharing` value this
 * context wrote into the session's metadata; it is now Jolli Edu's per-session grants, read and
 * written through `/jolli/session/:sessionID/share` (see `use-session-share.ts`), and nothing about
 * it is stored on the session.
 *
 * ⚠ A PARALLEL CONTEXT RATHER THAN THREE MORE FIELDS ON `context/local.tsx`, AND THAT IS A FORK
 * DECISION RATHER THAN A DESIGN ONE. `local.tsx` is upstream's file and carries its own migration,
 * handoff and validation machinery; every line this fork adds there is a line that conflicts on the
 * next rebase. This module deliberately MIRRORS its shape — same draft/promote lifecycle, same
 * handoff across the frame where a session is created — so a reader who knows one knows the other,
 * while the diff against upstream stays at the call sites.
 *
 * ⚠ THE IMMUTABILITY IS ENFORCED BY THE SERVER, AND THIS CONTEXT ONLY REFLECTS IT. An earlier
 * version of this note said the opposite — that nothing here is the authority and what fixes a
 * session's course is that no screen renders a control to change it. Both halves have since stopped
 * being true: `refuseRebindingAfterFirstMessage` in the session PATCH handler rejects a course or
 * assistant change once the conversation has started, and a screen *does* render a control, on the
 * draft route where the write would still be accepted. So `locked` is not the lock; it is how this
 * context tells a view which of the two forms to draw.
 *
 * ⚠ `Session.agent` REMAINS GENUINELY MUTABLE SERVER-SIDE — the server overwrites it whenever a turn
 * arrives naming a different agent, and a `switchAgent` endpoint exists — so an assistant lock
 * enforced anywhere but in the binding would be a lock this product does not actually have.
 */

import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLayout } from "@/context/layout"
import { assistantById, canStartSession, courseById, defaultAssistantFor, enrolledCourses, ready } from "./catalog"
import { useJolliCatalog } from "./catalog-fetch"
import { CourseIntent, courseIntentRouteKey } from "./course-intent"
import { ModelGrant } from "./model-grant"
import { useSync } from "@/context/sync"
import { courseBindingOf, type CourseBinding } from "@opencode-ai/core/jolli/binding"
import type { Assistant, Course } from "./types"

export type { CourseBinding }

/**
 * ⚠ THE SAME HANDOFF TRICK `local.tsx` USES, AND FOR THE SAME REASON. Creating a session navigates
 * to its route before the store write is visible to the new render, so the first frame of the new
 * session would find no binding and show no course. This carries it across that gap.
 */
const handoff = new Map<string, CourseBinding>()

/**
 * ⚠ THE HANDOFF IS DROPPED AS SOON AS THE SERVER'S COPY ARRIVES, because it only ever covers the
 * frame between creating a session and syncing it back. Left alone it grows for the life of the
 * renderer — one entry per session created — and each stale entry is a binding that would be
 * preferred over nothing if a session were ever read back unbound.
 */
function forgetHandoff(session: string) {
  handoff.delete(session)
}

export const { use: useCourseSession, provider: CourseSessionProvider } = createSimpleContext({
  name: "JolliCourseSession",
  /**
   * ⚠ `false` DELIBERATELY, AND IT IS THE ONE LINE HERE WORTH ARGUING ABOUT. Exposing a `ready`
   * field would make `gate` required, and gating holds back every child until this context settles —
   * which on the session route is the entire application. A fork's own store is the last thing that
   * should be able to render the product blank.
   */
  gate: false,
  init: () => {
    const params = useParams()
    const id = createMemo(() => params.id || undefined)
    /** Only ever read to scope a `CourseIntent` request to the session it was made for. */
    const layout = useLayout()

    /**
     * ⚠ THE FETCH IS NO LONGER THIS CONTEXT'S PRIVATE BUSINESS — see `catalog-fetch.ts`. It used to
     * be an effect right here, on the reasoning that this is the context that needs the catalogue.
     * That was true and still left the home route without one, because `/` mounts under neither of
     * this provider's two mount points. The hook is called here as one caller among several, and
     * `ensureCatalog` makes the duplicates free.
     */
    useJolliCatalog()

    const [store, setStore] = createStore<{
      draft?: CourseBinding
    }>({})

    /**
     * THE BINDING IN FORCE RIGHT NOW: the open session's, or the draft being composed.
     *
     * ⚠ THE ORDER MATTERS. With a session id the stored row is the authority and the handoff is the
     * fallback for the frame after creation. Without one we are on the new-session screen and the
     * draft is all there is.
     */
    const sync = useSync()
    const current = createMemo<CourseBinding | undefined>(() => {
      const session = id()
      if (!session) return store.draft
      /**
       * ⚠ THE SERVER'S COPY IS THE AUTHORITY AND THE HANDOFF IS ONLY THE GAP. Creating a session
       * navigates to its route before the new session has been synced back, so for a frame or two
       * there is no row to read — that is what `handoff` covers, and nothing else.
       */
      const bound = courseBindingOf(sync().data.session.find((item) => item.id === session))
      if (bound) forgetHandoff(session)
      return bound ?? handoff.get(session)
    })

    const course = createMemo<Course | undefined>(() => courseById(current()?.courseId))
    const assistant = createMemo<Assistant | undefined>(() => assistantById(current()?.assistantId))

    const draftFor = (courseId: string, assistantId?: string): CourseBinding | undefined => {
      if (!courseById(courseId)) return undefined
      const chosen = (assistantId ? assistantById(assistantId) : undefined) ?? defaultAssistantFor(courseId)
      if (!chosen) return undefined
      return { courseId, assistantId: chosen.id }
    }

    /**
     * THE FIRST STARTABLE COURSE IS PRE-SELECTED, SO A STUDENT WHO JUST SIGNED IN CAN TYPE.
     *
     * ⚠ THIS REVERSES THE EARLIER RULE, WHICH PRE-SELECTED ONLY WHERE THERE WAS EXACTLY ONE
     * CANDIDATE. That rule was argued from the weight of the decision — a course decides who may
     * answer, on which models, and who may read the result — and concluded that choosing by array
     * order was choosing for the student. What it actually produced was a student landing on the
     * new-session screen after sign-in, typing, and meeting a refusal they had to clear by opening
     * a menu. The decision is still theirs: the selector sits above the prompt on every new session
     * and stays live until the first message, so a wrong default costs one click to correct —
     * whereas no default cost every multi-course student one click, every time.
     *
     * ⚠ UNSTARTABLE COURSES ARE STILL SKIPPED. Drafts, courses that have not opened, ended or
     * archived ones and ones with no assistant are listed and refused by the picker; seeding one
     * here would bind the session to something the server will not run.
     *
     * ⚠ IT WAITS FOR `ready()`, WHICH IS THE WHOLE REASON THAT FLAG EXISTS. Courses arrive from the
     * server, and "no courses" and "courses still loading" are the same empty list. Acting on the
     * second would select nothing and then never revisit it — which is exactly the shape of the
     * sign-in case this is for, since the pre-sign-in ask is answered with an empty catalogue.
     *
     * ⚠ AND IT FIRES ONCE, NOT REACTIVELY. A student who picks a different course, or clears the
     * selection, would otherwise have this put the first one straight back and the control would
     * appear broken. Signing in goes through `resetCatalog()`, whose new answer re-runs this while
     * the latch is still open, because an empty catalogue never closed it.
     *
     * ⚠ PICKING A COURSE STILL PICKS AN ASSISTANT — see `draftFor`, which resolves the course's
     * default. One decision, not two, which is the part that was actually worth automating.
     *
     * ⚠ AND A REQUEST FROM THE SIDEBAR OUTRANKS ALL OF THAT — see `course-intent.ts`. The "+" on a
     * course row means "start a session in THIS course", which is a decision the student has just
     * made explicitly; folding it into this one effect rather than adding a second one is what
     * guarantees the two cannot both write a draft in the same frame.
     */
    let autoSelected = false
    createEffect(() => {
      if (!ready() || id()) return

      /**
       * ⚠ `claim`, NOT `pending`. The request belongs to one new session — see `course-intent.ts`.
       * Asking with this route's key is what lets both providers on this draft get the same answer
       * while a LATER draft, reached by abandoning this one, retires the request instead of
       * inheriting it.
       */
      const requested = CourseIntent.claim(courseIntentRouteKey(layout.route()))
      if (!requested) {
        if (autoSelected || store.draft) return
        const first = enrolledCourses().find((course) => canStartSession(course.id))
        if (!first) return
        /**
         * ⚠ THE LATCH CLOSES ONLY IF THE DRAFT WAS ACTUALLY BUILT. `draftFor` returns nothing when
         * the course resolves but its default assistant does not — rare, but setting the latch
         * first would make that a permanent refusal to pre-select on a course `canStartSession`
         * just called startable.
         */
        const draft = draftFor(first.id)
        if (!draft) return
        autoSelected = true
        setStore("draft", draft)
        return
      }

      /**
       * ⚠ THE REQUEST IS NOT CLEARED HERE, AND THAT IS THE WHOLE FIX — see `course-intent.ts`. Two
       * `CourseSessionProvider` instances are mounted on this route and both reach this line;
       * clearing as we read gave the request to the outer one and sent the inner one, which is the
       * one the screen reads, into the default branch above. Both now apply the same course —
       * `claim` answers per route, so a second reader on the same draft is not a second consumer.
       *
       * ⚠ AN UNSTARTABLE OR UNRESOLVABLE COURSE IS CLEARED, THOUGH, so a request the product
       * cannot honour does not sit there waiting to fire at whatever mounts next.
       *
       * ⚠ THIS BRANCH DELIBERATELY IGNORES `store.draft` AND THE LATCH. A student already sitting
       * on the draft screen with CS 310 pre-selected, who clicks the "+" on CS 240, means CS 240;
       * respecting either guard here would silently keep the default and the button would look
       * broken.
       */
      if (!canStartSession(requested)) {
        CourseIntent.clear()
        return
      }
      const draft = draftFor(requested)
      if (!draft) {
        CourseIntent.clear()
        return
      }
      autoSelected = true
      setStore("draft", draft)
    })

    /**
     * PUBLISH WHAT THE ASSISTANT DECIDES ABOUT MODELS so the models context can narrow its list and
     * the selection chain can honour the professor's default. See `model-grant.ts` for why this
     * crosses a module signal rather than a context.
     */
    createEffect(() => {
      const current = assistant()
      ModelGrant.set({
        allowed: current?.allowedModelIds ?? [],
        preferred: current?.modelId,
        bound: !!current,
      })
    })

    return {
      current,
      course,
      assistant,
      /** True once a session exists, which is what makes the binding unchangeable. */
      locked: createMemo(() => !!id()),
      /** The session on screen, or undefined on the new-session screen. */
      sessionID: id,

      draft: {
        get value() {
          return store.draft
        },
        /**
         * ⚠ CHANGING THE COURSE RESETS THE ASSISTANT RATHER THAN KEEPING IT. An assistant belongs to
         * exactly one course, so carrying a selection across would leave a binding naming an
         * assistant the new course has never heard of.
         */
        setCourse(courseId: string) {
          /**
           * ⚠ A HAND-PICKED COURSE OVERRULES A PENDING "+" REQUEST. Without this, a student who
           * clicked the "+" on CS 310 and then changed their mind in the picker would have the
           * request re-apply CS 310 the next time the effect ran.
           */
          CourseIntent.clear()
          setStore("draft", draftFor(courseId))
        },
        setAssistant(assistantId: string) {
          const courseId = store.draft?.courseId ?? assistantById(assistantId)?.courseId
          if (!courseId) return
          setStore("draft", draftFor(courseId, assistantId))
        },
        clear() {
          CourseIntent.clear()
          setStore("draft", undefined)
        },
      },

      /**
       * CARRY THE DRAFT ONTO THE SESSION THAT WAS JUST CREATED. Called from the submit path
       * alongside `local.session.promote`, which does exactly this for agent/model/variant.
       *
       * ⚠ IT NO LONGER WRITES THE BINDING ANYWHERE — `submit.ts` sends it as part of `session.create`
       * so that the session never exists unbound. All this does is cover the frame between that
       * call and the new session arriving over sync.
       */
      promote(_dir: string, session: string, binding?: CourseBinding) {
        const next = binding ?? store.draft
        if (!next) return
        handoff.set(session, { ...next })
        setStore("draft", undefined)
        /**
         * ⚠ THE "+" REQUEST IS ANSWERED HERE, WHICH IS THE ONLY MOMENT IT CAN BE. It has to outlive
         * the two providers that read it — that is why it is not consumed on read — so the thing
         * that ends it is the session existing. Leaving it set would re-apply that course to the
         * next new session the student opened from anywhere.
         */
        CourseIntent.clear()
      },
    }
  },
})
