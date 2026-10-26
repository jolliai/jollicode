/**
 * WHAT JOLLI EDU ACTUALLY RETURNS, DECODED — AND NOTHING ELSE.
 *
 * ⚠ THIS LAYER HUGS THE WIRE, ON PURPOSE. The shapes below are Jolli Edu's, field for field,
 * numeric ids included; the domain types this repo renders live in `@opencode-ai/schema/jolli` and
 * the mapping between them belongs to the caller. Keeping the two apart is what makes "the gateway
 * changed a field" a diff in one file rather than a hunt through the renderer.
 *
 * ⚠ AND IT HOLDS NO CREDENTIAL. Three surfaces need these calls and each gets its token from
 * somewhere different — the desktop from the OS keychain, the sidecar from its environment, the
 * bare CLI from `auth.json`. A module that reached for one would work on exactly one of them.
 *
 * Contract verified against jolliedu's `origin/main`:
 *   GET /api/me/courses                       MeRouter.ts            requireAuth(), fanned out across the person's orgs
 *   GET /api/courses                          CourseRouter.ts:1289   requireAuth(), home org only — for a server that predates the one above
 *   GET /api/courses/:id/assistant-choices    CourseRouter.ts:1993   spaces.view, 404-on-no-permission
 *   GET /api/agent/models                     AgentModelRouter.ts:21 any signed-in user
 * The cross-org list answers `{ courses, unavailable, home }`; the rest a bare array.
 *
 * And the session-share surface, verified against the same tree:
 *   POST   /api/agent/convos                        AgentConvoRouter.ts   `coding_agent` origin, see openConversation
 *   GET    /api/agent/convos/:id                    AgentConvoRouter.ts   owner only, 404 otherwise
 *   PATCH  /api/agent/convos/:id                    AgentConvoRouter.ts   owner only, 404 otherwise
 *   GET    /api/agent/convos/:id/shares             ConversationShareRouter.ts   owner only, 404 otherwise
 *   POST   /api/agent/convos/:id/shares             ConversationShareRouter.ts   owner only
 *   DELETE /api/agent/convos/:id/shares/:subject    ConversationShareRouter.ts   owner only
 *   GET    /api/spaces/:id/members                  SpaceMemberRouter.ts  spaces.view
 * The shares read and the share writes answer with the conversation's composed visibility, the convo
 * read carries the same object under `visibility`, and the roster is a bare array.
 *
 * And a student's assignments, all mounted on `/api/courses/:id/assignments` (AssignmentRouter.ts):
 *   GET  /student-view                                       the student's list, in three groups
 *   GET  /:assignmentId/student-view                         one assignment with the student's own work
 *   POST /:assignmentId/parts/:partId/jolli-code/sessions    start a task's session, idempotent by id
 *   POST /:assignmentId/parts/:partId/jolli-code/preview     what handing the session in would hand in
 *   POST /:assignmentId/parts/:partId/jolli-code/hand-in     hand it in, up to where the preview ended it
 *   POST /:assignmentId/turn-in                              turn the whole assignment in
 * A refusal answers `{ code, error }`, `error` being the sentence the student is to read.
 */
import { Duration, Effect, Schedule, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Brand } from "../brand"
import { orgScopeHeaders, type OrgScope } from "./org-scoped-id"
import { isJolliOriginAllowed, parseJolliUrl } from "./origin"
import { Jolli } from "@opencode-ai/schema/jolli"
import { JOLLI_CODE_PARTICIPATION_HEADER, JOLLI_CODE_PARTICIPATION_VERSION } from "./coding-headers"

