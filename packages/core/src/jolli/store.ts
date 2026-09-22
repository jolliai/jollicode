export * as JolliStore from "./store"

import { randomUUID } from "node:crypto"
import { eq, ne } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { JolliCredentialStateTable, JolliCredentialTable } from "./sql"

/** `jolli_credential_state` holds exactly one row. */
const STATE_ID = 1

/** The row id used until a backend reports a subject of its own. */
export const DEFAULT_ID = "default"

export type Row = typeof JolliCredentialTable.$inferSelect

export interface SignIn {
  readonly subject?: string
  readonly email?: string
  readonly baseUrl?: string
  readonly accessToken: string
  readonly refreshToken?: string
  /** Absolute epoch milliseconds, already resolved from the backend's `expires_in`. */
  readonly expiry?: number
}

export interface Rotation {
  readonly id: string
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiry?: number
  /**
   * The tenant's address, when the refresh reported one. Absent leaves the stored value alone —
   * see {@link Interface.persistToken}, where that rule is the opposite of the one `persist` uses.
   */
  readonly baseUrl?: string
}

export interface Interface {
  /** The active credential, or undefined when signed out. Never touches the network. */
  readonly active: () => Effect.Effect<Row | undefined>
  /** Replaces the credential for this identity and makes it active. Returns the stored row. */
  readonly persist: (input: SignIn) => Effect.Effect<Row>
  /**
   * Updates the access/refresh/expiry triple after a refresh, and the tenant's address with it.
   *
   * ⚠ AN ABSENT `baseUrl` LEAVES THE STORED ONE ALONE — THE OPPOSITE OF WHAT `persist` DOES WITH
   * THE SAME FIELD. A sign-in reports the whole identity, so a field it omits is a field that no
   * longer applies. A refresh reports what it could resolve: the endpoint answers without an
   * address whenever the tenant registry is unreachable, and nulling the row on that would send
   * every later refresh to the auth hub instead of the tenant, permanently, over one bad read.
   */
  readonly persistToken: (input: Rotation) => Effect.Effect<void>
  /** Removes the credential and clears the active pointer. */
  readonly remove: (id: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/JolliStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const read = (id: string) =>
      db.select().from(JolliCredentialTable).where(eq(JolliCredentialTable.id, id)).get().pipe(Effect.orDie)

    return Service.of({
      active: Effect.fn("JolliStore.active")(function* () {
        const state = yield* db
          .select()
          .from(JolliCredentialStateTable)
          .where(eq(JolliCredentialStateTable.id, STATE_ID))
          .get()
          .pipe(Effect.orDie)
        if (!state?.active_credential_id) return undefined
        return yield* read(state.active_credential_id)
      }),

      persist: Effect.fn("JolliStore.persist")(function* (input) {
        const id = input.subject ?? DEFAULT_ID
        // Minted once per call so the insert and the subjectless update below agree on it.
        const identity = randomUUID()
        /**
         * ⚠ EVERY NULLABLE FIELD IS WRITTEN EXPLICITLY, INCLUDING WHEN IT IS ABSENT. Omitting a key
         * from `set` tells drizzle to leave the old value alone, which would keep a tenant the new
         * sign-in did not report — the behaviour `jolli-auth.test.ts` pins as "forgets the tenant".
         */
        const fields = {
          subject: input.subject ?? null,
          email: input.email ?? null,
          base_url: input.baseUrl ?? null,
          access_token: input.accessToken,
          refresh_token: input.refreshToken ?? null,
          token_expiry: input.expiry ?? null,
        }
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(JolliCredentialTable)
                .values({ id, ...fields, cache_key: identity })
                /**
                 * ⚠ THE IDENTITY SURVIVES A RE-SIGN-IN, BECAUSE RE-MINTING IT WOULD ORPHAN THE
                 * PREVIOUS CATALOGUE SNAPSHOT — the cold three-request reload on the startup path
                 * that `jolli/cache.ts` keys its filename to avoid. So it is absent from `set`.
                 *
                 * ⚠ EXCEPT ON THE SUBJECTLESS ROW, WHERE KEEPING IT SERVED ONE STUDENT'S COURSES TO
                 * THE NEXT. `sub` is optional on the wire (`exchange.ts` tolerates its absence), and
                 * every sign-in that arrives without one lands on this single `default` row — so
                 * "keep the old key" means two DIFFERENT students share a cache filename, and B
                 * signing in within the TTL is served A's course list and A's model grants. That is
                 * exactly the leak the key exists to prevent, walked in through the fallback id.
                 * Without a subject there is nothing to tell a re-sign-in from a different person,
                 * and a cold reload is the cheaper of the two things to be wrong about.
                 */
                .onConflictDoUpdate({
                  target: JolliCredentialTable.id,
                  set: id === DEFAULT_ID ? { ...fields, cache_key: identity } : fields,
                })
                .run()
              /**
               * ⚠ SIGNING IN IS SIGNING IN AS SOMEBODY, AND THE PREVIOUS SOMEBODY'S TOKENS GO WITH
               * IT. Rows are keyed by subject, so "use a different account" writes a second row
               * and only moves the pointer below — leaving the last student's access AND refresh
               * token readable in a database the next person on this machine shares. There is no
               * account switcher to keep them for: the interface exposes one active credential.
               */
              yield* tx.delete(JolliCredentialTable).where(ne(JolliCredentialTable.id, id)).run()
              yield* tx
                .insert(JolliCredentialStateTable)
                .values({ id: STATE_ID, active_credential_id: id })
                .onConflictDoUpdate({ target: JolliCredentialStateTable.id, set: { active_credential_id: id } })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        // Re-read so the caller sees the minted `cache_key` rather than guessing at it.
        const row = yield* read(id)
        if (!row) return yield* Effect.die(new Error(`Jolli credential vanished immediately after write: ${id}`))
        return row
      }),

      persistToken: Effect.fn("JolliStore.persistToken")(function* (input) {
        yield* db
          .update(JolliCredentialTable)
          .set({
            access_token: input.accessToken,
            refresh_token: input.refreshToken ?? null,
            token_expiry: input.expiry ?? null,
            ...(input.baseUrl !== undefined ? { base_url: input.baseUrl } : {}),
          })
          .where(eq(JolliCredentialTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
      }),

      remove: Effect.fn("JolliStore.remove")(function* (id) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // The foreign key would null this on delete anyway; doing it first keeps the intent
              // readable and does not depend on `PRAGMA foreign_keys` being on.
              yield* tx
                .update(JolliCredentialStateTable)
                .set({ active_credential_id: null })
                .where(eq(JolliCredentialStateTable.active_credential_id, id))
                .run()
              yield* tx.delete(JolliCredentialTable).where(eq(JolliCredentialTable.id, id)).run()
            }),
          )
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
