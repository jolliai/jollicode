import { $ } from "bun"
import { buildCliToResources } from "./utils"
import { copyPdfjsAssets } from "../../app/script/copy-pdfjs-assets"

copyPdfjsAssets()

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`
await buildCliToResources()
