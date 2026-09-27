import { describe, expect, test } from "bun:test"
import { isAllowedAuthorizationRedirect } from "./auth-redirect"

describe("authorization redirect validation", () => {
  test("allows registered callbacks in production", () => {
    expect(isAllowedAuthorizationRedirect("app", "https://jolli.ai/auth/callback", "production")).toBe(true)
    expect(isAllowedAuthorizationRedirect("app", "https://auth.jolli.ai/auth/callback", "production")).toBe(true)
    expect(isAllowedAuthorizationRedirect("app", "http://localhost:3000/auth/callback", "production")).toBe(true)
    expect(isAllowedAuthorizationRedirect("app", "http://127.0.0.1:3000/auth/callback", "production")).toBe(true)
  })

  test("allows dev and local-dev domains only outside production", () => {
    expect(isAllowedAuthorizationRedirect("app", "https://jolli.dev/auth/callback", "dev")).toBe(true)
    expect(isAllowedAuthorizationRedirect("app", "https://demo.jolli-local.me/auth/callback", "dev")).toBe(true)
    expect(isAllowedAuthorizationRedirect("app", "https://jolli.dev/auth/callback", "production")).toBe(false)
    expect(isAllowedAuthorizationRedirect("app", "https://demo.jolli-local.me/auth/callback", "production")).toBe(false)
  })

  test("rejects unregistered clients and external redirects", () => {
    expect(isAllowedAuthorizationRedirect("other", "https://jolli.ai/auth/callback", "dev")).toBe(false)
    expect(isAllowedAuthorizationRedirect("app", "https://evil.example/callback", "dev")).toBe(false)
    expect(isAllowedAuthorizationRedirect("app", "https://jolli.ai.evil.example/callback", "dev")).toBe(false)
    expect(isAllowedAuthorizationRedirect("app", "http://jolli-local.me/auth/callback", "dev")).toBe(false)
    expect(isAllowedAuthorizationRedirect("app", "javascript:alert(1)", "dev")).toBe(false)
  })
})
