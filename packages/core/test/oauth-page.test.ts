import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"
import { Brand } from "../src/brand"

describe("OauthCallbackPage", () => {
  // This page is the last thing a user sees in the browser after signing in, so
  // an unbranded string here is the most visible one in the product.
  test("carries no upstream branding", () => {
    for (const html of [
      OauthCallbackPage.success({ provider: "Jolli" }),
      OauthCallbackPage.success(),
      OauthCallbackPage.error("boom", { provider: "Jolli" }),
      OauthCallbackPage.error("boom"),
      OauthCallbackPage.bootstrap({ tokenPath: "/token", provider: "Jolli" }),
    ]) {
      expect(html).not.toContain("OpenCode")
      expect(html).toContain(Brand.name)
    }
  })


  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
