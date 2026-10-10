#!/usr/bin/env bun
/**
 * ⚠ CODEGEN IS NOT PART OF `build`, AND MUST NOT BECOME PART OF IT AGAIN. `createClient` below is
 * configured with `clean: true`, so it deletes `src/v2/gen` before rewriting it — and that is
 * *tracked source* every consumer imports, not a `dist/` artifact. While this ran as
 * `@opencode-ai/sdk#build`, turbo scheduled it concurrently with `@opencode-ai/app#build`, whose
 * vite/rollup pass resolves `@opencode-ai/sdk/v2/client` -> `./gen/types.gen.js`. A resolution that
 * landed in the few hundred ms between the clean and the rewrite failed the whole run with
 * `Could not resolve "./gen/types.gen.js"`, intermittently and only on whichever leg happened to
 * miss the turbo cache.
 *
 * The output is committed, so nothing in the build or test path needs to regenerate it. CI runs
 * `check:generated` instead, which regenerates and diffs — the same contract `packages/client` uses.
 */
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

/**
 * THE ONE DIRECTORY THIS SCRIPT OWNS: it is cleaned, written, asserted and formatted below.
 *
 * ⚠ `check:generated` IN `package.json` NAMES IT A SECOND TIME AND CANNOT READ THIS. That pathspec
 * is what CI diffs, so moving the codegen means moving both — a check pointed at a directory
 * nothing writes any more passes forever.
 */
const GENERATED_DIR = "./src/v2/gen"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: GENERATED_DIR,
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

/**
 * ⚠ `clean: true` DELETED TRACKED SOURCE BEFORE WRITING, so a codegen that produced nothing and
 * still exited zero is answered three times downstream — `ENOENT` on `types.gen.ts`, prettier's
 * "No supported files were found", then `check:generated`'s `pathspec ... did not match` — each
 * one a complaint about a path rather than about the generator. Any file counts: what the plugins
 * emit is their business, and this only asks whether anything was written.
 */
const written = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: GENERATED_DIR, onlyFiles: true })).catch(
  // A missing directory IS the thing being reported; anything else — EACCES, EMFILE — is its own
  // failure and must not be rewritten into "wrote nothing".
  (error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return []
    throw error
  },
)
if (written.length === 0) {
  throw new Error(`codegen wrote no files to ${GENERATED_DIR}, which check:generated diffs and needs populated there`)
}

const typesPath = `${GENERATED_DIR}/types.gen.ts`
const generatedTypes = await Bun.file(typesPath).text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write(typesPath, historyTypesPatched)

const sdkPath = `${GENERATED_DIR}/sdk.gen.ts`
const generatedSdk = await Bun.file(sdkPath).text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write(sdkPath, historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = `${GENERATED_DIR}/client/types.gen.ts`
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

/**
 * ⚠ {@link GENERATED_DIR} AND NOTHING ELSE, BECAUSE WHAT IS FORMATTED HERE MUST BE WHAT
 * `check:generated` DIFFS. This formatted `src/gen` and the whole of `src/v2` while the check only
 * looked at the generated directory — so every run reformatted the v1 client this script does not
 * write, and could rewrite hand-written files under `src/v2`, with no check anywhere that would
 * notice. Repo-wide formatting belongs to `script/format.ts`, which owns those files.
 */
await $`bun prettier --write ${GENERATED_DIR}`
await $`rm openapi.json`
