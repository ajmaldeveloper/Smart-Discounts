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
import { normalizeRewardConfig, type TierMetric } from "../lib/reward-types";

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
