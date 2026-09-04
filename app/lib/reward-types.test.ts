import { describe, expect, it } from "vitest";
import { computeDiscountAmount, hasAnyReward, normalizeRewardConfig, resolveDiscountValue, selectTier } from "./reward-types";

describe("normalizeRewardConfig", () => {
  it("normalizes a full valid config", () => {
    const config = normalizeRewardConfig({
      product: { value: { type: "percentage", value: 15 }, appliesTo: "ALL_MATCHING_LINES", maxDiscountAmount: 50 },
      order: { value: { type: "fixedAmount", value: 20 } },
      shipping: { value: { type: "percentage", value: 100 } },
    });

    expect(config).toEqual({
      product: { value: { type: "percentage", value: 15 }, appliesTo: "ALL_MATCHING_LINES", maxDiscountAmount: 50 },
      order: { value: { type: "fixedAmount", value: 20 } },
      shipping: { value: { type: "percentage", value: 100 } },
    });
  });

  it("normalizes a shipping reward's optionTitle, trimmed", () => {
    const config = normalizeRewardConfig({
      shipping: { value: { type: "percentage", value: 100 }, optionTitle: "  Standard  " },
    });
    expect(config.shipping?.optionTitle).toBe("Standard");
  });

  it("omits optionTitle when blank/absent — discounts every delivery option", () => {
    expect(normalizeRewardConfig({ shipping: { value: { type: "percentage", value: 100 }, optionTitle: "   " } }).shipping?.optionTitle).toBeUndefined();
    expect(normalizeRewardConfig({ shipping: { value: { type: "percentage", value: 100 } } }).shipping?.optionTitle).toBeUndefined();
  });

  it("clamps percentage to [0, 100] and fixedAmount to >= 0", () => {
    const config = normalizeRewardConfig({
      product: { value: { type: "percentage", value: 150 }, appliesTo: "ALL_MATCHING_LINES" },
      order: { value: { type: "fixedAmount", value: -5 } },
    });

    expect(config.product?.value).toEqual({ type: "percentage", value: 100 });
    expect(config.order?.value).toEqual({ type: "fixedAmount", value: 0 });
  });

  it("drops a malformed section instead of throwing", () => {
    expect(normalizeRewardConfig({ product: { value: { type: "bogus" } } })).toEqual({});
    expect(normalizeRewardConfig(null)).toEqual({});
    expect(normalizeRewardConfig("garbage")).toEqual({});
  });

  it("defaults an invalid appliesTo to ALL_MATCHING_LINES", () => {
    const config = normalizeRewardConfig({
      product: { value: { type: "percentage", value: 10 }, appliesTo: "NONSENSE" },
    });
    expect(config.product?.appliesTo).toBe("ALL_MATCHING_LINES");
  });

  it("normalizes a quantity-tiered product reward, sorted by minValue", () => {
    const config = normalizeRewardConfig({
      product: {
        value: { type: "percentage", value: 0 },
        appliesTo: "ALL_MATCHING_LINES",
        tierMetric: "cart.quantity",
        tiers: [
          { minValue: 6, value: { type: "percentage", value: 15 } },
          { minValue: 3, value: { type: "percentage", value: 10 } },
        ],
      },
    });

    expect(config.product?.tierMetric).toBe("cart.quantity");
    expect(config.product?.tiers).toEqual([
      { minValue: 3, value: { type: "percentage", value: 10 } },
      { minValue: 6, value: { type: "percentage", value: 15 } },
    ]);
  });

  it("drops a malformed tier row instead of rejecting the whole list", () => {
    const config = normalizeRewardConfig({
      order: {
        value: { type: "fixedAmount", value: 0 },
        tiers: [
          { minValue: 100, value: { type: "fixedAmount", value: 10 } },
          { minValue: "not-a-number", value: { type: "fixedAmount", value: 20 } },
          { minValue: 200, value: { type: "bogus" } },
        ],
      },
    });

    expect(config.order?.tiers).toEqual([{ minValue: 100, value: { type: "fixedAmount", value: 10 } }]);
  });

  it("an empty tiers array leaves the reward as a flat (non-tiered) value", () => {
    const config = normalizeRewardConfig({ order: { value: { type: "percentage", value: 10 }, tiers: [] } });
    expect(config.order?.tiers).toBeUndefined();
    expect(config.order?.tierMetric).toBeUndefined();
  });

  it("normalizes a valid mixAndMatch rule on a product reward", () => {
    const config = normalizeRewardConfig({
      product: { value: { type: "percentage", value: 0 }, appliesTo: "ALL_MATCHING_LINES", mixAndMatch: { bundleSize: 3, bundlePrice: 50 } },
    });
    expect(config.product?.mixAndMatch).toEqual({ bundleSize: 3, bundlePrice: 50 });
  });

  it("floors a fractional bundleSize and rejects one below 2", () => {
    const config = normalizeRewardConfig({
      product: { value: { type: "percentage", value: 0 }, appliesTo: "ALL_MATCHING_LINES", mixAndMatch: { bundleSize: 3.7, bundlePrice: 50 } },
    });
    expect(config.product?.mixAndMatch?.bundleSize).toBe(3);

    expect(
      normalizeRewardConfig({
        product: { value: { type: "percentage", value: 0 }, appliesTo: "ALL_MATCHING_LINES", mixAndMatch: { bundleSize: 1, bundlePrice: 50 } },
      }).product?.mixAndMatch,
    ).toBeUndefined();
  });

  it("rejects a negative bundlePrice", () => {
    const config = normalizeRewardConfig({
      product: { value: { type: "percentage", value: 0 }, appliesTo: "ALL_MATCHING_LINES", mixAndMatch: { bundleSize: 3, bundlePrice: -10 } },
    });
    expect(config.product?.mixAndMatch).toBeUndefined();
  });

  it("mixAndMatch wins over tiers when a malformed campaign somehow has both", () => {
    const config = normalizeRewardConfig({
      product: {
        value: { type: "percentage", value: 0 },
        appliesTo: "ALL_MATCHING_LINES",
        mixAndMatch: { bundleSize: 3, bundlePrice: 50 },
        tiers: [{ minValue: 2, value: { type: "percentage", value: 10 } }],
      },
    });
    expect(config.product?.mixAndMatch).toEqual({ bundleSize: 3, bundlePrice: 50 });
    expect(config.product?.tiers).toBeUndefined();
  });

  it("omits mixAndMatch for a missing/malformed value", () => {
    expect(
      normalizeRewardConfig({ product: { value: { type: "percentage", value: 10 }, appliesTo: "ALL_MATCHING_LINES" } }).product?.mixAndMatch,
    ).toBeUndefined();
    expect(
      normalizeRewardConfig({
        product: { value: { type: "percentage", value: 10 }, appliesTo: "ALL_MATCHING_LINES", mixAndMatch: "garbage" },
      }).product?.mixAndMatch,
    ).toBeUndefined();
  });
});

