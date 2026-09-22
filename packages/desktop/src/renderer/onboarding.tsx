import { resetJolliCatalog, ServerConnection, useServer, useSettings, useTabs } from "@opencode-ai/app"
import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { createEffect, createSignal, on, onMount, Show } from "solid-js"
import { shouldOpenDefaultProject } from "./first-launch"
import { t } from "./i18n"
import type { CourseGateResult } from "../preload/types"

/**
 * RAISE THE SIGN-IN GATE AGAIN, FROM OUTSIDE THE COMPONENT THAT OWNS IT.
 *
 * ⚠ SIGNING OUT FROM INSIDE THE APP NEEDS THIS, AND NOTHING ELSE WOULD DO. The gate runs `onMount`
 * only, so after a sign-out the app would otherwise stay alive with an empty catalogue, a send
 * button held disabled by `submitDisabled={!course()}`, and no route back to signing in. Relaunching
 * the process would also work and is heavier for no gain.
 *
 * ⚠ A COUNTER, NOT A BOOLEAN, so a second sign-out in the same session fires it again.
 *
 * ⚠ AND IT IS SAFE TO RE-ENTER. The gate is `fixed inset-0 z-[10000]` and is already documented as
 * rendering above a mounted app; `props.onLoaded` resolves a `Promise.withResolvers`, so calling it
 * twice is free; and the sign-out-then-sign-in sequence is exactly what `useAnotherAccount` below
 * has always done.
 */
const [reopenCount, setReopenCount] = createSignal(0)

export function reopenJolliSignIn() {
  setReopenCount((value) => value + 1)
}

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
  /**
   * WHICH SIGN-IN ATTEMPT THE SCREEN IS CURRENTLY SHOWING.
   *
   * ⚠ IT EXISTS BECAUSE AN ATTEMPT CANNOT BE ABORTED, ONLY ABANDONED — see `cancelSignIn`. Every
   * write in `signIn` is gated on still being the current attempt, so a promise that settles after
   * the student cancelled cannot write over the screen they are looking at now.
   */
  const [attempt, setAttempt] = createSignal(0)
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

  /**
   * ⚠ `defer` SO THIS DOES NOT DOUBLE UP WITH `onMount`. Without it the effect would run once on
   * creation and race `start()` on every launch.
   */
  createEffect(
    on(
      reopenCount,
      () => {
        setCourses(undefined)
        setError(undefined)
        setServerUnavailable(false)
        setSigningIn(false)
        setNeedsSignIn(true)
      },
      { defer: true },
    ),
  )

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

  /**
   * CALL OFF A SIGN-IN THAT IS WAITING ON A BROWSER TAB THE STUDENT HAS GIVEN UP ON.
   *
   * ⚠ IT REALLY ENDS THE ATTEMPT: `jolliSignInCancel` closes the loopback callback server in the
   * main process, so the code can no longer be redeemed and the port is freed immediately rather
   * than after the five-minute timeout in `core/jolli/loopback.ts`.
   *
   * ⚠ THE COUNTER IS STILL NEEDED, AND THAT IS NOT BELT-AND-BRACES. Cancelling makes the in-flight
   * `jolliSignIn()` invoke REJECT, and that rejection lands in this component's `catch` — which
   * would put "Sign-in was cancelled" on a screen the student cancelled to get away from. There is
   * also a genuine race: the browser may have completed a millisecond before the click, in which
   * case the promise resolves with real credentials. Gating every write on still being the current
   * attempt is what makes both outcomes silent.
   *
   * ⚠ AND IT DOES NOT AWAIT THE IPC BEFORE CLEARING THE UI. The button should stop saying "waiting"
   * on click, not one round-trip later; the teardown has nothing the screen needs to hear back.
   */
  async function cancelSignIn() {
    setAttempt((value) => value + 1)
    setSigningIn(false)
    setError(undefined)
    await window.api.jolliSignInCancel().catch(() => undefined)
  }

  async function signIn() {
    const run = attempt()
    /** True while this call is still the attempt the screen is showing. */
    const current = () => attempt() === run
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
      /**
       * ⚠ A CANCELLED ATTEMPT MAY STILL SUCCEED, AND MUST NOT BE ACTED ON. The credential it stored
       * is real and the next launch will use it, but the student has moved on from this screen —
       * dropping the gate out from under them because a tab they abandoned finished would be worse
       * than making them click Sign in again.
       */
      if (!current()) return
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
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // ⚠ GUARDED TOO: a stale attempt clearing this would cancel a newer one's waiting state.
      if (current()) setSigningIn(false)
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

      const projects = server.projects.list()
      const shouldTrigger = shouldOpenDefaultProject({
        hasProjects: projects.length > 0,
        initialUrl: props.initialUrl,
        openTabs: tabs.store.length,
      })

      console.info("[desktop-onboarding] first launch onboarding evaluated", {
        pending,
        shouldTrigger,
        existingInstall,
        projects: projects.length,
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        servers: server.list.map(ServerConnection.key),
      })

      /**
       * ⚠ THE ONE-SHOT FLAG IS SPENT ONLY WHEN SOMETHING IS ACTUALLY CREATED. It used to be marked
       * complete on the way past either branch, which is what made every wrong answer permanent:
       * the WSL misjudgement this file already documents, a launch that restored a route, a window
       * that happened to have a tab open. None of those say the student will never need a default
       * project — they say not on THIS launch — so the question is left open for the next one.
       */
      if (!shouldTrigger) return

      const directory = await window.api.finishFirstLaunchOnboarding(true)
      if (!directory) return

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
              {/*
               * ⚠ THE WAY OUT OF A SIGN-IN THAT WILL NEVER FINISH. Closing the browser tab sends no
               * signal — the loopback server simply never receives its callback — so the attempt is
               * held open by a five-minute timeout in `core/jolli/loopback.ts` and nothing shorter.
               * Without this button a student who closed the tab by accident sat on a disabled
               * button for five minutes, because re-clicking is blocked by `signingIn()`.
               *
               * ⚠ IT REALLY TEARS THE ATTEMPT DOWN, rather than only looking away from it. The
               * loopback server is closed and the pending promise rejected in the main process —
               * see `jolli-auth.ts` — so a cancelled sign-in cannot come back and store a
               * credential for a student who has given up on it, and the port is freed at once
               * instead of five minutes later.
               */}
              <Button variant="ghost" size="small" onClick={() => void cancelSignIn()}>
                {t("desktop.jolli.signIn.cancel")}
              </Button>
            </Show>
          </Show>
        </Show>
        <Show when={error()}>{(message) => <p class="max-w-sm text-center text-xs text-error">{message()}</p>}</Show>
      </div>
    </Show>
  )
}
