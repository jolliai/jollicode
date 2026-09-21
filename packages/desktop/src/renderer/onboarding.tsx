import { resetJolliCatalog, ServerConnection, useServer, useSettings, useTabs } from "@opencode-ai/app"
import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { createSignal, onMount, Show } from "solid-js"
import { t } from "./i18n"
import type { CourseGateResult } from "../preload/types"

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
  const [serverUnavailable, setServerUnavailable] = createSignal(false)
  /**
   * ⚠ THE GATE IS A THIRD OUTCOME OF SIGNING IN, NOT A SECOND SCREEN AFTER IT. A student with no
   * Jolli Code course is signed in and still has nowhere to go, so neither letting them through nor
   * sending them back to the browser is right. `undefined` means not asked yet.
   */
  const [courses, setCourses] = createSignal<CourseGateResult["kind"] | undefined>(undefined)
  const [checking, setChecking] = createSignal(false)
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
    /**
     * ⚠ AN ALREADY-SIGNED-IN LAUNCH STILL HAS TO ASK. Enrolment changes between runs — a student
     * added to a course overnight, or removed from their last one — and this path has no sign-in
     * result to read it off.
     */
    const gate = await window.api.jolliCourseGate().catch(() => ({ kind: "unreachable" }) as CourseGateResult)
    if (gate.kind !== "ok") {
      setCourses(gate.kind)
      setNeedsSignIn(true)
      return
    }
    await finish()
  }

  async function signIn() {
    setSigningIn(true)
    setError(undefined)
    try {
      /**
       * ⚠ SIGNED IN BUT SERVERLESS IS ITS OWN OUTCOME, AND IT IS NEITHER OF THE OTHER TWO. The
       * credential is stored by the time this resolves, so phrasing it as a failed sign-in would
       * send the student back through the browser to fix something the browser has no part in;
       * falling through to `finish()` would drop this gate and hand them an app whose every request
       * fails against a sidecar that never came back. Restarting the app is what actually fixes it.
       */
      const result = await window.api.jolliSignIn()
      if (!result.serverReady) {
        setServerUnavailable(true)
        return
      }
      if (result.courses !== "ok") {
        setCourses(result.courses)
        return
      }
      /**
       * ⚠ THE COURSE CATALOGUE HAS TO BE THROWN AWAY HERE, AND IT IS EASY TO MISS WHY. The app
       * mounts before sign-in — `AppInterface` renders its children without waiting on this
       * screen — so the catalogue was already fetched once, with no credential, and answered
       * empty. Signing in restarts the sidecar on the same host and port, so nothing downstream
       * can tell that the answer is now different; without this the student reaches an empty
       * course picker and only a restart fixes it.
       */
      resetJolliCatalog()
      setNeedsSignIn(false)
      await finish()
    } catch (cause) {
      // The main process already phrases these for a person; showing the raw object would not help.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSigningIn(false)
    }
  }

  /**
   * ⚠ THE WAY OUT OF THE GATE, AND IT IS NOT OPTIONAL. A student who gets themselves added to a
   * course would otherwise have to kill the app to be let in — the check only runs at launch and at
   * sign-in, and they have just done both.
   */
  async function recheck() {
    setChecking(true)
    try {
      const gate = await window.api.jolliCourseGate().catch(() => ({ kind: "unreachable" }) as CourseGateResult)
      if (gate.kind !== "ok") {
        setCourses(gate.kind)
        return
      }
      setCourses(undefined)
      resetJolliCatalog()
      setNeedsSignIn(false)
      await finish()
    } finally {
      setChecking(false)
    }
  }

  /** The other way out: the wrong account is a real reason to be looking at an empty course list. */
  async function useAnotherAccount() {
    setCourses(undefined)
    await window.api.jolliSignOut().catch(() => undefined)
    await signIn()
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
          <h1 class="text-lg font-medium text-text-strong">
            {courses() === "none"
              ? t("desktop.jolli.courseGate.noCourses.title")
              : courses() === "unreachable"
                ? t("desktop.jolli.courseGate.unreachable.title")
                : t("desktop.jolli.signIn.title")}
          </h1>
          <p class="max-w-sm text-sm text-text-base">
            {courses() === "none"
              ? t("desktop.jolli.courseGate.noCourses.body")
              : courses() === "unreachable"
                ? t("desktop.jolli.courseGate.unreachable.body")
                : t("desktop.jolli.signIn.body")}
          </p>
        </div>
        {/*
          ⚠ THE GATE IS CHECKED BEFORE THE SERVER BRANCH, BECAUSE IT IS THE MORE ACTIONABLE OF THE
          TWO. Both can be true at once — no courses AND a sidecar that did not come back — and
          telling a student to restart an app they have no reason to open is the worse of the two
          messages to lead with.
        */}
        <Show
          when={!courses()}
          fallback={
            <div class="flex flex-col items-center gap-3">
              <Button variant="primary" disabled={checking()} onClick={() => void recheck()}>
                {t("desktop.jolli.courseGate.retry")}
              </Button>
              <Button
                variant="ghost"
                size="small"
                disabled={checking() || signingIn()}
                onClick={() => void useAnotherAccount()}
              >
                {t("desktop.jolli.courseGate.switchAccount")}
              </Button>
            </div>
          }
        >
          <Show
            when={!serverUnavailable()}
            fallback={
              <>
                <p class="max-w-sm text-center text-sm text-error">{t("desktop.jolli.signIn.serverUnavailable")}</p>
                <Button variant="primary" onClick={() => window.api.relaunch()}>
                  {t("desktop.menu.restart")}
                </Button>
              </>
            }
          >
            <Button variant="primary" disabled={signingIn()} onClick={() => void signIn()}>
              {signingIn() ? t("desktop.jolli.signIn.waiting") : t("desktop.jolli.signIn.action")}
            </Button>
            <Show when={signingIn()}>
              <p class="text-xs text-text-weak">{t("desktop.jolli.signIn.hint")}</p>
            </Show>
          </Show>
        </Show>
        <Show when={error()}>{(message) => <p class="max-w-sm text-center text-xs text-error">{message()}</p>}</Show>
      </div>
    </Show>
  )
}
