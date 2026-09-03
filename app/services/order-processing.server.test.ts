import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { processOrderForWinslet } from "./order-processing.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "order-test-" } } });
});

function fakeAdmin(handler: (query: string, variables: Record<string, unknown>) => unknown): AdminApiContext {
  return {
    graphql: vi.fn((query: string, opts?: { variables?: Record<string, unknown> }) =>
      Promise.resolve({ json: async () => handler(query, opts?.variables ?? {}) }),
    ),
  } as unknown as AdminApiContext;
}

async function makeShopWithCampaign(name: string) {
  const shop = await db.shop.create({ data: { domain: `order-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
  const campaign = await db.campaign.create({
    data: {
      shopId: shop.id,
      name,
      kind: "AUTOMATIC",
      status: "ACTIVE",
      shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1",
      conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
      rewardJson: { order: { value: { type: "percentage", value: 10 } } },
    },
  });
  return { shop, campaign };
}

function orderResponse(overrides: {
  name?: string;
  customerId?: string | null;
  totalPrice?: string;
  currency?: string;
  lineItemDiscountName?: string | null;
  lineItemDiscountAmount?: string;
  lineItemDiscountType?: "AutomaticDiscountApplication" | "DiscountCodeApplication";
}) {
  const discountApp =
    overrides.lineItemDiscountName === null
      ? null
      : overrides.lineItemDiscountType === "DiscountCodeApplication"
        ? { __typename: "DiscountCodeApplication", code: overrides.lineItemDiscountName }
        : { __typename: "AutomaticDiscountApplication", title: overrides.lineItemDiscountName };

  return {
    data: {
      order: {
        name: overrides.name ?? "#1001",
        customer: overrides.customerId ? { id: overrides.customerId } : null,
        totalPriceSet: { shopMoney: { amount: overrides.totalPrice ?? "100.00", currencyCode: overrides.currency ?? "USD" } },
        lineItems: {
          nodes: discountApp
            ? [
                {
                  discountAllocations: [
                    { allocatedAmountSet: { shopMoney: { amount: overrides.lineItemDiscountAmount ?? "10.00" } }, discountApplication: discountApp },
                  ],
                },
              ]
            : [{ discountAllocations: [] }],
        },
        shippingLines: { nodes: [] },
      },
    },
  };
}

describe("processOrderForWinslet", () => {
  it("does nothing when the order has no discount allocations", async () => {
    const { shop } = await makeShopWithCampaign("Some campaign");
    const admin = fakeAdmin(() => orderResponse({ lineItemDiscountName: null }));

    await processOrderForWinslet(admin, shop.domain, "gid://shopify/Order/1");

    const executions = await db.discountExecution.findMany({ where: { shopId: shop.id } });
    expect(executions).toHaveLength(0);
  });

  it("does nothing when the discount name doesn't match any campaign", async () => {
    const { shop } = await makeShopWithCampaign("Real campaign");
    const admin = fakeAdmin(() => orderResponse({ lineItemDiscountName: "Some other app's discount" }));

    await processOrderForWinslet(admin, shop.domain, "gid://shopify/Order/1");

    const campaign = await db.campaign.findFirst({ where: { shopId: shop.id } });
    expect(campaign?.usageCount).toBe(0);
  });

  it("records a DiscountExecution, upserts daily analytics, and increments usageCount for a matched automatic campaign", async () => {
    const { shop, campaign } = await makeShopWithCampaign("Summer Sale");
    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletOrderProcessing")) {
        return orderResponse({ name: "#2001", totalPrice: "150.00", lineItemDiscountName: "Summer Sale", lineItemDiscountAmount: "15.00" });
      }
      return { data: { metafieldsSet: { userErrors: [] } } };
    });

    await processOrderForWinslet(admin, shop.domain, "gid://shopify/Order/2001");

    const updatedCampaign = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(updatedCampaign.usageCount).toBe(1);

    const executions = await db.discountExecution.findMany({ where: { campaignId: campaign.id } });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ orderName: "#2001", campaignName: "Summer Sale", currency: "USD" });
    expect(Number(executions[0]!.discountAmount)).toBe(15);

    const daily = await db.campaignAnalyticsDaily.findFirst({ where: { campaignId: campaign.id } });
    expect(daily).toMatchObject({ ordersCount: 1 });
    expect(Number(daily!.totalDiscount)).toBe(15);
    expect(Number(daily!.totalRevenue)).toBe(150);
  });

  it("matches a CODE campaign by its discount code, not its internal name", async () => {
    const shop = await db.shop.create({ data: { domain: `order-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
    const campaign = await db.campaign.create({
      data: {
        shopId: shop.id,
        name: "Internal name merchants never see on the order",
        kind: "CODE",
        discountCode: "SAVE20",
        status: "ACTIVE",
        conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
        rewardJson: { order: { value: { type: "percentage", value: 20 } } },
      },
    });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletOrderProcessing")) {
        return orderResponse({ lineItemDiscountName: "SAVE20", lineItemDiscountType: "DiscountCodeApplication", lineItemDiscountAmount: "20.00" });
      }
      return { data: {} };
    });

    await processOrderForWinslet(admin, shop.domain, "gid://shopify/Order/3001");

    const executions = await db.discountExecution.findMany({ where: { campaignId: campaign.id } });
    expect(executions).toHaveLength(1);
  });

  it("accumulates a second order into the same day's analytics row instead of creating a duplicate", async () => {
    const { shop, campaign } = await makeShopWithCampaign("Repeat campaign");
    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletOrderProcessing")) {
        return orderResponse({ lineItemDiscountName: "Repeat campaign", lineItemDiscountAmount: "5.00", totalPrice: "50.00" });
      }
      return { data: {} };
    });

    await processOrderForWinslet(admin, shop.domain, "gid://shopify/Order/A");
    await processOrderForWinslet(admin, shop.domain, "gid://shopify/Order/B");

    const dailyRows = await db.campaignAnalyticsDaily.findMany({ where: { campaignId: campaign.id } });
    expect(dailyRows).toHaveLength(1);
    expect(dailyRows[0]).toMatchObject({ ordersCount: 2 });
    expect(Number(dailyRows[0]!.totalDiscount)).toBe(10);
  });
});
