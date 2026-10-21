import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { type Accessor, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptInputState } from "@/components/prompt-input"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { todoDockCollapsedHeight } from "./session-todo-dock"
import type { SessionComposerController } from "./session-composer-state"

export type SessionComposerFollowupDock = {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}

export type SessionComposerRevertDock = {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}

export function createSessionComposerRegionController(input: {
  state: SessionComposerController
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  prompt: PromptInputState
  ready: Accessor<boolean>
  centered: Accessor<boolean>
  todo: {
    collapsed: Accessor<boolean>
    onToggle: () => void
  }
  followup: Accessor<SessionComposerFollowupDock | undefined>
  revert: Accessor<SessionComposerRevertDock | undefined>
  onResponseSubmit: () => void
  openParent: () => void
  setPromptRef: (el: HTMLDivElement) => void
  setDockRef: (el: HTMLDivElement) => void
}) {
  const sync = useSync()
  const [store, setStore] = createStore({
    ready: input.ready() || input.state.dock(),
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    timer = undefined
    frame = undefined
  }

  createEffect(() => {
    input.sessionKey()
    const ready = input.ready()
    const dock = input.state.dock()

    clear()
    if (store.ready || (!ready && !dock)) return
    if (dock) {
      setStore("ready", true)
      return
    }

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, 140)
    })
  })

  createEffect(() => {
    if (!input.prompt.ready()) return
    setSessionHandoff(input.sessionKey(), {
      prompt: input.prompt
        .current()
        .map((part) => {
          if (part.type === "file") return `[file:${part.path}]`
          if (part.type === "agent") return `@${part.name}`
          if (part.type === "image") return `[image:${part.filename}]`
          return part.content
        })
        .join("")
        .trim(),
    })
  })

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(el, update)
    update()
  })

  onCleanup(clear)

  const parentID = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.get(id)?.parentID : undefined
  })
  const open = createMemo(() => store.ready && input.state.dock() && !input.state.closing())
  const progress = useSpring(
    () => (open() ? 1 : 0),
    { visualDuration: 0.3, bounce: 0 },
    () => `${input.sessionKey()}\0${store.ready}`,
  )
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const ready = Promise.resolve()
  const [promptReady] = createResource(
    () => input.prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return {
    state: input.state,
    centered: input.centered,
    todo: input.todo,
    followup: input.followup,
    revert: input.revert,
    onResponseSubmit: input.onResponseSubmit,
    openParent: input.openParent,
    setPromptRef: input.setPromptRef,
    setDockRef: input.setDockRef,
    parentID,
    child: () => !!parentID(),
    showComposer: () => !input.state.blocked() || !!parentID(),
    handoffPrompt: () => getSessionHandoff(input.sessionKey())?.prompt,
    promptReady: () => input.prompt.ready() || promptReady(),
    dock: () => (store.ready && input.state.dock()) || value() > 0.001,
    dockProgress: value,
    dockHeight: () => Math.max(todoDockCollapsedHeight, store.height),
    /**
     * ⚠ A GAP, NOT A TUCK — THIS USED TO BE A NEGATIVE `lift`. The composer was pulled up 36px over
     * the dock's bottom so the dock read as a tray sliding behind the box. `SessionCourseBar` now
     * sits at the top of the pulled-up element and is transparent, so the lift stopped hiding
     * anything and started dragging the breadcrumb over the todo rows (JOLLI-2572).
     *
     * ⚠ AND IT CANNOT BE FIXED BY LIFTING FURTHER, which is the obvious reading and the wrong one.
     * The breadcrumb plus its `gap-3` is 40px, so the box already clears the dock by 4px; putting
     * the box back over the dock means lifting 76px, which lands the breadcrumb INSIDE the dock, on
     * real rows rather than on the strip that was reserved for this. The tray is not recoverable
     * with something opaque-less in the middle, so the dock is its own card now.
     *
     * ⚠ SCALED BY THE SPRING so the space opens with the dock instead of appearing under a dock
     * that is still at zero height. 8px is this file's existing dock-to-next spacing — see `pb-2`
     * on the revert dock in the loading branch of `session-composer-region.tsx`.
     */
    dockGap: () => 8 * value(),
    setDockBodyRef: (el: HTMLDivElement) => setStore("body", el),
  }
}

export type SessionComposerRegionController = ReturnType<typeof createSessionComposerRegionController>
