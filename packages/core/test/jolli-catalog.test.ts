import { describe, expect, test } from "bun:test"
import type { AgentModel, CatalogModel, CourseAssistantChoice, CourseListItem } from "../src/jolli/api"
import {
  accentOf,
  assistantIconOf,
  courseEntryState,
  grantedModelIds,
  isOwnCourse,
  isVisibleCourse,
  toAssistant,
  toCourse,
  projectCatalog,
  toProviderModels,
  today,
} from "../src/jolli/catalog"

const course = (over: Partial<CourseListItem> = {}): CourseListItem => ({
  id: 7,
  name: "Systems Programming",
  description: null,
  code: "CS 310",
  status: "published",
  requiresCoding: true,
  endsOn: null,
  viewerRole: "course-student",
  isStaff: false,
  ...over,
})

const choice = (over: Partial<CourseAssistantChoice> = {}): CourseAssistantChoice => ({
  id: 12,
  name: "Pair programmer",
  blurb: "Works through the problem with you",
  icon: "Terminal",
  accent: 0,
  worksThroughProblems: true,
  answersFromMaterialsOnly: false,
  showCitations: true,
  modelId: "uuid-opus",
  allowedModelIds: ["uuid-opus", "uuid-haiku"],
  ...over,
})

const model = (
  id: string,
  name: string,
  category: AgentModel["category"] = null,
  protocol = "anthropic",
): CatalogModel => ({
  id,
  name,
  category,
  description: null,
  isActive: true,
  protocol,
})

const catalogue = new Map<string, CatalogModel>([
  ["uuid-opus", model("uuid-opus", "claude-opus-4-8", "Premium")],
  ["uuid-haiku", model("uuid-haiku", "claude-haiku-4-5", "Basic")],
])

describe("courseEntryState", () => {
  test("archived and draft win over any date", () => {
    expect(courseEntryState({ status: "archived", endsOn: null }, "2026-09-21")).toBe("archived")
    expect(courseEntryState({ status: "draft", endsOn: null }, "2026-09-21")).toBe("draft")
  })

  test("a published course with no dates is open", () => {
    expect(courseEntryState({ status: "published", endsOn: null }, "2026-09-21")).toBe("open")
  })

  // jolliedu's rule, quoted: both ends are INCLUSIVE.
  test("the last day of term has not ended yet", () => {
    expect(courseEntryState({ status: "published", endsOn: "2026-09-21" }, "2026-09-21")).toBe("open")
  })

  // ⚠ The one-day slack, which jolliedu's comment says not to tighten. There is no institution
  // timezone, so the margin belongs on the end that locks people out.
  test("a course that ended yesterday is still open, and the day before that is not", () => {
    expect(courseEntryState({ status: "published", endsOn: "2026-09-20" }, "2026-09-21")).toBe("open")
    expect(courseEntryState({ status: "published", endsOn: "2026-09-19" }, "2026-09-21")).toBe("ended")
  })

  test("a course whose first day is today has started", () => {
    expect(courseEntryState({ status: "published", startsOn: "2026-09-21", endsOn: null }, "2026-09-21")).toBe("open")
    expect(courseEntryState({ status: "published", startsOn: "2026-09-22", endsOn: null }, "2026-09-21")).toBe(
      "not-yet",
    )
  })

  // The list shape carries no startsOn, so this is what a real course list produces today.
  test("without startsOn a future course cannot be distinguished and reads as open", () => {
    expect(courseEntryState({ status: "published", endsOn: null }, "2026-01-01")).toBe("open")
  })

  test("comparisons are lexical, so a month boundary does not need date arithmetic", () => {
    expect(courseEntryState({ status: "published", endsOn: "2026-08-31" }, "2026-09-01")).toBe("open")
    expect(courseEntryState({ status: "published", endsOn: "2026-08-30" }, "2026-09-01")).toBe("ended")
  })
})

