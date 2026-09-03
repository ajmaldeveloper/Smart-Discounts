/**
 * Mirrors app/lib/conflict-resolution.ts's resolveConflicts EXACTLY.
 * See condition-engine.ts's module comment for why this is a
 * deliberate duplicate, not a cross-package import, and how parity is
 * enforced.
 */

export type ConflictStrategy = "HIGHEST_DISCOUNT" | "LOWEST_DISCOUNT" | "STACK";

export interface CampaignCandidate {
  id: string;
  priority: number;
  isExclusive: boolean;
  estimatedAmount: number;
}

export interface ConflictResolutionInput {
  strategy: ConflictStrategy;
  maxTotalDiscountAmount?: number;
  candidates: CampaignCandidate[];
}

export interface ConflictResolutionResult {
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
