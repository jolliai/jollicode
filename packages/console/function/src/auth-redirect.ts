// Production only issues codes to jolli.ai. jolli.dev and jolli-local.me are dev and local-dev
// domains whose certificates are handed to developers, so only non-production stages trust them.
// This deliberately differs from core's jolli/origin.ts allowlist: a client may point at a dev
// tenant, but the production issuer must never redirect its codes there.
const PRODUCTION_HOSTS = ["jolli.ai"]
const DEV_HOSTS = [...PRODUCTION_HOSTS, "jolli.dev", "jolli-local.me"]

export const isAllowedAuthorizationRedirect = (clientID: string, redirectURI: string, stage: string) => {
  if (clientID !== "app") return false
  const redirect = (() => {
    try {
      return new URL(redirectURI)
    } catch {
      return undefined
    }
  })()
  if (redirect === undefined) return false
  if (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1") {
    return redirect.protocol === "http:" || redirect.protocol === "https:"
  }
  return (
    redirect.protocol === "https:" &&
    (stage === "production" ? PRODUCTION_HOSTS : DEV_HOSTS).some(
      (host) => redirect.hostname === host || redirect.hostname.endsWith(`.${host}`),
    )
  )
}