describe("today", () => {
  test("uses local calendar fields rather than an ISO conversion", () => {
    // 23:30 local on the 21st is still the 21st, whatever UTC thinks.
    expect(today(new Date(2026, 8, 21, 23, 30))).toBe("2026-09-21")
    expect(today(new Date(2026, 0, 5, 0, 15))).toBe("2026-01-05")
  })
})

describe("isOwnCourse / isVisibleCourse", () => {
  test("keeps the two course-level roles", () => {
    expect(isOwnCourse(course({ viewerRole: "course-student" }))).toBe(true)
    expect(isOwnCourse(course({ viewerRole: "course-instructor" }))).toBe(true)
  })

  // jolliedu seats the person who CREATED a course as space-owner, not course-instructor, so a
  // professor teaching their own course met an empty list while their co-teachers did not.
  test("keeps a course the viewer owns", () => {
    expect(isOwnCourse(course({ viewerRole: "space-owner" }))).toBe(true)
  })

  // jolliedu's COURSE_STUDENT_ROLES: an enrolment predating the course vocabulary, one made through
  // the add-member UI, or one seated by a course whose defaultMemberRole names either of these is a
  // student taking the course. Refusing them showed the course to its staff and to none of its class.
  test("keeps the legacy enrolment roles a student can hold", () => {
    expect(isOwnCourse(course({ viewerRole: "space-contributor" }))).toBe(true)
    expect(isOwnCourse(course({ viewerRole: "space-viewer" }))).toBe(true)
  })

  // An institution administrator sees every course in the org with an implicit space-manager role.
  test("drops the implicit sight an administrator has", () => {
    for (const role of ["space-manager", null] as const) {
      expect(isOwnCourse(course({ viewerRole: role }))).toBe(false)
    }
  })

  test("a non-coding course never reaches Jolli Code", () => {
    expect(isVisibleCourse(course({ requiresCoding: false }))).toBe(false)
  })

  // Being a draft or having ended must NOT remove a course — those are shown and refused.
  test("draft and archived courses stay visible", () => {
    expect(isVisibleCourse(course({ status: "draft" }))).toBe(true)
    expect(isVisibleCourse(course({ status: "archived" }))).toBe(true)
  })
})

describe("assistantIconOf", () => {
  test("keeps the glyph the professor picked on the web", () => {
    expect(assistantIconOf("Gavel")).toBe("Gavel")
    expect(assistantIconOf("MessageCircleQuestion")).toBe("MessageCircleQuestion")
  })

  test("wears the web's default for a name this client has not heard of", () => {
    expect(assistantIconOf("Rocket")).toBe("Sparkles")
    expect(assistantIconOf("")).toBe("Sparkles")
  })
})

describe("accentOf", () => {
  test("lands in 1..5 and is stable for an id", () => {
    for (const id of [0, 1, 4, 5, 9, 1234]) {
      const accent = accentOf(id)
      expect(accent).toBeGreaterThanOrEqual(1)
      expect(accent).toBeLessThanOrEqual(5)
    }
    expect(accentOf(7)).toBe(accentOf(7))
  })
})

describe("toCourse", () => {
  test("maps names across", () => {
    const mapped = toCourse({ item: course(), entryState: "open", assistantIds: ["12"] })
    expect(mapped.id).toBe("7")
    expect(mapped.title).toBe("Systems Programming")
    expect(mapped.code).toBe("CS 310")
    expect(mapped.kind).toBe("code")
    expect(mapped.assistantIds).toEqual(["12"])
  })

  test("omits an absent description rather than emitting null", () => {
    expect(toCourse({ item: course(), entryState: "open", assistantIds: [] }).description).toBeUndefined()
  })
})

