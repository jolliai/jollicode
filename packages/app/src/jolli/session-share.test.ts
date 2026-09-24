import { describe, expect, test } from "bun:test"
import type { Jolli } from "@opencode-ai/schema/jolli"
import {
  applyWrite,
  initials,
  matchCandidates,
  pickerState,
  shareCandidates,
  staffCanRead,
  writeRefusal,
} from "./session-share"

const grace: Jolli.SessionReader = { kind: "person", userId: 2, name: "Grace Hopper", access: "view" }
const alan: Jolli.SessionReader = { kind: "person", userId: 3, name: "Alan Turing", access: "view" }
const everyone: Jolli.SessionReader = { kind: "class", classSize: 40, access: "view" }

const members: Jolli.ShareMember[] = [
  { userId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", kind: "staff" },
  { userId: 3, name: "Alan Turing", detail: "alan@jolli.ai", kind: "student" },
  { userId: 4, name: "Barbara Liskov", detail: "barbara@mit.edu", kind: "student" },
]

const share = (patch: Partial<Jolli.SessionShare> = {}): Jolli.SessionShare => ({
  status: "ok",
  courseId: 7,
  courseCode: "CS 310",
  readers: [],
  members,
  classSize: 40,
  roster: "ok",
  ...patch,
})

describe("shareCandidates", () => {
  test("drops people who already hold a grant", () => {
    expect(shareCandidates(members, [grace]).map((m) => m.userId)).toEqual([3, 4])
  })

  test("takes nobody out for the class grant", () => {
    expect(shareCandidates(members, [everyone])).toHaveLength(3)
  })
})

describe("matchCandidates", () => {
  test("matches by name or by the address the picker never draws", () => {
    expect(matchCandidates(members, "  hop ").map((m) => m.userId)).toEqual([2])
    expect(matchCandidates(members, "mit.edu").map((m) => m.userId)).toEqual([4])
    expect(matchCandidates(members, "")).toHaveLength(3)
  })
})

describe("applyWrite", () => {
  test("replaces the readers whole and keeps the read's roster", () => {
    const next = applyWrite(share(), share({ readers: [alan], members: [], classSize: 0 }))
    expect(next.readers).toEqual([alan])
    expect(next.members).toBe(members)
    expect(next.classSize).toBe(40)
    expect(writeRefusal(share())).toBeUndefined()
  })

  test("leaves the panel alone on a refusal and says why", () => {
    const current = share({ readers: [grace] })
    const refused = share({ status: "refused", refusal: "subject_not_in_course", readers: [] })
    expect(applyWrite(current, refused)).toBe(current)
    expect(writeRefusal(refused)).toBe("subject_not_in_course")
  })

  test("words an unreachable gateway as the generic failure", () => {
    expect(writeRefusal(share({ status: "unreachable" }))).toBe("unknown")
  })

  test("marks the answer ok once a write lands", () => {
    expect(applyWrite(share({ status: "unreachable" }), share({ readers: [alan] })).status).toBe("ok")
  })
})

describe("staffCanRead", () => {
  test("opens for a named grant to somebody the roster lists as staff", () => {
    expect(staffCanRead(share({ readers: [grace] }))).toBe(true)
  })

  test("opens for the class grant, which admits staff too", () => {
    expect(staffCanRead(share({ readers: [everyone] }))).toBe(true)
  })

  test("stays shut for grants to students only", () => {
    expect(staffCanRead(share({ readers: [alan] }))).toBe(false)
  })

  /** ⚠ FAILS CLOSED: no roster means nobody is known to be staff. */
  test("stays shut when the roster could not be read", () => {
    expect(staffCanRead(share({ readers: [grace], members: [] }))).toBe(false)
  })

  test("stays shut for anything short of an ok answer", () => {
    expect(staffCanRead(undefined)).toBe(false)
    expect(staffCanRead(share({ status: "unsynced", readers: [everyone] }))).toBe(false)
    expect(staffCanRead(share({ status: "unreachable", readers: [everyone] }))).toBe(false)
  })
})

describe("pickerState", () => {
  test("offers whoever is left", () => {
    expect(pickerState(share(), members)).toBe("pick")
  })

  /** ⚠ THE BUG THIS EXISTS FOR: an unreadable roster is not "everyone can already read it". */
  test("says the roster could not be read rather than that everyone has access", () => {
    expect(pickerState(share({ members: [], roster: "unavailable" }), [])).toBe("roster-unavailable")
  })

  test("tells a course with nobody else in it apart from one where everybody is added", () => {
    expect(pickerState(share({ members: [] }), [])).toBe("nobody-else")
    expect(pickerState(share(), shareCandidates(members, [grace, alan, { ...alan, userId: 4 }]))).toBe("exhausted")
  })
})

describe("initials", () => {
  test("takes the first and last words, like the web's avatars", () => {
    expect(initials("Sam Li")).toBe("SL")
    expect(initials("  grace  brewster murray hopper ")).toBe("GH")
    expect(initials("ada@jolli.ai")).toBe("A")
    expect(initials("李雷")).toBe("李")
    expect(initials("")).toBe("")
  })
})
