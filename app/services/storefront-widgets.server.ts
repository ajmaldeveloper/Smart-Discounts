/**
 * Read-only, storefront-facing queries backing the App Proxy endpoints
 * under app/routes/apps.proxy.*.tsx. Deliberately separate from
 * campaign-compiler.server.ts's compileCampaign/compileCampaignForPublish
 * — those do live Admin API calls and bake in every sibling campaign for
 * checkout-time conflict resolution, far more than a storefront widget
 * needs (and too slow to call on every page load). This just reads
 * already-normalized reward data straight from the database.
 */

import db from "../db.server";
import { normalizeRewardConfig, type DiscountValue, type TierMetric } from "../lib/reward-types";
import { parseConditionTree, type ConditionGroup } from "../lib/campaign-types";

export type FreeShippingThreshold =
  | { active: true; minimumValue: number; minimumMetric: TierMetric }
  | { active: false };

/**
 * The free-shipping bar's threshold: the first ACTIVE campaign whose
 * Shipping reward sets minimumValue (see reward-types.ts's
 * ShippingReward — there's no tiers array on it, just this one flat
 * gate). First match wins if a shop somehow has more than one
 * qualifying campaign at once — a single active free-shipping campaign
 * is the overwhelmingly common case, and there's no UI yet for a
 * merchant to pick which one the storefront bar should track.
 */
export async function getActiveFreeShippingThreshold(shopId: string): Promise<FreeShippingThreshold> {
  const campaigns = await db.campaign.findMany({
    where: { shopId, status: "ACTIVE" },
    select: { rewardJson: true },
  });

  for (const campaign of campaigns) {
    const reward = normalizeRewardConfig(campaign.rewardJson);
    const shipping = reward.shipping;
    if (shipping?.minimumValue !== undefined) {
      // normalizeRewardConfig's normalizeMinimum always sets minimumMetric
      // (defaulting to "cart.quantity") whenever minimumValue is present —
      // this fallback is just for type-safety, never actually hit.
      return { active: true, minimumValue: shipping.minimumValue, minimumMetric: shipping.minimumMetric ?? "cart.quantity" };
    }
  }

  return { active: false };
}

export type OrderDiscountThreshold =
  | { active: true; minimumValue: number; minimumMetric: TierMetric; discountValue: DiscountValue }
  | { active: false };

/**
 * The order-discount bar's threshold: the first ACTIVE campaign whose
 * Order reward sets minimumValue — same "flat gate" shape as
 * ShippingReward, ignoring `tiers` (a multi-breakpoint order discount
 * is the separate tier-progress widget's job, not this one). Also
 * surfaces the reward's own DiscountValue so the bar's message can
 * show the actual %/amount the shopper unlocks, e.g. "Spend $20 more
 * for 15% off!".
 */
export async function getActiveOrderDiscountThreshold(shopId: string): Promise<OrderDiscountThreshold> {
  const campaigns = await db.campaign.findMany({
    where: { shopId, status: "ACTIVE" },
    select: { rewardJson: true },
  });

  for (const campaign of campaigns) {
    const reward = normalizeRewardConfig(campaign.rewardJson);
    const order = reward.order;
    if (order?.minimumValue !== undefined) {
      return {
        active: true,
        minimumValue: order.minimumValue,
        minimumMetric: order.minimumMetric ?? "cart.quantity",
        discountValue: order.value,
      };
    }
  }

  return { active: false };
}

export type BogoGiftCampaign =
  | {
      active: true;
      // The campaign's own top-level conditions (the "buy" side) —
      // evaluated client-side against the live cart, so the widget
      // knows whether the shopper has already qualified. Duplicated
      // (not imported) into the storefront bundle, same rationale as
      // extensions/winslet-discounts/src/condition-engine.ts.
      conditions: ConditionGroup;
      // The tier's minValue minus its getQuantity — how many
      // qualifying units the shopper needs before the first free unit
      // ramps in (see reward-types.ts's progressive-BOGO comment).
      buyQuantity: number;
      getQuantity: number;
      freeProductIds: string[];
    }
  | { active: false };

/**
 * The BOGO gift-picker widget's campaign: the first ACTIVE campaign
 * whose Product reward has a tier with freeProductIds set (see
 * reward-types.ts's TierBreak — freeProductIds only appears on a "Buy
 * X, get Y free with a pool of gift products" tier). First match wins
 * on the same reasoning as getActiveFreeShippingThreshold.
 */
export async function getActiveBogoGiftCampaign(shopId: string): Promise<BogoGiftCampaign> {
  const campaigns = await db.campaign.findMany({
    where: { shopId, status: "ACTIVE" },
    select: { conditionsJson: true, rewardJson: true },
  });

  for (const campaign of campaigns) {
    const reward = normalizeRewardConfig(campaign.rewardJson);
    const tier = reward.product?.tiers?.find((candidate) => (candidate.freeProductIds?.length ?? 0) > 0);
    if (tier?.freeProductIds && tier.getQuantity !== undefined) {
      return {
        active: true,
        conditions: parseConditionTree(campaign.conditionsJson),
        buyQuantity: Math.max(0, tier.minValue - tier.getQuantity),
        getQuantity: tier.getQuantity,
        freeProductIds: tier.freeProductIds,
      };
    }
  }

  return { active: false };
}
