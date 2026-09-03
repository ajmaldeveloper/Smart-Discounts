import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { archiveCampaign, deleteCampaignEverywhere, publishCampaign, unpublishCampaign } from "./discount-publish.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "publish-test-" } } });
});

function fakeAdmin(handler: (query: string, variables: Record<string, unknown>) => unknown): AdminApiContext {
  return {
    graphql: vi.fn((query: string, opts?: { variables?: Record<string, unknown> }) =>
      Promise.resolve({ json: async () => handler(query, opts?.variables ?? {}) }),
    ),
  } as unknown as AdminApiContext;
}

async function makeShop() {
  return db.shop.create({ data: { domain: `publish-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
}

async function makeCampaign(shopId: string, overrides: Partial<{ kind: string; shopifyDiscountId: string | null; scheduleStartAt: Date | null }> = {}) {
  return db.campaign.create({
    data: {
      shopId,
      name: "Black Friday",
      kind: "AUTOMATIC",
      status: "DRAFT",
      conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
      rewardJson: { order: { value: { type: "percentage", value: 10 } } },
      ...overrides,
    },
  });
}

describe("publishCampaign — scheduling", () => {
  it("defaults startsAt to the moment of publish when creating a discount with no schedule set", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id);

    let capturedStartsAt: unknown;
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletDiscountAutomaticCreate")) {
        capturedStartsAt = (variables.automaticAppDiscount as Record<string, unknown>).startsAt;
        return { data: { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: "gid://shopify/DiscountAutomaticNode/1" }, userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await publishCampaign(admin, campaign);

    expect(result.ok).toBe(true);
    expect(typeof capturedStartsAt).toBe("string");
    expect(Number.isNaN(new Date(capturedStartsAt as string).getTime())).toBe(false);
  });

  it("never sets combinesWith true for a discount class the campaign itself uses — Shopify rejects that combination", async () => {
    const shop = await makeShop();
    // Default reward is order-only (see makeCampaign), so discountClasses is ["ORDER"].
    const campaign = await makeCampaign(shop.id);

    let capturedCombinesWith: unknown;
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletDiscountAutomaticCreate")) {
        capturedCombinesWith = (variables.automaticAppDiscount as Record<string, unknown>).combinesWith;
        return { data: { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: "gid://shopify/DiscountAutomaticNode/1" }, userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    await publishCampaign(admin, campaign);

    expect(capturedCombinesWith).toEqual({ orderDiscounts: false, productDiscounts: true, shippingDiscounts: true });
  });

  it("uses the campaign's own scheduled start time when one is set, on create", async () => {
    const shop = await makeShop();
    const scheduleStartAt = new Date("2026-12-01T00:00:00.000Z");
    const campaign = await makeCampaign(shop.id, { scheduleStartAt });

    let capturedStartsAt: unknown;
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletDiscountAutomaticCreate")) {
        capturedStartsAt = (variables.automaticAppDiscount as Record<string, unknown>).startsAt;
        return { data: { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: "gid://shopify/DiscountAutomaticNode/1" }, userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    await publishCampaign(admin, campaign);
    expect(capturedStartsAt).toBe(scheduleStartAt.toISOString());
  });

  it("activates now instead of backdating, when a never-published campaign's scheduled start has already passed", async () => {
    const shop = await makeShop();
    const pastScheduleStartAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const campaign = await makeCampaign(shop.id, { scheduleStartAt: pastScheduleStartAt });

    let capturedStartsAt: unknown;
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletDiscountAutomaticCreate")) {
        capturedStartsAt = (variables.automaticAppDiscount as Record<string, unknown>).startsAt;
        return { data: { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: "gid://shopify/DiscountAutomaticNode/1" }, userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    await publishCampaign(admin, campaign);

    expect(capturedStartsAt).not.toBe(pastScheduleStartAt.toISOString());
    expect(typeof capturedStartsAt).toBe("string");
    expect(new Date(capturedStartsAt as string).getTime()).toBeGreaterThan(pastScheduleStartAt.getTime());
  });

  it("omits startsAt on update when no schedule is set, leaving Shopify's existing start time alone", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });

    let sawStartsAtKey = true;
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletDiscountAutomaticUpdate")) {
        sawStartsAtKey = "startsAt" in (variables.automaticAppDiscount as Record<string, unknown>);
        return { data: { discountAutomaticAppUpdate: { userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await publishCampaign(admin, campaign);

    expect(result.ok).toBe(true);
    expect(sawStartsAtKey).toBe(false);
  });
});

describe("deleteCampaignEverywhere", () => {
  it("deletes the local campaign row when Shopify confirms the discount was deleted", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDelete")) {
        return { data: { discountAutomaticDelete: { userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await deleteCampaignEverywhere(admin, campaign);

    expect(result.ok).toBe(true);
    await expect(db.campaign.findUnique({ where: { id: campaign.id } })).resolves.toBeNull();
  });

  it("still deletes the local campaign row when Shopify says the discount no longer exists", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { kind: "CODE", shopifyDiscountId: "gid://shopify/DiscountCodeNode/1" });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountCodeDelete")) {
        return { data: { discountCodeDelete: { userErrors: [{ field: ["id"], message: "Code discount does not exist." }] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await deleteCampaignEverywhere(admin, campaign);

    expect(result.ok).toBe(true);
    await expect(db.campaign.findUnique({ where: { id: campaign.id } })).resolves.toBeNull();
  });

  it("keeps the local campaign row when Shopify rejects the delete for a real reason", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDelete")) {
        return { data: { discountAutomaticDelete: { userErrors: [{ field: ["id"], message: "Something else went wrong." }] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await deleteCampaignEverywhere(admin, campaign);

    expect(result.ok).toBe(false);
    await expect(db.campaign.findUnique({ where: { id: campaign.id } })).resolves.not.toBeNull();
  });
});

describe("archiveCampaign", () => {
  it("deactivates the Shopify discount and marks the campaign ARCHIVED, not PAUSED", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDeactivate")) {
        return { data: { discountAutomaticDeactivate: { userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await archiveCampaign(admin, campaign);

    expect(result.ok).toBe(true);
    const updated = await db.campaign.findUnique({ where: { id: campaign.id } });
    expect(updated?.status).toBe("ARCHIVED");
  });

  it("does not archive locally when Shopify rejects the deactivation", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDeactivate")) {
        return { data: { discountAutomaticDeactivate: { userErrors: [{ field: ["id"], message: "Something went wrong." }] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await archiveCampaign(admin, campaign);

    expect(result.ok).toBe(false);
    const updated = await db.campaign.findUnique({ where: { id: campaign.id } });
    expect(updated?.status).toBe("DRAFT");
  });
});

describe("unpublishCampaign", () => {
  it("deletes the Shopify discount and resets the campaign to a clean, never-published Draft", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE", publishedAt: new Date(), publishedSnapshotJson: { reward: {} } } });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDelete")) {
        return { data: { discountAutomaticDelete: { userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await unpublishCampaign(admin, campaign);

    expect(result.ok).toBe(true);
    const updated = await db.campaign.findUnique({ where: { id: campaign.id } });
    expect(updated?.status).toBe("DRAFT");
    expect(updated?.shopifyDiscountId).toBeNull();
    expect(updated?.publishedAt).toBeNull();
    expect(updated?.publishedSnapshotJson).toBeNull();
  });

  it("clears a stale past schedule — otherwise the auto-publish scheduler would immediately republish it", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, {
      shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1",
      scheduleStartAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE" } });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDelete")) {
        return { data: { discountAutomaticDelete: { userErrors: [] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    await unpublishCampaign(admin, campaign);

    const updated = await db.campaign.findUnique({ where: { id: campaign.id } });
    expect(updated?.scheduleStartAt).toBeNull();
    expect(updated?.scheduleEndAt).toBeNull();
  });

  it("still resets to Draft when Shopify says the discount is already gone", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE" } });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDelete")) {
        return { data: { discountAutomaticDelete: { userErrors: [{ field: ["id"], message: "Discount does not exist." }] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await unpublishCampaign(admin, campaign);

    expect(result.ok).toBe(true);
    const updated = await db.campaign.findUnique({ where: { id: campaign.id } });
    expect(updated?.status).toBe("DRAFT");
    expect(updated?.shopifyDiscountId).toBeNull();
  });

  it("keeps the campaign published when Shopify rejects the delete for a real reason", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id, { shopifyDiscountId: "gid://shopify/DiscountAutomaticNode/1" });
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE" } });

    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletDiscountAutomaticDelete")) {
        return { data: { discountAutomaticDelete: { userErrors: [{ field: ["id"], message: "Something else went wrong." }] } } };
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const result = await unpublishCampaign(admin, campaign);

    expect(result.ok).toBe(false);
    const updated = await db.campaign.findUnique({ where: { id: campaign.id } });
    expect(updated?.status).toBe("ACTIVE");
    expect(updated?.shopifyDiscountId).toBe("gid://shopify/DiscountAutomaticNode/1");
  });
});