export class JolliApiError extends Schema.TaggedErrorClass<JolliApiError>()("Jolli.ApiError", {
  path: Schema.String,
  /** Absent when the request never got a response. */
  status: Schema.optional(Schema.Number),
  /**
   * The machine-readable reason a write was refused, when the gateway sent one. Read by the share
   * writes ({@link shareConversation}) and by {@link openConversation}.
   */
  code: Schema.optional(Schema.String),
  /**
   * The gateway's own sentence for the student, when a refusal sent one: the assignment routes word
   * every refusal with its next step, and saying it again here would be a second wording to keep in
   * step with theirs.
   */
  explanation: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * WHAT A FAILED GATEWAY CALL MEANS: `refused`, a 4xx other than 401, where the gateway said no and
 * wrote nothing; `expired`, a 401, a credential to renew, where nothing was written either; `failed`,
 * anything else — no answer, a 5xx, or a 2xx whose body would not decode — after which a write may
 * have landed.
 *
 * ⚠ A 2XX THAT WOULD NOT DECODE IS `failed`, NOT `refused`. The gateway did what was asked; telling
 * the student it refused would have them try again at something already done.
 */
export function failureOf(error: JolliApiError) {
  if (error.status === 401) return "expired" as const
  if (error.status !== undefined && error.status >= 400 && error.status < 500) return "refused" as const
  return "failed" as const
}

/**
 * WHERE TO CALL AND AS WHOM.
 *
 * ⚠ `origin` IS AN ORIGIN, NEVER A TENANT URL WITH A PATH. Jolli mounts its API at the origin root
 * even when the tenant is addressed path-wise (`https://host/acme`), in which case the slug travels
 * as a header instead — concatenating an API path onto the tenant URL reaches the app router, not
 * the API. Build one with {@link gatewayRequest}, which makes that split for you.
 */
export interface GatewayRequest {
  readonly origin: string
  readonly tenantSlug?: string
  readonly token: string
  /**
   * WHO THIS REQUEST IS FOR, AS SOMETHING THAT OUTLIVES THE TOKEN.
   *
   * ⚠ IT EXISTS BECAUSE THE ACCESS TOKEN ROTATES AND THE CACHE FILENAME MUST NOT. `cache.ts` keys a
   * student's snapshot on this so two people on one machine never read each other's; keying it on
   * the token itself orphaned the file on every refresh and dropped the student into a cold
   * three-request reload on the startup path. Minted once per sign-in and stored on the credential
   * row — never re-minted by a refresh.
   *
   * ⚠ IT IS NOT A SECRET AND MUST NOT BE USED AS ONE. Only `token` authenticates anything.
   */
  readonly identity: string
  /**
   * WHICH ORG THIS REQUEST RUNS IN, when it is not the home one. Its tenant and org replace the
   * base URL's tenant header on the wire. It is per-request, so the catalogue cache key does not read it.
   */
  readonly scope?: OrgScope
}

/** The same request, aimed at `org`; with no org it is returned untouched. */
export function scopedRequest(request: GatewayRequest, org: OrgScope | undefined): GatewayRequest {
  return org ? { ...request, scope: org } : request
}

/** What a caller must hold to address the gateway: something to send, and something to file it under. */
export interface GatewayCredential {
  readonly token: string
  readonly identity: string
}

/**
 * Split a tenant base URL (`https://acme.jolli.ai` or `https://host/acme`) into the origin every
 * route is mounted on and the slug a path-based deployment carries in a header.
 *
 * ⚠ IT RE-CHECKS THE ALLOWLIST rather than trusting whoever stored the URL. A long-lived process
 * can be holding a value that was allowlisted when it was read and is not any more, and this
 * request carries the student's credential — same reason `exchange.ts` re-checks.
 */
export function gatewayRequest(baseUrl: string, credential: GatewayCredential): GatewayRequest | undefined {
  if (!URL.canParse(baseUrl)) return undefined
  if (!isJolliOriginAllowed(baseUrl)) return undefined
  const tenant = parseJolliUrl(baseUrl)
  return {
    origin: tenant.origin,
    ...(tenant.tenantSlug ? { tenantSlug: tenant.tenantSlug } : {}),
    token: credential.token,
    identity: credential.identity,
  }
}

// ── The wire shapes ─────────────────────────────────────────────────────────────────────────────

/** jolliedu `common/src/types/Course.ts:126`. */
export const CourseListItem = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  code: Schema.String,
  /**
   * ⚠ DECODED AS A STRING, NARROWED LATER. A closed union here would fail the WHOLE array on one
   * unrecognised value, and `schemaBodyJson` has no per-element recovery — so the day Jolli Edu
   * adds a course status, every student is locked out of the app and told their network is down.
   * The mapping layer decides what an unknown status means; the wire decoder's job is to let the
   * response through.
   */
  status: Schema.String,
  /** Whether this course's work happens in Jolli Code. The professor sets it. */
  requiresCoding: Schema.Boolean,
  endsOn: Schema.NullOr(Schema.String),
  /**
   * The viewer's role in THIS course, and the only way to tell a course of theirs from one an
   * institution administrator merely has sight of — see the filter in `packages/opencode`.
   */
  /** Open for the same reason as {@link status}: a new role must not lock anybody out. */
  viewerRole: Schema.NullOr(Schema.String),
  isStaff: Schema.Boolean,
}).annotate({ identifier: "JolliApi.CourseListItem" })
export interface CourseListItem extends Schema.Schema.Type<typeof CourseListItem> {}

/**
 * jolliedu `common/src/types/OrgScope.ts` `OrgRef`, less the ids this client does not read.
 *
 * ⚠ ONLY THE SLUGS ARE REQUIRED. Every course and every `unavailable` entry decodes one, so a field
 * the client merely displays being null on one org would fail the whole list — every org's courses
 * down over one org's label. The slugs are the address; without them a course cannot be asked about.
 */
export const OrgRef = Schema.Struct({
  tenantSlug: Schema.String,
  orgSlug: Schema.String,
  institutionName: Schema.optional(Schema.NullOr(Schema.String)),
  orgName: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "JolliApi.OrgRef" })
export interface OrgRef extends Schema.Schema.Type<typeof OrgRef> {}

/** jolliedu `common/src/types/MyCourses.ts` `MyCourseListItem`: a course and the org it lives in. */
export const MyCourseListItem = Schema.Struct({ ...CourseListItem.fields, org: OrgRef }).annotate({
  identifier: "JolliApi.MyCourseListItem",
})
export interface MyCourseListItem extends Schema.Schema.Type<typeof MyCourseListItem> {}

/**
 * jolliedu `common/src/types/MyCourses.ts` `MyCoursesResponse`, less what this client does not read.
 *
 * ⚠ `home` IS OPTIONAL ON THE WIRE TYPE for a server that predates it. Without it the client cannot
 * tell which org is home, so the catalogue does not read such an answer — see `listCourses` in `cache.ts`.
 */
export const MyCourses = Schema.Struct({
  courses: Schema.Array(MyCourseListItem),
  /**
   * Orgs that did not answer in time; their courses are missing from `courses`. Optional only so a
   * server that leaves it out reads as "every org answered" rather than failing the whole list.
   */
  unavailable: Schema.optional(Schema.Array(OrgRef)),
  home: Schema.optional(OrgRef),
}).annotate({ identifier: "JolliApi.MyCourses" })
export interface MyCourses extends Schema.Schema.Type<typeof MyCourses> {}

/** Course skill catalog metadata, without instruction bodies. */
export const CourseSkillChoice = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  command: Schema.String,
  description: Schema.String,
})
export type CourseSkillChoice = typeof CourseSkillChoice.Type

export const CourseSkillReference = Jolli.CourseSkillReference
export type CourseSkillReference = typeof CourseSkillReference.Type

/**
 * Student-facing assistant choices. Only live assistants are returned, with the default first.
 * Teacher and skill instructions never reach this client.
 */
