import { describe, expect, test } from "bun:test"
import { classSizeOf, projectMembers, projectReaders, refusalOf } from "../src/jolli/share"

const member = (userId: number, role: string, userName: string | null, userEmail: string) => ({
  userId,
  role,
  userName,
  userEmail,
})

describe("projectReaders", () => {
  test("keeps both kinds of grant, in the gateway's order", () => {
    expect(
      projectReaders({
        courseCode: "CS 310",
        courseId: 7,
        mayControl: true,
        shares: [
          { subjectIsClass: false, subjectUserId: 4, name: "Grace Hopper", detail: "grace@jolli.ai", access: "view" },
          { subjectIsClass: true, classSize: 42, access: "view" },
        ],
      }),
    ).toEqual([
      { kind: "person", userId: 4, name: "Grace Hopper", detail: "grace@jolli.ai", access: "view" },
      { kind: "class", classSize: 42, access: "view" },
    ])
  })

  test("reads a withheld list as nobody rather than failing", () => {
    expect(projectReaders({ courseCode: null, courseId: null, mayControl: true })).toEqual([])
  })

  test("omits an absent detail and narrows an unheard-of level to view", () => {
    expect(
      projectReaders({
        courseCode: "CS 310",
        courseId: 7,
        mayControl: true,
        shares: [{ subjectIsClass: false, subjectUserId: 4, name: "Grace", detail: null, access: "edit" }],
      }),
    ).toEqual([{ kind: "person", userId: 4, name: "Grace", access: "view" }])
  })
})

describe("projectMembers", () => {
  const roster = [
    member(1, "course-student", "Ada Lovelace", "ada@jolli.ai"),
    member(2, "course-instructor", "Grace Hopper", "grace@jolli.ai"),
    member(3, "space-viewer", null, "anon@jolli.ai"),
    member(4, "some-future-role", "Mystery", "mystery@jolli.ai"),
  ]

  test("groups by the course ladder and drops the signed-in student by email", () => {
    expect(projectMembers(roster, "ADA@jolli.ai")).toEqual([
      { userId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", kind: "staff" },
      { userId: 3, name: "anon@jolli.ai", kind: "student" },
    ])
  })

  test("counts the class over the whole roster, viewer included", () => {
    expect(classSizeOf(roster)).toBe(2)
  })

  test("drops nobody for being the viewer when the token names no address", () => {
    expect(projectMembers(roster, undefined).map((m) => m.userId)).toEqual([1, 2, 3])
  })
})

describe("refusalOf", () => {
  test("passes the four known codes through and folds everything else into unknown", () => {
    expect(refusalOf("subject_not_in_course")).toBe("subject_not_in_course")
    expect(refusalOf("subject_is_owner")).toBe("subject_is_owner")
    expect(refusalOf("conversation_has_no_course")).toBe("conversation_has_no_course")
    expect(refusalOf("access_not_writable")).toBe("access_not_writable")
    expect(refusalOf("something_new")).toBe("unknown")
    expect(refusalOf(undefined)).toBe("unknown")
  })
})
