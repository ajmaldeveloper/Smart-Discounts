/**
 * extensions/winslet-discounts/src/reward-engine.ts is a deliberate
 * duplicate of app/lib/reward-types.ts's selectTier/resolveDiscountValue/
 * computeDiscountAmount (see condition-engine.ts's module comment for
 * the full rationale). This test runs the same cases through both and
 * fails the moment they disagree.
 */
import { describe, expect, it } from "vitest";
import * as adminEngine from "./reward-types";
// eslint-disable-next-line import/no-relative-packages -- deliberate cross-package import, test-only
import * as functionEngine from "../../extensions/winslet-discounts/src/reward-engine";

describe("reward engine parity: app/lib/reward-types.ts vs extensions/winslet-discounts/src/reward-engine.ts", () => {
  const tiers = [
    { minValue: 3, value: { type: "percentage" as const, value: 10 } },
    { minValue: 6, value: { type: "percentage" as const, value: 15 }, maxDiscountAmount: 30 },
    { minValue: 10, value: { type: "percentage" as const, value: 20 } },
  ];

  it.each([0, 2, 3, 5, 6, 9, 10, 100])("selectTier agrees for metricValue=%i", (metricValue) => {
    expect(functionEngine.selectTier(tiers, metricValue)).toEqual(adminEngine.selectTier(tiers, metricValue));
  });

  it("resolveDiscountValue agrees for a flat (non-tiered) reward", () => {
    const reward = { value: { type: "fixedAmount" as const, value: 20 }, maxDiscountAmount: 15 };
    const metrics = { quantity: 1, subtotal: 150 };
    expect(functionEngine.resolveDiscountValue(reward, metrics)).toEqual(adminEngine.resolveDiscountValue(reward, metrics));
  });

  it("resolveDiscountValue agrees for a tiered reward, both above and below the floor", () => {
    const reward = { value: { type: "percentage" as const, value: 999 }, tierMetric: "cart.quantity" as const, tiers };
    expect(functionEngine.resolveDiscountValue(reward, { quantity: 7, subtotal: 0 })).toEqual(
      adminEngine.resolveDiscountValue(reward, { quantity: 7, subtotal: 0 }),
    );
    expect(functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 0 })).toEqual(
      adminEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 0 })
    );
    expect(functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 0 })).toBeNull();
  });

  it("resolveDiscountValue surfaces the selected tier's own name, agreeing between engines", () => {
    const namedTiers = [
      { minValue: 2, value: { type: "percentage" as const, value: 10 }, name: "Buy 2 get 1 free" },
      { minValue: 3, value: { type: "percentage" as const, value: 15 }, name: "Buy 3 get 3 free" },
    ];
    const reward = { value: { type: "percentage" as const, value: 999 }, tierMetric: "cart.quantity" as const, tiers: namedTiers };

    const atTwo = functionEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 });
    expect(atTwo).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 }));
    expect(atTwo?.name).toBe("Buy 2 get 1 free");

    const atThree = functionEngine.resolveDiscountValue(reward, { quantity: 3, subtotal: 0 });
    expect(atThree).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 3, subtotal: 0 }));
    expect(atThree?.name).toBe("Buy 3 get 3 free");
  });

  it.each([2, 3, 4, 5, 6, 100])("selectTier agrees on exactMatch vs threshold tiers for metricValue=%i", (metricValue) => {
    // Mirrors wholesale-registration's own selectBreak test shape: an
    // exact-match break at 3 (a "buy exactly 3" bundle) alongside a
    // normal threshold break at 5+ — the exact break should only win
    // at precisely 3, never at 4 (falls through to no tier) or above 5
    // (the threshold break, having the higher minValue, wins there).
    const exactAndThresholdTiers = [
      { minValue: 3, value: { type: "fixedAmount" as const, value: 10 }, exactMatch: true },
      { minValue: 5, value: { type: "percentage" as const, value: 15 } },
    ];
    expect(functionEngine.selectTier(exactAndThresholdTiers, metricValue)).toEqual(
      adminEngine.selectTier(exactAndThresholdTiers, metricValue),
    );
  });

  it("selectTier treats an exactMatch tier as a no-match everywhere but its own value", () => {
    const exactOnly = [{ minValue: 3, value: { type: "fixedAmount" as const, value: 10 }, exactMatch: true }];
    expect(functionEngine.selectTier(exactOnly, 3)).toEqual(adminEngine.selectTier(exactOnly, 3));
    expect(adminEngine.selectTier(exactOnly, 3)).not.toBeNull();
    expect(functionEngine.selectTier(exactOnly, 4)).toEqual(adminEngine.selectTier(exactOnly, 4));
    expect(adminEngine.selectTier(exactOnly, 4)).toBeNull();
  });

  it("resolveDiscountValue surfaces a Buy X get Y free tier's getQuantity, agreeing between engines", () => {
    // "Buy 2, get 1 free": a single tier at minValue=3 (2 paid + 1
    // free), 100% off, capped to 1 unit via getQuantity.
    const bogoTiers = [{ minValue: 3, value: { type: "percentage" as const, value: 100 }, getQuantity: 1 }];
    const reward = { value: { type: "percentage" as const, value: 0 }, tierMetric: "cart.quantity" as const, tiers: bogoTiers };

    const atThree = functionEngine.resolveDiscountValue(reward, { quantity: 3, subtotal: 0 });
    expect(atThree).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 3, subtotal: 0 }));
    expect(atThree?.getQuantity).toBe(1);

    const atTwo = functionEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 });
    expect(atTwo).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 }));
    expect(atTwo).toBeNull();
  });

  it("resolveDiscountValue ramps a Buy X get Y free tier's granted quantity progressively, agreeing between engines", () => {
    // "Buy 2, get 2 free" (minValue 4, getQuantity 2): free units should
    // scale in one at a time above the buy threshold rather than
    // requiring the full buy+get quantity before anything is free.
    const progressiveBogoTiers = [{ minValue: 4, value: { type: "percentage" as const, value: 100 }, getQuantity: 2 }];
    const reward = { value: { type: "percentage" as const, value: 0 }, tierMetric: "cart.quantity" as const, tiers: progressiveBogoTiers };

    const atTwo = functionEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 });
    expect(atTwo).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 }));
    expect(atTwo).toBeNull();

    const atThree = functionEngine.resolveDiscountValue(reward, { quantity: 3, subtotal: 0 });
    expect(atThree).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 3, subtotal: 0 }));
    expect(atThree?.getQuantity).toBe(1);

    const atFour = functionEngine.resolveDiscountValue(reward, { quantity: 4, subtotal: 0 });
    expect(atFour).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 4, subtotal: 0 }));
    expect(atFour?.getQuantity).toBe(2);

    const atFive = functionEngine.resolveDiscountValue(reward, { quantity: 5, subtotal: 0 });
    expect(atFive).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 5, subtotal: 0 }));
    expect(atFive?.getQuantity).toBe(2);
  });

  it("resolveDiscountValue surfaces a free-gift tier's freeProductIds, agreeing between engines", () => {
    const freeGiftTiers = [
      {
        minValue: 2,
        value: { type: "percentage" as const, value: 100 },
        getQuantity: 1,
        freeProductIds: ["gid://shopify/Product/999", "gid://shopify/Product/1000"],
      },
    ];
    const reward = { value: { type: "percentage" as const, value: 0 }, tierMetric: "cart.quantity" as const, tiers: freeGiftTiers };

    const atTwo = functionEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 });
    expect(atTwo).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 }));
    expect(atTwo?.freeProductIds).toEqual(["gid://shopify/Product/999", "gid://shopify/Product/1000"]);

    const atOne = functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 0 });
    expect(atOne).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 0 }));
    expect(atOne).toBeNull();
  });

  it("resolveDiscountValue surfaces a free-gift tier's freeGiftAllocation choice, agreeing between engines", () => {
    const mostExpensiveFirstTiers = [
      {
        minValue: 2,
        value: { type: "percentage" as const, value: 100 },
        getQuantity: 1,
        freeProductIds: ["gid://shopify/Product/999", "gid://shopify/Product/1000"],
        freeGiftAllocation: "MOST_EXPENSIVE" as const,
      },
    ];
    const reward = {
      value: { type: "percentage" as const, value: 0 },
      tierMetric: "cart.quantity" as const,
      tiers: mostExpensiveFirstTiers,
    };

    const atTwo = functionEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 });
    expect(atTwo).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 2, subtotal: 0 }));
    expect(atTwo?.freeGiftAllocation).toBe("MOST_EXPENSIVE");
  });

  it("resolveDiscountValue enforces a Simple (non-tiered) reward's minimum requirement, agreeing between engines", () => {
    const reward = { value: { type: "percentage" as const, value: 15 }, minimumMetric: "cart.subtotal" as const, minimumValue: 50 };

    const below = functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 49.99 });
    expect(below).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 49.99 }));
    expect(below).toBeNull();

    const atThreshold = functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 50 });
    expect(atThreshold).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 50 }));
    expect(atThreshold).not.toBeNull();
  });

  it("resolveDiscountValue's minimum requirement is an extra floor UNDER a tiered reward, not a replacement for tier minValue", () => {
    // An overall $100 floor sits in front of a tier ladder whose own
    // lowest rung only needs $10 — the floor must win even though the
    // tier itself would otherwise have qualified.
    const reward = {
      value: { type: "percentage" as const, value: 999 },
      tierMetric: "cart.subtotal" as const,
      tiers: [{ minValue: 10, value: { type: "percentage" as const, value: 10 } }],
      minimumMetric: "cart.subtotal" as const,
      minimumValue: 100,
    };

    const belowFloor = functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 50 });
    expect(belowFloor).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 50 }));
    expect(belowFloor).toBeNull();

    const aboveFloor = functionEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 150 });
    expect(aboveFloor).toEqual(adminEngine.resolveDiscountValue(reward, { quantity: 1, subtotal: 150 }));
    expect(aboveFloor).not.toBeNull();
  });

  it.each([
    [{ type: "percentage" as const, value: 20 }, 100, undefined],
    [{ type: "fixedAmount" as const, value: 500 }, 100, undefined],
    [{ type: "percentage" as const, value: 50 }, 200, 30],
  ] as const)("computeDiscountAmount agrees for %j on base %i with cap %s", (value, base, cap) => {
    expect(functionEngine.computeDiscountAmount(value, base, cap)).toBe(adminEngine.computeDiscountAmount(value, base, cap));
  });
});
