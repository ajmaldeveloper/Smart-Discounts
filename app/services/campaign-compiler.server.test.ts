import { describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { compileCampaign } from "./campaign-compiler.server";
import { RESOLVED_PRODUCT_IDS_FIELD } from "../lib/compiled-campaign";
import type { Campaign } from "@prisma/client";

function fakeAdmin(handler: (query: string, variables: Record<string, unknown>) => unknown): AdminApiContext {
  return {
    graphql: vi.fn((query: string, opts?: { variables?: Record<string, unknown> }) =>
      Promise.resolve({ json: async () => handler(query, opts?.variables ?? {}) }),
    ),
  } as unknown as AdminApiContext;
}

type CampaignForCompilation = Pick<
  Campaign,
  "id" | "conditionsJson" | "rewardJson" | "priority" | "isExclusive" | "usageLimitTotal" | "usageLimitPerCustomer" | "usageCount"
>;

function campaignWith(conditionsJson: unknown, rewardJson: unknown = {}): CampaignForCompilation {
  return {
    id: "campaign-1",
    conditionsJson,
    rewardJson,
    priority: 0,
    isExclusive: false,
    usageLimitTotal: null,
    usageLimitPerCustomer: null,
    usageCount: 0,
  } as CampaignForCompilation;
}

describe("compileCampaign — product.tag resolution", () => {
  it("resolves an 'in' tag condition to a resolved-product-ids 'in' leaf", async () => {
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletProductsByTag")) {
        expect(variables.query).toBe("tag:'VIP'");
        return { data: { products: { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }] } } };
      }
      throw new Error("unexpected query");
    });

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [{ id: "c1", type: "condition", field: "product.tag", operator: "in", value: ["VIP"] }],
      }),
    );

    expect(compiled.conditions.children[0]).toEqual({
      id: "c1",
      type: "condition",
      field: RESOLVED_PRODUCT_IDS_FIELD,
      operator: "in",
      value: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
    });
  });

  it("maps not_in and not_contains to a resolved 'not_in' leaf", async () => {
    const admin = fakeAdmin(() => ({ data: { products: { nodes: [{ id: "gid://shopify/Product/9" }] } } }));

    for (const operator of ["not_in", "not_contains"] as const) {
      const compiled = await compileCampaign(
        admin,
        campaignWith({
          id: "root",
          type: "group",
          combinator: "ALL",
          children: [{ id: "c1", type: "condition", field: "product.tag", operator, value: ["Sale"] }],
        }),
      );

      expect(compiled.conditions.children[0]).toMatchObject({ field: RESOLVED_PRODUCT_IDS_FIELD, operator: "not_in" });
    }
  });

  it("dedupes product ids across multiple tags", async () => {
    const admin = fakeAdmin((_query, variables) => {
      const tag = String(variables.query);
      if (tag.includes("VIP")) return { data: { products: { nodes: [{ id: "gid://shopify/Product/1" }] } } };
      return { data: { products: { nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }] } } };
    });

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ANY",
        children: [{ id: "c1", type: "condition", field: "product.tag", operator: "in", value: ["VIP", "Sale"] }],
      }),
    );

    const leaf = compiled.conditions.children[0] as { value: string[] };
    expect(new Set(leaf.value)).toEqual(new Set(["gid://shopify/Product/1", "gid://shopify/Product/2"]));
    expect(leaf.value).toHaveLength(2);
  });
});

