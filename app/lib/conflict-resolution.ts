/**
 * The Smart Conflict Engine (M10).
 *
 * Why this has to be a pure, fully self-contained algorithm run
 * identically by every Campaign's own Function invocation: each
 * Campaign is its own Shopify Discount node, and Shopify invokes the
 * shared Function once PER discount node — Campaign A's invocation
 * never sees what Campaign B's invocation computed, and vice versa
 * (Shopify Functions "execute concurrently and don't have knowledge of
 * each other's output"). Winslet compensates by giving every
 * invocation the SAME full picture — its own config plus a snapshot of
 * every sibling campaign active as of its own last publish (see
 * campaign-compiler.server.ts) — so that running this exact function
 * independently in each invocation still converges on one consistent,
 * correct answer: every invocation evaluates the same candidate list
 * and the same deterministic tie-breaks, so they all agree on who
 * actually wins without ever talking to each other.
 *
 * Scope: resolves conflicts WITHIN one discount class at a time
 * (product-class campaigns compete only with other product-class
 * campaigns for the same cart; likewise for order-class). Shipping and
 * cross-class combination continue to be governed by Shopify's own
 * combinesWith settings, not this engine — a documented v1 boundary.
 */

export type ConflictStrategy = "HIGHEST_DISCOUNT" | "LOWEST_DISCOUNT" | "STACK";

export interface CampaignCandidate {
  id: string;
  priority: number;
  isExclusive: boolean;
  // This campaign's own estimated discount amount for the current
  // cart, in money terms, for the ONE discount class being resolved —
  // computed by the caller via resolveDiscountValue/computeDiscountAmount
  // against a matched campaign's own reward, exactly as it would emit.
  estimatedAmount: number;
}

export interface ConflictResolutionInput {
  strategy: ConflictStrategy;
  // Absolute money cap for this class's combined winning total,
  // already converted by the caller from Shop.maxTotalDiscountPercent
  // (a percent of cart subtotal) — kept unit-agnostic here.
  maxTotalDiscountAmount?: number;
  // Every campaign whose conditions matched this cart for this
  // discount class, including the campaign asking the question.
  candidates: CampaignCandidate[];
}

export interface ConflictResolutionResult {
  // campaign id -> scaling factor in [0, 1] to multiply that
  // campaign's own computed discount amount by. A campaign absent
  // here (or mapped to 0) must emit no discount for this class at all.
  scalingFactors: Record<string, number>;
}

function tieBreak(a: CampaignCandidate, b: CampaignCandidate, preferHighest: boolean): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.estimatedAmount !== b.estimatedAmount) {
    return preferHighest ? b.estimatedAmount - a.estimatedAmount : a.estimatedAmount - b.estimatedAmount;
  }
  return a.id.localeCompare(b.id);
}

export function resolveConflicts(input: ConflictResolutionInput): ConflictResolutionResult {
  const { strategy, maxTotalDiscountAmount, candidates } = input;
  if (candidates.length === 0) return { scalingFactors: {} };

  const exclusiveCandidates = candidates.filter((candidate) => candidate.isExclusive);

  let winners: CampaignCandidate[];

  if (exclusiveCandidates.length > 0) {
    // An exclusive match always wins alone, regardless of the shop's
    // default strategy — highest priority, then highest discount, then
    // id breaks a tie among multiple matching exclusive campaigns.
    winners = [[...exclusiveCandidates].sort((a, b) => tieBreak(a, b, true))[0]!];
  } else if (strategy === "STACK") {
    winners = candidates;
  } else {
    const sorted = [...candidates].sort((a, b) => tieBreak(a, b, strategy === "HIGHEST_DISCOUNT"));
    winners = [sorted[0]!];
  }

  const scalingFactors: Record<string, number> = {};
  for (const winner of winners) scalingFactors[winner.id] = 1;

  if (maxTotalDiscountAmount !== undefined) {
    const totalWinning = winners.reduce((sum, winner) => sum + winner.estimatedAmount, 0);
    if (totalWinning > maxTotalDiscountAmount && totalWinning > 0) {
      const scale = maxTotalDiscountAmount / totalWinning;
      for (const winner of winners) scalingFactors[winner.id] = scale;
    }
  }

  return { scalingFactors };
}
