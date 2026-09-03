/**
 * extensions/winslet-discounts/src/conflict-resolution.ts is a
 * deliberate duplicate of app/lib/conflict-resolution.ts (see
 * condition-engine.ts's module comment for the full rationale). This
 * test runs the plan's own worked example, plus the exclusive/cap
 * edge cases, through both and fails the moment they disagree.
 */
import { describe, expect, it } from "vitest";
import * as adminEngine from "./conflict-resolution";
// eslint-disable-next-line import/no-relative-packages -- deliberate cross-package import, test-only
import * as functionEngine from "../../extensions/winslet-discounts/src/conflict-resolution";
import type { CampaignCandidate } from "./conflict-resolution";

function candidate(overrides: Partial<CampaignCandidate> & Pick<CampaignCandidate, "id" | "estimatedAmount">): CampaignCandidate {
  return { priority: 0, isExclusive: false, ...overrides };
}

describe("conflict resolution parity", () => {
  it("agrees on the plan's own worked example (STACK + 25% cap)", () => {
    const input = {
      strategy: "STACK" as const,
      maxTotalDiscountAmount: 25,
      candidates: [
        candidate({ id: "vip-15", estimatedAmount: 15 }),
        candidate({ id: "canada-summer-10", estimatedAmount: 10 }),
        candidate({ id: "buy5-20", estimatedAmount: 20 }),
      ],
    };
    expect(functionEngine.resolveConflicts(input)).toEqual(adminEngine.resolveConflicts(input));
  });

  it.each(["HIGHEST_DISCOUNT", "LOWEST_DISCOUNT", "STACK"] as const)("agrees for strategy=%s with mixed priorities", (strategy) => {
    const input = {
      strategy,
      candidates: [
        candidate({ id: "a", estimatedAmount: 15, priority: 1 }),
        candidate({ id: "b", estimatedAmount: 10, priority: 5 }),
        candidate({ id: "c", estimatedAmount: 20, priority: 0 }),
      ],
    };
    expect(functionEngine.resolveConflicts(input)).toEqual(adminEngine.resolveConflicts(input));
  });

  it("agrees when an exclusive candidate overrides STACK", () => {
    const input = {
      strategy: "STACK" as const,
      candidates: [
        candidate({ id: "normal", estimatedAmount: 30 }),
        candidate({ id: "exclusive", estimatedAmount: 5, isExclusive: true }),
      ],
    };
    expect(functionEngine.resolveConflicts(input)).toEqual(adminEngine.resolveConflicts(input));
  });

  it("agrees with no candidates", () => {
    const input = { strategy: "STACK" as const, candidates: [] };
    expect(functionEngine.resolveConflicts(input)).toEqual(adminEngine.resolveConflicts(input));
  });
});
