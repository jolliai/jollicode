import { expect, test } from "bun:test"
import {
  jolliCodingAgentHeaders,
  jolliInputTextHeader,
  JOLLI_CODE_PARTICIPATION_HEADER,
  JOLLI_CODE_PARTICIPATION_VERSION,
  overrideHeaders,
} from "../src/jolli/coding-headers"
import { providerIdFor } from "../src/jolli/gateway-config"

const turn = {
  providerID: providerIdFor("openai"),
  sessionID: "ses_test",
  turnID: "turn",
  clientAttemptID: "attempt",
  stepIndex: 0,
}
const scope = { "x-jolli-org-scope": "1", "x-tenant-slug": "acme", "x-org-slug": "main" }

test("a turn for an org-scoped course names the numeric ids and the org", () => {
  const headers = jolliCodingAgentHeaders({ ...turn, courseID: "acme:main:12", courseAssistantID: "acme:main:5" })
  expect(headers["x-jolli-space-id"]).toBe("12")
  expect(headers["x-jolli-assistant-id"]).toBe("5")
  expect(headers).toMatchObject(scope)
})

test("a turn for a bare course id sends no scope headers", () => {
  const headers = jolliCodingAgentHeaders({ ...turn, courseID: "12", courseAssistantID: "5" })
  expect(headers["x-jolli-space-id"]).toBe("12")
  expect(headers["x-jolli-assistant-id"]).toBe("5")
  for (const name of Object.keys(scope)) expect(headers).not.toHaveProperty(name)
})

/**
 * ⚠ NOT DROPPED: sent as written, the gateway refuses them and the student is told, where leaving
 * them off would run the turn as an unbound chat outside the course's rules.
 */
test("half a course binding goes as written, with no org", () => {
  expect(jolliCodingAgentHeaders({ ...turn, courseID: "acme:main:12" })).toMatchObject({
    "x-jolli-space-id": "acme:main:12",
  })
  expect(jolliCodingAgentHeaders({ ...turn, courseAssistantID: "acme:main:5" })).toMatchObject({
    "x-jolli-assistant-id": "acme:main:5",
  })
  for (const ids of [{ courseID: "acme:main:12" }, { courseAssistantID: "acme:main:5" }]) {
    const headers = jolliCodingAgentHeaders({ ...turn, ...ids })
    for (const name of Object.keys(scope)) expect(headers).not.toHaveProperty(name)
  }
})

test("ids that do not parse, or name different orgs, go as written with no scope headers", () => {
  for (const ids of [
    { courseID: "abc", courseAssistantID: "5" },
    { courseID: "acme:main:12", courseAssistantID: "x" },
    { courseID: "acme:main:12", courseAssistantID: "acme:other:5" },
    { courseID: "acme:main:12", courseAssistantID: "5" },
  ]) {
    const headers = jolliCodingAgentHeaders({ ...turn, ...ids })
    expect(headers["x-jolli-space-id"]).toBe(ids.courseID)
    expect(headers["x-jolli-assistant-id"]).toBe(ids.courseAssistantID)
    for (const name of Object.keys(scope)) expect(headers).not.toHaveProperty(name)
  }
})

test("a compaction of an org-scoped session carries the scope", () => {
  const headers = jolliCodingAgentHeaders({
    providerID: turn.providerID,
    sessionID: "ses_test",
    requestKind: "compaction",
    courseID: "acme:main:12",
    courseAssistantID: "acme:main:5",
  })
  expect(headers).toEqual({ "x-jolli-conversation-id": "ses_test", "x-jolli-request-kind": "compaction", ...scope })
  expect(headers).not.toHaveProperty("x-jolli-space-id")
})

test("a compaction without an org-scoped course binding carries no scope", () => {
  for (const ids of [
    {},
    { courseID: "12", courseAssistantID: "5" },
    { courseID: "abc", courseAssistantID: "5" },
    { courseID: "acme:main:12" },
    { courseID: "acme:main:12", courseAssistantID: "acme:other:5" },
  ])
    expect(
      jolliCodingAgentHeaders({
        providerID: turn.providerID,
        sessionID: "ses_test",
        requestKind: "compaction",
        ...ids,
      }),
    ).toEqual({ "x-jolli-conversation-id": "ses_test", "x-jolli-request-kind": "compaction" })
})

test("a non-Jolli provider gets no headers", () => {
  expect(jolliCodingAgentHeaders({ ...turn, providerID: "anthropic", courseID: "acme:main:12" })).toEqual({})
})

test("request headers replace static ones whatever their case", () => {
  expect(overrideHeaders({ "X-Tenant-Slug": "home", "x-other": "keep" }, { "x-tenant-slug": "acme" })).toEqual({
    "x-other": "keep",
    "x-tenant-slug": "acme",
  })
})

test("turn requests declare the additive participation UX capability, compactions do not", () => {
  expect(jolliCodingAgentHeaders(turn)[JOLLI_CODE_PARTICIPATION_HEADER]).toBe(JOLLI_CODE_PARTICIPATION_VERSION)
  expect(jolliCodingAgentHeaders({ ...turn, requestKind: "compaction" })).not.toHaveProperty(
    JOLLI_CODE_PARTICIPATION_HEADER,
  )
  expect(jolliCodingAgentHeaders({ ...turn, providerID: "openai" })).not.toHaveProperty(JOLLI_CODE_PARTICIPATION_HEADER)
})

test("declares only nonblank root student text without putting its contents in a header", () => {
  expect(jolliInputTextHeader("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  expect(jolliInputTextHeader(undefined)).toBe("none")
  expect(jolliInputTextHeader("")).toBe("none")
  expect(jolliInputTextHeader("  ")).toBe("none")
})
