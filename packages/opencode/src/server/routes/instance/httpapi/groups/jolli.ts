/**
 * THE COURSE CATALOGUE, AS THE RENDERER READS IT.
 *
 * ⚠ IT IS A ROOT ROUTE, NOT AN INSTANCE ONE, BECAUSE A COURSE IS NOT A DIRECTORY'S BUSINESS. A
 * student's enrolment is the same wherever they are working — the same course spans every
 * repository they open — so this asks for no location and answers the same thing for all of them.
 *
 * ⚠ AND IT IS DECLARED HERE RATHER THAN IN `packages/protocol`, WHICH LOOKS LIKE THE WRONG PLACE
 * UNTIL YOU CHECK WHO IS LISTENING. The app probes `/global/health` to pick a protocol, this server
 * answers it, and so every call the app makes goes through the v1 compatibility layer. An endpoint
 * added to the v2 protocol would be served correctly and never once be asked for.
 */
import { Jolli } from "@opencode-ai/schema/jolli"
import { PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

export const JolliPaths = {
  course: "/jolli/course",
  groupChats: "/jolli/group-chat",
  groupChat: "/jolli/group-chat/:chatID",
  groupChatPost: "/jolli/group-chat/:chatID/messages",
  groupChatWatch: "/jolli/group-chat/:chatID/watch",
  groupChatPeople: "/jolli/course/:courseId/group-chat/people",

  share: "/jolli/session/:sessionID/share",
  shareReaders: "/jolli/session/:sessionID/share/readers",
  unshare: "/jolli/session/:sessionID/share/:subject",
  assignments: "/jolli/assignment",
  assignment: "/jolli/assignment/:courseId/:assignmentId",
  turnIn: "/jolli/assignment/:courseId/:assignmentId/turn-in",
} as const

/** An assignment by its course and its own id, as the gateway numbers both. */
const AssignmentParams = { courseId: Schema.String, assignmentId: Schema.String }

/**
 * ⚠ THE SESSION ID IS A PLAIN STRING HERE, NOT THE BRANDED `SessionID`. These routes never touch the
 * local session store — they name a conversation on the gateway, where the same ID is the public
 * conversation ID — and a root route has no instance to validate a session against anyway.
 */
const ShareParams = { sessionID: Schema.String }

/** ⚠ INLINE, NOT A NAMED SCHEMA, so the generated client takes `{ sessionID, subject }` flat. */
const SharePayload = Schema.Struct({ subject: Jolli.ShareSubject })

/**
 * ⚠ `fresh` IS FOR A STUDENT WHO HAS JUST BEEN TOLD THE CATALOGUE IS WRONG — a refused Start, a
 * picker opened to choose again. Without it this route serves `cache.ts`'s snapshot for its whole
 * TTL, so the re-ask those screens make came back with the assistant that had just closed.
 */
const CourseQuery = Schema.Struct({ fresh: Schema.optional(QueryBoolean) })

export const JolliApi = HttpApi.make("jolli").add(
  HttpApiGroup.make("jolli")
    .add(
      HttpApiEndpoint.post("groupChatCancel", "/jolli/group-chat/:chatID/cancel", {
        params: { chatID: Jolli.GroupChatID },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.patch("groupChatRename", "/jolli/group-chat/:chatID", {
        params: { chatID: Jolli.GroupChatID },
        payload: Schema.Struct({ title: Schema.String }),
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.post("groupChatAddPeople", "/jolli/group-chat/:chatID/participants", {
        params: { chatID: Jolli.GroupChatID },
        payload: Schema.Struct({ userIds: Schema.Array(Schema.Int) }),
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.delete("groupChatRemovePerson", "/jolli/group-chat/:chatID/participants/:userId", {
        params: { chatID: Jolli.GroupChatID, userId: Schema.Int },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.post("groupChatRead", "/jolli/group-chat/:chatID/read", {
        params: { chatID: Jolli.GroupChatID },
        payload: Schema.Struct({ seq: Schema.Int }),
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.put("groupChatTarget", "/jolli/group-chat/:chatID/composer-target", {
        params: { chatID: Jolli.GroupChatID },
        // No body is the whole group, as `{}` is: the generated client sends none for a target without an agent.
        payload: [HttpApiSchema.NoContent, Jolli.GroupChatTarget],
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.get("groupChatFeatures", "/jolli/group-chat/:chatID/features", {
        params: { chatID: Jolli.GroupChatID },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.post("reference", "/jolli/reference", {
        payload: Jolli.ReferenceRequest,
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.get("groupChatMaterials", "/jolli/course/:courseId/material", {
        params: { courseId: Schema.String },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.get("groupChatShare", "/jolli/group-chat/:chatID/share", {
        params: { chatID: Jolli.GroupChatID },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.post("groupChatShareAdd", "/jolli/group-chat/:chatID/share", {
        params: { chatID: Jolli.GroupChatID },
        // Ids are positive, as the session share routes require: anything else is refused here.
        payload: Schema.Struct({
          subject: Schema.Union([PositiveInt, Schema.Literal("everyone"), Schema.Struct({ groupId: PositiveInt })]),
        }),
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.delete("groupChatShareRemove", "/jolli/group-chat/:chatID/share/:subject", {
        params: { chatID: Jolli.GroupChatID, subject: Schema.String },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.delete("groupChatShareGroupRemove", "/jolli/group-chat/:chatID/share/groups/:groupId", {
        params: { chatID: Jolli.GroupChatID, groupId: PositiveInt },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.get("groupChatAttachmentStatus", "/jolli/group-chat/:chatID/attachment/:attachmentId", {
        params: { chatID: Jolli.GroupChatID, attachmentId: Schema.Int },
        success: Jolli.GroupChatAnswer,
      }),
    )
    .add(
      HttpApiEndpoint.post("groupChatAttachment", "/jolli/group-chat/:chatID/attachment", {
        params: { chatID: Jolli.GroupChatID },
        success: Schema.Json,
      }),
    )
    .add(
      HttpApiEndpoint.get("groupChatDownload", "/jolli/group-chat/:chatID/download/:attachmentId", {
        params: { chatID: Jolli.GroupChatID, attachmentId: Schema.Int },
        query: Schema.Struct({ filename: Schema.String }),
        success: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.post("groupChatTranscription", "/jolli/voice/transcription", {
        query: Schema.Struct({ chatID: Jolli.GroupChatID }),
        success: Schema.Json,
      }),
    )
    .add(
      HttpApiEndpoint.get("groupChatTranscriptionPoll", "/jolli/voice/transcription/:requestId", {
        params: { requestId: Schema.String },
        query: Schema.Struct({ chatID: Jolli.GroupChatID }),
        success: Schema.Json,
      }),
    )
    .add(
      HttpApiEndpoint.post("groupChatReadAloud", "/jolli/voice/read-aloud", {
        query: Schema.Struct({ chatID: Jolli.GroupChatID }),
        success: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.delete("groupChatVoiceRelease", "/jolli/voice/session", {
        query: Schema.Struct({ chatID: Jolli.GroupChatID }),
        success: Schema.Json,
      }),
    )

    .add(
      HttpApiEndpoint.get("groupChats", JolliPaths.groupChats, {
        query: Schema.Struct({ courseId: Schema.String.pipe(Schema.optional) }),
        success: Jolli.GroupChatAnswer,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "jolli.groupChats", summary: "List server-owned group chats" }),
      ),
    )
    .add(
      HttpApiEndpoint.post("groupChatCreate", "/jolli/course/:courseId/group-chat", {
        params: { courseId: Schema.String },
        payload: Schema.Struct({
          participantIds: Jolli.GroupChatCreate.fields.participantIds,
          title: Jolli.GroupChatCreate.fields.title,
        }),
        success: Jolli.GroupChatAnswer,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "jolli.groupChatCreate", summary: "Create a course group chat" }),
      ),
    )
    .add(
      HttpApiEndpoint.get("groupChatPeople", JolliPaths.groupChatPeople, {
        params: { courseId: Schema.String },
        success: Jolli.GroupChatAnswer,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "jolli.groupChatPeople", summary: "List people who can join a group chat" }),
      ),
    )
    .add(
      HttpApiEndpoint.get("groupChat", JolliPaths.groupChat, {
        params: { chatID: Jolli.GroupChatID },
        success: Jolli.GroupChatAnswer,
      }).annotateMerge(OpenApi.annotations({ identifier: "jolli.groupChat", summary: "Open a server group chat" })),
    )
    .add(
      HttpApiEndpoint.post("groupChatPost", JolliPaths.groupChatPost, {
        params: { chatID: Jolli.GroupChatID },
        payload: Jolli.GroupChatPost,
        success: Jolli.GroupChatAnswer,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.groupChatPost",
          summary: "Send a group message without a local session",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("groupChatWatch", JolliPaths.groupChatWatch, {
        params: { chatID: Jolli.GroupChatID },
        payload: Schema.Struct({ clientID: Schema.String, active: Schema.Boolean }),
        success: Jolli.GroupChatAnswer,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.groupChatWatch",
          summary: "Lease group updates to a global event connection",
        }),
      ),
    )

    .add(
      HttpApiEndpoint.get("course", JolliPaths.course, {
        query: CourseQuery,
        success: described(Jolli.Catalog, "The student's courses, their assistants and model tiers"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.course",
          summary: "List the signed-in student's courses",
          description:
            "Courses the signed-in student is enrolled in that use Jolli Code, each with the " +
            "professor-authored assistants a session may run. Courses that cannot be started yet " +
            "are included and carry the reason in `entryState`. Answers an empty catalogue rather " +
            "than an error when no Jolli credential is present. Served from a short-lived cache " +
            "unless `fresh` is `true`, which asks Jolli again and falls back to the cache only if " +
            "Jolli cannot answer.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("share", JolliPaths.share, {
        params: ShareParams,
        success: described(Jolli.SessionShare, "Who can read the session, and who in its course it could be shown to"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.share",
          summary: "Read a session's readers",
          description:
            "The Jolli readers of one of the signed-in student's sessions, plus the members of the " +
            "session's course it could still be shared with. Answers `unsynced` while the gateway has " +
            "no conversation for the session yet and `unreachable` when there is no credential or the " +
            "gateway did not answer, rather than an error.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("shareReaders", JolliPaths.shareReaders, {
        params: ShareParams,
        success: described(Jolli.SessionShare, "Who can read the session, without the course's roster"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.shareReaders",
          summary: "Read a session's readers without its course",
          description:
            "The Jolli readers of one of the signed-in student's sessions, answered the way a write is: " +
            "`members` empty and `roster` `unavailable`. Cheap enough to ask for every session shown, " +
            "where the full read also fetches the conversation's timeline and its course roster. " +
            "Answers `unsynced` and `unreachable` as the full read does.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("shareAdd", JolliPaths.share, {
        params: ShareParams,
        payload: SharePayload,
        success: described(Jolli.SessionShare, "The session's readers after the grant"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.shareAdd",
          summary: "Share a session",
          description:
            "Grants one course member, or the whole class (`everyone`), read access to the session on " +
            "Jolli. A refusal answers `refused` with the reason in `refusal`.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("shareRemove", JolliPaths.unshare, {
        params: { ...ShareParams, subject: Schema.String },
        success: described(Jolli.SessionShare, "The session's readers after the grant is withdrawn"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.shareRemove",
          summary: "Stop sharing a session",
          description:
            "Withdraws one reader's grant — a user id, or `everyone` for the class. Withdrawing a grant " +
            "that was not there is not an error.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("assignments", JolliPaths.assignments, {
        query: CourseQuery,
        success: described(Jolli.AssignmentList, "The student's assignments to do that have a Jolli Code task"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.assignments",
          summary: "List the signed-in student's assignments to do",
          description:
            "Across the student's Jolli Code courses, the open assignments not yet turned in that have a " +
            "task worked in Jolli Code, due soonest first. One past a due date it stops at is left out. " +
            "Answers `unreachable` rather than an error when there is no credential or Jolli did not " +
            "answer. Served from a minute-long cache unless `fresh` is `true`.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("assignment", JolliPaths.assignment, {
        params: AssignmentParams,
        query: CourseQuery,
        success: described(Jolli.AssignmentAnswer, "One assignment and its tasks, with this machine's sessions"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.assignment",
          summary: "Read one assignment",
          description:
            "One assignment with the student's own work: each task, where it is worked, whether it is " +
            "handed in and by which session, and the task's session on this machine when there is one. " +
            "A refusal answers `refused` with Jolli's own sentence in `message`.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("turnIn", JolliPaths.turnIn, {
        params: AssignmentParams,
        success: described(Jolli.AssignmentAnswer, "The assignment as it stands after the turn-in"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.turnIn",
          summary: "Turn an assignment in",
          description:
            "Turns the whole assignment in for the teacher to review. The caller has already had the " +
            "student confirm it. A refusal answers `refused` with Jolli's own sentence in `message`.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "jolli",
        description: "Jolli Code course, assistant, assignment and session-share routes.",
      }),
    ),
)
