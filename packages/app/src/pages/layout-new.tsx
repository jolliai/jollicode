import { createEffect, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { AppSidebar } from "@/components/app-sidebar/app-sidebar"
import { SessionTabsSync } from "@/components/app-sidebar/session-tabs-sync"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"

/**
 * ⚠ THE DEV CHROME IS OPT-IN IN THIS FORK, WHERE UPSTREAM HAS IT ON BY DEFAULT. The `DEV` badge and
 * the performance bar are the first two things a reader sees in a screenshot, and this build exists
 * to be shown to people who do not know what CLS or JANK are.
 *
 * ⚠ A FLAG RATHER THAN A DELETION, because the bar is genuinely useful while building. Set
 * `VITE_JOLLI_DEBUG=1` in the environment to get both back:
 *
 *   VITE_JOLLI_DEBUG=1 bun run dev:desktop
 *
 * It is still gated behind `import.meta.env.DEV` as well, so a packaged build can never show it
 * however the flag is set.
 */
const DEBUG_CHROME = import.meta.env.DEV && import.meta.env.VITE_JOLLI_DEBUG === "1"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          DEBUG_CHROME
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      {/*
       * ⚠ A ROW BETWEEN THE TITLEBAR AND THE DEBUG BAR, AND `<main>`'s OWN CLASSES DO NOT CHANGE.
       * `home.tsx` stretches itself with `self-stretch` and `session.tsx` with `size-full`, both
       * measured against the `items-start` and `contain-strict` that are already on this element;
       * rewriting them to suit the new axis would break both pages.
       *
       * ⚠ `contain-strict` IS `contain: size layout style paint`, so size containment makes
       * `<main>` contribute nothing intrinsic. In a row that means `flex-1` (for the `flex-basis:
       * 0%` it implies) and `min-w-0` are load-bearing rather than decorative: drop either and a
       * non-shrinking sidebar produces horizontal overflow instead of a narrower main pane.
       *
       * ⚠ THE SAFE-AREA INSETS ARE ON THE CHILDREN, NOT ON THE CONTAINER ABOVE. The titlebar is
       * that container's sibling and computes its own left padding for the macOS traffic lights and
       * its own width for the Windows caption buttons, both against the window edge.
       */}
      <div class="flex min-h-0 min-w-0 flex-1 flex-row">
        <AppSidebar />
        <main
          class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict"
          style={{ "padding-inline-end": "env(safe-area-inset-right, 0px)" }}
        >
          <Suspense>{props.children}</Suspense>
        </main>
      </div>
      {DEBUG_CHROME && state.debugTools && <DebugBar inline />}
      {/*
       * ⚠ RENDERS NOTHING, AND MUST NOT BE REMOVED. It carries the two behaviours that used to live
       * inside the titlebar's tab strip and have nothing to do with drawing tabs: keeping
       * `recentKey` current so `mod+w` lands somewhere sensible, and the only listener for the
       * archive event — without which archiving the session you are reading leaves you on a dead
       * route. See the file for the full argument.
       */}
      <SessionTabsSync />
      <ToastRegion v2 />
    </div>
  )
}
