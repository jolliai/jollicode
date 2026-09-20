/**
 * SIGNING IN TO JOLLI, AS A PROVIDER AUTH METHOD.
 *
 * ⚠ THE FLOW ITSELF LIVES IN CORE. `startJolliLogin` is shared with the desktop app's main process
 * so the two surfaces cannot drift on the wire contract; everything specific to this one is here.
 *
 * ⚠ THIS PLUGIN DOES NOT OPEN THE BROWSER, DELIBERATELY. `authorize` runs inside the opencode
 * server, which is not always the machine the user is sitting at — opening a browser there is how a
 * remote `opencode serve` ends up launching Chrome on a server nobody can see. It returns the URL
 * and the client decides; the TUI opens it on mount. (Upstream's DigitalOcean plugin does call
 * `open()` here; its Codex plugin does not. The Codex posture is the correct one.)
 *
 * ⚠ THE CREDENTIAL IS A JWT, NOT AN API KEY. It is stored as `{type:"api"}` because that is the
 * shape opencode fills a provider's `apiKey` from, and the Jolli gateway normalises the resulting
 * `x-api-key` header into `Authorization: Bearer`. There is no refresh token to store: Jolli issues
 * a long-lived CLI token and re-issues it only through another sign-in.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Brand } from "@opencode-ai/core/brand"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { startJolliLogin } from "@opencode-ai/core/jolli/loopback"

export async function JolliAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: Brand.short,
      methods: [
        {
          type: "oauth",
          label: `Sign in to ${Brand.name}`,
          async authorize() {
            const attempt = await startJolliLogin({ clientVersion: InstallationVersion })
            return {
              url: attempt.url,
              instructions: "Complete sign-in in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                const credentials = await attempt.wait().catch(() => undefined)
                if (!credentials) return { type: "failed" as const }
                return {
                  type: "success" as const,
                  provider: Brand.short,
                  key: credentials.token,
                  // The tenant the token belongs to. The config layer reads it back to point the
                  // provider at `<baseUrl>/api`; absent when the backend did not report one.
                  ...(credentials.baseUrl ? { metadata: { baseUrl: credentials.baseUrl } } : {}),
                }
              },
            }
          },
        },
      ],
    },
  }
}
