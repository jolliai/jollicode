import type { Schema } from "effect"

export type ReferenceMapTopic = {
  id: string
  text: string
  notes?: string
  collapsed: boolean
  children: ReferenceMapTopic[]
  image?: string
  parts: { id: number; title: string }[]
}
function record(value: Schema.Json | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}
export function referenceMindMap(value: Schema.Json) {
  const seen = new Set<string>()
  let partial = false
  const parse = (value: Schema.Json, depth: number): ReferenceMapTopic | undefined => {
    const node = record(value)
    if (!node || typeof node.oid !== "string" || seen.has(node.oid)) return undefined
    if (seen.size >= 2000 || depth > 64) {
      partial = true
      return undefined
    }
    seen.add(node.oid)
    const link = record(node.link)
    const image = record(node.image)
    const attachments = Array.isArray(node.attachments)
      ? node.attachments.flatMap((value) => {
          const part = record(value)
          return typeof part?.materialId === "number"
            ? [{ id: part.materialId, title: typeof part.name === "string" ? part.name : "" }]
            : []
        })
      : []
    return {
      id: node.oid,
      text: typeof node.text === "string" ? node.text : "",
      notes: typeof node.notes === "string" ? node.notes : undefined,
      collapsed: node.collapsed === true,
      // Only an image the map carries as a part of its own has a URL the server signed for its stored
      // bytes. Anything else could make the reader fetch an address the map's author chose.
      image: typeof image?.materialId === "number" && typeof image.url === "string" ? image.url : undefined,
      parts: [
        ...(typeof link?.materialId === "number"
          ? [{ id: link.materialId, title: typeof link.url === "string" ? link.url : "" }]
          : []),
        ...attachments,
      ],
      children: Array.isArray(node.children)
        ? node.children.flatMap((child) => {
            const result = parse(child, depth + 1)
            return result ? [result] : []
          })
        : [],
    }
  }
  const data = record(value)
  const roots = [data?.root ?? null, ...(Array.isArray(data?.floating) ? data.floating : [])].flatMap((value) => {
    const result = parse(value, 0)
    return result ? [result] : []
  })
  return { roots, partial: partial || data?.incomplete === true }
}

export function referenceMindMapLayout(roots: readonly ReferenceMapTopic[], collapsed: ReadonlySet<string>) {
  const nodes: { topic: ReferenceMapTopic; x: number; y: number }[] = []
  const edges: { from: { x: number; y: number }; to: { x: number; y: number } }[] = []
  let row = 0
  const visit = (topic: ReferenceMapTopic, depth: number) => {
    const node = { topic, x: 24 + depth * 232, y: 0 }
    nodes.push(node)
    const children = collapsed.has(topic.id) ? [] : topic.children.map((child) => visit(child, depth + 1))
    node.y = children.length ? children.reduce((sum, child) => sum + child.y, 0) / children.length : 24 + row++ * 76
    children.forEach((child) =>
      edges.push({ from: { x: node.x + 200, y: node.y + 24 }, to: { x: child.x, y: child.y + 24 } }),
    )
    return node
  }
  roots.forEach((root) => {
    visit(root, 0)
    row++
  })
  return {
    nodes,
    edges,
    width: Math.max(280, ...nodes.map((node) => node.x + 224)),
    height: Math.max(120, row * 76 + 48),
  }
}
