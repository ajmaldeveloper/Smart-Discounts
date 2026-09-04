/**
 * The Promotion Simulator (M11): runs every one of a shop's campaigns
 * against a merchant-entered hypothetical scenario, using the exact
 * same evaluateConditionNode/resolveDiscountValue/resolveConflicts the
 * checkout Function uses (parity-tested identical — see
 * campaign-types.parity.test.ts, reward-types.parity.test.ts,
 * conflict-resolution.parity.test.ts) — so what the simulator says
 * will happen is what actually happens, not a best-effort guess.
 *
 * Deliberately evaluates against each campaign's DECLARED conditions
 * (conditionsJson as the builder edits it), not the compiled/resolved
 * tree the Function reads. A real product.tag/collection.id/market.id
 * condition normally gets resolved into concrete GIDs at publish time
 * (see campaign-compiler.server.ts) because the Function can't look up
 * "does this product have tag X" itself — but the simulator isn't
 * looking up a real product; the merchant directly states the
 * hypothetical product's tags/vendor/type in the scenario, so the
 * generic evaluator can check the declared condition directly with no
 * resolution step needed. Resource-list conditions (product.id,
 * variant.id, collection.id, market.id — real GIDs) are checked
 * against whatever GIDs the merchant optionally types into the
 * matching scenario field; the simulator has no live resource picker.
 */

import db from "../db.server";
import { evaluateConditionNode, parseConditionTree, type ConditionContext } from "../lib/campaign-types";
import { explainConditionNode, failingLeaves, type ExplainedNode } from "../lib/condition-explain";
import { normalizeRewardConfig, resolveDiscountValue, computeDiscountAmount, hasAnyReward } from "../lib/reward-types";
import { resolveConflicts, type CampaignCandidate, type ConflictStrategy } from "../lib/conflict-resolution";

export interface SimulatorScenario {
  countryCode: string;
  languageCode: string;
  currencyCode: string;
  customerLoggedIn: boolean;
  customerTags: string[];
  customerTotalSpent: number;
  customerOrderCount: number;
  cartSubtotal: number;
  cartQuantity: number;
  cartTotalWeight: number;
  productVendor: string;
  productType: string;
  productTags: string[];
  variantSku: string;
  productIds: string[];
  variantIds: string[];
  collectionIds: string[];
  marketIds: string[];
}

export function buildScenarioContext(scenario: SimulatorScenario): ConditionContext {
  return {
    "market.countryCode": scenario.countryCode,
    "market.languageCode": scenario.languageCode,
    "currency.code": scenario.currencyCode,
    "customer.loggedIn": scenario.customerLoggedIn,
    "customer.tag": scenario.customerTags,
    "customer.totalSpent": scenario.customerTotalSpent,
    "customer.orderCount": scenario.customerOrderCount,
    "cart.subtotal": scenario.cartSubtotal,
    "cart.quantity": scenario.cartQuantity,
    "cart.totalWeight": scenario.cartTotalWeight,
    "product.vendor": scenario.productVendor,
    "product.type": scenario.productType,
    "product.tag": scenario.productTags,
    "variant.sku": scenario.variantSku,
    "product.id": scenario.productIds,
    "variant.id": scenario.variantIds,
    "collection.id": scenario.collectionIds,
    "market.id": scenario.marketIds,
  };
}

export interface SimulatedCampaignResult {
  campaignId: string;
  campaignName: string;
  status: string;
  matched: boolean;
  explanation: ExplainedNode;
  failingFieldSummaries: string[];
  estimatedProductAmount: number;
  estimatedOrderAmount: number;
  // Set once conflict resolution runs across every matched campaign —
  // undefined for a campaign that didn't match at all.
  appliedProductAmount?: number;
  appliedOrderAmount?: number;
  suppressedByConflict: boolean;
}

export interface SimulatorResult {
  campaigns: SimulatedCampaignResult[];
  totalProductDiscount: number;
  totalOrderDiscount: number;
  totalSavings: number;
}