describe("selectTier", () => {
  const tiers = [
    { minValue: 3, value: { type: "percentage" as const, value: 10 } },
    { minValue: 6, value: { type: "percentage" as const, value: 15 } },
    { minValue: 10, value: { type: "percentage" as const, value: 20 } },
  ];

  it("picks the highest threshold the value qualifies for", () => {
    expect(selectTier(tiers, 2)).toBeNull();
    expect(selectTier(tiers, 3)).toMatchObject({ minValue: 3 });
    expect(selectTier(tiers, 5)).toMatchObject({ minValue: 3 });
    expect(selectTier(tiers, 6)).toMatchObject({ minValue: 6 });
    expect(selectTier(tiers, 100)).toMatchObject({ minValue: 10 });
  });
});

describe("resolveDiscountValue", () => {
  it("returns the flat value/cap when no tiers are configured", () => {
    const resolved = resolveDiscountValue(
      { value: { type: "percentage", value: 10 }, maxDiscountAmount: 50 },
      { quantity: 1, subtotal: 1 },
    );
    expect(resolved).toEqual({ value: { type: "percentage", value: 10 }, maxDiscountAmount: 50 });
  });

  it("returns null for a mixAndMatch reward rather than falling through to a stale flat value", () => {
    const resolved = resolveDiscountValue(
      { value: { type: "percentage", value: 99 }, mixAndMatch: { bundleSize: 3, bundlePrice: 50 } },
      { quantity: 3, subtotal: 60 },
    );
    expect(resolved).toBeNull();
  });

  it("resolves the qualifying tier's value/cap when tiers are configured, by quantity", () => {
    const reward = {
      value: { type: "percentage" as const, value: 0 },
      tierMetric: "cart.quantity" as const,
      tiers: [
        { minValue: 3, value: { type: "percentage" as const, value: 10 } },
        { minValue: 6, value: { type: "percentage" as const, value: 15 }, maxDiscountAmount: 30 },
      ],
    };

    expect(resolveDiscountValue(reward, { quantity: 4, subtotal: 0 })).toEqual({
      value: { type: "percentage", value: 10 },
      maxDiscountAmount: undefined,
    });
    expect(resolveDiscountValue(reward, { quantity: 6, subtotal: 0 })).toEqual({
      value: { type: "percentage", value: 15 },
      maxDiscountAmount: 30,
    });
  });

  it("resolves by subtotal when tierMetric is cart.subtotal", () => {
    const reward = {
      value: { type: "fixedAmount" as const, value: 0 },
      tierMetric: "cart.subtotal" as const,
      tiers: [{ minValue: 100, value: { type: "fixedAmount" as const, value: 10 } }],
    };

    expect(resolveDiscountValue(reward, { quantity: 999, subtotal: 50 })).toBeNull();
    expect(resolveDiscountValue(reward, { quantity: 0, subtotal: 150 })).toEqual({
      value: { type: "fixedAmount", value: 10 },
      maxDiscountAmount: undefined,
    });
  });

  it("returns null when tiers exist but none qualify — never falls back to the flat value", () => {
    const reward = {
      value: { type: "percentage" as const, value: 999 },
      tiers: [{ minValue: 10, value: { type: "percentage" as const, value: 10 } }],
    };
    expect(resolveDiscountValue(reward, { quantity: 1, subtotal: 1 })).toBeNull();
  });
});

