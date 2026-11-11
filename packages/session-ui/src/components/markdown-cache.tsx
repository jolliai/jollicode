import { checksum } from "@opencode-ai/core/util/encode"
import { sanitizeMarkdown } from "./markdown-sanitize"
export { sanitizeMarkdown } from "./markdown-sanitize"
import { parseMarkdown } from "./markdown-worker"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, MarkdownCacheEntry>()
export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function preloadMarkdown(text: string, cacheKey: string) {
  const key = `${cacheKey}:0:full`
  const cached = getCachedMarkdown(key)
  if (cached?.raw === text) {
    touchCachedMarkdown(key, cached)
    return
  }
  const hash = checksum(text)
  if (!hash) return
  touchCachedMarkdown(key, {
    raw: text,
    hash,
    html: sanitizeMarkdown(await parseMarkdown(text)),
  })
}
