/**
 * WHICH COURSE AND WHICH ASSISTANT THE SESSION ON SCREEN BELONGS TO.
 *
 * This is the route-aware view of `session-store.ts`: the store holds every binding, and this
 * context answers "the one in force right now" plus the small number of things a student may still
 * decide about it.
 *
 * ⚠ A PARALLEL CONTEXT RATHER THAN THREE MORE FIELDS ON `context/local.tsx`, AND THAT IS A FORK
 * DECISION RATHER THAN A DESIGN ONE. `local.tsx` is upstream's file and carries its own migration,
 * handoff and validation machinery; every line this fork adds there is a line that conflicts on the
 * next rebase. This module deliberately MIRRORS its shape — same draft/promote lifecycle, same
 * handoff across the frame where a session is created — so a reader who knows one knows the other,
 * while the diff against upstream stays at the call sites.
 *
 * ⚠ THE IMMUTABILITY IS UI-ONLY, AND SAYING SO IS THE POINT. Nothing here prevents a binding being
 * rewritten, because nothing here is the authority. What makes a session's course fixed is that no
 * screen renders a control to change it, exactly as project, location and branch are fixed today.
 * `Session.agent` is genuinely mutable server-side — the server overwrites it whenever a turn
 * arrives naming a different agent, and a `switchAgent` endpoint exists — so an assistant lock
 * enforced anywhere but the UI would be a lock this product does not actually have.
 */

import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { assistantById, courseById, defaultAssistantFor } from "./fixtures"
import { ModelGrant } from "./model-grant"
import { SessionCourses, type CourseBinding } from "./session-store"
import { defaultSessionSharing, mayMakePrivate } from "./sharing"
import type { Assistant, Course, SessionSharing } from "./types"

export type { CourseBinding }

/**
 * ⚠ THE SAME HANDOFF TRICK `local.tsx` USES, AND FOR THE SAME REASON. Creating a session navigates
 * to its route before the store write is visible to the new render, so the first frame of the new
 * session would find no binding and show no course. This carries it across that gap.
 */
const handoff = new Map<string, CourseBinding>()

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

    const [store, setStore] = createStore<{ draft?: CourseBinding }>({})

    /**
     * THE BINDING IN FORCE RIGHT NOW: the open session's, or the draft being composed.
     *
     * ⚠ THE ORDER MATTERS. With a session id the stored row is the authority and the handoff is the
     * fallback for the frame after creation. Without one we are on the new-session screen and the
     * draft is all there is.
     */
    const current = createMemo<CourseBinding | undefined>(() => {
      const session = id()
      if (!session) return store.draft
      return SessionCourses.get(session) ?? handoff.get(session)
    })

    const course = createMemo<Course | undefined>(() => courseById(current()?.courseId))
    const assistant = createMemo<Assistant | undefined>(() => assistantById(current()?.assistantId))
    const assistantList = () => (assistant() ? [assistant()!] : [])

    const draftFor = (courseId: string, assistantId?: string): CourseBinding | undefined => {
      const next = courseById(courseId)
      if (!next) return undefined
      const chosen = (assistantId ? assistantById(assistantId) : undefined) ?? defaultAssistantFor(courseId)
      if (!chosen) return undefined
      return {
        courseId,
        assistantId: chosen.id,
        sharing: defaultSessionSharing(next, [chosen]),
      }
    }

    /**
     * CHANGE WHO CAN READ THIS, WHEREVER IT LIVES. The draft before a session exists, the store
     * after — one function so the two setters below cannot disagree about which is which.
     */
    const write = (next: (sharing: SessionSharing) => SessionSharing) => {
      const existing = current()
      if (!existing) return
      const sharing = next(existing.sharing)
      const session = id()
      if (!session) {
        setStore("draft", "sharing", sharing)
        return
      }
      SessionCourses.set(session, { ...existing, sharing })
    }

    /**
     * ⚠ NOTHING IS PRE-SELECTED, AND AN EARLIER VERSION SEEDED THE FIRST STARTABLE COURSE. Pre-filling
     * looked helpful and was the wrong default for a decision this size: a course decides who may
     * answer, on which models, and who may read the result, so a student who never touched the
     * control has had all three chosen for them by array order. The project and model selectors
     * beside it are pre-filled because being wrong about those costs a click.
     *
     * ⚠ PICKING A COURSE STILL PICKS AN ASSISTANT — see `draftFor`, which resolves the course's
     * default. One decision, not two, which is the part that was actually worth automating.
     */

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
      /** Whether the student may take this session private, per the course's policy. */
      mayMakePrivate: createMemo(() => mayMakePrivate(course(), assistantList())),

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
          setStore("draft", draftFor(courseId))
        },
        setAssistant(assistantId: string) {
          const courseId = store.draft?.courseId ?? assistantById(assistantId)?.courseId
          if (!courseId) return
          setStore("draft", draftFor(courseId, assistantId))
        },
        clear() {
          setStore("draft", undefined)
        },
      },

      /**
       * WHAT A STUDENT MAY STILL DECIDE ABOUT VISIBILITY.
       *
       * ⚠ WRITABLE ON A LIVE SESSION, UNLIKE COURSE AND ASSISTANT, because it is the one thing here
       * that is genuinely theirs. The course decides where a session STARTS; who reads it from then
       * on is the student's, except that a `staff-required` course keeps staff on it.
       *
       * ⚠ TWO SWITCHES RATHER THAN ONE SETTING, because they are two unrelated grants. Handing a
       * session to a professor and handing it to a study group are different acts with different
       * consequences, and a student doing one has said nothing about the other.
       */
      setStaffShared(on: boolean) {
        // The refusal the control also renders. A menu is not a permission check.
        if (!on && !mayMakePrivate(course(), assistantList())) return
        write((sharing) => ({ ...sharing, staff: on }))
      },
      setEveryone(on: boolean) {
        write((sharing) => ({ ...sharing, everyone: on }))
      },
      /**
       * BACK TO NOBODY BUT THE STUDENT, IN ONE ACT.
       *
       * ⚠ PRIVATE IS THE ABSENCE OF BOTH GRANTS AND IT STILL NEEDS ITS OWN CONTROL. The first cut
       * left it implicit — turn both switches off and the session is private — which is true and is
       * not the same as being told. A student deciding how candid to be is looking for the word
       * "private", and a menu that only offers ways to SHARE reads as a product with no private
       * mode. It is also two clicks to undo what one click did.
       *
       * ⚠ AND IT REFUSES UNDER A COURSE THAT REQUIRES SHARING, like the staff switch it clears.
       */
      setPrivate() {
        if (!mayMakePrivate(course(), assistantList())) return
        write(() => ({ staff: false, everyone: false }))
      },

      /**
       * CARRY THE DRAFT ONTO THE SESSION THAT WAS JUST CREATED. Called from the submit path
       * alongside `local.session.promote`, which does exactly this for agent/model/variant.
       */
      promote(_dir: string, session: string, binding?: CourseBinding) {
        const next = binding ?? store.draft
        if (!next) return
        handoff.set(session, { ...next })
        SessionCourses.set(session, next)
        setStore("draft", undefined)
      },
    }
  },
})
