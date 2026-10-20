import { describe, expect, test } from "bun:test"
import {
  bindingOrg,
  orgScopedId,
  orgScopeHeaders,
  parseCourseBinding,
  parseOrgScopedId,
  sameOrg,
} from "../src/jolli/org-scoped-id"

test("an org-scoped id round-trips with and without an org", () => {
  expect(orgScopedId(undefined, 12)).toBe("12")
  expect(orgScopedId({ tenantSlug: "acme", orgSlug: "main" }, 12)).toBe("acme:main:12")
  expect(parseOrgScopedId("12")).toEqual({ id: 12 })
  expect(parseOrgScopedId("acme:main:12")).toEqual({ org: { tenantSlug: "acme", orgSlug: "main" }, id: 12 })
})

test("a malformed org-scoped id parses as nothing", () => {
  for (const bad of [
    "",
    "abc",
    "1e1",
    " 12",
    "0",
    "acme:12",
    "acme:main:x",
    ":main:12",
    "acme::12",
    "a:b:c:12",
    "acme:main:012",
  ])
    expect(parseOrgScopedId(bad)).toBeUndefined()
})

test("scope headers are lowercase and absent without an org", () => {
  expect(orgScopeHeaders(undefined)).toEqual({})
  expect(orgScopeHeaders({ tenantSlug: "acme", orgSlug: "main" })).toEqual({
    "x-jolli-org-scope": "1",
    "x-tenant-slug": "acme",
    "x-org-slug": "main",
  })
})

test("a session's org is the one its course binding names, and none for anything else", () => {
  const bound = (courseId: string, assistantId: string) => ({ metadata: { jolli: { courseId, assistantId } } })
  expect(bindingOrg(bound("acme:main:12", "acme:main:5"))).toEqual({ tenantSlug: "acme", orgSlug: "main" })
  expect(bindingOrg(bound("12", "5"))).toBeUndefined()
  expect(bindingOrg(bound("acme:12", "acme:5"))).toBeUndefined()
  expect(bindingOrg({ metadata: {} })).toBeUndefined()
  expect(bindingOrg(undefined)).toBeUndefined()
})

test("a session whose course and assistant name different orgs names no org", () => {
  const pair = (courseId: string, assistantId: string) => ({ metadata: { jolli: { courseId, assistantId } } })
  expect(bindingOrg(pair("acme:main:12", "acme:other:5"))).toBeUndefined()
  expect(bindingOrg(pair("acme:main:12", "5"))).toBeUndefined()
  expect(bindingOrg(pair("acme:main:12", "acme:main:x"))).toBeUndefined()
})

describe("parseCourseBinding", () => {
  const acme = { tenantSlug: "acme", orgSlug: "main" }

  test("reads a bare pair as numeric ids with no org", () => {
    expect(parseCourseBinding({ courseId: "12", assistantId: "5" })).toEqual({ courseId: 12, assistantId: 5 })
  })

  test("reads a pair scoped to one org as that org and its numeric ids", () => {
    expect(parseCourseBinding({ courseId: "acme:main:12", assistantId: "acme:main:5" })).toEqual({
      org: acme,
      courseId: 12,
      assistantId: 5,
    })
  })

  test("reads a pair naming two orgs as no binding", () => {
    for (const binding of [
      { courseId: "acme:main:12", assistantId: "acme:other:5" },
      { courseId: "acme:main:12", assistantId: "beta:main:5" },
      { courseId: "acme:main:12", assistantId: "5" },
      { courseId: "12", assistantId: "acme:main:5" },
    ])
      expect(parseCourseBinding(binding)).toBeUndefined()
  })

  test("reads a pair with either half unparseable as no binding", () => {
    for (const binding of [
      { courseId: "abc", assistantId: "5" },
      { courseId: "12", assistantId: "1e1" },
      { courseId: "acme:12", assistantId: "acme:main:5" },
      { courseId: "acme:main:12", assistantId: "acme:main:x" },
      { courseId: "", assistantId: "" },
    ])
      expect(parseCourseBinding(binding)).toBeUndefined()
    expect(parseCourseBinding(undefined)).toBeUndefined()
  })
})

test("two ids are in the same org when both name it or neither does", () => {
  const acme = { tenantSlug: "acme", orgSlug: "main" }
  expect(sameOrg(undefined, undefined)).toBe(true)
  expect(sameOrg(acme, { ...acme })).toBe(true)
  expect(sameOrg(acme, undefined)).toBe(false)
  expect(sameOrg(acme, { tenantSlug: "acme", orgSlug: "other" })).toBe(false)
  expect(sameOrg(acme, { tenantSlug: "beta", orgSlug: "main" })).toBe(false)
})
