/**
 * Mirrors app/lib/reward-types.ts's DiscountValue/RewardConfig,
 * selectTier, resolveDiscountValue and computeDiscountAmount EXACTLY.
 * See condition-engine.ts's module comment for why this is a
 * deliberate duplicate, not a cross-package import, and how parity is
 * enforced.
 */

export type DiscountValue = { type: "percentage"; value: number } | { type: "fixedAmount"; value: number };

export type TierMetric = "cart.quantity" | "cart.subtotal";

export interface TierBreak {
  minValue: number;
  value: DiscountValue;
  maxDiscountAmount?: number;
  name?: string;
  exactMatch?: boolean;
  getQuantity?: number;
  freeProductIds?: string[];
  freeGiftAllocation?: "CHEAPEST" | "MOST_EXPENSIVE";
}

export interface ProductReward {
  value: DiscountValue;
  appliesTo: "ALL_MATCHING_LINES" | "CHEAPEST_MATCHING_LINE" | "MOST_EXPENSIVE_MATCHING_LINE";
  maxDiscountAmount?: number;
  tierMetric?: TierMetric;
  tiers?: TierBreak[];
  name?: string;
  minimumMetric?: TierMetric;
  minimumValue?: number;
}

export interface OrderReward {
  value: DiscountValue;
  maxDiscountAmount?: number;
  tierMetric?: TierMetric;
  tiers?: TierBreak[];
  name?: string;
  minimumMetric?: TierMetric;
  minimumValue?: number;
}

export interface ShippingReward {
  value: DiscountValue;
  maxDiscountAmount?: number;
  optionTitle?: string;
  name?: string;
  minimumMetric?: TierMetric;
  minimumValue?: number;
}

// Shown to the customer in their cart and at checkout when the
// merchant hasn't set their own reward.name (see the matching comment
// on ProductReward in app/lib/reward-types.ts).
export const DEFAULT_DISCOUNT_MESSAGE = "Winslet discount";

export interface RewardConfig {
  product?: ProductReward;
  order?: OrderReward;
  shipping?: ShippingReward;
}

export function selectTier(tiers: TierBreak[], metricValue: number): TierBreak | null {
  let best: TierBreak | null = null;

  for (const tier of tiers) {
    const qualifyingThreshold = tier.getQuantity !== undefined ? tier.minValue - tier.getQuantity + 1 : tier.minValue;
    const matches = tier.exactMatch ? metricValue === tier.minValue : metricValue >= qualifyingThreshold;
    if (matches && (!best || tier.minValue > best.minValue)) {
      best = tier;
    }
  }

  return best;
}

export function resolveDiscountValue(
  reward: {
    value: DiscountValue;
    maxDiscountAmount?: number;
    tierMetric?: TierMetric;
    tiers?: TierBreak[];
    minimumMetric?: TierMetric;
    minimumValue?: number;
  },
  metrics: { quantity: number; subtotal: number },
): {
  value: DiscountValue;
  maxDiscountAmount?: number;
  name?: string;
  getQuantity?: number;
  freeProductIds?: string[];
  freeGiftAllocation?: "CHEAPEST" | "MOST_EXPENSIVE";
} | null {
  if (reward.minimumValue !== undefined && reward.minimumValue > 0) {
    const minimumMetricValue = reward.minimumMetric === "cart.subtotal" ? metrics.subtotal : metrics.quantity;
    if (minimumMetricValue < reward.minimumValue) return null;
  }

  if (reward.tiers && reward.tiers.length > 0) {
    const metricValue = reward.tierMetric === "cart.subtotal" ? metrics.subtotal : metrics.quantity;
    const tier = selectTier(reward.tiers, metricValue);
    if (!tier) return null;

    const getQuantity =
      tier.getQuantity !== undefined ? Math.max(0, Math.min(tier.getQuantity, metricValue - tier.minValue + tier.getQuantity)) : undefined;

    return {
      value: tier.value,
      maxDiscountAmount: tier.maxDiscountAmount,
      name: tier.name,
      getQuantity,
      freeProductIds: tier.freeProductIds,
      freeGiftAllocation: tier.freeGiftAllocation,
    };
  }

  return { value: reward.value, maxDiscountAmount: reward.maxDiscountAmount };
}

export function computeDiscountAmount(value: DiscountValue, baseAmount: number, maxDiscountAmount?: number): number {
  const raw = value.type === "percentage" ? baseAmount * (value.value / 100) : value.value;
  const capped = maxDiscountAmount !== undefined ? Math.min(raw, maxDiscountAmount) : raw;
  return Math.max(0, Math.min(capped, baseAmount));
}
