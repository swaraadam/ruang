/**
 * Most-restrictive-wins — blueprint §7.2.
 *
 * "The Project establishes domain invariants and the safety floor. `change_unit` is owned by the
 * Project/domain and a Role cannot override it. For `change_budget` and evidence requirements,
 * most-restrictive-wins; a Role may tighten but never loosen."
 *
 * One function implements that sentence, and it is used three times: folding an org node's
 * `policy_overrides` onto a Project, folding a Role's `output_contract` on top, and checking a
 * delegate's contract against its delegator's (§7.3). Three call sites, one rule — so the rule
 * cannot hold in one place and not another.
 *
 * **Totality.** `tighten` answers for every input pair. It never returns "leave it as it was" for
 * a field it could not compare: an incomparable pair is `ok: false`, which the loader turns into a
 * configuration error and the runtime turns into a refusal. The only way to reach a resolved
 * contract is for every field to have been *decided*.
 */
import type { ContractOverride, EffectiveContract, EvidenceProfile } from './vocabulary.js';

/**
 * Strictness order for §16.1's three profiles, highest number = hardest to satisfy.
 *
 * `partial` lets a skipped required check through on an acknowledgement; `strong` blocks it without
 * an owner waiver; `manual-required` can never be rendered green-equivalent and needs an owner
 * acknowledgement before apply. So tightening runs partial -> strong -> manual-required.
 *
 * Typed as a total `Record` over the closed union on purpose. A fourth profile added to
 * `EVIDENCE_PROFILES` without a rank here is a **compile error**, not a lookup that yields
 * `undefined` and compares as loose. That is the "missing case must not be a silent permit" rule,
 * expressed where it is cheapest to enforce.
 */
export const EVIDENCE_STRICTNESS = {
  partial: 0,
  strong: 1,
  'manual-required': 2,
} as const satisfies Record<EvidenceProfile, number>;

/** Higher strictness wins. Equal is not a loosening, so equal is allowed and returns the base. */
export const tightestEvidence = (
  base: EvidenceProfile,
  override: EvidenceProfile,
): EvidenceProfile => (EVIDENCE_STRICTNESS[override] > EVIDENCE_STRICTNESS[base] ? override : base);

/** Which declared field a refusal is about, so the caller can name an exact config path. */
export type ContractField = 'change_unit' | 'change_budget' | 'evidence_profile';

export type TightenOutcome =
  | { readonly ok: true; readonly contract: EffectiveContract }
  | { readonly ok: false; readonly field: ContractField; readonly why: string };

/**
 * Apply an override to a base contract, refusing anything that would widen it.
 *
 * `change_unit` is not folded, it is *checked*. §7.2 gives the unit to the Project, so a declared
 * unit that agrees is redundant and a declared unit that disagrees is an override attempt — and
 * there is no third possibility, because units are names, not magnitudes. This is also why a
 * `change_budget` never needs converting: the number is always in the Project's unit.
 */
export const tighten = (base: EffectiveContract, override: ContractOverride): TightenOutcome => {
  const unit = override.change_unit;
  if (unit !== undefined && unit !== base.change_unit) {
    return {
      ok: false,
      field: 'change_unit',
      why: `declares change_unit '${unit}' but the Project owns change_unit '${base.change_unit}'; §7.2 gives the unit to the Project and budgets are counted in it`,
    };
  }

  const budget = override.change_budget;
  if (budget !== undefined && !isBudget(budget)) {
    return {
      ok: false,
      field: 'change_budget',
      why: `change_budget must be a non-negative whole number of ${base.change_unit}, got ${JSON.stringify(budget)}`,
    };
  }
  if (budget !== undefined && budget > base.change_budget) {
    return {
      ok: false,
      field: 'change_budget',
      why: `change_budget ${budget} loosens the ${base.change_budget} ${base.change_unit} it inherits; §7.2 allows tightening only`,
    };
  }

  const evidence = override.evidence_profile;
  if (
    evidence !== undefined &&
    EVIDENCE_STRICTNESS[evidence] < EVIDENCE_STRICTNESS[base.evidence_profile]
  ) {
    return {
      ok: false,
      field: 'evidence_profile',
      why: `evidence_profile '${evidence}' loosens the '${base.evidence_profile}' floor it inherits; §7.2 allows tightening only`,
    };
  }

  return {
    ok: true,
    contract: {
      change_unit: base.change_unit,
      change_budget: budget ?? base.change_budget,
      evidence_profile:
        evidence === undefined
          ? base.evidence_profile
          : tightestEvidence(base.evidence_profile, evidence),
    },
  };
};

/** A budget is a count of whole units. `NaN`, fractions and negatives are not counts. */
export const isBudget = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** An `EffectiveContract` read as a fully-declared override, for comparing two resolved contracts. */
export const asOverride = (contract: EffectiveContract): ContractOverride => ({
  change_unit: contract.change_unit,
  change_budget: contract.change_budget,
  evidence_profile: contract.evidence_profile,
});
