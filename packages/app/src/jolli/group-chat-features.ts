import { Option, Schema } from "effect"
import { createStore, reconcile } from "solid-js/store"
import { Jolli } from "@opencode-ai/schema/jolli"

/**
 * A chat's optional features as the server offers them: dictation, read-aloud and the composer's state.
 * `generation` is the page's count of what it dropped: a read that left before a drop (the credential went
 * away, another person signed in, or the reader lost the chat) writes nothing when it answers. A read
 * answering that the credential is gone calls `signOut`, as every other read of the page does.
 */
export function createGroupChatFeatures(input: {
  read: () => Promise<Jolli.GroupChatAnswer>
  generation: () => number
  signOut: () => void
}) {
  const [capabilities, setCapabilities] = createStore<Jolli.GroupChatFeatures>({ input: false, readAloud: false })
  const [status, setStatus] = createStore({ loading: true, loaded: false })
  /** Counts reads, so one that a later read overtook does not end that read's loading. */
  let reads = 0
  const load = () => {
    const run = input.generation()
    const read = ++reads
    setStatus("loading", true)
    return input
      .read()
      .then((answer) => {
        if (run !== input.generation()) return
        if (answer.status === "signed-out") {
          input.signOut()
          return
        }
        if (answer.status !== "ok") return
        const features = Option.getOrUndefined(Schema.decodeUnknownOption(Jolli.GroupChatFeatures)(answer.resource))
        if (!features) return
        setCapabilities(reconcile(features))
        setStatus("loaded", true)
      })
      .catch(() => undefined)
      .finally(() => {
        if (read === reads) setStatus("loading", false)
      })
  }
  return { capabilities, status, load }
}