export const CourseAssistantChoice = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  blurb: Schema.String,
  /** A closed set of 16 names the client maps to a glyph; kept loose here, narrowed on mapping. */
  icon: Schema.String,
  accent: Schema.Number,
  worksThroughProblems: Schema.Boolean,
  answersFromMaterialsOnly: Schema.Boolean,
  showCitations: Schema.Boolean,
  includeAssignments: Schema.optional(Schema.Boolean),
  /** A Registry UUID. Never null: only a `live` assistant is offered and `live` requires a model. */
  modelId: Schema.String,
  /** Registry UUIDs. Empty means UNRESTRICTED, not "no models". */
  allowedModelIds: Schema.Array(Schema.String),
  /**
   * What the teacher wrote for students to read before they start. Empty means none.
   *
   * ⚠ IT AND THE FOUR FIELDS AFTER IT ARE OPTIONAL BECAUSE A SERVER THAT PREDATES THEM MUST STILL
   * DECODE. `schemaBodyJson` fails the whole array on one missing key, so requiring them would lock
   * every student of an older tenant out over a feature they cannot use anyway. `toAssistant` fills
   * the defaults: no brief, no window, chat allowed, the agent does not speak first.
   */
  /** Null is the same as absent: a teacher who wrote no brief may be stored either way. */
  brief: Schema.optional(Schema.NullOr(Schema.String)),
  /** ISO instants bounding when a new chat may start; null on a side means unbounded. */
  startsAt: Schema.optional(Schema.NullOr(Schema.String)),
  endsAt: Schema.optional(Schema.NullOr(Schema.String)),
  directChatEnabled: Schema.optional(Schema.Boolean),
  /** Whether the agent speaks first. Only newer servers send it. */
  opensConversation: Schema.optional(Schema.Boolean),
  skills: Schema.optional(Schema.Array(CourseSkillChoice)),
}).annotate({ identifier: "JolliApi.CourseAssistantChoice" })
export interface CourseAssistantChoice extends Schema.Schema.Type<typeof CourseAssistantChoice> {}

/** jolliedu `common/src/types/AgentHub.ts:44`. */
export const AgentModel = Schema.Struct({
  /** The Registry UUID that `allowedModelIds` names. */
  id: Schema.String,
  /** The public model name the LLM router accepts, e.g. `claude-sonnet-4-5`. */
  name: Schema.String,
  /** Open for the same reason as the course fields; an unknown tier simply produces no nudge. */
  category: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  isActive: Schema.Boolean,
  /**
   * What the model accepts as input (`text`, `image`, `pdf`, ...), as the catalogue answers for it.
   *
   * ⚠ OPTIONAL, AND ABSENT MEANS UNKNOWN. A backend that predates the field, and a model its
   * catalogue has no answer for, both omit it; the provider config then declares nothing and the
   * model keeps the defaults it had before. Open strings for the reason `category` is open: a
   * modality this client has not heard of must not fail the whole array.
   */
  inputModalities: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "JolliApi.AgentModel" })
export interface AgentModel extends Schema.Schema.Type<typeof AgentModel> {}

const AgentModelProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * The wire protocol this provider's models are reached over. Held as an open
   * string for the same reason `CourseListItem.status` is: a value the client
   * has not heard of must not fail the whole array. The mapping layer leaves a
   * model on such a protocol out (`runnableModels` in `catalog.ts`), since this
   * build has no provider to send it through.
   */
  protocol: Schema.String,
  isActive: Schema.Boolean,
  models: Schema.Array(AgentModel),
}).annotate({ identifier: "JolliApi.AgentModelProvider" })

/**
 * jolliedu `common/src/types/CourseChat.ts` — `ConversationPersonShare` | `ConversationClassShare`.
 *
 * ⚠ `access` IS AN OPEN STRING HERE for the reason `CourseListItem.status` is: a level this client
 * has not heard of must not fail the whole visibility object. The mapping narrows it.
 */
const ConversationShareRow = Schema.Union([
  Schema.Struct({
    subjectIsClass: Schema.Literal(false),
    subjectUserId: Schema.Number,
    name: Schema.String,
    detail: Schema.optional(Schema.NullOr(Schema.String)),
    access: Schema.String,
  }),
  Schema.Struct({
    subjectIsClass: Schema.Literal(true),
    classSize: Schema.Number,
    access: Schema.String,
  }),
])

/**
 * jolliedu `common/src/types/CourseChat.ts` — `ConversationVisibility`.
 *
 * ⚠ `shares` IS ABSENT FOR ANYBODY BUT THE OWNER. The share routes only ever answer the owner, so
 * absence here means the gateway withheld the list, and the mapping reads it as "nobody" rather
 * than guessing.
 */
export const ConversationVisibility = Schema.Struct({
  courseCode: Schema.NullOr(Schema.String),
  courseId: Schema.NullOr(Schema.Number),
  mayControl: Schema.Boolean,
  shares: Schema.optional(Schema.Array(ConversationShareRow)),
}).annotate({ identifier: "JolliApi.ConversationVisibility" })
export interface ConversationVisibility extends Schema.Schema.Type<typeof ConversationVisibility> {}

/**
 * The one field of jolliedu's `AgentSessionDetail` this client reads.
 *
 * ⚠ THE WHOLE DETAIL COMES DOWN THE WIRE — timeline included, unpaged. Only `visibility` is decoded,
 * and the renderer asks for it only when the share panel opens or the coaching gate's cached answer
 * is stale. What is asked per session on screen goes to {@link fetchConversationShares} instead.
 */
const ConversationDetail = Schema.Struct({ visibility: ConversationVisibility })

/**
 * The one field of the detail `POST /api/agent/convos` answers with that this client reads: the
 * opener, with the student's and teacher's names already put in.
 *
 * ⚠ EVERY LEVEL IS OPTIONAL, AND AN ABSENT OPENER IS A SUCCESS. The server still creates the
 * conversation without one when the school has AI switched off, the generator is saturated, or it
 * failed — and the student then simply starts typing, as on the web.
 */
const OpenedConversation = Schema.Struct({
  config: Schema.optional(
    Schema.NullOr(Schema.Struct({ opener: Schema.optional(Schema.NullOr(Schema.Struct({ text: Schema.String }))) })),
  ),
})

/**
 * A task's session as the gateway started it: the opener, and the course and agent the TASK bound it to.
 *
 * ⚠ THE AGENT IS THE GATEWAY'S ANSWER, NOT THE ONE ASKED FOR. The task decides it, and every turn the
 * session takes is checked against it; a session recorded under any other would be refused as a
 * binding conflict on its first message.
 */
const StartedTaskSession = Schema.Struct({
  ...OpenedConversation.fields,
  courseId: Schema.Number,
  courseAssistantId: Schema.Number,
})