describe("hasAnyReward", () => {
  it("is false for an empty config", () => {
    expect(hasAnyReward({})).toBe(false);
  });

  it("is true when any section is present", () => {
    expect(hasAnyReward({ shipping: { value: { type: "percentage", value: 100 } } })).toBe(true);
  });
});

describe("computeDiscountAmount", () => {
  it("computes a percentage discount", () => {
    expect(computeDiscountAmount({ type: "percentage", value: 20 }, 100)).toBe(20);
  });

  it("computes a fixed amount discount", () => {
    expect(computeDiscountAmount({ type: "fixedAmount", value: 30 }, 100)).toBe(30);
  });

  it("never exceeds the base amount", () => {
    expect(computeDiscountAmount({ type: "fixedAmount", value: 500 }, 100)).toBe(100);
    expect(computeDiscountAmount({ type: "percentage", value: 100 }, 42)).toBe(42);
  });

  it("respects a cap lower than the raw discount", () => {
    expect(computeDiscountAmount({ type: "percentage", value: 50 }, 200, 30)).toBe(30);
  });

  it("a cap higher than the raw discount has no effect", () => {
    expect(computeDiscountAmount({ type: "percentage", value: 10 }, 100, 500)).toBe(10);
  });

  it("never goes negative", () => {
    expect(computeDiscountAmount({ type: "fixedAmount", value: 10 }, 0)).toBe(0);
  });
});
