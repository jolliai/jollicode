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
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

export const JolliPaths = {
  course: "/jolli/course",
} as const

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
    .annotateMerge(
      OpenApi.annotations({
        title: "jolli",
        description: "Jolli Code course and assistant routes.",
      }),
    ),
)
