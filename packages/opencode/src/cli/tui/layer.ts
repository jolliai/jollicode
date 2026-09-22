import { run as runTui, type TuiInput } from "@opencode-ai/tui"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect } from "effect"

// The TUI renders in this main process while the server runs in a worker that
// installs its own handlers. Cancelling in-flight requests during teardown can
// surface a benign AbortError with no reactive owner left to catch it; swallow
// only that and re-throw everything else so real failures surface as before.
const isAbortError = (error: unknown) =>
  (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"

process.on("unhandledRejection", (error) => {
  if (isAbortError(error)) return
  throw error
})
process.on("uncaughtException", (error) => {
  if (isAbortError(error)) return
  throw error
})

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