/** jolliedu `common/src/types/SpaceMember.ts` — `SpaceMemberWithUser`, trimmed to what a picker reads. */
export const SpaceMember = Schema.Struct({
  userId: Schema.Number,
  /** Open for the same reason as `CourseListItem.viewerRole`: a new role must not fail the roster. */
  role: Schema.String,
  userName: Schema.NullOr(Schema.String),
  userEmail: Schema.String,
}).annotate({ identifier: "JolliApi.SpaceMember" })
export interface SpaceMember extends Schema.Schema.Type<typeof SpaceMember> {}

/**
 * What a part asks the student to hand in. jolliedu `common/src/types/Assignment.ts` —
 * `AssignmentPartTurnIn`.
 */
export const AssignmentTurnIn = Schema.Struct({
  transcript: Schema.Boolean,
  summary: Schema.Boolean,
  reflection: Schema.Boolean,
}).annotate({ identifier: "JolliApi.AssignmentTurnIn" })
export interface AssignmentTurnIn extends Schema.Schema.Type<typeof AssignmentTurnIn> {}

/**
 * jolliedu `AssignmentProgress`, trimmed to what this client reads.
 *
 * ⚠ `state` IS AN OPEN STRING for the reason `CourseListItem.status` is: a state this client has not
 * heard of must not fail the whole list.
 */
const AssignmentProgress = Schema.Struct({
  state: Schema.String,
  partsSubmitted: Schema.Number,
  partsTotal: Schema.Number,
  turnedInAt: Schema.NullOr(Schema.String),
})

/**
 * One part a student owes, as their list names it. jolliedu `StudentAssignmentTask`.
 *
 * ⚠ `workedIn` IS OPEN, AND READ AS A WEB TASK WHEN IT IS NOT `jolli_code`: a place this client does
 * not know is not one it can work in.
 */
export const StudentAssignmentTask = Schema.Struct({
  partId: Schema.Number,
  assistantId: Schema.Number,
  workedIn: Schema.String,
  submitted: Schema.Boolean,
}).annotate({ identifier: "JolliApi.StudentAssignmentTask" })
export interface StudentAssignmentTask extends Schema.Schema.Type<typeof StudentAssignmentTask> {}

/**
 * One row of a student's Assignments tab. jolliedu `StudentAssignmentListItem`.
 *
 * ⚠ `tasks` IS OPTIONAL BECAUSE A SERVER THAT PREDATES JOLLI CODE TASKS DOES NOT SEND IT, and such a
 * server has no task to work here: absent reads as none.
 */
export const StudentAssignmentListItem = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  status: Schema.String,
  opensAt: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.String),
  stopAtDue: Schema.Boolean,
  progress: AssignmentProgress,
  tasks: Schema.optional(Schema.Array(StudentAssignmentTask)),
}).annotate({ identifier: "JolliApi.StudentAssignmentListItem" })
export interface StudentAssignmentListItem extends Schema.Schema.Type<typeof StudentAssignmentListItem> {}

/** jolliedu `StudentAssignmentList`: open and not turned in, not open yet, and turned in. */
export const StudentAssignmentList = Schema.Struct({
  todo: Schema.Array(StudentAssignmentListItem),
  upcoming: Schema.Array(StudentAssignmentListItem),
  completed: Schema.Array(StudentAssignmentListItem),
}).annotate({ identifier: "JolliApi.StudentAssignmentList" })
export interface StudentAssignmentList extends Schema.Schema.Type<typeof StudentAssignmentList> {}

/** One session a student opened from a part. jolliedu `StudentAssignmentAttempt`, trimmed. */
const StudentAssignmentAttempt = Schema.Struct({
  id: Schema.Number,
  /** The session's public id: the id this client gave it. */
  conversationId: Schema.String,
  countedAt: Schema.NullOr(Schema.String),
})

/** What a student handed in for a part. jolliedu `StudentAssignmentSubmission`, trimmed. */
const StudentAssignmentSubmission = Schema.Struct({
  completionKind: Schema.optional(Schema.Literals(["hand_in", "participation"])),
  attemptId: Schema.Number,
  submittedAt: Schema.String,
})

/** One agent part, from the student's side. jolliedu `StudentAgentTask`, trimmed. */
export const StudentAssignmentAgentPart = Schema.Struct({
  id: Schema.Number,
  /** Absent from a server that predates task kinds, where every part is an agent's. */
  kind: Schema.optional(Schema.Literal("agent")),
  assistantId: Schema.Number,
  assistantName: Schema.String,
  assistantBlurb: Schema.String,
  /** Open, as every status here is. */
  assistantStatus: Schema.String,
  turnIn: AssignmentTurnIn,
  reflectionPrompt: Schema.NullOr(Schema.String),
  /** Optional for the reason `tasks` is: absent reads as a web task. */
  workedIn: Schema.optional(Schema.String),
  attempts: Schema.Array(StudentAssignmentAttempt),
  submission: Schema.NullOr(StudentAssignmentSubmission),
  owed: Schema.Boolean,
}).annotate({ identifier: "JolliApi.StudentAssignmentAgentPart" })
export interface StudentAssignmentAgentPart extends Schema.Schema.Type<typeof StudentAssignmentAgentPart> {}

/**
 * A part of any other kind — a File upload task, and whatever kind comes after it. jolliedu
 * `StudentFileTask`, trimmed to what every kind carries.
 *
 * ⚠ NO AGENT, SO NEVER WORKED HERE. It is read only so the assignment's dialog can list it as a task
 * done on the web, and count it among the tasks owed before turning in.
 *
 * ⚠ NEVER AN AGENT PART. One that failed its own schema must fail the read, as it did before kinds:
 * taken for this, it would be offered on the web, lose its attempts here, and a hand-in to it would
 * read as not landed.
 */
export const StudentAssignmentOtherPart = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String.check(Schema.makeFilter((kind) => kind !== "agent")),
  name: Schema.String,
  submission: Schema.NullOr(Schema.Struct({ submittedAt: Schema.String })),
  owed: Schema.Boolean,
}).annotate({ identifier: "JolliApi.StudentAssignmentOtherPart" })
export interface StudentAssignmentOtherPart extends Schema.Schema.Type<typeof StudentAssignmentOtherPart> {}

