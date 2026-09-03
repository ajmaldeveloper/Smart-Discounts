import { describe, expect, it } from "vitest";
import { resolveConflicts, type CampaignCandidate } from "./conflict-resolution";

function candidate(overrides: Partial<CampaignCandidate> & Pick<CampaignCandidate, "id" | "estimatedAmount">): CampaignCandidate {
  return { priority: 0, isExclusive: false, ...overrides };
}

describe("resolveConflicts — no candidates", () => {
  it("returns no winners", () => {
    expect(resolveConflicts({ strategy: "STACK", candidates: [] })).toEqual({ scalingFactors: {} });
  });
});

describe("resolveConflicts — HIGHEST_DISCOUNT", () => {
  it("only the highest estimated amount wins", () => {
    const candidates = [
      candidate({ id: "vip-15", estimatedAmount: 15 }),
      candidate({ id: "canada-summer-10", estimatedAmount: 10 }),
      candidate({ id: "buy5-20", estimatedAmount: 20 }),
    ];

    const result = resolveConflicts({ strategy: "HIGHEST_DISCOUNT", candidates });
    expect(result.scalingFactors).toEqual({ "buy5-20": 1 });
  });

  it("breaks a tie by priority, then by id", () => {
    const tiedByAmount = [
      candidate({ id: "b", estimatedAmount: 10, priority: 5 }),
      candidate({ id: "a", estimatedAmount: 10, priority: 10 }),
    ];
    expect(resolveConflicts({ strategy: "HIGHEST_DISCOUNT", candidates: tiedByAmount }).scalingFactors).toEqual({ a: 1 });

    const tiedByEverything = [candidate({ id: "z", estimatedAmount: 10 }), candidate({ id: "a", estimatedAmount: 10 })];
    expect(resolveConflicts({ strategy: "HIGHEST_DISCOUNT", candidates: tiedByEverything }).scalingFactors).toEqual({ a: 1 });
  });
});

describe("resolveConflicts — LOWEST_DISCOUNT", () => {
  it("only the lowest estimated amount wins", () => {
    const candidates = [candidate({ id: "high", estimatedAmount: 20 }), candidate({ id: "low", estimatedAmount: 5 })];
    expect(resolveConflicts({ strategy: "LOWEST_DISCOUNT", candidates }).scalingFactors).toEqual({ low: 1 });
  });
});

describe("resolveConflicts — STACK", () => {
  it("every matched candidate wins at full value", () => {
    const candidates = [candidate({ id: "a", estimatedAmount: 15 }), candidate({ id: "b", estimatedAmount: 10 })];
    expect(resolveConflicts({ strategy: "STACK", candidates }).scalingFactors).toEqual({ a: 1, b: 1 });
  });
});

describe("resolveConflicts — isExclusive overrides the shop strategy", () => {
  it("an exclusive match wins alone even under STACK", () => {
    const candidates = [
      candidate({ id: "normal-a", estimatedAmount: 15 }),
      candidate({ id: "normal-b", estimatedAmount: 10 }),
      candidate({ id: "vip-exclusive", estimatedAmount: 5, isExclusive: true }),
    ];
    expect(resolveConflicts({ strategy: "STACK", candidates }).scalingFactors).toEqual({ "vip-exclusive": 1 });
  });

  it("among multiple exclusive matches, priority then amount then id breaks the tie", () => {
    const candidates = [
      candidate({ id: "excl-low-priority", estimatedAmount: 100, isExclusive: true, priority: 0 }),
      candidate({ id: "excl-high-priority", estimatedAmount: 5, isExclusive: true, priority: 10 }),
    ];
    expect(resolveConflicts({ strategy: "HIGHEST_DISCOUNT", candidates }).scalingFactors).toEqual({ "excl-high-priority": 1 });
  });
});

describe("resolveConflicts — maxTotalDiscountAmount cap", () => {
  it("scales down a single winner that alone exceeds the cap", () => {
    const candidates = [candidate({ id: "a", estimatedAmount: 40 })];
    const result = resolveConflicts({ strategy: "HIGHEST_DISCOUNT", maxTotalDiscountAmount: 25, candidates });
    expect(result.scalingFactors.a).toBeCloseTo(25 / 40);
  });

  it("scales every stacked winner proportionally so their combined total hits exactly the cap", () => {
    // The plan's own worked example: three campaigns would combine to
    // 45 (15+10+20) under STACK, but the shop caps total promotional
    // discount at 25 — every winner is scaled down proportionally,
    // not just clipped, so the relative weighting a merchant configured
    // between campaigns is preserved.
    const candidates = [
      candidate({ id: "vip-15", estimatedAmount: 15 }),
      candidate({ id: "canada-summer-10", estimatedAmount: 10 }),
      candidate({ id: "buy5-20", estimatedAmount: 20 }),
    ];

    const result = resolveConflicts({ strategy: "STACK", maxTotalDiscountAmount: 25, candidates });
    const scale = 25 / 45;
    expect(result.scalingFactors["vip-15"]).toBeCloseTo(scale);
    expect(result.scalingFactors["canada-summer-10"]).toBeCloseTo(scale);
    expect(result.scalingFactors["buy5-20"]).toBeCloseTo(scale);

    const total = candidates.reduce((sum, c) => sum + c.estimatedAmount * result.scalingFactors[c.id]!, 0);
    expect(total).toBeCloseTo(25);
  });

  it("does nothing when the winning total is already under the cap", () => {
    const candidates = [candidate({ id: "a", estimatedAmount: 10 })];
    const result = resolveConflicts({ strategy: "HIGHEST_DISCOUNT", maxTotalDiscountAmount: 25, candidates });
    expect(result.scalingFactors.a).toBe(1);
  });

  it("a losing (non-winning) candidate is never scaled by the cap — it simply isn't in the map", () => {
    const candidates = [candidate({ id: "winner", estimatedAmount: 100 }), candidate({ id: "loser", estimatedAmount: 1 })];
    const result = resolveConflicts({ strategy: "HIGHEST_DISCOUNT", maxTotalDiscountAmount: 25, candidates });
    expect(result.scalingFactors.loser).toBeUndefined();
  });
});