describe("toAssistant", () => {
  test("prefixes grants with the provider and keeps the UUID as the model id", () => {
    const mapped = toAssistant({ choice: choice(), courseId: "7", isDefault: true, models: catalogue })
    expect(mapped.allowedModelIds).toEqual(["jolli-anthropic/uuid-opus", "jolli-anthropic/uuid-haiku"])
    expect(mapped.modelId).toBe("jolli-anthropic/uuid-opus")
    expect(mapped.isDefault).toBe(true)
  })

  // A grant naming a retired model would match nothing and empty the picker with no explanation.
  test("drops grants the catalogue no longer carries", () => {
    const mapped = toAssistant({
      choice: choice({ allowedModelIds: ["uuid-opus", "uuid-retired"] }),
      courseId: "7",
      isDefault: false,
      models: catalogue,
    })
    expect(mapped.allowedModelIds).toEqual(["jolli-anthropic/uuid-opus"])
    expect(mapped.isDefault).toBeUndefined()
  })

  // ⚠ Empty means UNRESTRICTED, so an empty grant must stay empty rather than become a list.
  test("an unrestricted assistant stays unrestricted", () => {
    const mapped = toAssistant({
      choice: choice({ allowedModelIds: [] }),
      courseId: "7",
      isDefault: false,
      models: catalogue,
    })
    expect(mapped.allowedModelIds).toEqual([])
  })

  test("a preferred model the catalogue dropped leaves modelId absent", () => {
    const mapped = toAssistant({
      choice: choice({ modelId: "uuid-retired" }),
      courseId: "7",
      isDefault: false,
      models: catalogue,
    })
    expect(mapped.modelId).toBeUndefined()
  })

  test("guardrails map from the student-facing flags and the cap stays zero", () => {
    const mapped = toAssistant({ choice: choice(), courseId: "7", isDefault: false, models: catalogue })
    expect(mapped.guardrails).toEqual({
      neverGiveDirectAnswers: true,
      restrictToMaterials: false,
      showCitations: true,
      weeklyTokenCap: 0,
    })
    expect(mapped.instructions).toBe("")
    expect(mapped.skills).toEqual([])
  })
})