/**
 * One part, from the student's side, by its kind. jolliedu `StudentAssignmentTask`.
 *
 * ⚠ AN AGENT PART IS TRIED FIRST: a part of another kind has none of its agent's fields, and fails it.
 */
export const StudentAssignmentPart = Schema.Union([StudentAssignmentAgentPart, StudentAssignmentOtherPart]).annotate({
  identifier: "JolliApi.StudentAssignmentPart",
})
export type StudentAssignmentPart = typeof StudentAssignmentPart.Type

/**
 * One assignment as its student sees it. jolliedu `StudentAssignment`, trimmed.
 *
 * ⚠ `parts` ARE THE LIVE PARTS IN WORKSHEET ORDER, so a part's place in it is the "Task 2" the gateway
 * names it by in a hand-in preview.
 */
export const StudentAssignment = Schema.Struct({
  id: Schema.Number,
  courseId: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  opensAt: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.String),
  stopAtDue: Schema.Boolean,
  status: Schema.String,
  progress: AssignmentProgress,
  authorName: Schema.NullOr(Schema.String),
  parts: Schema.Array(StudentAssignmentPart),
}).annotate({ identifier: "JolliApi.StudentAssignment" })
export interface StudentAssignment extends Schema.Schema.Type<typeof StudentAssignment> {}

/** jolliedu `HandedInCommit`: one commit of the project a session reports. */
export const HandedInCommit = Schema.Struct({
  sha: Schema.String,
  shortSha: Schema.String,
  subject: Schema.String,
  committedAt: Schema.String,
  pushed: Schema.Boolean,
}).annotate({ identifier: "JolliApi.HandedInCommit" })
export interface HandedInCommit extends Schema.Schema.Type<typeof HandedInCommit> {}

/** jolliedu `JolliCodeProjectReport`: what this client read of the repository. */
export interface ProjectReport {
  readonly remoteUrl: string | null
  readonly branch: string | null
  readonly commits: ReadonlyArray<HandedInCommit>
}

/** jolliedu `HandedInProject`: the report, with the pull requests the gateway found. */
export const HandedInProject = Schema.Struct({
  remoteUrl: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  commits: Schema.Array(HandedInCommit),
  pullRequests: Schema.Array(Schema.Struct({ url: Schema.String, number: Schema.Number })),
}).annotate({ identifier: "JolliApi.HandedInProject" })
export interface HandedInProject extends Schema.Schema.Type<typeof HandedInProject> {}

/**
 * jolliedu `AssignmentSummaryDraft`: the summary written, or why none could be.
 *
 * ⚠ `reason` IS OPEN: a failure this client has not heard of is still a failure.
 */
const SummaryDraft = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), throughSeq: Schema.Number, summary: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), throughSeq: Schema.Number, reason: Schema.String }),
])

/** jolliedu `JolliCodeHandInPreview`: what handing a session in would hand in, for the student to approve. */
export const HandInPreview = Schema.Struct({
  assignmentTitle: Schema.String,
  taskTitle: Schema.String,
  staffLabel: Schema.String,
  messageCount: Schema.Number,
  throughSeq: Schema.Number,
  includes: AssignmentTurnIn,
  summary: Schema.NullOr(SummaryDraft),
  reflectionPrompt: Schema.NullOr(Schema.String),
  reflection: Schema.NullOr(Schema.String),
  project: Schema.NullOr(HandedInProject),
}).annotate({ identifier: "JolliApi.HandInPreview" })
export interface HandInPreview extends Schema.Schema.Type<typeof HandInPreview> {}

/** jolliedu `JolliCodeHandInResult`: the part as it now stands, and how many tasks are still owed. */
export const HandInResult = Schema.Struct({
  part: StudentAssignmentAgentPart,
  owedCount: Schema.Number,
}).annotate({ identifier: "JolliApi.HandInResult" })
export interface HandInResult extends Schema.Schema.Type<typeof HandInResult> {}

// ── The calls ───────────────────────────────────────────────────────────────────────────────────

const retry = Schedule.exponential(200).pipe(Schedule.jittered)

const get = Effect.fn("Jolli.get")(function* <A, I>(request: GatewayRequest, path: string, schema: Schema.Codec<A, I>) {
  const http = HttpClient.filterStatusOk(
    (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({ retryOn: "errors-and-responses", times: 2, schedule: retry }),
    ),
  )
  return yield* HttpClientRequest.get(new URL(path, request.origin).toString()).pipe(
    HttpClientRequest.bearerToken(request.token),
    HttpClientRequest.setHeader("User-Agent", Brand.userAgent()),
    // The API is mounted on the origin, so a path-addressed tenant names itself in a header.
    request.tenantSlug ? HttpClientRequest.setHeader("x-tenant-slug", request.tenantSlug) : (r) => r,
    // After the home tenant's header, so the scope's tenant wins rather than being appended to it.
    HttpClientRequest.setHeaders(orgScopeHeaders(request.scope)),
    http.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.timeout("15 seconds"),
    Effect.catch((cause) => {
      /**
       * ⚠ THE `response` FIELD EXISTS EVEN WHEN THERE WAS NO RESPONSE. A transport failure — DNS,
       * a refused connection, the student's train going into a tunnel — is a `RequestError`, which
       * declares the field and leaves it undefined, so testing only for its presence and reaching
       * through it threw INSIDE the error constructor. That turned every offline request into a
       * defect, and a defect is not what `loadCatalog` catches: the stale-cache fallback never ran
       * and the sidecar's config load died instead.
       */
      const response = typeof cause === "object" && cause !== null && "response" in cause ? cause.response : undefined
      const status =
        typeof response === "object" && response !== null && "status" in response ? response.status : undefined
      return Effect.fail(
        new JolliApiError({
          path,
          ...(typeof status === "number" ? { status } : {}),
          message: `Jolli request failed: GET ${path}`,
          cause,
        }),
      )
    }),
  )
})

