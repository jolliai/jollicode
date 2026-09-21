/**
 * HOW HEAVY EACH GRANTED MODEL IS, AS THE GATEWAY CLASSIFIES IT.
 *
 * ⚠ IT REPLACED A LOOKUP TABLE, AND THE REPLACEMENT WAS NOT OPTIONAL. The tier used to be found by
 * searching `MODEL_CATALOG` for the model's id. Model ids are now the gateway's Registry UUIDs, so
 * that search could never match again — `coachTurn`'s model-choice branch would have gone quiet
 * with nothing to show for it, which is the worst kind of regression: a feature that still renders.
 *
 * ⚠ KEYED BY MODEL, NOT BY ASSISTANT. The nudge asks about the model that ACTUALLY RAN a turn, and
 * a student may have switched away from the professor's default. A tier carried on the assistant
 * would answer a different question and be wrong exactly when the picker got used.
 *
 * ⚠ A MODULE SIGNAL, FOR THE SAME REASON `model-grant.ts` IS ONE: it is written by the catalog
 * store and read by a pure gate that has no reactive owner of its own.
 */

import { createSignal } from "solid-js"
import type { ModelTier } from "./types"

export type { ModelTier }

const [tiers, setTiers] = createSignal<Readonly<Record<string, ModelTier>>>({})

export const ModelTiers = {
  all: tiers,
  /** Called by the catalog store whenever `/jolli/course` lands. */
  set(next: Readonly<Record<string, ModelTier>>) {
    setTiers(next)
  },
}

/**
 * The tier of an opencode model key (`jolli/<uuid>`), or undefined when the gateway did not
 * classify it — in which case callers stay silent rather than guessing a default.
 */
export function modelTier(modelKey: string): ModelTier | undefined {
  return tiers()[modelKey]
}