describe("toProviderModels", () => {
  test("carries the catalogue's input modalities onto each model, and leaves them off where it has none", () => {
    const models = new Map([
      ["uuid-a", { ...model("uuid-a", "claude-sonnet-5"), inputModalities: ["text", "image", "pdf"] }],
      ["uuid-b", model("uuid-b", "claude-haiku-4-5")],
    ])

    const anthropic = toProviderModels(models)["anthropic"] ?? []

    expect(anthropic[0]?.inputModalities).toEqual(["text", "image", "pdf"])
    expect(anthropic[1]).not.toHaveProperty("inputModalities")
  })

  // Model names are not unique across vendors; the object is keyed by id, so ids must be.
  test("keys on the UUID and sends the name upstream, grouped by protocol", () => {
    const models = new Map([
      ["uuid-a", model("uuid-a", "gpt-5.5", "Premium", "openai")],
      ["uuid-b", model("uuid-b", "gpt-5.5", "Basic", "openai")],
    ])
    const mapped = toProviderModels(models)
    const openai = mapped["openai"] ?? []
    expect(openai.map((m) => m.id)).toEqual(["uuid-a", "uuid-b"])
    expect(openai.map((m) => m.upstreamId)).toEqual(["gpt-5.5", "gpt-5.5"])
    expect(new Set(openai.map((m) => m.id)).size).toBe(2)
  })

  test("shows the raw name, keeping the tier only to tell same-named models apart", () => {
    const models = new Map([
      ["uuid-a", model("uuid-a", "gpt-5.5", "Premium", "openai")],
      ["uuid-b", model("uuid-b", "gpt-5.5", "Basic", "openai")],
      ["uuid-c", model("uuid-c", "claude-haiku-4-5", "Basic", "anthropic")],
      ["uuid-d", model("uuid-d", "gpt-5.5", "Basic", "google")],
    ])
    const mapped = toProviderModels(models)
    expect(mapped["openai"]?.map((m) => m.name)).toEqual(["gpt-5.5 (Premium)", "gpt-5.5 (Basic)"])
    expect(mapped["anthropic"]?.map((m) => m.name)).toEqual(["claude-haiku-4-5"])
    expect(mapped["google"]?.map((m) => m.name)).toEqual(["gpt-5.5"])
  })

  test("names whatever tells same-named rows apart, the vendor, the tier, or both", () => {
    const vendored = (id: string, name: string, category: string, vendor: string) => ({
      ...model(id, name, category, "openai"),
      vendor,
    })
    const models = new Map([
      ["uuid-a", vendored("uuid-a", "gpt-5.5", "Basic", "OpenAI")],
      ["uuid-b", vendored("uuid-b", "gpt-5.5", "Basic", "Azure")],
      ["uuid-c", vendored("uuid-c", "o4", "Premium", "OpenAI")],
      ["uuid-d", vendored("uuid-d", "o4", "Basic", "Azure")],
    ])
    expect(toProviderModels(models)["openai"]?.map((m) => m.name)).toEqual([
      "gpt-5.5 (OpenAI)",
      "gpt-5.5 (Azure)",
      "o4 (OpenAI, Premium)",
      "o4 (Azure, Basic)",
    ])
  })

  test("labels only what the student's courses grant", () => {
    const models = new Map([
      ["uuid-a", model("uuid-a", "gpt-5.5", "Premium", "openai")],
      ["uuid-b", { ...model("uuid-b", "gpt-5.5", "Basic", "openai"), vendor: "OpenAI" }],
      ["uuid-c", { ...model("uuid-c", "deepseek-v4", "Basic", "openai"), vendor: "DeepSeek" }],
    ])
    const openai = toProviderModels(models, new Set(["uuid-b"]))["openai"]
    // One granted row needs no suffix, and an ungranted vendor names no group.
    expect(openai?.map((m) => m.name)).toEqual(["gpt-5.5", "gpt-5.5", "deepseek-v4"])
    expect(openai?.map((m) => m.vendor)).toEqual([undefined, "OpenAI", undefined])
    // Still declared: the grant in force is the app's to apply.
    expect(openai?.map((m) => m.id)).toEqual(["uuid-a", "uuid-b", "uuid-c"])
  })

  test("carries the gateway vendor name through to each model, or the protocol without one", () => {
    const models = new Map([
      ["uuid-a", { ...model("uuid-a", "gpt-5.5", "Premium", "openai"), vendor: "OpenAI" }],
      ["uuid-b", model("uuid-b", "claude-haiku-4-5", "Basic", "anthropic")],
    ])
    const mapped = toProviderModels(models)
    expect(mapped["openai"]?.[0]?.vendor).toBe("OpenAI")
    // A schema-2 cache entry predates the field; its protocol stands in rather than a blank.
    expect(mapped["anthropic"]?.[0]?.vendor).toBe("anthropic")
    // A protocol this client has no SDK for still reads as what the gateway called it, not as the
    // protocol it is routed through.
    const unknown = toProviderModels(new Map([["uuid-c", model("uuid-c", "mistral-large", "Basic", "mistral")]]))
    expect(unknown["anthropic"]?.[0]?.vendor).toBe("mistral")
  })

  test("splits models across protocol buckets", () => {
    const models = new Map([
      ["uuid-a", model("uuid-a", "claude-opus-4-8", "Premium", "anthropic")],
      ["uuid-b", model("uuid-b", "gpt-5.5", "Premium", "openai")],
      ["uuid-c", model("uuid-c", "gemini-2.0-flash", "Basic", "google")],
    ])
    const mapped = toProviderModels(models)
    expect(mapped["anthropic"]?.map((m) => m.id)).toEqual(["uuid-a"])
    expect(mapped["openai"]?.map((m) => m.id)).toEqual(["uuid-b"])
    expect(mapped["google"]?.map((m) => m.id)).toEqual(["uuid-c"])
  })

  test("falls back safely when the server reports an unknown protocol", () => {
    const models = new Map([["uuid-new", model("uuid-new", "future-model", "Premium", "future-protocol")]])
    const mapped = toProviderModels(models)
    expect(mapped["anthropic"]?.map((entry) => entry.id)).toEqual(["uuid-new"])
    expect(mapped["future-protocol"]).toBeUndefined()
  })
})

