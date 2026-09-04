import { afterEach, describe, expect, it } from "vitest";
import db from "../db.server";
import { getActiveFreeShippingThreshold } from "./storefront-widgets.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "storefront-widgets-test-" } } });
});

async function makeShop() {
  return db.shop.create({ data: { domain: `storefront-widgets-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
}

async function makeCampaign(shopId: string, overrides: Partial<{ status: string; rewardJson: object }> = {}) {
  return db.campaign.create({
    data: {
      shopId,
      name: "Test campaign",
      kind: "AUTOMATIC",
      status: "DRAFT",
      conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
      rewardJson: { order: { value: { type: "percentage", value: 10 } } },
      ...overrides,
    },
  });
}

describe("getActiveFreeShippingThreshold", () => {
  it("returns inactive when the shop has no campaigns at all", async () => {
    const shop = await makeShop();
    expect(await getActiveFreeShippingThreshold(shop.id)).toEqual({ active: false });
  });

  it("returns the threshold from an ACTIVE campaign's shipping reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { shipping: { value: { type: "percentage", value: 100 }, minimumMetric: "cart.subtotal", minimumValue: 75 } },
    });

    expect(await getActiveFreeShippingThreshold(shop.id)).toEqual({ active: true, minimumValue: 75, minimumMetric: "cart.subtotal" });
  });

  it("ignores a PAUSED campaign even with a qualifying shipping reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "PAUSED",
      rewardJson: { shipping: { value: { type: "percentage", value: 100 }, minimumValue: 50 } },
    });

    expect(await getActiveFreeShippingThreshold(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign with no shipping reward at all", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { product: { value: { type: "percentage", value: 10 }, appliesTo: "ALL_MATCHING_LINES" } },
    });

    expect(await getActiveFreeShippingThreshold(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign whose shipping reward has no minimumValue set", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { shipping: { value: { type: "percentage", value: 100 } } },
    });

    expect(await getActiveFreeShippingThreshold(shop.id)).toEqual({ active: false });
  });

  it("defaults minimumMetric to cart.quantity when unset on the reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { shipping: { value: { type: "percentage", value: 100 }, minimumValue: 3 } },
    });

    expect(await getActiveFreeShippingThreshold(shop.id)).toEqual({ active: true, minimumValue: 3, minimumMetric: "cart.quantity" });
  });
});
