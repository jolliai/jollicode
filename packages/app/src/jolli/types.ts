/**
 * THE DOMAIN CONTRACT FOR THE EDUCATION SURFACE, RE-EXPORTED FROM THE SCHEMA PACKAGE.
 *
 * ⚠ THE SHAPES MOVED, THIS FILE DID NOT. They now live in `packages/schema/src/jolli.ts` because
 * three packages need them: `packages/opencode` declares the `/jolli/course` endpoint with them,
 * `packages/core` produces them from the gateway's responses, and this package renders them.
 * AGENTS.md puts anything shared that way in Schema, which depends on nothing. The invariants that
 * used to be recorded here — an empty `allowedModelIds` means UNRESTRICTED while an empty `skills`
 * means exactly none — travelled with them.
 *
 * ⚠ THIS FILE STAYS SO THE ~20 `@/jolli/types` IMPORTS DO NOT HAVE TO MOVE, and because
 * `packages/app/package.json` publishes it as `./jolli/types`.
 *
 * ⚠ THEY ARE NO LONGER FIXTURES. The gateway serves them; `packages/core/src/jolli/api.ts` decodes
 * what Jolli Edu actually returns and maps it onto these.
 */

import { Jolli } from "@opencode-ai/schema/jolli"

export type ChatSharing = Jolli.ChatSharing
export type CourseKind = Jolli.CourseKind
export type AssistantKind = Jolli.AssistantKind
export type CourseEntryState = Jolli.CourseEntryState
export type SessionSharing = Jolli.SessionSharing
export type Accent = Jolli.Accent
export type Course = Jolli.Course
export type AssistantGuardrails = Jolli.AssistantGuardrails
export type CoachingRubric = Jolli.CoachingRubric
export type AssistantSkill = Jolli.AssistantSkill
export type ModelTier = Jolli.ModelTier
export type Assistant = Jolli.Assistant
export type Catalog = Jolli.Catalog
export type Viewer = Jolli.Viewer
