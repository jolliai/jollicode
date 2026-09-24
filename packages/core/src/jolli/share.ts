/**
 * TURNING JOLLI EDU'S SHARE ANSWERS INTO WHAT THE SHARE PANEL RENDERS.
 *
 * Ported from jolliedu's `ConversationShareRows.ts` and `SpaceRoleLadder.ts`, the two places the web
 * product decides who a chat may be shown to. The web panel and this one must offer the same people
 * for the same course, so the rules below are theirs, not new ones.
 *
 * ⚠ EVERYTHING HERE IS PURE, like `catalog.ts`. Fetching is `api.ts`; the sidecar's
 * `/jolli/session/:sessionID/share` handler strings the two together.
 */
import { Jolli } from "@opencode-ai/schema/jolli"
import type { ConversationVisibility, SpaceMember } from "./api"

/**
 * THE ONE LEVEL A GRANT MAY BE WRITTEN AT, today.
 *
 * ⚠ jolliedu's `WRITABLE_SHARE_ACCESSES[0]`. When `comment` becomes writable there, the panel grows a
 * chooser; until then there is nothing to choose and no chooser.
 */
export const WRITABLE_ACCESS = "view" satisfies Jolli.ShareAccess

/** jolliedu `COURSE_STAFF_ROLES`. */
const STAFF_ROLES = ["space-owner", "space-manager", "course-instructor"]

/** jolliedu `COURSE_STUDENT_ROLES`. */
const STUDENT_ROLES = ["course-student", "space-contributor", "space-viewer"]

/**
 * THE GRANTS, AS ROWS.
 *
 * ⚠ AN ABSENT `shares` IS NOBODY. The gateway omits the list for anybody but the owner, and these
 * routes only ever ask as the owner — so absence is a list withheld, and inventing readers from it
 * would be worse than showing none.
 */
export function projectReaders(visibility: ConversationVisibility): Jolli.SessionReader[] {
  return (visibility.shares ?? []).map((share) =>
    share.subjectIsClass
      ? { kind: "class" as const, classSize: share.classSize, access: accessOf(share.access) }
      : {
          kind: "person" as const,
          userId: share.subjectUserId,
          name: share.name,
          ...(share.detail ? { detail: share.detail } : {}),
          access: accessOf(share.access),
        },
  )
}

/**
 * THE COURSE'S ROSTER, AS THE PICKER MAY OFFER IT.
 *
 * - ⚠ **The signed-in student is dropped.** They already read it, and a grant addressed to the
 *   owner is refused on write (`subject_is_owner`). Matched by email because the token's identity
 *   is the only one this process holds — the convo read carries no owner id.
 * - ⚠ **A role the course ladder does not recognise is dropped**, rather than defaulted into a
 *   group. An unrecognised role is a row to look at, not a classmate.
 *
 * People who already hold a grant are NOT dropped here: the grants change with every write and the
 * roster does not, so that filter belongs to the renderer, which holds both.
 */
export function projectMembers(members: readonly SpaceMember[], viewerEmail: string | undefined): Jolli.ShareMember[] {
  const viewer = viewerEmail?.toLowerCase()
  return members.flatMap((member) => {
    if (viewer && member.userEmail.toLowerCase() === viewer) return []
    const kind = roleKind(member.role)
    if (!kind) return []
    return [
      {
        userId: member.userId,
        name: member.userName ?? member.userEmail,
        ...(member.userName ? { detail: member.userEmail } : {}),
        kind,
      },
    ]
  })
}

/** jolliedu `classSizeOf`: the students a course seats, counted over the WHOLE roster. */
export function classSizeOf(members: readonly SpaceMember[]) {
  return members.filter((member) => roleKind(member.role) === "student").length
}

/**
 * A REFUSAL CODE, NARROWED. Anything this client has not heard of is `unknown`, so a screen never
 * prints a wire code at a student.
 */
export function refusalOf(code: string | undefined): Jolli.ShareRefusal {
  if (
    code === "access_not_writable" ||
    code === "subject_not_in_course" ||
    code === "subject_is_owner" ||
    code === "conversation_has_no_course"
  )
    return code
  return "unknown"
}

/** jolliedu `courseRoleKind`. */
function roleKind(role: string) {
  if (STAFF_ROLES.includes(role)) return "staff" as const
  if (STUDENT_ROLES.includes(role)) return "student" as const
  return undefined
}

/**
 * ⚠ AN UNKNOWN LEVEL READS AS `view`, THE NARROWEST ONE. Showing a grant as less than it is costs a
 * label; showing it as more would tell a student somebody can do something they cannot.
 */
function accessOf(access: string): Jolli.ShareAccess {
  return access === "comment" ? "comment" : "view"
}
