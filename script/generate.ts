#!/usr/bin/env bun

import { $ } from "bun"

await $`bun run --cwd packages/sdk/js generate`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

await $`./script/format.ts`