/**
 * A body-carrying request: the share writes and the rename.
 *
 * ⚠ NOT RETRIED, UNLIKE {@link get}. A write that timed out may still have landed, and the student
 * is looking at the panel that will say so on its next read — replaying it blind is how a grant the
 * student just withdrew comes back.
 *
 * ⚠ A NON-2XX ANSWER IS READ FOR ITS `code` BEFORE IT BECOMES AN ERROR. A refusal is an answer the
 * student can act on, and a status alone cannot tell "somebody outside the course" from "the
 * owner themselves".
 */
const send = Effect.fn("Jolli.send")(function* <A, I>(
  request: GatewayRequest,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  schema: Schema.Codec<A, I>,
  body?: unknown,
  timeout: Duration.Input = "15 seconds",
  headers: Readonly<Record<string, string>> = {},
) {
  const http = yield* HttpClient.HttpClient
  const url = new URL(path, request.origin).toString()
  const failed = (cause: unknown, status?: number, refusal?: { code?: string; explanation?: string }) =>
    new JolliApiError({
      path,
      ...(status === undefined ? {} : { status }),
      ...(refusal?.code === undefined ? {} : { code: refusal.code }),
      ...(refusal?.explanation === undefined ? {} : { explanation: refusal.explanation }),
      message: `Jolli request failed: ${method} ${path}`,
      cause,
    })
  const response = yield* HttpClientRequest.make(method)(url).pipe(
    HttpClientRequest.bearerToken(request.token),
    HttpClientRequest.setHeader("User-Agent", Brand.userAgent()),
    request.tenantSlug ? HttpClientRequest.setHeader("x-tenant-slug", request.tenantSlug) : (r) => r,
    // After the home tenant's header, so the scope's tenant wins rather than being appended to it.
    HttpClientRequest.setHeaders(orgScopeHeaders(request.scope)),
    HttpClientRequest.setHeaders(headers),
    body === undefined ? Effect.succeed : HttpClientRequest.bodyJson(body),
    Effect.flatMap((r) => http.execute(r)),
    Effect.timeout(timeout),
    Effect.mapError((cause) => failed(cause)),
  )
  if (response.status >= 200 && response.status < 300) {
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError((cause) => failed(cause, response.status)),
    )
  }
  const refusal = yield* response.json.pipe(
    Effect.map(refusalOf),
    Effect.orElseSucceed(() => undefined),
  )
  return yield* Effect.fail(failed(undefined, response.status, refusal))
})

/** The `code` and the student's sentence (`error`) a refusal's body carries, each when it is a string. */
function refusalOf(json: unknown) {
  if (typeof json !== "object" || json === null) return undefined
  return {
    ...("code" in json && typeof json.code === "string" ? { code: json.code } : {}),
    ...("error" in json && typeof json.error === "string" ? { explanation: json.error } : {}),
  }
}

/**
 * Every course the signed-in user can see in every org they belong to, each tagged with its org.
 * NOT only theirs — see `CourseListItem.viewerRole`.
 *
 * ⚠ ASK IT UNSCOPED. The answer names as `home` the org the request ran in, and a scoped read
 * answers as if the scope were home; the catalogue reads `home` to keep home ids bare.
 */
export const fetchMyCourses = (request: GatewayRequest) => get(request, "/api/me/courses", MyCourses)

/** The home org's courses alone, untagged: the list a server without {@link fetchMyCourses}'s `home` still answers. */
export const fetchCourses = (request: GatewayRequest) => get(request, "/api/courses", Schema.Array(CourseListItem))

/** The server stores private instructions and returns only an immutable message reference. */
export type SkillInvocationSource = { readonly messageId: string; readonly toolIndex: number }

export const createCourseSkillReference = (
  request: GatewayRequest,
  input: {
    readonly sessionID: string
    readonly skillId: number
    readonly toolCallId: string
    readonly name: string
    readonly turnId?: string
    readonly source?: SkillInvocationSource
  },
) =>
  send(
    request,
    "POST",
    `/api/agent/convos/${encodeURIComponent(input.sessionID)}/skills/${input.skillId}/invocations`,
    CourseSkillReference,
    {
      toolCallId: input.toolCallId,
      name: input.name,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.source ? { source: input.source } : {}),
    },
  )

export const ForkedSkillReference = Schema.Struct({ sourceMessageId: Schema.Number, reference: CourseSkillReference })
export type ForkedSkillReference = typeof ForkedSkillReference.Type

export const forkCourseSkills = (
  request: GatewayRequest,
  input: {
    readonly sourceSessionID: string
    readonly sessionID: string
    readonly references: ReadonlyArray<CourseSkillReference>
  },
) =>
  send(
    request,
    "POST",
    `/api/agent/convos/${encodeURIComponent(input.sourceSessionID)}/skills/fork`,
    Schema.Array(ForkedSkillReference),
    { publicSessionId: input.sessionID, references: input.references },
  )

export const fetchCourseSkills = (request: GatewayRequest, sessionID: string) =>
  get(request, `/api/agent/convos/${encodeURIComponent(sessionID)}/skills`, Schema.Array(CourseSkillChoice))

/** What a course turn's reply carries beside its text, as the gateway decided it for that turn. */
export const CourseTurnLinks = Schema.Struct({ assignmentsUrl: Schema.NullOr(Schema.String) })
export type CourseTurnLinks = Schema.Schema.Type<typeof CourseTurnLinks>

/**
 * The links a finished course turn's reply carries, by the turn id the gateway was handed for its
 * steps — the student message that opened it. Null where there is nothing to draw.
 */
export const fetchCourseTurnLinks = (request: GatewayRequest, sessionID: string, turnID: string) =>
  get(
    request,
    `/api/agent/convos/${encodeURIComponent(sessionID)}/turns/${encodeURIComponent(turnID)}/course-links`,
    CourseTurnLinks,
  )

/**
 * The MCP servers the tenant wants a Jolli Code session to connect to, keyed by server name. Each
 * entry stays unknown here: the config loader decides what a usable entry looks like.
 */
export const fetchMcpConfig = (request: GatewayRequest) =>
  get(request, "/api/jollicode/mcp-config", Schema.Struct({ mcp: Schema.Record(Schema.String, Schema.Unknown) }))

