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
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

export const JolliPaths = {
  course: "/jolli/course",
  share: "/jolli/session/:sessionID/share",
  shareReaders: "/jolli/session/:sessionID/share/readers",
  unshare: "/jolli/session/:sessionID/share/:subject",
} as const

/**
 * ⚠ THE SESSION ID IS A PLAIN STRING HERE, NOT THE BRANDED `SessionID`. These routes never touch the
 * local session store — they name a conversation on the gateway, where the same ID is the public
 * conversation ID — and a root route has no instance to validate a session against anyway.
 */
const ShareParams = { sessionID: Schema.String }

/** ⚠ INLINE, NOT A NAMED SCHEMA, so the generated client takes `{ sessionID, subject }` flat. */
const SharePayload = Schema.Struct({ subject: Jolli.ShareSubject })

export const JolliApi = HttpApi.make("jolli").add(
  HttpApiGroup.make("jolli")
    .add(
      HttpApiEndpoint.get("course", JolliPaths.course, {
        success: described(Jolli.Catalog, "The student's courses, their assistants and model tiers"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "jolli.course",
          summary: "List the signed-in student's courses",
          description:
            "Courses the signed-in student is enrolled in that use Jolli Code, each with the " +
            "professor-authored assistants a session may run. Courses that cannot be started yet " +
            "are included and carry the reason in `entryState`. Answers an empty catalogue rather " +
            "than an error when no Jolli credential is present.",
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
    .annotateMerge(
      OpenApi.annotations({
        title: "jolli",
        description: "Jolli Code course, assistant and session-share routes.",
      }),
    ),
)
