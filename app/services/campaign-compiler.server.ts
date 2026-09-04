/**
 * Compiles a Campaign's author-time condition tree (what the builder
 * UI edits — product.tag, collection.id, product.id, cart.subtotal,
 * etc., see app/lib/condition-fields.ts) into the run-time tree the
 * Shopify Function actually evaluates.
 *
 * Why this exists: the Function API's Product/Customer types only
 * expose tag and collection membership through hasAnyTag/hasTags and
 * inAnyCollection/inCollections, which take a STATIC list of tags/ids
 * fixed at query-authoring time. Winslet's Functions are shared across
 * every campaign in every shop, so there is no single static list that
 * could work for all of them — each campaign's tags/collections are
 * only known at publish time. wholesale-registration hit this same
 * wall and solved it the same way this does: resolve tag/collection
 * membership into concrete product-GID lists server-side (Admin API
 * has no such static-argument restriction), and let the Function do a
 * plain array-membership check instead. See that app's
 * pricing-compiler.server.ts and its comment on this exact tradeoff.
 *
 * product.vendor, product.type and variant.sku need no resolution —
 * they're plain string fields on the Function API's Product/
 * ProductVariant types, so the Function reads them directly.
 *
 * market.id gets the same treatment for an unrelated reason: the
 * Function API's own `localization.market` field is deprecated
 * outright (scheduled for removal), and Shopify separately warns that
 * a buyer can match parent and child Markets, so a single stored
 * Market ID was never a robust target. Each market.id leaf is resolved
 * here into the concrete ISO country codes it covers (see
 * resolveMarketCountryCodes) and rewritten into a market.countryCode
 * in/not_in check — country code, read from
 * input.localization.country.isoCode, is the stable signal the
 * Function actually checks.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Campaign } from "@prisma/client";
import db from "../db.server";
import {
  parseConditionTree,
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionNode,
  type ConditionOperator,
} from "../lib/campaign-types";
import { normalizeRewardConfig } from "../lib/reward-types";
import { RESOLVED_PRODUCT_IDS_FIELD, type CompiledCampaignConfig, type CompiledSiblingCampaign } from "../lib/compiled-campaign";
import type { ConflictStrategy } from "../lib/conflict-resolution";
import { resolveMarketCountryCodes } from "./shopify-resources.server";

function valuesOf(leaf: ConditionLeaf): string[] {
  if (leaf.value === undefined) return [];
  return Array.isArray(leaf.value) ? leaf.value.map(String) : [String(leaf.value)];
}

function membershipOperator(operator: ConditionOperator): "in" | "not_in" {
  return operator === "not_in" || operator === "not_contains" ? "not_in" : "in";
}

async function resolveProductsByTag(admin: AdminApiContext, tag: string): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletProductsByTag($query: String!) {
        products(first: 250, query: $query) {
          nodes { id }
        }
      }`,
    { variables: { query: `tag:'${tag.replace(/'/g, "\\'")}'` } },
  );

  const payload = (await response.json()) as { data?: { products?: { nodes?: Array<{ id: string }> } } };
  return (payload.data?.products?.nodes ?? []).map((node) => node.id);
}

async function resolveCollectionMemberIds(admin: AdminApiContext, collectionId: string): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletCollectionMembers($id: ID!) {
        collection(id: $id) {
          products(first: 250) {
            nodes { id }
          }
        }
      }`,
    { variables: { id: collectionId } },
  );

  const payload = (await response.json()) as {
    data?: { collection?: { products?: { nodes?: Array<{ id: string }> } } | null };
  };
  return (payload.data?.collection?.products?.nodes ?? []).map((node) => node.id);
}

async function resolveLeaf(admin: AdminApiContext, leaf: ConditionLeaf): Promise<ConditionNode> {
  if (leaf.field === "product.tag") {
    const tags = valuesOf(leaf);
    const idLists = await Promise.all(tags.map((tag) => resolveProductsByTag(admin, tag)));
    return {
      id: leaf.id,
      type: "condition",
      field: RESOLVED_PRODUCT_IDS_FIELD,
      operator: membershipOperator(leaf.operator),
      value: [...new Set(idLists.flat())],
    };
  }

  if (leaf.field === "collection.id") {
    const collectionIds = valuesOf(leaf);
    const idLists = await Promise.all(collectionIds.map((id) => resolveCollectionMemberIds(admin, id)));
    return {
      id: leaf.id,
      type: "condition",
      field: RESOLVED_PRODUCT_IDS_FIELD,
      operator: membershipOperator(leaf.operator),
      value: [...new Set(idLists.flat())],
    };
  }

  if (leaf.field === "market.id") {
    const marketIds = valuesOf(leaf);
    const codeLists = await Promise.all(marketIds.map((id) => resolveMarketCountryCodes(admin, id)));
    return {
      id: leaf.id,
      type: "condition",
      field: "market.countryCode",
      operator: membershipOperator(leaf.operator),
      value: [...new Set(codeLists.flat())],
    };
  }

  return leaf;
}

async function resolveNode(admin: AdminApiContext, node: ConditionNode): Promise<ConditionNode> {
  if (node.type === "condition") return resolveLeaf(admin, node);

  const children = await Promise.all(node.children.map((child) => resolveNode(admin, child)));
  return { ...node, children };
}

async function compileConditionsAndReward(
  admin: AdminApiContext,
  campaign: Pick<Campaign, "conditionsJson" | "rewardJson">,
) {
  const declaredTree = parseConditionTree(campaign.conditionsJson);
  const resolvedTree = (await resolveNode(admin, declaredTree)) as ConditionGroup;
  return { conditions: resolvedTree, reward: normalizeRewardConfig(campaign.rewardJson) };
}

type CampaignForCompilation = Pick<
  Campaign,
  | "id"
  | "conditionsJson"
  | "rewardJson"
  | "priority"
  | "isExclusive"
  | "usageLimitTotal"
  | "usageLimitPerCustomer"
  | "usageCount"
  | "experimentVariant"
>;

export interface ShopConflictSettings {
  conflictStrategy: ConflictStrategy;
  maxTotalDiscountPercent?: number;
  maxTotalDiscountAmount?: number;
}

/**
 * Compiles one campaign into the full shape its Function invocation
 * reads — its own conditions/reward plus a snapshot of every OTHER
 * active campaign in the shop (see compiled-campaign.ts's
 * CompiledSiblingCampaign doc comment for why duplication, not a
 * shared reference, is required) and the shop's conflict-resolution
 * defaults (M10). Siblings are compiled with the exact same
 * tag/collection/market resolution as the primary campaign, so every
 * campaign's Function invocation evaluates every candidate — including
 * itself — through byte-identical logic.
 *
 * Deliberately takes already-fetched sibling rows and shop settings
 * rather than querying the database itself, so this stays testable
 * with just a mocked Admin API client — see loadShopConflictSettings/
 * loadSiblingCampaigns below for the real DB-backed callers, wired
 * together by compileCampaignForPublish.
 */