export async function runSimulation(shopId: string, scenario: SimulatorScenario): Promise<SimulatorResult> {
  const campaigns = await db.campaign.findMany({
    // Variant B of an A/B test is excluded: the simulator has no
    // concept of which bucket a shopper would land in, and the
    // checkout Function itself defaults an unassigned/missing bucket
    // to "A" (see cart_lines_discounts_generate_run.ts's abBucketFor)
    // — showing Variant B here would make it look like both variants
    // always compete simultaneously, which never actually happens at
    // checkout.
    // Prisma's `{ not: "B" }` on a nullable column excludes NULLs too
    // (translates to a plain `!= 'B'`, which is neither true nor false
    // for a null row) — the OR spells out "no variant at all, or some
    // variant that isn't B" explicitly instead.
    where: {
      shopId,
      status: { in: ["ACTIVE", "DRAFT", "PAUSED"] },
      OR: [{ experimentVariant: null }, { experimentVariant: { not: "B" } }],
    },
    orderBy: { updatedAt: "desc" },
  });

  const context = buildScenarioContext(scenario);
  const tierMetrics = { quantity: scenario.cartQuantity, subtotal: scenario.cartSubtotal };

  const evaluated = campaigns.map((campaign) => {
    const tree = parseConditionTree(campaign.conditionsJson);
    const explanation = explainConditionNode(tree, context);
    const matched = evaluateConditionNode(tree, context);
    const reward = normalizeRewardConfig(campaign.rewardJson);

    let estimatedProductAmount = 0;
    if (matched && reward.product) {
      const resolved = resolveDiscountValue(reward.product, tierMetrics);
      if (resolved) estimatedProductAmount = computeDiscountAmount(resolved.value, scenario.cartSubtotal, resolved.maxDiscountAmount);
    }

    let estimatedOrderAmount = 0;
    if (matched && reward.order) {
      const resolved = resolveDiscountValue(reward.order, tierMetrics);
      if (resolved) estimatedOrderAmount = computeDiscountAmount(resolved.value, scenario.cartSubtotal, resolved.maxDiscountAmount);
    }

    return {
      campaign,
      matched,
      explanation,
      hasReward: hasAnyReward(reward),
      priority: campaign.priority,
      isExclusive: campaign.isExclusive,
      estimatedProductAmount,
      estimatedOrderAmount,
    };
  });

  const matchedForProduct = evaluated.filter((e) => e.matched && e.estimatedProductAmount > 0);
  const matchedForOrder = evaluated.filter((e) => e.matched && e.estimatedOrderAmount > 0);

  // Every ACTIVE campaign shares one shop-wide conflict policy at
  // runtime (see campaign-compiler.server.ts) — the simulator applies
  // the same policy uniformly across whichever campaigns matched here,
  // DRAFT/PAUSED included, so a merchant can preview a not-yet-active
  // campaign's effect on today's live conflict landscape.
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { conflictStrategy: true, maxTotalDiscountPercent: true } });
  const strategy = shop.conflictStrategy as ConflictStrategy;
  const maxTotalDiscountAmount =
    shop.maxTotalDiscountPercent !== null ? scenario.cartSubtotal * (shop.maxTotalDiscountPercent / 100) : undefined;

  function resolveAmounts(pool: typeof evaluated, pick: (e: (typeof evaluated)[number]) => number): Record<string, number> {
    if (pool.length === 0) return {};
    const candidates: CampaignCandidate[] = pool.map((e) => ({
      id: e.campaign.id,
      priority: e.priority,
      isExclusive: e.isExclusive,
      estimatedAmount: pick(e),
    }));
    const resolution = resolveConflicts({ strategy, maxTotalDiscountAmount, candidates });
    const applied: Record<string, number> = {};
    for (const e of pool) {
      const factor = resolution.scalingFactors[e.campaign.id] ?? 0;
      applied[e.campaign.id] = pick(e) * factor;
    }
    return applied;
  }

  const appliedProduct = resolveAmounts(matchedForProduct, (e) => e.estimatedProductAmount);
  const appliedOrder = resolveAmounts(matchedForOrder, (e) => e.estimatedOrderAmount);

  const results: SimulatedCampaignResult[] = evaluated.map((e) => {
    const appliedProductAmount = e.campaign.id in appliedProduct ? appliedProduct[e.campaign.id] : undefined;
    const appliedOrderAmount = e.campaign.id in appliedOrder ? appliedOrder[e.campaign.id] : undefined;

    return {
      campaignId: e.campaign.id,
      campaignName: e.campaign.name,
      status: e.campaign.status,
      matched: e.matched,
      explanation: e.explanation,
      failingFieldSummaries: failingLeaves(e.explanation).map((leaf) => leaf.description),
      estimatedProductAmount: e.estimatedProductAmount,
      estimatedOrderAmount: e.estimatedOrderAmount,
      ...(appliedProductAmount !== undefined ? { appliedProductAmount } : {}),
      ...(appliedOrderAmount !== undefined ? { appliedOrderAmount } : {}),
      suppressedByConflict:
        (e.estimatedProductAmount > 0 && (appliedProductAmount ?? 0) === 0) ||
        (e.estimatedOrderAmount > 0 && (appliedOrderAmount ?? 0) === 0),
    };
  });

  const totalProductDiscount = Object.values(appliedProduct).reduce((sum, amount) => sum + amount, 0);
  const totalOrderDiscount = Object.values(appliedOrder).reduce((sum, amount) => sum + amount, 0);

  return {
    campaigns: results,
    totalProductDiscount,
    totalOrderDiscount,
    totalSavings: totalProductDiscount + totalOrderDiscount,
  };
}
