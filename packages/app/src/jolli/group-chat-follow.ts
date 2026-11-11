/**
 * How an open chat page keeps its chat read and its live updates followed when either does not get
 * through. A read that did not reach the server proves nothing about the chat, yet sending waits for one
 * that does; a chat whose live updates could not be followed shows nothing new until it is read again.
 * So the read is asked again on its own, sooner at first, and the watch with it when the watch failed,
 * rather than only on a reconnect or focus.
 *
 * The wait starts over only once both got through, and a watch still on its way leaves it as it is, so a
 * watch that keeps failing backs off even while reads succeed. A reader who is signed out has no page to
 * follow: a lost sign-in drops every group chat the window holds.
 */
export function createGroupChatFollow(input: { read: () => void; watch: () => void }) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = 0
  let reached = false
  let watching: "idle" | "pending" | "ok" | "failed" = "idle"
  let stopped = false
  const next = () => {
    if (stopped) return
    if (reached && watching === "pending") return
    clearTimeout(timer)
    if (reached && watching !== "failed") {
      delay = 0
      return
    }
    delay = Math.min(delay * 2 || 2_000, 60_000)
    timer = setTimeout(() => {
      // A hidden page is read again when it is shown.
      if (stopped || document.visibilityState === "hidden") return
      if (watching === "failed") input.watch()
      input.read()
    }, delay)
  }
  return {
    /**
     * A read of the chat answered. `reached` when the server said something about the chat: not when
     * it could not be reached, nor an offline copy, nor a refusal that turns the request away for now.
     */
    read(answer: { reached: boolean }) {
      reached = answer.reached
      next()
    },
    /** A watch request went out. */
    watching() {
      watching = "pending"
    },
    /** A watch request was answered; `ok` when the chat is followed. */
    watched(answer: { ok: boolean }) {
      watching = answer.ok ? "ok" : "failed"
      next()
    },
    /** Asks nothing more until {@link reset}: the page dropped the chat. */
    stop() {
      stopped = true
      clearTimeout(timer)
    },
    /** Starts over, for another chat or another connection to the server. */
    reset() {
      clearTimeout(timer)
      delay = 0
      reached = false
      watching = "idle"
      stopped = false
    },
  }
}
