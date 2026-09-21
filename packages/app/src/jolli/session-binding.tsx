/**
 * WHICH COURSE AND WHICH ASSISTANT THE SESSION ON SCREEN BELONGS TO.
 *
 * This is the route-aware view of `@opencode-ai/core/jolli/binding`: that module reads a binding off
 * any session, and this context answers "the one in force right now" plus the small number of
 * things a student may still decide about it.
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
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import {
  assistantById,
  canStartSession,
  catalogGeneration,
  courseById,
  defaultAssistantFor,
  ensureCatalog,
  enrolledCourses,
  ready,
} from "./catalog"
import { ModelGrant } from "./model-grant"
import { useSync } from "@/context/sync"
import { courseBindingOf, type CourseBinding } from "@opencode-ai/core/jolli/binding"
import { defaultSessionSharing, mayMakePrivate } from "@opencode-ai/core/jolli/sharing"
import type { Assistant, Catalog, Course, SessionSharing } from "./types"

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
 * renderer — one entry per session created and per visibility toggle — and each stale entry is a
 * binding that would be preferred over nothing if a session were ever read back unbound.
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

    /**
     * ⚠ THE CATALOGUE IS FETCHED HERE BECAUSE THIS IS THE CONTEXT THAT NEEDS IT, and `ensureCatalog`
     * makes the duplicate harmless — this provider mounts on both the new-session route and inside
     * the directory layout, so a bare fetch would run twice on every launch.
     */
    const serverSDK = useServerSDK()
    const sdk = useSDK()
    createEffect(() => {
      const server = serverSDK()
      /**
       * ⚠ THE GENERATION IS READ SO A RESET RE-RUNS THIS. The server's URL survives a sign-in —
       * the sidecar restarts on the same host and port — so it cannot be the only thing this
       * depends on, and `resetCatalog()` would otherwise clear the store with nothing left to
       * refill it.
       */
      void ensureCatalog(`${server.url}#${catalogGeneration()}`, () =>
        server.client.jolli.course().then((response) => response.data as Catalog),
      )
    })

    const [store, setStore] = createStore<{ draft?: CourseBinding }>({})

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
      const row = sync().data.session.find((item) => item.id === session)
      const bound = courseBindingOf(row)
      if (bound) {
        forgetHandoff(session)
        return bound
      }
      return handoff.get(session)
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
      /**
       * ⚠ VISIBILITY IS THE ONE PART OF A BINDING A LIVE SESSION MAY STILL CHANGE, so it is the one
       * write that goes back to the server after the session exists. The course and the assistant
       * do not: the server refuses to rewrite those once the conversation has started.
       */
      handoff.set(session, { ...existing, sharing })
      void sdk()
        .client.session.update({
          sessionID: session,
          directory: sdk().directory,
          metadata: { jolli: { ...existing, sharing } },
        })
        .catch(() => undefined)
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
     */
    let autoSelected = false
    createEffect(() => {
      if (autoSelected || !ready() || id() || store.draft) return
      const first = enrolledCourses().find((course) => canStartSession(course.id))
      if (!first) return
      /**
       * ⚠ THE LATCH CLOSES ONLY IF THE DRAFT WAS ACTUALLY BUILT. `draftFor` returns nothing when the
       * course resolves but its default assistant does not — rare, but setting the latch first would
       * make that a permanent refusal to pre-select on a course `canStartSession` just called
       * startable.
       */
      const draft = draftFor(first.id)
      if (!draft) return
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
      },
    }
  },
})