describe("projectCatalog", () => {
  /**
   * ⚠ A PROJECTED SNAPSHOT IS BY CONSTRUCTION AN ANSWERED ONE. Every path that never reached the
   * gateway answers `unreachable` before this function is called, so an empty `courses` from HERE
   * really does mean the student is enrolled in nothing.
   */
  test("says the gateway answered", () => {
    expect(projectCatalog({ courses: [], assistants: {}, models: [] }, "2026-01-01").status).toBe("ok")
  })

  const snapshot = {
    courses: [course({ id: 7, endsOn: "2026-12-01" }), course({ id: 8, code: "CS 101", status: "draft" as const })],
    assistants: {
      "7": [choice({ id: 12, name: "Pair programmer" }), choice({ id: 13, name: "Reviewer" })],
      "8": [],
    },
    models: Array.from(catalogue.values()),
  }

  test("computes entryState per course against the given day", () => {
    const projected = projectCatalog(snapshot, "2026-09-21")
    expect(projected.courses.map((c) => [c.code, c.entryState])).toEqual([
      ["CS 310", "open"],
      ["CS 101", "draft"],
    ])
  })

  // The same snapshot, a different morning: this is why the verdict is never cached.
  test("the same snapshot yields a different verdict after the end date", () => {
    expect(projectCatalog(snapshot, "2027-01-01").courses[0]?.entryState).toBe("ended")
  })

  test("assistant order survives and the first one is the default", () => {
    const projected = projectCatalog(snapshot, "2026-09-21")
    expect(projected.courses[0]?.assistantIds).toEqual(["12", "13"])
    expect(projected.assistants.map((a) => [a.id, a.isDefault])).toEqual([
      ["12", true],
      ["13", undefined],
    ])
  })

  test("a course with no assistants still appears, with an empty list", () => {
    const projected = projectCatalog(snapshot, "2026-09-21")
    expect(projected.courses[1]?.assistantIds).toEqual([])
    expect(projected.assistants.filter((a) => a.courseId === "8")).toEqual([])
  })
})

describe("modelTiers", () => {
  // The tier used to be looked up in MODEL_CATALOG by model id, which UUID ids can never match.
  test("maps the gateway's category onto every classified model", () => {
    const projected = projectCatalog(
      { courses: [], assistants: {}, models: Array.from(catalogue.values()) },
      "2026-09-21",
    )
    expect(projected.modelTiers).toEqual({
      "jolli-anthropic/uuid-opus": "premium",
      "jolli-anthropic/uuid-haiku": "economy",
    })
  })

  // ⚠ It is keyed by model, not by assistant, because the nudge asks about the model that actually
  // ran — which the student may have switched away from the professor's default.
  test("covers models beyond the assistant's default", () => {
    const projected = projectCatalog(
      {
        courses: [course()],
        assistants: { "7": [choice({ modelId: "uuid-opus", allowedModelIds: ["uuid-opus", "uuid-haiku"] })] },
        models: Array.from(catalogue.values()),
      },
      "2026-09-21",
    )
    expect(Object.keys(projected.modelTiers).sort()).toEqual([
      "jolli-anthropic/uuid-haiku",
      "jolli-anthropic/uuid-opus",
    ])
  })

  test("an unclassified model is simply absent, so it draws no nudge", () => {
    const projected = projectCatalog(
      { courses: [], assistants: {}, models: [model("uuid-plain", "some-model")] },
      "2026-09-21",
    )
    expect(projected.modelTiers).toEqual({})
  })
})

