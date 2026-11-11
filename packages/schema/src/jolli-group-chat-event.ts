export * as JolliGroupChatEvent from "./jolli-group-chat-event"
import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"
const Changed = define({ type: "jolli.groupChat.changed", schema: { chatID: Schema.String.pipe(optional) } })
const Revoked = define({ type: "jolli.groupChat.revoked", schema: { chatID: Schema.String } })
const Answer = define({
  type: "jolli.groupChat.answer",
  schema: {
    chatID: Schema.String,
    type: Schema.String,
    content: Schema.String.pipe(optional),
    seq: Schema.Int.pipe(optional),
    frameSeq: Schema.Int.pipe(optional),
    reset: Schema.Boolean.pipe(optional),
    truncated: Schema.Boolean.pipe(optional),
  },
})
const Mention = define({ type: "jolli.groupChat.mention", schema: { chatID: Schema.String } })
const ListChanged = define({ type: "jolli.groupChat.listChanged", schema: { chatID: Schema.String.pipe(optional) } })
/**
 * The credential went away (a sign-out, one that could not be renewed, one another process removed), another
 * account signed in, or the sidecar cannot tell whose group chats are on screen: drop them all. With
 * `sameAccount` the same person signed in again over a credential the sidecar was following: everything stays,
 * and only the streams restart, so lists and open chats read and watch again.
 */
const Reset = define({ type: "jolli.groupChat.reset", schema: { sameAccount: Schema.Boolean.pipe(optional) } })
export const Event = {
  Changed,
  Revoked,
  Answer,
  Mention,
  ListChanged,
  Reset,
  Definitions: inventory(Changed, Revoked, Answer, Mention, ListChanged, Reset),
}