describe("compileCampaign — collection.id resolution", () => {
  it("resolves collection membership to the union of member product ids", async () => {
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletCollectionMembers")) {
        const id = variables.id;
        if (id === "gid://shopify/Collection/1") {
          return { data: { collection: { products: { nodes: [{ id: "gid://shopify/Product/A" }] } } } };
        }
        return { data: { collection: { products: { nodes: [{ id: "gid://shopify/Product/B" }] } } } };
      }
      throw new Error("unexpected query");
    });

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [
          {
            id: "c1",
            type: "condition",
            field: "collection.id",
            operator: "in",
            value: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
          },
        ],
      }),
    );

    const leaf = compiled.conditions.children[0] as { value: string[] };
    expect(new Set(leaf.value)).toEqual(new Set(["gid://shopify/Product/A", "gid://shopify/Product/B"]));
  });

  it("tolerates a deleted collection (null) by resolving to an empty list", async () => {
    const admin = fakeAdmin(() => ({ data: { collection: null } }));

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [{ id: "c1", type: "condition", field: "collection.id", operator: "in", value: ["gid://deleted"] }],
      }),
    );

    expect((compiled.conditions.children[0] as { value: string[] }).value).toEqual([]);
  });
});

describe("compileCampaign — market.id resolution", () => {
  it("resolves a market into the union of its countries' ISO codes, rewritten as market.countryCode", async () => {
    const admin = fakeAdmin((query, variables) => {
      if (query.includes("WinsletMarketRegions")) {
        if (variables.id === "gid://shopify/Market/1") {
          return { data: { market: { regions: { nodes: [{ code: "US" }, { code: "CA" }] } } } };
        }
        return { data: { market: { regions: { nodes: [{ code: "GB" }] } } } };
      }
      throw new Error("unexpected query");
    });

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [
          {
            id: "c1",
            type: "condition",
            field: "market.id",
            operator: "in",
            value: ["gid://shopify/Market/1", "gid://shopify/Market/2"],
          },
        ],
      }),
    );

    const leaf = compiled.conditions.children[0] as { field: string; operator: string; value: string[] };
    expect(leaf.field).toBe("market.countryCode");
    expect(leaf.operator).toBe("in");
    expect(new Set(leaf.value)).toEqual(new Set(["US", "CA", "GB"]));
  });

  it("maps not_in to a not_in market.countryCode check", async () => {
    const admin = fakeAdmin(() => ({ data: { market: { regions: { nodes: [{ code: "DE" }] } } } }));

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [{ id: "c1", type: "condition", field: "market.id", operator: "not_in", value: ["gid://shopify/Market/3"] }],
      }),
    );

    expect(compiled.conditions.children[0]).toMatchObject({ field: "market.countryCode", operator: "not_in" });
  });

  it("tolerates a deleted market (null) by resolving to an empty list", async () => {
    const admin = fakeAdmin(() => ({ data: { market: null } }));

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [{ id: "c1", type: "condition", field: "market.id", operator: "in", value: ["gid://deleted"] }],
      }),
    );

    expect((compiled.conditions.children[0] as { value: string[] }).value).toEqual([]);
  });
});

describe("compileCampaign — passthrough fields", () => {
  it("leaves vendor/type/sku/cart/currency/product.id/variant.id conditions untouched", async () => {
    const admin = fakeAdmin(() => {
      throw new Error("should not call the Admin API for passthrough fields");
    });

    const tree = {
      id: "root",
      type: "group" as const,
      combinator: "ALL" as const,
      children: [
        { id: "c1", type: "condition" as const, field: "product.vendor", operator: "equals" as const, value: "Nike" },
        { id: "c2", type: "condition" as const, field: "cart.subtotal", operator: "greater_than_or_equal" as const, value: 100 },
        { id: "c3", type: "condition" as const, field: "product.id", operator: "in" as const, value: ["gid://shopify/Product/1"] },
        { id: "c4", type: "condition" as const, field: "market.countryCode", operator: "in" as const, value: ["US", "CA"] },
      ],
    };

    const compiled = await compileCampaign(admin, campaignWith(tree));
    expect(compiled.conditions).toEqual(tree);
  });

  it("resolves nested groups recursively alongside passthrough siblings", async () => {
    const admin = fakeAdmin(() => ({ data: { products: { nodes: [{ id: "gid://shopify/Product/1" }] } } }));

    const compiled = await compileCampaign(
      admin,
      campaignWith({
        id: "root",
        type: "group",
        combinator: "ALL",
        children: [
          { id: "c1", type: "condition", field: "cart.subtotal", operator: "greater_than_or_equal", value: 100 },
          {
            id: "g1",
            type: "group",
            combinator: "ANY",
            children: [{ id: "c2", type: "condition", field: "product.tag", operator: "in", value: ["VIP"] }],
          },
        ],
      }),
    );

    expect(compiled.conditions.children[0]).toMatchObject({ field: "cart.subtotal" });
    const nestedGroup = compiled.conditions.children[1] as { children: unknown[] };
    expect(nestedGroup.children[0]).toMatchObject({ field: RESOLVED_PRODUCT_IDS_FIELD });
  });

  it("normalizes the reward config alongside the conditions", async () => {
    const admin = fakeAdmin(() => ({}));

    const compiled = await compileCampaign(
      admin,
      campaignWith(
        { id: "root", type: "group", combinator: "ALL", children: [] },
        { order: { value: { type: "percentage", value: 10 } } },
      ),
    );

    expect(compiled.reward).toEqual({ order: { value: { type: "percentage", value: 10 } } });
  });
});

