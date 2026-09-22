/**
 * Seed a Jolli course catalogue into the on-disk cache so a TUI can be driven without a gateway.
 *
 * `loadCatalog` serves a cache younger than its 5-minute TTL WITHOUT touching the network, so a
 * snapshot dropped at the key the real code computes is indistinguishable from a real fetch.
 *
 * ⚠ IT LIVES IN `packages/core` RATHER THAN IN THE REPO'S TOP-LEVEL `script/`, AND THAT IS WHAT
 * LETS IT IMPORT THE REAL THING. An earlier cut sat at the root and could not resolve
 * `@opencode-ai/core` under the isolated linker — `Global` reaches for `xdg-basedir`, which is not
 * installed there — so it hand-copied the cache key, the filename, the cache directory and the
 * schema version. Four mirrors of one module: bumping `CATALOG_SCHEMA` would have left this
 * writing a file `readSnapshot` rejects, with nothing to say why the fixture stopped working.
 *
 * Run it from this package: `bun run seed-jolli-catalog`.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { gatewayRequest } from "../src/jolli/api"
import { Hash } from "../src/util/hash"
import { CATALOG_SCHEMA, catalogCachePath, type CatalogSnapshot } from "../src/jolli/cache"

const BASE_URL = process.env["JOLLICODE_JOLLI_BASE_URL"] ?? "https://demo.jolli-local.me"
const TOKEN = process.env["JOLLICODE_JOLLI_TOKEN"] ?? "fixture-token"
/**
 * ⚠ THE FIXTURE MUST LAND UNDER THE IDENTITY THE PRODUCT WILL LOOK IT UP BY, AND FOR AN INJECTED
 * TOKEN THAT IS DERIVED FROM THE TOKEN ITSELF. `jolli/session.ts` builds a synthetic credential row
 * for `JOLLICODE_JOLLI_TOKEN` whose `cache_key` is `Hash.fast(token)`; seeding under anything else
 * writes a file nothing reads. A real sign-in mints a random one instead, which is exactly why this
 * script is for the injected path only.
 */
const IDENTITY = Hash.fast(TOKEN)

/**
 * ⚠ THE SAME CONSTRUCTOR THE PRODUCT USES, SO THE ALLOWLIST APPLIES HERE TOO. A base URL this
 * refuses is one no amount of seeding would make work: `loadCatalog` would never be handed a
 * request for it, so the fixture would sit unread at a path nothing computes.
 */
const request = gatewayRequest(BASE_URL, { token: TOKEN, identity: IDENTITY })
if (!request) throw new Error(`Not an allowed Jolli origin: ${BASE_URL}`)

/**
 * ⚠ `protocol` DECIDES WHICH PROVIDER BLOCK THE MODEL LANDS IN, so it is not decoration. The config
 * generator groups the catalogue by it and emits one `@ai-sdk/*` provider per group; a model
 * carrying an unsupported value is dropped rather than routed through the wrong SDK. These are all
 * Claude models, so they all say `anthropic`.
 */
const model = (id: string, name: string, category: string | null) => ({
  id,
  name,
  category,
  description: null,
  isActive: true,
  protocol: "anthropic",
})

/**
 * ⚠ THE CATEGORIES ARE THE GATEWAY'S OWN WORDS, NOT DESCRIPTIVE ONES. `catalog.ts` maps exactly
 * `Premium` and `Basic` onto a `Jolli.ModelTier`; anything else classifies as nothing and
 * produces no model-choice nudge at all. An earlier fixture said `frontier`/`balanced`/`fast`,
 * which reads better and made the coaching nudge impossible to demonstrate.
 */
const MODELS = [
  model("11111111-1111-1111-1111-111111111111", "claude-opus-4-5", "Premium"),
  model("22222222-2222-2222-2222-222222222222", "claude-sonnet-4-5", null),
  model("33333333-3333-3333-3333-333333333333", "claude-haiku-4-5", "Basic"),
]

const course = (id: number, code: string, name: string, status: string, endsOn: string | null = null) => ({
  id,
  name,
  description: null,
  code,
  status,
  requiresCoding: true,
  endsOn,
  viewerRole: "course-student",
  isStaff: false,
})

const assistant = (id: number, name: string, blurb: string, allowedModelIds: string[]) => ({
  id,
  name,
  blurb,
  icon: "sparkles",
  accent: 0,
  worksThroughProblems: true,
  answersFromMaterialsOnly: false,
  showCitations: true,
  modelId: MODELS[1].id,
  allowedModelIds,
})

/**
 * ⚠ TYPED AS THE REAL SNAPSHOT, WHICH IS THE OTHER HALF OF LIVING IN THIS PACKAGE. `tsconfig.json`
 * has no `include`, so `bun typecheck` covers `script/` — a field added to `CourseListItem` or
 * `CourseAssistantChoice` fails here instead of at the fixture's first use.
 */
const snapshot: CatalogSnapshot = {
  schema: CATALOG_SCHEMA,
  courses: [
    course(101, "CS 101", "Intro to Programming", "published"),
    course(210, "CS 210", "Data Structures", "published"),
    // Blocked, each for a different reason, so the picker's sentences can be read.
    course(202, "MATH 202", "Linear Algebra", "draft"),
    course(303, "ART 303", "Generative Art", "published"),
    course(404, "HIST 404", "Last Term", "published", "2020-01-01"),
  ],
  assistants: {
    // Default sorts FIRST — there is no isDefault flag on the wire.
    "101": [
      assistant(1, "Tutor", "Works through problems with you", [MODELS[1].id]),
      assistant(2, "Reviewer", "Reads a diff the way the marker will", []),
    ],
    "210": [assistant(3, "Lab Assistant", "Pairs with you in the editor", [MODELS[0].id, MODELS[2].id])],
    // 303 deliberately has none -> "no assistants yet".
  },
  models: MODELS,
}

const file = catalogCachePath(request)
await mkdir(path.dirname(file), { recursive: true })
await writeFile(file, JSON.stringify(snapshot))
console.log("seeded:", file)
console.log("JOLLICODE_JOLLI_BASE_URL=" + BASE_URL)
console.log("JOLLICODE_JOLLI_TOKEN=" + TOKEN)
