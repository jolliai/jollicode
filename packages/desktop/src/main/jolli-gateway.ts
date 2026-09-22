/**
 * THE JOLLI CONFIG THE SIDECAR SERVER IS STARTED WITH — WHICH IS NOW A CEILING AND NOTHING ELSE.
 *
 * ⚠ THE SHAPE ITSELF LIVES IN `@opencode-ai/core/jolli/gateway-config`, SHARED WITH THE BARE CLI.
 * Both surfaces must lock to the same provider and point at the same gateway, and an earlier
 * version of this file was the only place that knew how — so the CLI had none of it. What stays
 * here is what is genuinely desktop-only: the generated course skills under `userData`.
 *
 * ⚠ IT ARRIVES AS `JOLLICODE_CONFIG_CONTENT`, WHICH IS THE STRONGEST LAYER SHORT OF MDM. Config
 * merges well-known → global → custom → project → this (`config/config.ts`), so a student who
 * writes an `opencode.json` into their coursework repository cannot widen the list.
 *
 * ⚠ IT NO LONGER CARRIES A CREDENTIAL OR A MODEL LIST, AND BOTH ABSENCES ARE DELIBERATE. The
 * sidecar resolves the signed-in student from the database it shares with the bare CLI, and builds
 * the catalogue from that — so this process does not need a token, does not need to know whether
 * one is fresh, and can produce this config before anyone has signed in at all. What is left is the
 * part a student must not be able to change: one provider, one gateway.
 *
 * ⚠ AND IT IS SYNCHRONOUS AGAIN, WHICH IS WORTH MORE THAN IT LOOKS. It used to fetch the tenant's
 * whole catalogue before returning, and the sidecar could not fork until it did — every second
 * spent here was a second the app had no server at all. The server warms that cache itself now,
 * from `/jolli/course`.
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { jolliBaseConfig } from "@opencode-ai/core/jolli/gateway-config"

/**
 * WHICH REAL ENDPOINT ANSWERS. A build may pin one via `JOLLICODE_GATEWAY_URL` (electron.vite
 * define); otherwise the tenant the student signed in to decides, and `jolliBaseConfig` falls back
 * to `Brand.gatewayUrl`. It is deliberately NOT a runtime env var: the gateway is the model
 * lockdown, and a runtime var would be inherited from the student's shell (`preferAppEnv`) and let
 * them repoint it — see the scrub in `server.ts`.
 *
 * ⚠ IT IS A GATEWAY ROOT, NOT A TENANT, AND `jolliBaseConfig` KEEPS THOSE APART. It is handed over
 * as `gatewayUrl` so its path is preserved and only the protocol version suffix is appended;
 * passing it as `baseUrl` would add `/api` to an endpoint that is already the gateway and drop any
 * path it carries.
 *
 * ⚠ EXPORTED BECAUSE THE SIDECAR HAS TO BE TOLD, AND THE CONFIG BELOW IS NOT ENOUGH TO TELL IT. The
 * server rebuilds the Jolli provider block after every config layer has merged (`config.ts`,
 * strict lockdown) and writes the result over what arrived here — so a pin the server cannot name
 * for itself is erased by the very pass that is supposed to be protecting it. `createSidecarEnv()`
 * hands it over as `JOLLICODE_GATEWAY_URL`, scrubbing the inherited key first so this build's value
 * is the only one that can be there.
 */
export const GATEWAY_URL = import.meta.env.JOLLICODE_GATEWAY_URL || undefined

/**
 * The ceiling the sidecar server is started with, as JSON.
 *
 * ⚠ `signedIn: true` HERE IS NOT A CLAIM ABOUT ANYONE. It is what makes `jolliBaseConfig` emit the
 * provider block at all, and that block is the part that pins `baseURL` and `npm` beyond a
 * coursework repository's reach. Whether a student is actually signed in — and which tenant they
 * belong to — is the server's answer, arrived at from the shared database; its own floor supplies
 * the models, and its post-merge pass removes this block entirely when nobody is signed in.
 */
export function jolliGatewayConfig(): string {
  return JSON.stringify(
    jolliBaseConfig({
      signedIn: true,
      // A build-pinned gateway wins over the tenant, so a demo build can be aimed at a fixture.
      ...(GATEWAY_URL ? { gatewayUrl: GATEWAY_URL } : {}),
    }),
  )
}

/**
 * CLEAR THE GENERATED COURSE SKILLS. There are none to write yet.
 *
 * ⚠ THIS USED TO MATERIALISE `ASSISTANTS[*].skills` FROM THE FIXTURES, AND THAT SOURCE IS GONE.
 * Courses and assistants now come from the Jolli gateway, whose student-facing assistant shape
 * (`assistant-choices`) carries no skills at all — jolliedu has no such concept. Writing the
 * fixtures' skills against real courses would have offered every student a procedure no professor
 * of theirs had written.
 *
 * ⚠ IT STILL CLEARS, AND THAT IS THE POINT OF KEEPING IT. Anyone upgrading from a build that DID
 * write these has stale `SKILL.md` files under `userData` that the server would keep discovering
 * and offering as slash commands. Returning `undefined` stops the config pointing at the directory;
 * removing it stops the files existing.
 *
 * When the gateway serves skills, this is where they land again.
 */
export function clearCourseSkills(userDataPath: string) {
  rmSync(join(userDataPath, "jolli-skills"), { recursive: true, force: true })
}
