# Releasing

Jolli Code ships the CLI and the desktop app through manually dispatched GitHub Actions workflows. Each product's version and release notes come from its own `CHANGELOG.md`; nothing else chooses a version.

| Product | Changelog | Workflow | Published to |
| --- | --- | --- | --- |
| CLI | `packages/opencode/CHANGELOG.md` | `publish-cli` (`.github/workflows/publish.yml`) | npm `@jolli.ai/jollicode`, GitHub release `cli-vX.Y.Z` in `jolliai/jollicode` |
| Desktop | `packages/desktop/CHANGELOG.md` | `publish-desktop` (`.github/workflows/publish-desktop.yml`) | GitHub release `desktop-vX.Y.Z` in `jolliai/jollicode-releases` |

The VS Code extension follows the same pattern with `sdks/vscode/CHANGELOG.md` and `publish-vscode`.

Every workflow can be dispatched from the `gh` commands below or from the web: open https://github.com/jolliai/jollicode/actions, pick the workflow in the sidebar, click **Run workflow**, keep the branch on **dev**, and confirm.

## 1. Prepare the changelogs

1. Check what has landed since the last release, for example `git log --oneline cli-v0.0.1..origin/dev` or `git log --oneline desktop-v0.0.2..origin/dev`.
2. Add a `## MAJOR.MINOR.PATCH` section at the top of each changelog you are releasing. The whole section, up to the next `##` heading, becomes the GitHub release notes, so write it for users.
3. The version must be newer than the one already published: npm `latest` for the CLI, the highest published `desktop-v*` release for desktop. The workflows refuse anything else, because desktop clients allow downgrades and would roll back to a lower Latest.
4. Merge the changelog change into `dev` and wait for `test` and `typecheck` to pass there.

## 2. Release the CLI

```sh
gh workflow run publish-cli -R jolliai/jollicode --ref dev
gh run watch -R jolliai/jollicode $(gh run list -R jolliai/jollicode -w publish-cli -L 1 --json databaseId -q '.[0].databaseId')
```

What the run does:

1. `version`: reads the changelog, checks the version against npm, and creates (or reuses) a draft release `cli-vX.Y.Z`.
2. `build-cli`: builds the macOS, Linux and Windows binaries.
3. `sign-cli-windows`: signs the Windows binaries through Azure Key Vault when the vault secrets are set, otherwise warns and ships them unsigned, then uploads the Windows zips to the draft.
4. `publish`: runs `script/publish.ts`, which publishes to npm, pushes the `cli-vX.Y.Z` tag, pushes a "sync release versions" commit onto `dev`, and publishes the draft.

Release the CLI before desktop whenever both are going out: the desktop build pins whichever CLI version is current on npm for its Windows WSL installer.

## 3. Release desktop

```sh
gh workflow run publish-desktop -R jolliai/jollicode --ref dev
```

What the run does:

1. `version`: reads the changelog, checks the version against the published `desktop-v*` releases, reads the current CLI version from npm, creates (or reuses) a draft in `jolliai/jollicode-releases`, and deletes any other stale desktop drafts.
2. `build-electron`: builds and packages macOS (x64, arm64), Windows (x64, arm64) and Linux (x64, arm64). macOS builds are signed and notarized; Windows builds are signed through Azure Key Vault.
3. `publish`: uploads the installers, finalizes the `latest*.yml` update manifests, tags the source commit in `jolliai/jollicode` with `desktop-vX.Y.Z`, and publishes the release as Latest. Installed apps auto-update from it.

### Windows signing

The Windows legs sign every executable with the Azure Key Vault certificate and fail if any `AZURE_*` secret is missing; the desktop installer never ships unsigned. There is no switch to skip signing: installed apps auto-update to whatever is published as Latest without checking its signature, so an unsigned Windows release would move every install onto an unsigned build.

## Rules and gotchas

- Dispatch from `dev` only. Both workflows fail on any other ref.
- Only one run of each workflow happens at a time; a second dispatch waits.
- A failed run leaves a draft release behind. Fix the cause on `dev` and dispatch again: the next run reuses the draft for the same tag, points it at the new commit, and refreshes its notes. Do not delete drafts by hand unless you are abandoning that version.
- A CLI draft whose tag shows as `untagged-<hash>` on GitHub has lost its tag name, which happens when anything edits it without resending `tag_name`. Later steps find the draft by tag and fail with `release not found`. Restore the tag with `gh api -X PATCH repos/jolliai/jollicode/releases/<id> -f tag_name=cli-vX.Y.Z`.
- A `publish-cli` run can be marked failed after npm already has the new version. Check npm (`npm view @jolli.ai/jollicode version`) and the GitHub release before re-running, since a re-run refuses a version npm already has. In that case finish the remaining steps by hand rather than bumping the version.
- If a PR merges into `dev` during a CLI release, the version sync commit retries on the new tip; it gives up after five attempts.

## Secrets the workflows need

Set on `jolliai/jollicode`:

- `JOLLICODE_APP_ID` (variable) and `JOLLICODE_APP_SECRET`: the GitHub App that creates releases and pushes tags and the version sync commit.
- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_KEY_VAULT_URL`, `AZURE_KEY_VAULT_CERTIFICATE`: Windows signing.
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, `APPLE_API_ISSUER`: macOS signing and notarization.
- Optional: `SENTRY_AUTH_TOKEN` plus the `SENTRY_ORG`, `WEB_SENTRY_PROJECT` and `WEB_SENTRY_DSN` variables, for desktop source maps and crash reporting. None are set today, and desktop builds without them.

npm needs no token secret: the workflow publishes with GitHub OIDC (`id-token: write`), so `@jolli.ai/jollicode` must keep `jolliai/jollicode`'s `publish.yml` as a trusted publisher on npm.