describe("compileCampaign — M10 sibling snapshot and shop conflict settings", () => {
  it("carries the primary campaign's own id/priority/isExclusive through", async () => {
    const admin = fakeAdmin(() => ({}));
    const campaign = {
      id: "camp-a",
      conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
      rewardJson: {},
      priority: 7,
      isExclusive: true,
      usageLimitTotal: null,
      usageLimitPerCustomer: null,
      usageCount: 0,
    } as CampaignForCompilation;

    const compiled = await compileCampaign(admin, campaign, [], { conflictStrategy: "HIGHEST_DISCOUNT" });

    expect(compiled.id).toBe("camp-a");
    expect(compiled.priority).toBe(7);
    expect(compiled.isExclusive).toBe(true);
    expect(compiled.conflictStrategy).toBe("HIGHEST_DISCOUNT");
    expect(compiled.maxTotalDiscountPercent).toBeUndefined();
  });

  it("compiles every sibling's conditions with the exact same tag/collection/market resolution", async () => {
    const admin = fakeAdmin((query) => {
      if (query.includes("WinsletProductsByTag")) {
        return { data: { products: { nodes: [{ id: "gid://shopify/Product/9" }] } } };
      }
      throw new Error("unexpected query");
    });

    const siblings = [
      {
        id: "camp-b",
        conditionsJson: {
          id: "root",
          type: "group",
          combinator: "ALL",
          children: [{ id: "c1", type: "condition", field: "product.tag", operator: "in", value: ["VIP"] }],
        },
        rewardJson: { order: { value: { type: "percentage", value: 10 } } },
        priority: 3,
        isExclusive: false,
        usageLimitTotal: null,
        usageLimitPerCustomer: null,
        usageCount: 0,
      },
    ] as CampaignForCompilation[];

    const compiled = await compileCampaign(admin, campaignWith({ id: "root", type: "group", combinator: "ALL", children: [] }), siblings, {
      conflictStrategy: "STACK",
      maxTotalDiscountPercent: 25,
    });

    expect(compiled.siblings).toHaveLength(1);
    expect(compiled.siblings[0]).toMatchObject({ id: "camp-b", priority: 3, isExclusive: false });
    expect(compiled.siblings[0]!.conditions.children[0]).toMatchObject({ field: RESOLVED_PRODUCT_IDS_FIELD, value: ["gid://shopify/Product/9"] });
    expect(compiled.siblings[0]!.reward).toEqual({ order: { value: { type: "percentage", value: 10 } } });
    expect(compiled.maxTotalDiscountPercent).toBe(25);
  });

  it("compiles to an empty siblings array when there are no other active campaigns", async () => {
    const admin = fakeAdmin(() => ({}));
    const compiled = await compileCampaign(admin, campaignWith({ id: "root", type: "group", combinator: "ALL", children: [] }), [], {
      conflictStrategy: "STACK",
    });
    expect(compiled.siblings).toEqual([]);
  });
});