/** The `live` assistants of one course, default first. 404 means "no permission" OR "no course". */
export const fetchAssistantChoices = (request: GatewayRequest, courseId: number) =>
  get(request, `/api/courses/${courseId}/assistant-choices`, Schema.Array(CourseAssistantChoice))

/**
 * A chat model with its owning provider's wire protocol denormalised onto it.
 *
 * ⚠ `protocol` IS NOT ON THE WIRE `AgentModel` — jolliedu declares it on the
 * `AgentModelProvider` group and every model inside that group inherits it. The
 * wire schema stays faithful to what the gateway returns; this shape is what
 * downstream code (`toProviderModels`, `modelKey`) needs to route one call to
 * the right upstream SDK.
 */
export interface CatalogModel extends AgentModel {
  readonly protocol: string
  /**
   * The owning provider's display name (e.g. `Anthropic`), which pickers group by.
   *
   * ⚠ OPTIONAL BECAUSE SCHEMA-2 CACHE FILES PREDATE IT. Such a snapshot still routes correctly, and
   * `toProviderModels` labels its groups with the protocol (`openai`) until the next refresh, so it
   * is not worth a schema bump that would throw an offline student's whole catalogue away. Without
   * that fallback the group would be labelled with its provider id.
   */
  readonly vendor?: string
}

/**
 * The whole chat-model catalogue, flattened to `UUID -> model + its protocol`.
 *
 * ⚠ EACH MODEL CARRIES ITS PROVIDER'S PROTOCOL AND NAME. Downstream code (the provider
 * config generator, the assistant mapper) uses the protocol to decide which `@ai-sdk/*`
 * package to route the call through and which HTTP path to hit, and the name to label the
 * picker group, so a vendor the gateway adds is shown by its own name without a client release.
 *
 * ⚠ A DISABLED PROVIDER TAKES ITS WHOLE GROUP WITH IT, which is the field's documented meaning.
 */
export const fetchModelIndex = (request: GatewayRequest) =>
  get(request, "/api/agent/models", Schema.Array(AgentModelProvider)).pipe(
    Effect.map((providers) => {
      const index = new Map<string, CatalogModel>()
      for (const provider of providers) {
        if (!provider.isActive) continue
        for (const model of provider.models) {
          if (model.isActive) index.set(model.id, { ...model, protocol: provider.protocol, vendor: provider.name })
        }
      }
      return index
    }),
  )

/**
 * Who may read one of the caller's conversations, by the public ID this client declared for it.
 *
 * ⚠ 404 MEANS "NOT YOURS OR NOT THERE", DELIBERATELY INDISTINGUISHABLE — jolliedu answers both the
 * same so ids cannot be enumerated. For a session this client owns it almost always means the first
 * message has not reached the gateway yet.
 */
export const fetchConversationVisibility = (request: GatewayRequest, sessionID: string) =>
  get(request, `/api/agent/convos/${encodeURIComponent(sessionID)}`, ConversationDetail).pipe(
    Effect.map((detail) => detail.visibility),
  )

/**
 * The same visibility, from the owner's read that carries nothing else — cheap enough to ask for
 * every session a header shows.
 *
 * ⚠ ITS 404 IS THE DETAIL'S: "not yours or not there", which for a session this client owns means
 * unsynced. Never retried against the detail — that would put the unpaged timeline back behind
 * every header this read was made cheap for.
 */
export const fetchConversationShares = (request: GatewayRequest, sessionID: string) =>
  get(request, `/api/agent/convos/${encodeURIComponent(sessionID)}/shares`, ConversationVisibility)

/**
 * Name one of the caller's conversations, so the web lists it by the title this client shows.
 *
 * ⚠ THE GATEWAY NEVER LEARNS A TITLE ANY OTHER WAY. It creates a coding-agent conversation from the
 * first model call's headers, with no title and auto-titling off, so without this the web shows it
 * as untitled forever. The answer is the whole conversation detail, timeline included; nothing in it
 * is read.
 */
export const renameConversation = (request: GatewayRequest, sessionID: string, title: string) =>
  send(request, "PATCH", `/api/agent/convos/${encodeURIComponent(sessionID)}`, Schema.Unknown, { title }).pipe(
    Effect.asVoid,
  )

/** Everybody seated in one course, staff and students both. */
export const fetchCourseMembers = (request: GatewayRequest, courseId: number) =>
  get(request, `/api/spaces/${courseId}/members`, Schema.Array(SpaceMember))

/**
 * Name a reader — one person by user id, or `everyone` for the course's class.
 *
 * ⚠ THE FIELD IS `subjectUserId` EVEN FOR THE CLASS, which is jolliedu keeping deployed clients
 * working rather than a mistake here. A refusal fails with `status: 400` and the reason in `code`.
 */
export const shareConversation = (
  request: GatewayRequest,
  sessionID: string,
  subject: number | "everyone",
  access: string,
) =>
  send(request, "POST", `/api/agent/convos/${encodeURIComponent(sessionID)}/shares`, ConversationVisibility, {
    subjectUserId: subject,
    access,
  })

/** Take one grant back. Removing a grant that was not there is not an error. */
export const unshareConversation = (request: GatewayRequest, sessionID: string, subject: number | "everyone") =>
  send(
    request,
    "DELETE",
    `/api/agent/convos/${encodeURIComponent(sessionID)}/shares/${subject}`,
    ConversationVisibility,
  )

