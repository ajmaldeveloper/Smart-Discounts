/**
 * Processes one completed order (webhooks.orders.paid.tsx) for
 * everything Winslet needs a real order for: usage-limit tracking (see
 * usage-limits.ts's module comment on why this can only be
 * near-real-time) and M13's discount analytics. Both need the exact
 * same order data, so they're done together in one Admin API round
 * trip rather than two separate webhook-triggered queries.
 *
 * Discount amounts are attributed per campaign via each line item's
 * and shipping line's own discountAllocations — each allocation links
 * directly back to the DiscountApplication it came from
 * (allocation.discountApplication), so summing allocatedAmountSet
 * across every line grouped by that application's title/code gives an
 * exact dollar figure per campaign, not an estimate. Matching a
 * campaign by name/code means campaign names/discount codes should
 * stay unique per shop for correct attribution — two campaigns
 * sharing a name would both match and both get credited.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { incrementBuyerCampaignUsage } from "./buyer-data.server";

interface DiscountAllocationNode {
  allocatedAmountSet: { shopMoney: { amount: string } };
  discountApplication: { __typename: string; title?: string; code?: string };
}

interface OrderProcessingResponse {
  order?: {
    name: string;
    customer?: { id: string } | null;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
    lineItems?: { nodes?: Array<{ discountAllocations?: DiscountAllocationNode[] }> };
    shippingLines?: { nodes?: Array<{ discountAllocations?: DiscountAllocationNode[] }> };
  } | null;
}

function applicationName(app: { __typename: string; title?: string; code?: string }): string | null {
  if (app.__typename === "AutomaticDiscountApplication") return app.title ?? null;
  if (app.__typename === "DiscountCodeApplication") return app.code ?? null;
  return null;
}

async function setDiscountUsageCountMetafield(admin: AdminApiContext, discountNodeId: string, usageCount: number) {
  await admin.graphql(
    `#graphql
      mutation WinsletSetUsageCount($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          { ownerId: discountNodeId, namespace: "$app", key: "usage-count", type: "number_integer", value: String(usageCount) },
        ],
      },
    },
  );
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function processOrderForWinslet(admin: AdminApiContext, shopDomain: string, orderId: string): Promise<void> {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const response = await admin.graphql(
    `#graphql
      query WinsletOrderProcessing($id: ID!) {
        order(id: $id) {
          name
          customer {
            id
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            nodes {
              discountAllocations {
                allocatedAmountSet { shopMoney { amount } }
                discountApplication {
                  __typename
                  ... on AutomaticDiscountApplication { title }
                  ... on DiscountCodeApplication { code }
                }
              }
            }
          }
          shippingLines(first: 10) {
            nodes {
              discountAllocations {
                allocatedAmountSet { shopMoney { amount } }
                discountApplication {
                  __typename
                  ... on AutomaticDiscountApplication { title }
                  ... on DiscountCodeApplication { code }
                }
              }
            }
          }
        }
      }`,
    { variables: { id: orderId } },
  );

  const payload = (await response.json()) as { data?: OrderProcessingResponse };
  const order = payload.data?.order;
  if (!order) return;

  const allAllocations = [
    ...(order.lineItems?.nodes ?? []).flatMap((line) => line.discountAllocations ?? []),
    ...(order.shippingLines?.nodes ?? []).flatMap((line) => line.discountAllocations ?? []),
  ];

  if (allAllocations.length === 0) return;

  const amountByName = new Map<string, number>();
  for (const allocation of allAllocations) {
    const name = applicationName(allocation.discountApplication);
    if (!name) continue;
    const amount = Number(allocation.allocatedAmountSet.shopMoney.amount) || 0;
    amountByName.set(name, (amountByName.get(name) ?? 0) + amount);
  }

  if (amountByName.size === 0) return;

  const matchedCampaigns = await db.campaign.findMany({
    where: {
      shopId: shop.id,
      status: "ACTIVE",
      OR: [{ name: { in: [...amountByName.keys()] } }, { discountCode: { in: [...amountByName.keys()] } }],
    },
  });

  if (matchedCampaigns.length === 0) return;

  const customerId = order.customer?.id;
  const currency = order.totalPriceSet.shopMoney.currencyCode;
  const orderRevenue = Number(order.totalPriceSet.shopMoney.amount) || 0;
  const now = new Date();
  const day = startOfDay(now);

  for (const campaign of matchedCampaigns) {
    const discountAmount = amountByName.get(campaign.name) ?? amountByName.get(campaign.discountCode ?? "") ?? 0;
    if (discountAmount <= 0) continue;

    const updated = await db.campaign.update({
      where: { id: campaign.id },
      data: { usageCount: { increment: 1 } },
    });

    if (campaign.shopifyDiscountId) {
      await setDiscountUsageCountMetafield(admin, campaign.shopifyDiscountId, updated.usageCount);
    }

    if (customerId) {
      await incrementBuyerCampaignUsage(admin, customerId, campaign.id);
    }

    await db.discountExecution.create({
      data: {
        shopId: shop.id,
        campaignId: campaign.id,
        campaignName: campaign.name,
        orderId,
        orderName: order.name,
        discountAmount,
        currency,
        occurredAt: now,
      },
    });

    await db.campaignAnalyticsDaily.upsert({
      where: { campaignId_date: { campaignId: campaign.id, date: day } },
      create: { campaignId: campaign.id, date: day, ordersCount: 1, totalDiscount: discountAmount, totalRevenue: orderRevenue },
      update: {
        ordersCount: { increment: 1 },
        totalDiscount: { increment: discountAmount },
        totalRevenue: { increment: orderRevenue },
      },
    });
  }
}
