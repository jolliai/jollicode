/**
 * THE JOLLIEDU COURSE-CHAT MCP SERVER, AND THE CREDENTIAL IT IS REACHED WITH.
 *
 * ⚠ THE TOKEN IS ATTACHED TO EACH REQUEST, NEVER WRITTEN INTO CONFIG. The CLI JWT rotates, and a
 * copy stitched into the discovered entry's headers was frozen at config load: once it aged out
 * every course tool answered 401 until the process restarted. It also made the credential part of
 * the resolved config, which `GET /config` and `debug config` print verbatim. Reading it from the
 * session at request time, as the model providers' `fetch` does, fixes both.
 *
 * ⚠ THE DESTINATION IS CHECKED BEFORE THE CREDENTIAL IS ATTACHED. A coursework repository can
 * declare its own `mcp.jolliedu`, and discovery replaces it only when discovery succeeds, so the
 * name alone says nothing about where a request is going. The student's token only goes to a Jolli
 * origin — the same allowlist sign-in and the gateway requests are held to.
 */
import { isJolliOriginAllowed } from "./origin"

/** The server key the tenant's discovery answer uses, and so the prefix of every tool it contributes. */
export const JOLLI_MCP_SERVER = "jolliedu"

/** The session calls the fetch needs, as promises so this module does not depend on the runtime. */
export interface JolliMcpCredential {
  /** A usable access token, renewed first when it is close to expiry. */
  readonly token: () => Promise<string>
  /** Renew after the server refused `token`, answering with its replacement. */
  readonly refused: (token: string) => Promise<string>
}

/**
 * A `fetch` for the Jolliedu MCP transport that carries the current CLI credential.
 *
 * Any authorization header the entry was configured with is dropped on a Jolli origin, so exactly
 * one credential is ever sent there, whatever case a config wrote the header name in. Elsewhere the
 * request is passed through as configured and carries no Jolli credential.
 */
export function jolliMcpFetch(
  credential: JolliMcpCredential,
  send: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  return async function jolliMcpRequest(input: string | URL, init?: RequestInit): Promise<Response> {
    if (!isJolliOriginAllowed(input.toString())) return send(input, init)
    const headers = new Headers(init?.headers)
    const token = await credential.token()
    headers.set("authorization", `Bearer ${token}`)
    const answer = await send(input, { ...init, headers })
    if (answer.status !== 401) return answer

    /**
     * ⚠ ONE RETRY, AND ONLY WITH A DIFFERENT TOKEN. A token revoked while still young is refused
     * long before it expires, and only a refusal reaches the renewal path. `refused` answers with
     * the token we sent when the backend could not be reached; re-sending that would just fail again.
     * A streamed body cannot be sent twice, so it gets the renewal but not the retry.
     */
    const renewed = await credential.refused(token).catch(() => undefined)
    if (!renewed || renewed === token || init?.body instanceof ReadableStream) return answer
    // Nothing reads the refusal now that it is being replaced, and an abandoned body holds its connection open.
    await answer.body?.cancel()
    headers.set("authorization", `Bearer ${renewed}`)
    return send(input, { ...init, headers })
  }
}
