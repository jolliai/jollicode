import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922032558_jolli_credential",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`jolli_credential_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_credential_id\` text,
          CONSTRAINT \`fk_jolli_credential_state_active_credential_id_jolli_credential_id_fk\` FOREIGN KEY (\`active_credential_id\`) REFERENCES \`jolli_credential\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`jolli_credential\` (
          \`id\` text PRIMARY KEY,
          \`subject\` text,
          \`email\` text,
          \`base_url\` text,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text,
          \`token_expiry\` integer,
          \`cache_key\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
