import { chmodSync, existsSync } from "node:fs"

/**
 * TIGHTEN THE DATABASE FILE TO OWNER-ONLY.
 *
 * ⚠ IT MUST RUN BEFORE `PRAGMA journal_mode = WAL`, AND THAT IS THE WHOLE REASON THIS IS ITS OWN
 * FUNCTION. SQLite creates `-wal` and `-shm` itself, deriving their mode from the main database
 * file. Tightening after WAL is on leaves two world-readable siblings holding recently-written
 * pages — which, once the Jolli credential lives in this database, means the access token.
 *
 * ⚠ IT IS SYNCHRONOUS ON PURPOSE. The callers are `Layer.effect` bodies whose next statement is
 * the WAL pragma; an async chmod would let that pragma run first and reintroduce the very ordering
 * bug above.
 *
 * ⚠ IT LIVES HERE RATHER THAN INLINE BECAUSE IT SPANS THE `#sqlite` CONDITIONAL EXPORT. Both
 * `sqlite.bun.ts` and `sqlite.node.ts` need it and share nothing else; inlining it twice is how the
 * two copies drift.
 */
export function restrictDatabaseFile(filename: string) {
  /**
   * Node's `chmod` on Windows only toggles the read-only bit and cannot express 0600. The real
   * control there is ACL inheritance from `%LOCALAPPDATA%`, so pretending otherwise would be a
   * cross-platform call that silently does nothing.
   */
  if (process.platform === "win32") return
  if (filename === ":memory:" || filename.startsWith("file::memory:")) return

  // The siblings do not exist yet on a fresh open — that is the point of running before WAL — but a
  // database created by an older build already has them at 0644, and WAL reuses rather than
  // recreates them.
  for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (!existsSync(path)) continue
    try {
      chmodSync(path, 0o600)
    } catch {
      // A filesystem that refuses chmod (exotic mounts, some network shares) must not stop the
      // database from opening, and the failure is not actionable at this layer.
    }
  }
}
