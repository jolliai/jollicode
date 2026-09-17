# Jolli Code Mockup Migration — Design

> **Status:** Delivered as a single squashed commit.
> **Date:** 2026-09-17
> **Ticket:** JOLLI-2317
> **Target branch:** `feature/jolli-2317-rebrand` (off `dev`)

## 1. Background & Goals

Luke built a Jolli Code desktop-IDE mockup on the `main` branch of the forked
opencode repo [`Jolli-Mocks/jolli-code-mock`](https://github.com/Jolli-Mocks/jolli-code-mock/) —
a runnable, branded demo that shows prospective customers the professor/student
educational product. This document describes how that mockup was migrated into the
current repo (`jolliai/jollicode`).

**Goal:** bring Luke's rebrand plus the educational features into a branch off `dev`,
as a faithful port of the fork's already-tested code.

**Non-goals:**
- Do not migrate Luke's Windows-only dev-environment workarounds (see §5).
- Do not reconcile the rebrand with the separate centralized `Brand` constants approach
  on the existing `feature/jolli-2317` branch (deliberately deferred).
- No production hardening, real gateway, code signing, or privacy review — consistent with
  the fork's own PLAN.md "Deliberately out of scope".

## 2. Source ↔ target relationship (findings)

| Fact | Conclusion |
|---|---|
| The fork branched from opencode `9f8db119` (2026-09-09) | That base is **already in the current `dev` history** (`git merge-base dev mock/main == 9f8db119`) |
| `dev` advanced past `9f8db119` | Of the files Luke touched, only `bun.lock` and `packages/app/package.json` also changed on `dev` |
| `feature/jolli-2317` forks from the older `b578b726` with a different rebrand | **Not the target** — avoids an older base plus rebrand conflicts |
| Luke's educational-feature code is largely namespaced under `packages/app/src/jolli/` | Highly self-contained and portable |

**Conflict assessment:** applying Luke's changes onto `dev` is essentially conflict-free;
only `bun.lock` (regenerated) and `packages/app/package.json` (a two-line `exports` merge)
need handling.

## 3. Migration mechanism

**Not a per-commit cherry-pick.** Luke's rebrand commit `6f9da904f3` records favicon and
other assets with a **corrupted symlink mode** (mode 120000 whose blob is actually file
content) — an artifact of Windows `core.symlinks=false`. On macOS/Linux a cherry-pick of it
fails outright with "File name too long"; Luke later fixed the mode in `9cc886e0ef`.

**Approach used:** for each feature, `git checkout <source-commit> -- <that feature's file set>`
(taking each file's full content at that commit), with the exclusions below applied, then
verify byte-identity to the source and commit. Shared files (e.g. `jolli/fixtures.ts`,
`jolli/types.ts`, `jolli-gateway.ts`, `prompt-input-v2.tsx`) progress to their final state as
later features are applied; the final tree equals `mock/main` minus the exclusions. Only the
corrupted-symlink assets under `packages/app/public/*` need the exclusion.

The result is delivered here as a **single squashed commit**.

## 4. What was migrated

| Feature | Source commit | File-set highlights |
|---|---|---|
| **Desktop demo foundation** | `6f9da904f3` | More than a rebrand: also bundles course scoping, model lockdown, privacy, and the gateway foundation. 63 i18n locales, wordmark-v2, `jolli-brand.tsx`, `logo.tsx`, `theme/context.tsx`, desktop `icons/{dev,beta,prod}`, `main/index.ts` (APP_NAMES/setName), `index.html` titles, `windows-app-menu.tsx`; plus `jolli/{model-grant,session-store,session-binding,home-selection,sharing,fixtures,types}`, `components/{course-accent,prompt-course-selector,session-course-label,prompt-privacy-control}`, `context/{local,models}`, `dialog-select-model.tsx`, `home/*`, `desktop/main/{jolli-gateway,server}`. **Only the `packages/ui/src/assets/favicon/*` sources are updated**; `packages/app/public/*` stays as symlinks. |
| **Prompt coaching** | `ed875a6e12` | `jolli/coaching*.{ts,test.ts}`, `coaching-prose*`, `pages/session/timeline/coach-nudge.tsx`, `message-timeline.tsx`, two FORK-marked edits in `session-ui/components/message-part.{tsx,css}` (a `coachBadge` prop and moving the action-row fade from parent onto children), `ui/src/components/icon.tsx` (graduation-cap), plus additions to `jolli/{fixtures,types}.ts`. |
| **Course procedures as opencode skills** | `a4ba4d0721` | `packages/desktop/src/main/{jolli-gateway,server}.ts`, `jolli/{fixtures,types}.ts`, `jolli/coaching.test.ts`, `.gitignore` (adds `.jolli/`), and a manual merge of `packages/app/package.json` (dev's content + two `jolli` exports). |
| **Group the slash list, course procedures first** | `34ebe6561f` | `components/prompt-input-v2.tsx`, `session-ui/src/v2/components/prompt-input/{index.tsx,types.ts}`, `jolli/slash-groups.{ts,test.ts}`. |

> Luke's "comment margin" feature (`6ed31adc4a`) was initially ported but then removed from
> this branch at the author's request; it is **not** part of the delivered migration.

## 5. Deliberate exclusions (Windows-only workarounds that would harm macOS/Linux)

| Excluded | Handling |
|---|---|
| `packages/{app,enterprise}/src/custom-elements.d.ts` materialization (120000→100644, from `07494a74fb`) | **Keep dev's symlink** |
| Root `package.json` removal of `tree-sitter`/`tree-sitter-bash`/`tree-sitter-powershell` from `trustedDependencies` | **Keep dev's** (macOS/Linux need the native postinstalls) |
| `packages/app/public/*` asset materialization (120000→100644, from `9cc886e0ef`) | **Keep symlinks**; only update the `ui/src/assets/favicon/*` sources they point at |
| The two fork fix-up commits themselves | `07494a74fb`, `9cc886e0ef` skipped (their useful parts folded in correctly above) |

## 6. Verification

1. **`packages/app/package.json`**: manual merge — keep all of dev's content, appending only
   `"./jolli/fixtures"` and `"./jolli/types"` under `exports`.
2. **`bun.lock`**: regenerated via `bun install` (not taken from the fork). No new dependencies.
3. **Typecheck**: `bun run --cwd packages/app typecheck` and `bun run --cwd packages/desktop typecheck` — both exit 0 (symlinks must be preserved).
4. **Tests**: `bun run --cwd packages/app test` (use `bun run`, never bare `bun test`). Green
   except one **pre-existing, unrelated** ICU/locale failure in `src/i18n/desktop-native.test.ts`
   that also fails on `dev`.
5. **macOS `.icns`** remains upstream's icon (Luke could not build one; acceptable for a mock) —
   recorded as a known limitation.

## 7. Risks / notes

- **favicon symlink targets**: `packages/app/public/*` symlinks resolve to the updated
  `ui/src/assets/favicon/*` sources (e.g. `favicon.svg → ../../ui/src/assets/favicon/favicon.svg`).
- **session-ui FORK edits (coaching)**: the coach badge needs the `coachBadge` prop in
  `message-part.tsx` and the fade moved from parent onto children in `message-part.css`
  (a parent `opacity` caps every descendant). Both must travel together.
- **Suspense pitfall** (see the fork's DEV.md): coaching async must use signal+effect, never
  `createResource`, or the whole session route suspends. The ported code already avoids it.

## 8. Out of scope / follow-ups

- Reconciling the rebrand with the centralized `Brand` constants module on `feature/jolli-2317`.
- Generating Jolli macOS `.icns` icons.
- The fork PLAN.md's unfinished phases (Jolli sign-in, full lockdown, course scoping UI, etc.).
- The "comment margin" feature, removed here, remains available in the fork (`6ed31adc4a`) if
  it is wanted later.