export async function compileCampaign(
  admin: AdminApiContext,
  campaign: CampaignForCompilation,
  siblingRows: CampaignForCompilation[] = [],
  shopSettings: ShopConflictSettings = { conflictStrategy: "STACK" },
): Promise<CompiledCampaignConfig> {
  const { conditions, reward } = await compileConditionsAndReward(admin, campaign);

  const siblings: CompiledSiblingCampaign[] = await Promise.all(
    siblingRows.map(async (sibling): Promise<CompiledSiblingCampaign> => {
      const compiledSibling = await compileConditionsAndReward(admin, sibling);
      return {
        id: sibling.id,
        priority: sibling.priority,
        isExclusive: sibling.isExclusive,
        ...compiledSibling,
        ...(sibling.usageLimitTotal !== null ? { usageLimitTotal: sibling.usageLimitTotal } : {}),
        ...(sibling.usageLimitPerCustomer !== null ? { usageLimitPerCustomer: sibling.usageLimitPerCustomer } : {}),
        ...(sibling.usageLimitTotal !== null ? { usageCountAsOfPublish: sibling.usageCount } : {}),
        ...(sibling.experimentVariant === "A" || sibling.experimentVariant === "B"
          ? { experimentVariant: sibling.experimentVariant }
          : {}),
      };
    }),
  );

  return {
    id: campaign.id,
    priority: campaign.priority,
    isExclusive: campaign.isExclusive,
    conditions,
    reward,
    siblings,
    conflictStrategy: shopSettings.conflictStrategy,
    ...(shopSettings.maxTotalDiscountPercent !== undefined
      ? { maxTotalDiscountPercent: shopSettings.maxTotalDiscountPercent }
      : {}),
    ...(shopSettings.maxTotalDiscountAmount !== undefined
      ? { maxTotalDiscountAmount: shopSettings.maxTotalDiscountAmount }
      : {}),
    ...(campaign.usageLimitTotal !== null ? { usageLimitTotal: campaign.usageLimitTotal } : {}),
    ...(campaign.usageLimitPerCustomer !== null ? { usageLimitPerCustomer: campaign.usageLimitPerCustomer } : {}),
    ...(campaign.experimentVariant === "A" || campaign.experimentVariant === "B"
      ? { experimentVariant: campaign.experimentVariant }
      : {}),
  };
}

export async function loadShopConflictSettings(shopId: string): Promise<ShopConflictSettings> {
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { conflictStrategy: true, maxTotalDiscountPercent: true, maxTotalDiscountAmount: true },
  });

  return {
    conflictStrategy: shop.conflictStrategy as ConflictStrategy,
    ...(shop.maxTotalDiscountPercent !== null ? { maxTotalDiscountPercent: shop.maxTotalDiscountPercent } : {}),
    ...(shop.maxTotalDiscountAmount !== null ? { maxTotalDiscountAmount: shop.maxTotalDiscountAmount } : {}),
  };
}

export async function loadSiblingCampaigns(shopId: string, excludeCampaignId: string): Promise<CampaignForCompilation[]> {
  return db.campaign.findMany({
    where: { shopId, status: "ACTIVE", id: { not: excludeCampaignId } },
    select: {
      id: true,
      priority: true,
      isExclusive: true,
      conditionsJson: true,
      rewardJson: true,
      usageLimitTotal: true,
      usageLimitPerCustomer: true,
      usageCount: true,
      experimentVariant: true,
    },
  });
}

/** The real entry point used at publish time — fetches siblings/shop settings, then compiles. */
export async function compileCampaignForPublish(admin: AdminApiContext, campaign: Campaign): Promise<CompiledCampaignConfig> {
  const [shopSettings, siblingRows] = await Promise.all([
    loadShopConflictSettings(campaign.shopId),
    loadSiblingCampaigns(campaign.shopId, campaign.id),
  ]);

  return compileCampaign(admin, campaign, siblingRows, shopSettings);
}
