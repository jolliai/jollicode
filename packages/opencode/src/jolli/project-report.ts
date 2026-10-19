/**
 * WHAT A TASK'S HAND-IN REPORTS OF THE PROJECT: WHERE IT LIVES, ITS BRANCH, AND THE COMMITS MADE
 * WHILE THE SESSION RAN.
 *
 * ⚠ NO CODE, NO DIFF, NO LOCAL PATH. The teacher reads where the work is and which commits are the
 * student's; the work itself stays in the repository, behind whatever access its host gives.
 *
 * ⚠ "WHILE THE SESSION RAN" IS "SINCE THE COMMIT HEAD WAS AT WHEN IT STARTED". Time alone is fooled by
 * a rebase and by a machine's clock; the commit the start route recorded is not. Only when that commit
 * is no longer behind HEAD — a rebase, a reset, another branch — does this fall back to the session's
 * start time, which may count a commit too many or too few.
 *
 * ⚠ "PUSHED" IS WHAT THIS MACHINE LAST FETCHED. A commit some remote branch here holds is pushed; one
 * none holds is not. Nothing is fetched to find out: a hand-in must not wait on the network, and the
 * report says what the student's machine saw, which is all it claims.
 *
 * ⚠ CREDENTIALS NEVER LEAVE. A remote like `https://user:token@host/repo` is reported without them;
 * the gateway takes them out again, but they should not have been sent.
 *
 * ⚠ NOR DOES A REMOTE ON THIS MACHINE. `/home/jordan/lab4.git` or `file:///Users/jordan/lab4.git` is a
 * local path — the student's user name included — and no teacher can open it, so it is not reported.
 */
import type { HandedInCommit, ProjectReport } from "@opencode-ai/core/jolli/api"
import { Effect } from "effect"
import type { Git } from "@/git"

/** The most commits a hand-in reports; the gateway keeps no more. */
const MAX_COMMITS = 50

/** Fields of one `git log` line, apart. */
const FIELD = "\u001f"

export const readProjectReport = Effect.fn("JolliProjectReport.read")(function* (input: {
  git: Pick<Git.Interface, "run">
  cwd: string
  /** The commit HEAD was at when the session started, when it was in a repository then. */
  startHead: string | undefined
  /** When the session started, in milliseconds: the fallback when `startHead` is no longer behind HEAD. */
  startedAt: number
}) {
  const git = (args: string[]) =>
    input.git
      .run(args, { cwd: input.cwd })
      .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, text: result.text() })))

  const inside = yield* git(["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.text.trim() !== "true") return undefined

  const branch = yield* git(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
    Effect.map((read) => (read.ok && read.text.trim() !== "HEAD" ? read.text.trim() || null : null)),
  )
  const remoteUrl = yield* remoteOf(git)

  const hasHead = (yield* git(["rev-parse", "--verify", "--quiet", "HEAD"])).ok
  if (!hasHead) return { remoteUrl, branch, commits: [] } satisfies ProjectReport

  const behind =
    input.startHead !== undefined && (yield* git(["merge-base", "--is-ancestor", input.startHead, "HEAD"])).ok
  const range = behind ? [`${input.startHead}..HEAD`] : ["HEAD", `--since=@${Math.floor(input.startedAt / 1000)}`]

  const log = yield* git(["log", `--max-count=${MAX_COMMITS}`, `--format=%H${FIELD}%h${FIELD}%cI${FIELD}%s`, ...range])
  // Unread is not pushed: a failure must not tell the teacher the commits are somewhere they can see.
  const unpushed = yield* git(["rev-list", ...range, "--not", "--remotes"]).pipe(
    Effect.map((read) => (read.ok ? new Set(read.text.split(/\r?\n/).filter(Boolean)) : undefined)),
  )
  const commits = (log.ok ? log.text.split(/\r?\n/) : [])
    .filter(Boolean)
    .flatMap((line): HandedInCommit[] => {
      const [sha, shortSha, committedAt, ...subject] = line.split(FIELD)
      if (!sha || !shortSha || !committedAt) return []
      return [
        {
          sha,
          shortSha,
          subject: subject.join(FIELD),
          committedAt,
          pushed: unpushed !== undefined && !unpushed.has(sha),
        },
      ]
    })
    // `git log` lists newest first; the report reads oldest first.
    .toReversed()
  return { remoteUrl, branch, commits } satisfies ProjectReport
})

/** The `origin` remote, else the first one there is, as {@link shareableRemote} reports it; null when there is none. */
const remoteOf = Effect.fn("JolliProjectReport.remote")(function* (
  git: (args: string[]) => Effect.Effect<{ ok: boolean; text: string }>,
) {
  const origin = yield* git(["remote", "get-url", "origin"])
  if (origin.ok && origin.text.trim()) return shareableRemote(origin.text.trim())
  const names = yield* git(["remote"])
  const first = names.ok ? names.text.split(/\r?\n/).find(Boolean) : undefined
  if (!first) return null
  const url = yield* git(["remote", "get-url", first])
  return url.ok && url.text.trim() ? shareableRemote(url.text.trim()) : null
})

/**
 * A remote with any user name, password or token taken out, and no query or fragment; null when it is
 * a path on this machine, or a URL that does not parse.
 *
 * ⚠ AN SCP-STYLE REMOTE (`git@host:path`) IS KEPT AS IT IS. It cannot carry a password, and its user
 * is the host's fixed SSH account, not the student's. Git's own rule tells one from a path: a colon
 * before any slash, unless it is a Windows drive letter.
 */
export function shareableRemote(remote: string) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return /^[^/\\]{2,}:/.test(remote) ? remote : null
  if (!URL.canParse(remote)) return null
  const url = new URL(remote)
  if (url.protocol === "file:") return null
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString()
}