/**
 * CREATE THE CONVERSATION ON THE GATEWAY BEFORE THE STUDENT HAS SAID ANYTHING, UNDER THE ID THIS
 * CLIENT WILL USE LOCALLY, AND ANSWER WITH THE AGENT'S OPENER WHEN IT HAS ONE.
 *
 * ⚠ 45 SECONDS, NOT `send`'S 15. A dynamic opener is a model call the server budgets twenty seconds
 * for, made before it answers; the shorter wait would give up on every one that is merely slow.
 *
 * ⚠ RETRIED ONCE, WITH THE SAME ID, ONLY WHEN NO RESPONSE CAME BACK AT ALL. The call is idempotent
 * by id — a second request returns the row the first one made, opener included, without writing a
 * new one — so a dropped connection is safe to replay. A timeout is not retried: the first request
 * may still be generating, and stacking a second 45 seconds behind it is a wait no student sits
 * through. An HTTP status is an answer and is never retried.
 *
 * ⚠ A FAILURE IS NEVER "NO OPENER". The server may have stored one the student did not see, and
 * entering the chat as though it had not would leave the model answering a greeting nobody read.
 * Refusals carry the gateway's `code` (`assistant_not_open`, `assistant_closed`,
 * `session_binding_conflict`, `session_not_found`); a 404 with no code is a course or assistant
 * that is gone.
 *
 * ⚠ THE ID IS SAFE TO CHOOSE CLIENT-SIDE because a session id carries far more entropy than anyone
 * could guess, which is what makes "this id is taken" — visible as 404 versus 201 — tell nobody
 * anything.
 */
export const openConversation = (
  request: GatewayRequest,
  input: { spaceId: number; courseAssistantId: number; publicSessionId: string },
) =>
  send(
    request,
    "POST",
    "/api/agent/convos",
    OpenedConversation,
    {
      spaceId: input.spaceId,
      courseAssistantId: input.courseAssistantId,
      origin: "coding_agent",
      publicSessionId: input.publicSessionId,
    },
    "45 seconds",
  ).pipe(
    Effect.retry({ times: 1, while: (error) => error.status === undefined && isTransportFailure(error.cause) }),
    Effect.map((detail) => ({ opener: detail.config?.opener?.text })),
  )

/** No response at all — not a timeout, not a body we could not read. */
function isTransportFailure(cause: unknown) {
  return HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError"
}

// ── A student's assignments ─────────────────────────────────────────────────────────────────────

const assignmentsOf = (courseId: number) => `/api/courses/${courseId}/assignments`
const partOf = (courseId: number, assignmentId: number, partId: number) =>
  `${assignmentsOf(courseId)}/${assignmentId}/parts/${partId}`

/**
 * One course's assignments, as its student's Assignments tab groups them.
 *
 * ⚠ A STUDENT'S READ ONLY. Staff are answered the same path with an empty student's view, which is
 * nothing this client could work in; the course list leaves staff's courses out before this is asked.
 */
export const fetchStudentAssignments = (request: GatewayRequest, courseId: number) =>
  get(request, `${assignmentsOf(courseId)}/student-view`, StudentAssignmentList)

/** One assignment with the student's own work. 404 is a draft, or not theirs; one not open is refused. */
export const fetchStudentAssignment = (request: GatewayRequest, courseId: number, assignmentId: number) =>
  get(request, `${assignmentsOf(courseId)}/${assignmentId}/student-view`, StudentAssignment)

/**
 * START A TASK'S SESSION ON THE GATEWAY, UNDER THE ID THIS CLIENT WILL USE LOCALLY.
 *
 * ⚠ {@link openConversation}'S RULES, FOR ITS REASONS. 45 seconds, because the opener is a model call
 * made before the answer; retried once under the same id when no response came back at all, because
 * the route is idempotent by id. A refusal carries the gateway's `code` and its `explanation`. The
 * answer's `binding` is the course and agent to record the session under.
 */
export const startTaskSession = (
  request: GatewayRequest,
  input: { courseId: number; assignmentId: number; partId: number; publicSessionId: string },
) =>
  send(
    request,
    "POST",
    `${partOf(input.courseId, input.assignmentId, input.partId)}/jolli-code/sessions`,
    StartedTaskSession,
    { publicSessionId: input.publicSessionId },
    "45 seconds",
    { [JOLLI_CODE_PARTICIPATION_HEADER]: JOLLI_CODE_PARTICIPATION_VERSION },
  ).pipe(
    Effect.retry({ times: 1, while: (error) => error.status === undefined && isTransportFailure(error.cause) }),
    Effect.map((detail) => ({
      opener: detail.config?.opener?.text,
      binding: { courseId: String(detail.courseId), assistantId: String(detail.courseAssistantId) },
    })),
  )

/** What a task's hand-in names: the session, the student's reflection, the project as this machine read it. */
export interface HandInInput {
  readonly courseId: number
  readonly assignmentId: number
  readonly partId: number
  readonly publicSessionId: string
  readonly reflection?: string
  readonly project?: ProjectReport
}

const handInBody = (input: HandInInput) => ({
  publicSessionId: input.publicSessionId,
  ...(input.reflection === undefined ? {} : { reflection: input.reflection }),
  ...(input.project === undefined ? {} : { project: input.project }),
})

/**
 * WHAT HANDING THE SESSION IN WOULD HAND IN, CHECKED AS THE HAND-IN WILL BE.
 *
 * ⚠ 90 SECONDS. The gateway writes the summary before it answers, a model call over the whole
 * session; `send`'s 15 would give up on every long one. Not retried: a second request would write
 * the summary twice.
 */
export const previewHandIn = (request: GatewayRequest, input: HandInInput) =>
  send(
    request,
    "POST",
    `${partOf(input.courseId, input.assignmentId, input.partId)}/jolli-code/preview`,
    HandInPreview,
    handInBody(input),
    "90 seconds",
  )

/**
 * HAND THE SESSION IN, UP TO WHERE ITS PREVIEW ENDED IT.
 *
 * ⚠ NOT RETRIED. A hand-in that timed out may have landed, and a second one is refused as already
 * handed in — a refusal the student would read as their work being lost.
 */
export const handIn = (request: GatewayRequest, input: HandInInput & { readonly throughSeq: number }) =>
  send(
    request,
    "POST",
    `${partOf(input.courseId, input.assignmentId, input.partId)}/jolli-code/hand-in`,
    HandInResult,
    { ...handInBody(input), throughSeq: input.throughSeq },
    "30 seconds",
  )

/** Turn the whole assignment in. The answer is the assignment as it now stands. */
export const turnInAssignment = (request: GatewayRequest, input: { courseId: number; assignmentId: number }) =>
  send(request, "POST", `${assignmentsOf(input.courseId)}/${input.assignmentId}/turn-in`, StudentAssignment)
