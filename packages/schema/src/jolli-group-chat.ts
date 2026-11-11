import { Schema } from "effect"
import { optional } from "./schema"

export const GroupChatID = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9_-]{1,200}$/),
)
  .pipe(Schema.brand("Jolli.GroupChatID"))
  .annotate({ identifier: "Jolli.GroupChatID" })
export type GroupChatID = typeof GroupChatID.Type

export const ChatPerson = Schema.Struct({
  userId: Schema.Int,
  name: Schema.String,
  picture: Schema.String.pipe(optional),
  /** "staff" or "student" today; other values are kept rather than failing the whole read. */
  role: Schema.NullOr(Schema.String).pipe(optional),
  creator: Schema.Boolean.pipe(optional),
})
export type ChatPerson = typeof ChatPerson.Type
export const ChatAlias = Schema.Struct({ alias: Schema.String, userId: Schema.Int })
export const ChatAssistant = Schema.Struct({ id: Schema.Int, name: Schema.String })
export const ChatTurn = Schema.Struct({
  turnId: Schema.Int,
  mode: Schema.String,
  assistantId: Schema.NullOr(Schema.Int),
  askerId: Schema.Int,
  triggerSeq: Schema.NullOr(Schema.Int),
})
export const GroupChatInfo = Schema.Struct({
  assignmentGroupId: Schema.Int.pipe(optional),
  ownerId: Schema.Int.pipe(optional),
  participants: Schema.Array(ChatPerson),
  formerPeople: Schema.Array(ChatPerson),
  aliases: Schema.Array(ChatAlias),
  mentionable: Schema.Array(ChatAssistant).pipe(optional),
  turns: Schema.Array(ChatTurn).pipe(optional),
  composerTargetAssistantId: Schema.NullOr(Schema.Int).pipe(optional),
  lastReadSeq: Schema.NullOr(Schema.Int).pipe(optional),
})
export type GroupChatInfo = typeof GroupChatInfo.Type
export const ChatMessage = Schema.Struct({
  kind: Schema.Literal("message"),
  id: Schema.Int,
  seq: Schema.Int,
  turnId: Schema.Int,
  role: Schema.String,
  content: Schema.String,
  authorId: Schema.Int.pipe(optional),
  payload: Schema.NullOr(Schema.Json).pipe(optional),
  timestamp: Schema.String,
  incomplete: Schema.Boolean.pipe(optional),
})
export type ChatMessage = typeof ChatMessage.Type
export const Reference = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("material"), materialId: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literal("assignment"),
    courseId: Schema.Int,
    assignmentId: Schema.Int,
    staffView: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("artifact"), artifactId: Schema.String, version: Schema.Int.pipe(optional) }),
  Schema.Struct({ kind: Schema.Literal("attachment"), attachmentId: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literal("assignmentFile"),
    courseId: Schema.Int,
    assignmentId: Schema.Int,
    taskId: Schema.Int,
    fileId: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("assignmentDoc"),
    courseId: Schema.Int,
    assignmentId: Schema.Int,
    taskId: Schema.Int,
    docId: Schema.Int,
    submitted: Schema.Boolean,
  }),
]).annotate({ identifier: "Jolli.Reference" })
export type Reference = typeof Reference.Type
export const ReferenceTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("group"), chatID: GroupChatID }),
  Schema.Struct({ kind: Schema.Literal("course"), courseId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("account") }),
]).annotate({ identifier: "Jolli.ReferenceTarget" })
export type ReferenceTarget = typeof ReferenceTarget.Type
export const ReferenceRequest = Schema.Struct({
  target: ReferenceTarget,
  reference: Reference,
  operation: Schema.Literals(["read", "content", "page", "map", "plan"]),
}).annotate({ identifier: "Jolli.ReferenceRequest" })
export interface ReferenceRequest extends Schema.Schema.Type<typeof ReferenceRequest> {}
export const GroupChat = Schema.Struct({
  id: GroupChatID,
  title: Schema.String,
  viewerId: Schema.NullOr(Schema.Int),
  webBaseUrl: Schema.String.pipe(optional),
  courseId: Schema.String,
  access: Schema.Literals(["owner", "participant", "reader"]),
  processing: Schema.Boolean,
  locked: Schema.Boolean.pipe(optional),
  shareBlocked: Schema.Boolean.pipe(optional),
  group: GroupChatInfo,
  messages: Schema.Array(ChatMessage),
})
export type GroupChat = typeof GroupChat.Type
export const GroupChatSummary = Schema.Struct({
  id: GroupChatID,
  title: Schema.String,
  courseId: Schema.String,
  courseCode: Schema.String,
  updatedAt: Schema.String,
  participantCount: Schema.Int,
  unreadCount: Schema.Int,
  processing: Schema.Boolean,
  ownership: Schema.String,
})
export type GroupChatSummary = typeof GroupChatSummary.Type

