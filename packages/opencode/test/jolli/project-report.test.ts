import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { readProjectReport, shareableRemote } from "../../src/jolli/project-report"
import { tmpdir } from "../fixture/fixture"

/** The git the report reads through: the real binary, in the repository under test. */
const git = {
  run: (args: string[], opts: { cwd: string }) =>
    Effect.promise(async () => {
      const result = await $`git ${args}`.cwd(opts.cwd).quiet().nothrow()
      return {
        exitCode: result.exitCode,
        text: () => result.stdout.toString(),
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: false,
      }
    }),
}

const head = async (cwd: string) => (await $`git rev-parse HEAD`.cwd(cwd).quiet().text()).trim()
const commit = (cwd: string, subject: string) => $`git commit --allow-empty -m ${subject}`.cwd(cwd).quiet()

const read = (cwd: string, startHead: string | undefined, startedAt = Date.now()) =>
  Effect.runPromise(readProjectReport({ git, cwd, startHead, startedAt }))

describe("readProjectReport", () => {
  test("reports the commits made since the session started, oldest first, and which are not pushed", async () => {
    await using repo = await tmpdir({ git: true })
    const start = await head(repo.path)
    await commit(repo.path, "first")
    await commit(repo.path, "second")
    // A remote-tracking ref that holds "first" but not "second": the state after a push and a commit.
    const first = (await $`git rev-parse HEAD~1`.cwd(repo.path).quiet().text()).trim()
    await $`git update-ref refs/remotes/origin/main ${first}`.cwd(repo.path).quiet()
    await $`git remote add origin https://jordan:ghp_secret@github.com/cs310-fall26/lab4-jordanlee.git`
      .cwd(repo.path)
      .quiet()

    const report = await read(repo.path, start)
    expect(report?.remoteUrl).toBe("https://github.com/cs310-fall26/lab4-jordanlee.git")
    expect(report?.branch).toBeTruthy()
    expect(report?.commits.map((item) => [item.subject, item.pushed])).toEqual([
      ["first", true],
      ["second", false],
    ])
    expect(report?.commits[0]?.sha).toBe(first)
    expect(report?.commits[0]?.shortSha.length).toBeGreaterThanOrEqual(7)
  })

  /** ⚠ A REBASE TAKES THE START COMMIT OUT OF HEAD'S HISTORY; TIME IS THE FALLBACK, NOT THE RULE. */
  test("falls back to the session's start time when the start commit is no longer behind HEAD", async () => {
    await using repo = await tmpdir({ git: true })
    await commit(repo.path, "since the start")
    const report = await read(repo.path, "0".repeat(40), Date.now() - 60_000)
    expect(report?.commits.map((item) => item.subject)).toContain("since the start")
    expect(report?.remoteUrl).toBeNull()
  })

  /** ⚠ WHAT COULD NOT BE READ IS NOT CLAIMED: a failed check of the remotes reports nothing pushed. */
  test("reports no commit pushed when the remotes cannot be checked", async () => {
    await using repo = await tmpdir({ git: true })
    const start = await head(repo.path)
    await commit(repo.path, "first")
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(repo.path).quiet()
    const failing = {
      run: (args: string[], opts: { cwd: string }) =>
        args[0] === "rev-list" ? git.run(["rev-list", "--no-such-flag"], opts) : git.run(args, opts),
    }
    const report = await Effect.runPromise(
      readProjectReport({ git: failing, cwd: repo.path, startHead: start, startedAt: Date.now() }),
    )
    expect(report?.commits.map((item) => [item.subject, item.pushed])).toEqual([["first", false]])
  })

  test("reports nothing outside a repository", async () => {
    await using dir = await tmpdir()
    expect(await read(dir.path, undefined)).toBeUndefined()
  })
})

describe("shareableRemote", () => {
  test("takes the user, password, query and fragment out of a URL remote", () => {
    expect(shareableRemote("https://x-access-token:ghs_abc@github.com/a/b.git?x=1#y")).toBe(
      "https://github.com/a/b.git",
    )
  })

  test("keeps an scp-style remote, which carries no password", () => {
    expect(shareableRemote("git@github.com:a/b.git")).toBe("git@github.com:a/b.git")
    expect(shareableRemote("github.com:a/b.git")).toBe("github.com:a/b.git")
  })

  test("reports no remote that is a path on this machine", () => {
    expect(shareableRemote("/home/jordan/school/lab4.git")).toBeNull()
    expect(shareableRemote("../lab4.git")).toBeNull()
    expect(shareableRemote("C:\\Users\\jordan\\lab4.git")).toBeNull()
    expect(shareableRemote("C:/Users/jordan/lab4.git")).toBeNull()
    expect(shareableRemote("file:///Users/jordan/lab4.git")).toBeNull()
  })
})
