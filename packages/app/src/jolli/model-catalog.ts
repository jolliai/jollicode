/**
 * Re-export so renderer code keeps importing the catalogue from `@opencode-ai/app/jolli/...`.
 * It lives in core because the CLI's provider config is built there and `packages/opencode`
 * cannot import this package. Same pattern as `packages/app/src/brand.ts`.
 */
export { MODEL_CATALOG, modelTier, type ModelTier } from "@opencode-ai/core/jolli/model-catalog"
