import { afterEach, describe, expect, it } from "vitest";
import db from "../db.server";
import { runSimulation, type SimulatorScenario } from "./simulator.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "sim-test-" } } });
});

const BASE_SCENARIO: SimulatorScenario = {
  countryCode: "US",
  languageCode: "EN",
  currencyCode: "USD",
  customerLoggedIn: false,
  customerTags: [],
  customerTotalSpent: 0,
  customerOrderCount: 0,
  cartSubtotal: 100,
  cartQuantity: 1,
  cartTotalWeight: 0,
  productVendor: "",
  productType: "",
  productTags: [],
  variantSku: "",
  productIds: [],
  variantIds: [],
  collectionIds: [],
  marketIds: [],
};

async function makeShop(overrides: Partial<{ conflictStrategy: string; maxTotalDiscountPercent: number | null }> = {}) {
  return db.shop.create({
    data: {
      domain: `sim-test-${Math.random().toString(36).slice(2)}.myshopify.com`,
      conflictStrategy: overrides.conflictStrategy ?? "HIGHEST_DISCOUNT",
      maxTotalDiscountPercent: overrides.maxTotalDiscountPercent ?? null,
    },
  });
}

describe("runSimulation", () => {
  it("reports no campaigns when the shop has none", async () => {
    const shop = await makeShop();
    const result = await runSimulation(shop.id, BASE_SCENARIO);
    expect(result.campaigns).toEqual([]);
    expect(result.totalSavings).toBe(0);
  });

  it("matches a campaign whose conditions pass and estimates its reward", async () => {
    const shop = await makeShop();
    await db.campaign.create({
      data: {
        shopId: shop.id,
        name: "VIP order discount",
        kind: "AUTOMATIC",
        status: "ACTIVE",
        conditionsJson: {
          id: "root",
          type: "group",
          combinator: "ALL",
          children: [{ id: "c1", type: "condition", field: "customer.tag", operator: "in", value: ["VIP"] }],
        },
        rewardJson: { order: { value: { type: "percentage", value: 10 } } },
      },
    });

    const result = await runSimulation(shop.id, { ...BASE_SCENARIO, customerTags: ["VIP"] });

    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0]).toMatchObject({ matched: true, campaignName: "VIP order discount" });
    expect(result.campaigns[0]!.appliedOrderAmount).toBeCloseTo(10);
    expect(result.totalSavings).toBeCloseTo(10);
  });

  it("explains why a campaign did NOT match, surfacing the failing condition", async () => {
    const shop = await makeShop();
    await db.campaign.create({
      data: {
        shopId: shop.id,
        name: "VIP order discount",
        kind: "AUTOMATIC",
        status: "ACTIVE",
        conditionsJson: {
          id: "root",
          type: "group",
          combinator: "ALL",
          children: [{ id: "c1", type: "condition", field: "customer.tag", operator: "in", value: ["VIP"] }],
        },
        rewardJson: { order: { value: { type: "percentage", value: 10 } } },
      },
    });

    const result = await runSimulation(shop.id, { ...BASE_SCENARIO, customerTags: ["Regular"] });

    expect(result.campaigns[0]!.matched).toBe(false);
    expect(result.campaigns[0]!.failingFieldSummaries).toEqual(["customer.tag is one of VIP"]);
    expect(result.totalSavings).toBe(0);
  });

  it("applies the shop's conflict resolution across multiple matching campaigns", async () => {
    const shop = await makeShop({ conflictStrategy: "HIGHEST_DISCOUNT" });
    const alwaysMatch = { id: "root", type: "group" as const, combinator: "ALL" as const, children: [] };

    await db.campaign.create({
      data: { shopId: shop.id, name: "Low", kind: "AUTOMATIC", status: "ACTIVE", conditionsJson: alwaysMatch, rewardJson: { order: { value: { type: "percentage", value: 5 } } } },
    });
    await db.campaign.create({
      data: { shopId: shop.id, name: "High", kind: "AUTOMATIC", status: "ACTIVE", conditionsJson: alwaysMatch, rewardJson: { order: { value: { type: "percentage", value: 20 } } } },
    });

    const result = await runSimulation(shop.id, BASE_SCENARIO);

    const low = result.campaigns.find((c) => c.campaignName === "Low")!;
    const high = result.campaigns.find((c) => c.campaignName === "High")!;

    expect(high.appliedOrderAmount).toBeCloseTo(20);
    expect(low.appliedOrderAmount).toBe(0);
    expect(low.suppressedByConflict).toBe(true);
    expect(result.totalSavings).toBeCloseTo(20);
  });

  it("respects the shop's max total discount cap, scaling STACK winners proportionally", async () => {
    const shop = await makeShop({ conflictStrategy: "STACK", maxTotalDiscountPercent: 25 });
    const alwaysMatch = { id: "root", type: "group" as const, combinator: "ALL" as const, children: [] };

    await db.campaign.create({
      data: { shopId: shop.id, name: "A", kind: "AUTOMATIC", status: "ACTIVE", conditionsJson: alwaysMatch, rewardJson: { order: { value: { type: "percentage", value: 15 } } } },
    });
    await db.campaign.create({
      data: { shopId: shop.id, name: "B", kind: "AUTOMATIC", status: "ACTIVE", conditionsJson: alwaysMatch, rewardJson: { order: { value: { type: "percentage", value: 20 } } } },
    });

    const result = await runSimulation(shop.id, BASE_SCENARIO);
    expect(result.totalSavings).toBeCloseTo(25);
  });

  it("includes DRAFT and PAUSED campaigns so a merchant can preview before publishing", async () => {
    const shop = await makeShop();
    await db.campaign.create({
      data: {
        shopId: shop.id,
        name: "Draft campaign",
        kind: "AUTOMATIC",
        status: "DRAFT",
        conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
        rewardJson: { order: { value: { type: "percentage", value: 10 } } },
      },
    });

    const result = await runSimulation(shop.id, BASE_SCENARIO);
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0]!.status).toBe("DRAFT");
    expect(result.campaigns[0]!.matched).toBe(true);
  });
});