describe("toAssistant — a grant whose models have all gone", () => {
  /**
   * ⚠ THE INVERSE OF THE "EMPTY MEANS UNRESTRICTED" RULE, AND THE DANGEROUS DIRECTION. Filtering a
   * restricted grant down to nothing would hand the student the entire tenant catalogue — the
   * opposite of what the professor asked for. It is reachable: a provider going inactive removes
   * its whole vendor group from the index in one step.
   */
  test("keeps the dead ids rather than collapsing into unrestricted", () => {
    const mapped = toAssistant({
      choice: choice({ modelId: "uuid-gone", allowedModelIds: ["uuid-gone", "uuid-also-gone"] }),
      courseId: "7",
      isDefault: false,
      models: catalogue,
    })
    expect(mapped.allowedModelIds).toEqual(["jolli-anthropic/uuid-gone", "jolli-anthropic/uuid-also-gone"])
    expect(mapped.allowedModelIds.length).toBeGreaterThan(0)
    expect(mapped.modelId).toBeUndefined()
  })

  test("a partially retired grant still drops just the dead ones", () => {
    const mapped = toAssistant({
      choice: choice({ allowedModelIds: ["uuid-opus", "uuid-gone"] }),
      courseId: "7",
      isDefault: false,
      models: catalogue,
    })
    expect(mapped.allowedModelIds).toEqual(["jolli-anthropic/uuid-opus"])
  })
})

describe("values this build has never seen", () => {
  /**
   * ⚠ THE WIRE DECODER ACCEPTS ANY STRING FOR `status`, `viewerRole` AND `category`, DELIBERATELY. A
   * closed union fails the whole array on one unrecognised row, so the day Jolli Edu adds a value,
   * every student would be locked out of the app and told their network was down. The cost is that
   * the mapping layer has to decide, and these pin what it decided.
   */
  test("an unknown course status is not runnable", () => {
    expect(courseEntryState({ status: "suspended", endsOn: null }, "2026-09-21")).toBe("archived")
    expect(toCourse({ item: course({ status: "suspended" }), entryState: "archived", assistantIds: [] }).status).toBe(
      "archived",
    )
  })

  test("an unknown viewer role is not one of the student's own courses", () => {
    expect(isOwnCourse(course({ viewerRole: "space-auditor" }))).toBe(false)
    expect(isVisibleCourse(course({ viewerRole: "space-auditor" }))).toBe(false)
  })

  test("an unknown model category simply produces no tier, so no nudge", () => {
    const projected = projectCatalog(
      { courses: [], assistants: {}, models: [model("uuid-x", "some-model", "Deluxe")] },
      "2026-09-21",
    )
    expect(projected.modelTiers).toEqual({})
  })

  // The point of all of the above: the response still decodes, so the student still gets in.
  test("a course carrying unknown values still reaches the client", () => {
    const projected = projectCatalog(
      { courses: [course({ status: "suspended", viewerRole: "course-student" })], assistants: {}, models: [] },
      "2026-09-21",
    )
    expect(projected.courses).toHaveLength(1)
    expect(projected.courses[0]?.entryState).toBe("archived")
  })
})

describe("grantedModelIds", () => {
  test("unions every course's grants", () => {
    const granted = grantedModelIds({
      "7": [choice({ allowedModelIds: ["uuid-opus"] })],
      "8": [choice({ allowedModelIds: ["uuid-haiku", "uuid-opus"] })],
    })
    expect(granted).toEqual(new Set(["uuid-opus", "uuid-haiku"]))
  })

  // An empty grant is unrestricted, and no assistant leaves nothing to narrow by.
  test("reaches everything when any assistant is unrestricted, or when there is none", () => {
    expect(grantedModelIds({ "7": [choice(), choice({ allowedModelIds: [] })] })).toBeUndefined()
    expect(grantedModelIds({ "7": [] })).toBeUndefined()
  })
})
