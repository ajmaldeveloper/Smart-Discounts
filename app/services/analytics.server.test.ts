import { afterEach, describe, expect, it } from "vitest";
import db from "../db.server";
import { getAnalyticsComparison, getAnalyticsOverview, getAnalyticsTrend, derivePromotionHealthInsights } from "./analytics.server";

function utcDaysAgo(daysAgo: number): Date {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysAgo));
}

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "analytics-test-" } } });
});

async function makeShop() {
  return db.shop.create({ data: { domain: `analytics-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
}

async function makeCampaign(shopId: string, name: string) {
  return db.campaign.create({
    data: {
      shopId,
      name,
      kind: "AUTOMATIC",
      status: "ACTIVE",
      conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
      rewardJson: {},
    },
  });
}

describe("getAnalyticsOverview", () => {
  it("returns zeroed totals with no campaigns/data", async () => {
    const shop = await makeShop();
    const overview = await getAnalyticsOverview(shop.id);
    expect(overview).toEqual({ totalOrders: 0, totalDiscountGiven: 0, totalRevenueInfluenced: 0, averageDiscountPerOrder: 0, campaigns: [] });
  });

  it("aggregates multiple daily rows for the same campaign into one summary", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, "Summer Sale");

    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: new Date("2026-01-01"), ordersCount: 3, totalDiscount: 30, totalRevenue: 300 },
    });
    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: new Date("2026-01-02"), ordersCount: 2, totalDiscount: 20, totalRevenue: 200 },
    });

    const overview = await getAnalyticsOverview(shop.id);

    expect(overview.totalOrders).toBe(5);
    expect(overview.totalDiscountGiven).toBe(50);
    expect(overview.totalRevenueInfluenced).toBe(500);
    expect(overview.averageDiscountPerOrder).toBe(10);
    expect(overview.campaigns).toHaveLength(1);
    expect(overview.campaigns[0]).toMatchObject({ campaignName: "Summer Sale", ordersCount: 5, totalDiscount: 50, averageDiscount: 10 });
  });

  it("sorts campaigns by total discount, highest first", async () => {
    const shop = await makeShop();
    const small = await makeCampaign(shop.id, "Small");
    const big = await makeCampaign(shop.id, "Big");

    await db.campaignAnalyticsDaily.create({ data: { campaignId: small.id, date: new Date("2026-01-01"), ordersCount: 1, totalDiscount: 5, totalRevenue: 50 } });
    await db.campaignAnalyticsDaily.create({ data: { campaignId: big.id, date: new Date("2026-01-01"), ordersCount: 1, totalDiscount: 50, totalRevenue: 500 } });

    const overview = await getAnalyticsOverview(shop.id);
    expect(overview.campaigns.map((c) => c.campaignName)).toEqual(["Big", "Small"]);
  });

  it("includes a campaign that hasn't processed an order yet, with zeroed stats", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, "Brand New Campaign");

    const overview = await getAnalyticsOverview(shop.id);

    expect(overview.campaigns).toHaveLength(1);
    expect(overview.campaigns[0]).toMatchObject({
      campaignName: "Brand New Campaign",
      ordersCount: 0,
      totalDiscount: 0,
      totalRevenue: 0,
      averageDiscount: 0,
    });
  });

  it("only includes campaigns belonging to the requested shop", async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const campaignA = await makeCampaign(shopA.id, "Shop A campaign");
    await makeCampaign(shopB.id, "Shop B campaign");

    await db.campaignAnalyticsDaily.create({ data: { campaignId: campaignA.id, date: new Date("2026-01-01"), ordersCount: 1, totalDiscount: 10, totalRevenue: 100 } });

    const overview = await getAnalyticsOverview(shopA.id);
    expect(overview.campaigns.map((c) => c.campaignName)).toEqual(["Shop A campaign"]);
  });
});

describe("derivePromotionHealthInsights", () => {
  it("returns no insights when nothing crosses a threshold", () => {
    const overview = {
      totalOrders: 1,
      totalDiscountGiven: 5,
      totalRevenueInfluenced: 500,
      averageDiscountPerOrder: 5,
      campaigns: [{ campaignId: "1", campaignName: "Modest", ordersCount: 1, totalDiscount: 5, totalRevenue: 500, averageDiscount: 5 }],
    };
    expect(derivePromotionHealthInsights(overview)).toEqual([]);
  });

  it("flags a campaign whose discount-to-revenue ratio exceeds 30%", () => {
    const overview = {
      totalOrders: 1,
      totalDiscountGiven: 40,
      totalRevenueInfluenced: 100,
      averageDiscountPerOrder: 40,
      campaigns: [{ campaignId: "1", campaignName: "Heavy Discount", ordersCount: 1, totalDiscount: 40, totalRevenue: 100, averageDiscount: 40 }],
    };
    const insights = derivePromotionHealthInsights(overview);
    expect(insights.some((i) => i.includes("Heavy Discount") && i.includes("40%"))).toBe(true);
  });

  it("flags a high-volume campaign responsible for over half of total discount spend", () => {
    const overview = {
      totalOrders: 20,
      totalDiscountGiven: 100,
      totalRevenueInfluenced: 10000,
      averageDiscountPerOrder: 5,
      campaigns: [
        { campaignId: "1", campaignName: "Dominant", ordersCount: 15, totalDiscount: 60, totalRevenue: 6000, averageDiscount: 4 },
        { campaignId: "2", campaignName: "Minor", ordersCount: 5, totalDiscount: 40, totalRevenue: 4000, averageDiscount: 8 },
      ],
    };
    const insights = derivePromotionHealthInsights(overview);
    expect(insights.some((i) => i.includes("Dominant") && i.includes("60%"))).toBe(true);
  });
});

describe("getAnalyticsTrend", () => {
  it("zero-fills every day in the window when there's no data", async () => {
    const shop = await makeShop();
    const trend = await getAnalyticsTrend(shop.id, 7);

    expect(trend.windowDays).toBe(7);
    expect(trend.days).toHaveLength(7);
    expect(trend.days.every((day) => day.ordersCount === 0 && day.totalDiscount === 0 && day.totalRevenue === 0)).toBe(true);
    // Oldest to newest, ending on today.
    expect(trend.days[6]!.date).toBe(utcDaysAgo(0).toISOString().slice(0, 10));
    expect(trend.days[0]!.date).toBe(utcDaysAgo(6).toISOString().slice(0, 10));
  });

  it("sums multiple campaigns' rows on the same day into one shop-wide total", async () => {
    const shop = await makeShop();
    const campaignA = await makeCampaign(shop.id, "A");
    const campaignB = await makeCampaign(shop.id, "B");
    const today = utcDaysAgo(0);

    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaignA.id, date: today, ordersCount: 2, totalDiscount: 20, totalRevenue: 200 },
    });
    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaignB.id, date: today, ordersCount: 3, totalDiscount: 30, totalRevenue: 300 },
    });

    const trend = await getAnalyticsTrend(shop.id, 7);
    const todayRow = trend.days.find((day) => day.date === today.toISOString().slice(0, 10));

    expect(todayRow).toMatchObject({ ordersCount: 5, totalDiscount: 50, totalRevenue: 500 });
  });

  it("excludes rows outside the requested window", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, "Old");

    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(10), ordersCount: 9, totalDiscount: 90, totalRevenue: 900 },
    });

    const trend = await getAnalyticsTrend(shop.id, 7);

    expect(trend.days.every((day) => day.ordersCount === 0)).toBe(true);
  });

  it("only includes rows belonging to the requested shop", async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const campaignB = await makeCampaign(shopB.id, "Shop B campaign");
    const today = utcDaysAgo(0);

    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaignB.id, date: today, ordersCount: 4, totalDiscount: 40, totalRevenue: 400 },
    });

    const trend = await getAnalyticsTrend(shopA.id, 7);
    expect(trend.days.every((day) => day.ordersCount === 0)).toBe(true);
  });
});

describe("getAnalyticsComparison", () => {
  it("returns null change percentages with no data in either period", async () => {
    const shop = await makeShop();
    const comparison = await getAnalyticsComparison(shop.id, 7);

    expect(comparison.current).toEqual({ totalOrders: 0, totalDiscountGiven: 0, totalRevenueInfluenced: 0, averageDiscountPerOrder: 0 });
    expect(comparison.changePercent).toEqual({
      totalOrders: null,
      totalDiscountGiven: null,
      totalRevenueInfluenced: null,
      averageDiscountPerOrder: null,
    });
  });

  it("computes a positive percent change against a non-zero previous period", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, "Campaign");

    // Previous 7-day window (days 8-14 ago): 100 discount total.
    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(10), ordersCount: 10, totalDiscount: 100, totalRevenue: 1000 },
    });
    // Current 7-day window (days 0-6 ago): 150 discount total — a 50% increase.
    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(2), ordersCount: 10, totalDiscount: 150, totalRevenue: 1500 },
    });

    const comparison = await getAnalyticsComparison(shop.id, 7);

    expect(comparison.current.totalDiscountGiven).toBe(150);
    expect(comparison.previous.totalDiscountGiven).toBe(100);
    expect(comparison.changePercent.totalDiscountGiven).toBe(50);
  });

  it("computes a negative percent change when the current period is lower", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, "Campaign");

    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(10), ordersCount: 10, totalDiscount: 200, totalRevenue: 2000 },
    });
    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(2), ordersCount: 10, totalDiscount: 100, totalRevenue: 1000 },
    });

    const comparison = await getAnalyticsComparison(shop.id, 7);

    expect(comparison.changePercent.totalDiscountGiven).toBe(-50);
  });

  it("returns null (not a percentage) when the previous period has no baseline, even with current activity", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, "Campaign");

    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(1), ordersCount: 5, totalDiscount: 50, totalRevenue: 500 },
    });

    const comparison = await getAnalyticsComparison(shop.id, 7);

    expect(comparison.current.totalDiscountGiven).toBe(50);
    expect(comparison.previous.totalDiscountGiven).toBe(0);
    expect(comparison.changePercent.totalDiscountGiven).toBeNull();
  });

  it("does not let the current and previous windows overlap", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, "Campaign");

    // Exactly on the boundary: 7 days ago is the first day of the *previous* window, not the current one.
    await db.campaignAnalyticsDaily.create({
      data: { campaignId: campaign.id, date: utcDaysAgo(7), ordersCount: 1, totalDiscount: 10, totalRevenue: 100 },
    });

    const comparison = await getAnalyticsComparison(shop.id, 7);

    expect(comparison.current.totalOrders).toBe(0);
    expect(comparison.previous.totalOrders).toBe(1);
  });
});
