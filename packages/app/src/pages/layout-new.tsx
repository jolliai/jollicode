import { createEffect, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
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
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {DEBUG_CHROME && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
