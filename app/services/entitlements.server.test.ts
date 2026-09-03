import { afterEach, describe, expect, it } from "vitest";
import db from "../db.server";
import {
  getShopEntitlements,
  requireActiveCampaignCapacity,
  requireShopFeature,
  requireTiersAccess,
} from "./entitlements.server";
import { PlanAccessError, PlanLimitError } from "./plans.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "entitlements-test-" } } });
});

async function makeShop(overrides: Partial<{ planCode: string; planStatus: string }> = {}) {
  return db.shop.create({ data: { domain: `entitlements-test-${Math.random().toString(36).slice(2)}.myshopify.com`, ...overrides } });
}

describe("getShopEntitlements", () => {
  it("defaults to Free for a freshly-installed shop", async () => {
    const shop = await makeShop();
    const entitlements = await getShopEntitlements(shop.domain);

    expect(entitlements.effectivePlanCode).toBe("FREE");
    expect(entitlements.plan.limits.activeCampaigns).toBe(5);
    expect(entitlements.plan.features).not.toContain("TIERS");
  });

  it("resolves a paid, ACTIVE plan to its own entitlements", async () => {
    const shop = await makeShop({ planCode: "GROWTH", planStatus: "ACTIVE" });
    const entitlements = await getShopEntitlements(shop.domain);

    expect(entitlements.effectivePlanCode).toBe("GROWTH");
    expect(entitlements.plan.features).toContain("TIERS");
    expect(entitlements.plan.features).toContain("ANALYTICS");
    expect(entitlements.plan.features).not.toContain("STACKING");
  });

  it("falls back to Free when a paid plan's status is not ACTIVE — a frozen/cancelled subscription must never keep paid access", async () => {
    const shop = await makeShop({ planCode: "PRO", planStatus: "FROZEN" });
    const entitlements = await getShopEntitlements(shop.domain);

    expect(entitlements.storedPlanCode).toBe("PRO");
    expect(entitlements.effectivePlanCode).toBe("FREE");
    expect(entitlements.plan.features).not.toContain("STACKING");
  });
});

describe("requireShopFeature / requireTiersAccess", () => {
  it("throws PlanAccessError for a Free shop requesting a Growth+ feature", async () => {
    const shop = await makeShop();
    await expect(requireTiersAccess(shop.domain)).rejects.toBeInstanceOf(PlanAccessError);
  });

  it("succeeds for a Growth shop", async () => {
    const shop = await makeShop({ planCode: "GROWTH", planStatus: "ACTIVE" });
    await expect(requireTiersAccess(shop.domain)).resolves.toBeDefined();
  });

  it("generic requireShopFeature agrees with the dedicated helper", async () => {
    const shop = await makeShop({ planCode: "GROWTH", planStatus: "ACTIVE" });
    await expect(requireShopFeature(shop.domain, "TIERS")).resolves.toBeDefined();
    await expect(requireShopFeature(shop.domain, "STACKING")).rejects.toBeInstanceOf(PlanAccessError);
  });
});

describe("requireActiveCampaignCapacity", () => {
  async function makeCampaign(shopId: string) {
    return db.campaign.create({
      data: {
        shopId,
        name: "Test campaign",
        kind: "AUTOMATIC",
        status: "DRAFT",
        conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
        rewardJson: {},
      },
    });
  }

  it("allows creating campaigns under a Free shop's 5-campaign limit", async () => {
    const shop = await makeShop();
    await expect(requireActiveCampaignCapacity(shop.domain, shop.id)).resolves.toBeDefined();

    await makeCampaign(shop.id);
    await expect(requireActiveCampaignCapacity(shop.domain, shop.id)).resolves.toBeDefined();
  });

  it("throws PlanLimitError once a Free shop already has 5 campaigns", async () => {
    const shop = await makeShop();
    for (let i = 0; i < 5; i += 1) await makeCampaign(shop.id);

    await expect(requireActiveCampaignCapacity(shop.domain, shop.id)).rejects.toBeInstanceOf(PlanLimitError);
  });

  it("never throws for a Pro shop (unlimited campaigns)", async () => {
    const shop = await makeShop({ planCode: "PRO", planStatus: "ACTIVE" });
    for (let i = 0; i < 15; i += 1) await makeCampaign(shop.id);

    await expect(requireActiveCampaignCapacity(shop.domain, shop.id)).resolves.toBeDefined();
  });
});
