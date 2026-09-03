import type { Shop } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  assertPlanFeature,
  assertPlanLimit,
  getPlanDefinition,
  getSerializablePlan,
  planHasFeature,
  type PlanCode,
  type PlanFeature,
  type PlanLimits,
} from "./plans.server";
import { synchronizeShopSubscription } from "./subscriptions.server";

const ACTIVE_PLAN_STATUS = "ACTIVE";

export type ShopEntitlements = {
  shopId: string;
  shopDomain: string;
  storedPlanCode: string;
  storedPlanStatus: string;
  effectivePlanCode: PlanCode;
  plan: ReturnType<typeof getSerializablePlan>;
};

/**
 * A paid plan is only trusted when its synchronized subscription
 * status is ACTIVE — pending, frozen, cancelled, or unknown plans
 * safely fall back to Free. See subscriptions.server.ts for how
 * planStatus actually gets set.
 */
function getEffectivePlanCode(shop: Pick<Shop, "planCode" | "planStatus">): PlanCode {
  if (shop.planStatus !== ACTIVE_PLAN_STATUS) return "FREE";
  return getPlanDefinition(shop.planCode).code;
}

function toEntitlements(shop: Pick<Shop, "id" | "domain" | "planCode" | "planStatus">): ShopEntitlements {
  const effectivePlanCode = getEffectivePlanCode(shop);
  return {
    shopId: shop.id,
    shopDomain: shop.domain,
    storedPlanCode: shop.planCode,
    storedPlanStatus: shop.planStatus,
    effectivePlanCode,
    plan: getSerializablePlan(effectivePlanCode),
  };
}

/**
 * The central source every action/loader should use. Browser-supplied
 * plan names must never be trusted — this always reads the shop's own
 * cached (Partner-API-verified, see subscriptions.server.ts) row.
 */
export async function getShopEntitlements(shopDomain: string): Promise<ShopEntitlements> {
  const shop = await db.shop.findUniqueOrThrow({ where: { domain: shopDomain } });
  return toEntitlements(shop);
}

/**
 * Same as getShopEntitlements, but forces a live Partner-API
 * resync first — used only where a merchant needs to see a just-made
 * plan change immediately (the Plans page, the post-checkout
 * subscription-sync redirect). Falls back to the cached entitlements
 * on ANY sync failure (missing Partner API credentials not yet
 * configured, a network hiccup, Shopify API error) rather than
 * breaking the page — a stale-by-one-request plan is a much smaller
 * problem than an unusable Plans page.
 */
export async function getFreshShopEntitlements(admin: AdminApiContext, shopDomain: string): Promise<ShopEntitlements> {
  try {
    await synchronizeShopSubscription(shopDomain, admin);
  } catch (error) {
    console.error(`[entitlements] Failed to sync subscription for ${shopDomain}; falling back to the cached plan.`, error);
  }

  return getShopEntitlements(shopDomain);
}

export async function requireShopFeature(shopDomain: string, feature: PlanFeature): Promise<ShopEntitlements> {
  const entitlements = await getShopEntitlements(shopDomain);
  assertPlanFeature(entitlements.effectivePlanCode, feature);
  return entitlements;
}

export async function requireShopLimit(shopDomain: string, limitName: keyof PlanLimits, currentUsage: number, additionalUsage = 1): Promise<ShopEntitlements> {
  const entitlements = await getShopEntitlements(shopDomain);
  assertPlanLimit(entitlements.effectivePlanCode, limitName, currentUsage, additionalUsage);
  return entitlements;
}

/** Active + draft campaigns both count — a plan's campaign limit caps how many exist at all, not just how many are live. */
export async function requireActiveCampaignCapacity(shopDomain: string, shopId: string, additionalCampaigns = 1): Promise<ShopEntitlements> {
  const currentCampaigns = await db.campaign.count({ where: { shopId } });
  return requireShopLimit(shopDomain, "activeCampaigns", currentCampaigns, additionalCampaigns);
}

export async function requireTiersAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "TIERS");
}

export async function requireFreeGiftBogoAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "FREE_GIFT_BOGO");
}

export async function requireCodeDiscountsAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "CODE_DISCOUNTS");
}

export async function requireCustomerTargetingAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "CUSTOMER_TARGETING");
}

export async function requireProductTargetingAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "PRODUCT_TARGETING");
}

export async function requireMarketTargetingAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "MARKET_TARGETING");
}

export async function requireMinimumRequirementAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "MINIMUM_REQUIREMENT");
}

export async function requireStackingAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "STACKING");
}

export async function requireAnalyticsAccess(shopDomain: string): Promise<ShopEntitlements> {
  return requireShopFeature(shopDomain, "ANALYTICS");
}

/** Non-throwing check for UI gating (disabling a control) — use the require* functions above for the server-side enforcement that actually matters. */
export async function hasShopFeature(shopDomain: string, feature: PlanFeature): Promise<boolean> {
  const entitlements = await getShopEntitlements(shopDomain);
  return planHasFeature(entitlements.effectivePlanCode, feature);
}