/** The source is deliberately absent: core adds it after decoding this request. */
export const GroupChatPost = Schema.Struct({
  message: Schema.String,
  clientRequestId: Schema.String,
  mentionedAssistantId: Schema.Int.pipe(optional),
  mentionedUserIds: Schema.Array(Schema.Int).pipe(optional),
  mentionsAll: Schema.Boolean.pipe(optional),
  attachmentIds: Schema.Array(Schema.Int).pipe(optional),
  pinnedMaterialIds: Schema.Array(Schema.Int).pipe(optional),
  modelId: Schema.String.pipe(optional),
})
export type GroupChatPost = typeof GroupChatPost.Type
export interface GroupChatFeatures extends Schema.Schema.Type<typeof GroupChatFeatures> {}
export const GroupChatFeatures = Schema.Struct({
  input: Schema.Boolean,
  readAloud: Schema.Boolean,
  composer: Schema.Struct({
    models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    assistants: Schema.Array(
      Schema.Struct({ id: Schema.Int, modelId: Schema.String, allowedModelIds: Schema.Array(Schema.String) }),
    ),
    /**
     * The model list or the agents' model choices could not be read. Asking an agent still works:
     * the ask is sent without a model and the server uses the agent's default.
     */
    unavailable: Schema.Boolean.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Jolli.GroupChatFeatures" })
/** The group chat refusal codes the server sends with a 4xx; any other code still reaches the client. */
export const GroupChatRefusalCode = Schema.Literals([
  "assignment_chat_membership",
  "participants_required",
  "too_many_participants",
  "not_in_course",
  "title_too_long",
  "not_allowed",
  "assistant_not_mentionable",
  "agent_busy",
  "chat_moved_on",
  "group_chat_not_deletable",
  "student_shares_staff_only",
])
export type GroupChatRefusalCode = typeof GroupChatRefusalCode.Type
/**
 * - `revoked`: access to the chat is gone. From any route, on a 404 labelled
 *   `conversation_access_revoked`; from opening a chat, also when its own open read answered a plain
 *   403/404 from jolliedu. Opening a chat has already purged its offline copy.
 * - `refused`: the server answered a 4xx other than 401; `code` and `httpStatus` say which. From any
 *   route but opening a chat, a 403/404 here does not mean access is gone: read the chat again.
 * - `signed-out`: a 401 that survived one refresh and retry, or no credential.
 * - `unreachable`: no response, a 5xx, or a response that could not be read.
 */
export const GroupChatAnswer = Schema.Struct({
  status: Schema.Literals(["ok", "unreachable", "refused", "revoked", "unsupported", "signed-out"]),
  code: Schema.String.pipe(optional),
  /** The upstream HTTP status behind a `refused`, `revoked` or `signed-out` answer. */
  httpStatus: Schema.Int.pipe(optional),
  /** The server's own sentence for a refusal, for a code the client has no wording of its own for. */
  message: Schema.String.pipe(optional),
  complete: Schema.Boolean.pipe(optional),
  resource: Schema.Json.pipe(optional),
  source: Schema.Literals(["server", "cache"]).pipe(optional),
  validatedAt: Schema.Number.pipe(optional),
  truncated: Schema.Boolean.pipe(optional),
  enabledCourseIds: Schema.Array(Schema.String).pipe(optional),
  chat: GroupChat.pipe(optional),
  chats: Schema.Array(GroupChatSummary).pipe(optional),
  people: Schema.Array(ChatPerson).pipe(optional),
  createdId: GroupChatID.pipe(optional),
  /**
   * On a chat list and on an opened chat (read live or from the offline copy), an opaque fingerprint of whose
   * chats these are (deployment, tenant and person), absent when the credential the answer was read with is no
   * longer active. A window that missed a reset, because its event stream was down, or that the sidecar never
   * told (it adopts the first credential it meets after a start), compares it with the owner of the chats it
   * holds and drops them when they differ.
   */
  owner: Schema.String.pipe(optional),
})
export type GroupChatAnswer = typeof GroupChatAnswer.Type
/**
 * Who the composer asks: the agent `assistantId` names, or the whole group when it is absent. Absent
 * rather than null, because the generated SDK drops `null` from body fields; core sends the server's
 * null for the group.
 */
export const GroupChatTarget = Schema.Struct({ assistantId: Schema.Int.pipe(optional) })
export type GroupChatTarget = typeof GroupChatTarget.Type
export const GroupChatAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cancel") }),
  Schema.Struct({ type: Schema.Literal("read"), seq: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("target"), ...GroupChatTarget.fields }),
  Schema.Struct({ type: Schema.Literal("rename"), title: Schema.String }),
  Schema.Struct({ type: Schema.Literal("add"), userIds: Schema.Array(Schema.Int) }),
  Schema.Struct({ type: Schema.Literal("remove"), userId: Schema.Int }),
])
export type GroupChatAction = typeof GroupChatAction.Type
export const GroupChatCreate = Schema.Struct({
  courseId: Schema.String,
  participantIds: Schema.Array(Schema.Int),
  title: Schema.String.pipe(optional),
})
export type GroupChatCreate = typeof GroupChatCreate.Type
