/**
 * WHAT IS LEFT OF THE JOLLI CREDENTIAL IN THIS PACKAGE: ONE KEY.
 *
 * ⚠ THE CREDENTIAL ITSELF MOVED TO `@opencode-ai/core/jolli/session`, AND WITH IT EVERYTHING THIS
 * MODULE USED TO DO. There is one store now — the shared database — so the "two surfaces, two
 * stores" problem this file was written to paper over does not exist. Signing out there removes the
 * row AND the course catalogue snapshot keyed to it, which is why the `forgetJolliCatalog` helper
 * that used to live here is gone rather than merely unused: two ways to forget one credential is
 * how they drift apart.
 *
 * ⚠ THE DEVELOPER OVERRIDE MOVED TOO. `JOLLICODE_JOLLI_TOKEN` is read by the session service, so a
 * credential has exactly one place that decides where it came from.
 */
import { Brand } from "@opencode-ai/core/brand"

/**
 * The provider id, which is still the key every provider-shaped surface names Jolli by — the model
 * list, the sign-in dialog, `connected`, and `DELETE /auth/:providerID`.
 */
export const JOLLI_AUTH_KEY = Brand.short
