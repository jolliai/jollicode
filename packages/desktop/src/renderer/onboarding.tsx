import { ServerConnection, useServer, useSettings, useTabs } from "@opencode-ai/app"
import { Splash } from "@opencode-ai/ui/logo"
import { createSignal, onMount, Show } from "solid-js"
import { t } from "./i18n"

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string; onLoaded: () => void }) {
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()

  /**
   * ⚠ THIS GATE RENDERS ABOVE THE STARTUP SPLASH, NOT INSTEAD OF IT. `AppInterface` keeps its own
   * `z-[9999]` overlay up for as long as `props.onLoaded` is unresolved, and renders this component
   * underneath it. Signing in has to be visible during exactly that window, so it sits one layer
   * higher and the splash waits behind it.
   */
  const [needsSignIn, setNeedsSignIn] = createSignal(false)
  const [signingIn, setSigningIn] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void start()
  })

  async function start() {
    const signedIn = await window.api.isJolliSignedIn().catch(() => false)
    if (!signedIn) {
      setNeedsSignIn(true)
      return
    }
    await finish()
  }

  async function signIn() {
    setSigningIn(true)
    setError(undefined)
    try {
      await window.api.jolliSignIn()
      setNeedsSignIn(false)
      await finish()
    } catch (cause) {
      // The main process already phrases these for a person; showing the raw object would not help.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSigningIn(false)
    }
  }

  async function finish() {
    await runFirstLaunchOnboarding()
    props.onLoaded()
  }

  async function runFirstLaunchOnboarding() {
    try {
      await Promise.all(
        [server.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map((p) => p ?? Promise.resolve()),
      )
      const existingInstall = await window.api.isOldLayoutEligible()
      settings.general.setOldLayoutEligible(existingInstall)
      settings.general.initializeAgentVisibility(existingInstall)
      if (!server.isLocal()) return

      const pending = await window.api.isFirstLaunchOnboardingPending()
      if (!pending) return

      const shouldTrigger =
        !existingInstall &&
        props.initialUrl === "/" &&
        tabs.store.length === 0 &&
        server.list.every(ServerConnection.builtin)

      console.info("[desktop-onboarding] first launch onboarding evaluated", {
        pending,
        shouldTrigger,
        existingInstall,
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        servers: server.list.map(ServerConnection.key),
      })

      const directory = await window.api.finishFirstLaunchOnboarding(shouldTrigger)
      if (!shouldTrigger || !directory) return

      console.info("[desktop-onboarding] starting first launch draft", { directory })
      server.projects.open(directory)
      server.projects.touch(directory)
      tabs.select(await tabs.newDraft({ server: server.key, directory }))
    } catch (error) {
      console.error("[desktop-onboarding] first launch onboarding failed", error)
    }
  }

  return (
    <Show when={needsSignIn()}>
      <div class="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-6 bg-background-base">
        <Splash class="w-16 h-20" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">{t("desktop.jolli.signIn.title")}</h1>
          <p class="max-w-sm text-sm text-text-base">{t("desktop.jolli.signIn.body")}</p>
        </div>
        <button
          type="button"
          class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-background-base disabled:opacity-60"
          disabled={signingIn()}
          onClick={() => void signIn()}
        >
          {signingIn() ? t("desktop.jolli.signIn.waiting") : t("desktop.jolli.signIn.action")}
        </button>
        <Show when={signingIn()}>
          <p class="text-xs text-text-weak">{t("desktop.jolli.signIn.hint")}</p>
        </Show>
        <Show when={error()}>
          {(message) => <p class="max-w-sm text-center text-xs text-error">{message()}</p>}
        </Show>
      </div>
    </Show>
  )
}
