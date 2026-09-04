import { afterEach, describe, expect, it } from "vitest";
import db from "../db.server";
import {
  getActiveBogoGiftCampaign,
  getActiveFreeShippingThreshold,
  getActiveOrderDiscountThreshold,
  getActiveTieredDiscount,
} from "./storefront-widgets.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "storefront-widgets-test-" } } });
});

async function makeShop() {
  return db.shop.create({ data: { domain: `storefront-widgets-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
}

async function makeCampaign(
  shopId: string,
  overrides: Partial<{ status: string; rewardJson: object; conditionsJson: object }> = {},
) {
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

describe("getActiveBogoGiftCampaign", () => {
  const conditions = { id: "root", type: "group" as const, combinator: "ALL" as const, children: [] };

  it("returns inactive when the shop has no campaigns at all", async () => {
    const shop = await makeShop();
    expect(await getActiveBogoGiftCampaign(shop.id)).toEqual({ active: false });
  });

  it("returns the tier's buy/get quantities and free-gift pool from an ACTIVE campaign", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      conditionsJson: conditions,
      rewardJson: {
        product: {
          value: { type: "percentage", value: 0 },
          appliesTo: "CHEAPEST_MATCHING_LINE",
          tierMetric: "cart.quantity",
          tiers: [
            {
              minValue: 4,
              value: { type: "percentage", value: 100 },
              getQuantity: 2,
              freeProductIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
            },
          ],
        },
      },
    });

    expect(await getActiveBogoGiftCampaign(shop.id)).toEqual({
      active: true,
      conditions,
      buyQuantity: 2,
      getQuantity: 2,
      freeProductIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
    });
  });

  it("ignores a PAUSED campaign even with a qualifying tier", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "PAUSED",
      rewardJson: {
        product: {
          value: { type: "percentage", value: 0 },
          appliesTo: "CHEAPEST_MATCHING_LINE",
          tiers: [{ minValue: 3, value: { type: "percentage", value: 100 }, getQuantity: 1, freeProductIds: ["gid://shopify/Product/1"] }],
        },
      },
    });

    expect(await getActiveBogoGiftCampaign(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign whose tiers have no freeProductIds (a plain quantity discount, not a gift pool)", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: {
        product: {
          value: { type: "percentage", value: 0 },
          appliesTo: "CHEAPEST_MATCHING_LINE",
          tiers: [{ minValue: 3, value: { type: "percentage", value: 10 } }],
        },
      },
    });

    expect(await getActiveBogoGiftCampaign(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign with no product reward at all", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { order: { value: { type: "percentage", value: 10 } } },
    });

    expect(await getActiveBogoGiftCampaign(shop.id)).toEqual({ active: false });
  });
});

describe("getActiveOrderDiscountThreshold", () => {
  it("returns inactive when the shop has no campaigns at all", async () => {
    const shop = await makeShop();
    expect(await getActiveOrderDiscountThreshold(shop.id)).toEqual({ active: false });
  });

  it("returns the threshold and discount value from an ACTIVE campaign's order reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { order: { value: { type: "percentage", value: 15 }, minimumMetric: "cart.subtotal", minimumValue: 100 } },
    });

    expect(await getActiveOrderDiscountThreshold(shop.id)).toEqual({
      active: true,
      minimumValue: 100,
      minimumMetric: "cart.subtotal",
      discountValue: { type: "percentage", value: 15 },
    });
  });

  it("ignores a PAUSED campaign even with a qualifying order reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "PAUSED",
      rewardJson: { order: { value: { type: "percentage", value: 15 }, minimumValue: 100 } },
    });

    expect(await getActiveOrderDiscountThreshold(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign with no order reward at all", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { shipping: { value: { type: "percentage", value: 100 }, minimumValue: 50 } },
    });

    expect(await getActiveOrderDiscountThreshold(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign whose order reward has no minimumValue set", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { order: { value: { type: "fixedAmount", value: 10 } } },
    });

    expect(await getActiveOrderDiscountThreshold(shop.id)).toEqual({ active: false });
  });

  it("defaults minimumMetric to cart.quantity when unset on the reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { order: { value: { type: "fixedAmount", value: 10 }, minimumValue: 3 } },
    });

    expect(await getActiveOrderDiscountThreshold(shop.id)).toEqual({
      active: true,
      minimumValue: 3,
      minimumMetric: "cart.quantity",
      discountValue: { type: "fixedAmount", value: 10 },
    });
  });
});

describe("getActiveTieredDiscount", () => {
  it("returns inactive when the shop has no campaigns at all", async () => {
    const shop = await makeShop();
    expect(await getActiveTieredDiscount(shop.id)).toEqual({ active: false });
  });

  it("returns the plain volume tiers, sorted ascending, from an ACTIVE campaign", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: {
        product: {
          value: { type: "percentage", value: 5 },
          appliesTo: "ALL_MATCHING_LINES",
          tierMetric: "cart.quantity",
          tiers: [
            { minValue: 6, value: { type: "percentage", value: 20 } },
            { minValue: 2, value: { type: "percentage", value: 10 } },
          ],
        },
      },
    });

    expect(await getActiveTieredDiscount(shop.id)).toEqual({
      active: true,
      tierMetric: "cart.quantity",
      tiers: [
        { minValue: 2, discountType: "percentage", discountValue: 10 },
        { minValue: 6, discountType: "percentage", discountValue: 20 },
      ],
    });
  });

  it("ignores a PAUSED campaign even with qualifying tiers", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "PAUSED",
      rewardJson: {
        product: {
          value: { type: "percentage", value: 5 },
          appliesTo: "ALL_MATCHING_LINES",
          tiers: [{ minValue: 2, value: { type: "percentage", value: 10 } }],
        },
      },
    });

    expect(await getActiveTieredDiscount(shop.id)).toEqual({ active: false });
  });

  it("excludes BOGO tiers (getQuantity set) and gift-pool tiers (freeProductIds set)", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: {
        product: {
          value: { type: "percentage", value: 5 },
          appliesTo: "ALL_MATCHING_LINES",
          tiers: [
            { minValue: 4, value: { type: "percentage", value: 100 }, getQuantity: 1 },
            { minValue: 3, value: { type: "percentage", value: 100 }, freeProductIds: ["gid://shopify/Product/1"] },
          ],
        },
      },
    });

    expect(await getActiveTieredDiscount(shop.id)).toEqual({ active: false });
  });

  it("ignores an ACTIVE campaign with no product tiers at all", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: { order: { value: { type: "percentage", value: 10 }, minimumValue: 50 } },
    });

    expect(await getActiveTieredDiscount(shop.id)).toEqual({ active: false });
  });

  it("defaults tierMetric to cart.quantity when unset on the reward", async () => {
    const shop = await makeShop();
    await makeCampaign(shop.id, {
      status: "ACTIVE",
      rewardJson: {
        product: {
          value: { type: "percentage", value: 5 },
          appliesTo: "ALL_MATCHING_LINES",
          tiers: [{ minValue: 2, value: { type: "percentage", value: 10 } }],
        },
      },
    });

    expect((await getActiveTieredDiscount(shop.id) as { tierMetric: string }).tierMetric).toBe("cart.quantity");
  });
});
