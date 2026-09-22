import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * THE SIGNED-IN STUDENT'S JOLLI CREDENTIAL, IN THE DATABASE BOTH SURFACES ALREADY SHARE.
 *
 * ⚠ ONE STORE, BECAUSE TWO WAS THE BUG. The CLI kept this in `auth.json` and the desktop kept it
 * encrypted in the OS keychain, so signing in on one surface left the other signed out and
 * `jolli/credential.ts` had to let an environment variable outrank stored state to keep them apart.
 * `Global.Path.data` is machine-global and the desktop sidecar already reads and writes this same
 * file for sessions and messages; only the credential was missing.
 *
 * ⚠ SEPARATE COLUMNS, NOT ONE JSON VALUE. A refresh updates exactly the access/refresh/expiry
 * triple, and a JSON blob would make every rotation a read-modify-write that races the other
 * process and can resurrect a refresh token the server has already retired. `account/repo.ts`
 * writes its triple as a single UPDATE for the same reason. `token_expiry` is also compared, not
 * just stored.
 *
 * ⚠ KEYED BY IDENTITY RATHER THAN BEING A SINGLETON. One row is all today's product needs, but a
 * singleton `id` would have to be re-typed to add a second account later, and SQLite cannot change
 * a primary key in place. Keying by tenant instead would be wrong: two students on one machine at
 * the same tenant is exactly the case the catalogue cache key exists to keep apart.
 */
export const JolliCredentialTable = sqliteTable("jolli_credential", {
  /** The backend's subject when it reports one, else the literal `default`. */
  id: text().primaryKey(),
  /** The backend's user id. Null on a backend that predates it. */
  subject: text(),
  /** Display only. */
  email: text(),
  /** The student's tenant, e.g. `https://acme.jolli.ai`. Null when the backend reported none. */
  base_url: text(),
  access_token: text().notNull(),
  /**
   * Null means a legacy long-lived token with nothing to refresh with — which is also why a null
   * `token_expiry` reads as fresh rather than as "unknown, go refresh". See `jolli/session.ts`.
   */
  refresh_token: text(),
  /** Absolute epoch milliseconds. Null when the backend reported no expiry. */
  token_expiry: integer(),
  /**
   * THE CATALOGUE CACHE'S STABLE IDENTITY, MINTED ONCE AT INSERT.
   *
   * ⚠ IT EXISTS BECAUSE THE ACCESS TOKEN ROTATES AND THE CACHE FILENAME MUST NOT. `jolli/cache.ts`
   * hashes this into the snapshot's filename so that two students on one machine never read each
   * other's courses; keying that on the token itself would orphan the file on every refresh and
   * drop the student into a cold three-request reload on the startup path.
   *
   * ⚠ A REFRESH AND A RE-SIGN-IN MUST NOT TOUCH IT. Re-minting it on conflict would leave an
   * unreadable-but-findable snapshot behind every time.
   */
  cache_key: text().notNull(),
  ...Timestamps,
})

/**
 * WHICH CREDENTIAL IS ACTIVE. A singleton row, mirroring `account_state`.
 *
 * It carries no weight while there is one credential, and it is what lets a second one arrive
 * without a table rebuild.
 */
export const JolliCredentialStateTable = sqliteTable("jolli_credential_state", {
  id: integer().primaryKey(),
  active_credential_id: text().references(() => JolliCredentialTable.id, { onDelete: "set null" }),
})
