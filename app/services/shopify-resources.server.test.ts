import { describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  hydrateCollectionRefs,
  hydrateProductRefs,
  listProductTags,
  resolveMarketCountryCodes,
  searchCollections,
  searchMarkets,
  searchProducts,
} from "./shopify-resources.server";

function fakeAdmin(jsonResponse: unknown): AdminApiContext {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => jsonResponse,
    }),
  } as unknown as AdminApiContext;
}

describe("searchProducts / searchCollections", () => {
  it("flattens edges into ResourceRefs", async () => {
    const admin = fakeAdmin({
      data: {
        products: {
          edges: [
            { node: { id: "gid://shopify/Product/1", title: "Jacket" } },
            { node: { id: "gid://shopify/Product/2", title: "Hat" } },
          ],
        },
      },
    });

    const results = await searchProducts(admin, "jacket");
    expect(results).toEqual([
      { id: "gid://shopify/Product/1", title: "Jacket" },
      { id: "gid://shopify/Product/2", title: "Hat" },
    ]);
  });

  it("returns an empty array when there are no matches", async () => {
    const admin = fakeAdmin({ data: { collections: { edges: [] } } });
    expect(await searchCollections(admin, "nonexistent")).toEqual([]);
  });

  it("tolerates a malformed/empty response instead of throwing", async () => {
    const admin = fakeAdmin({});
    expect(await searchProducts(admin, "x")).toEqual([]);
  });
});

describe("searchMarkets", () => {
  it("flattens nodes into ResourceRefs", async () => {
    const admin = fakeAdmin({
      data: { markets: { nodes: [{ id: "gid://shopify/Market/1", title: "Canada" }] } },
    });

    expect(await searchMarkets(admin, "canada")).toEqual([{ id: "gid://shopify/Market/1", title: "Canada" }]);
  });
});

describe("resolveMarketCountryCodes", () => {
  it("extracts country codes from MarketRegionCountry nodes", async () => {
    const admin = fakeAdmin({
      data: { market: { regions: { nodes: [{ code: "US" }, { code: "CA" }] } } },
    });

    expect(await resolveMarketCountryCodes(admin, "gid://shopify/Market/1")).toEqual(["US", "CA"]);
  });

  it("returns [] for a deleted market", async () => {
    const admin = fakeAdmin({ data: { market: null } });
    expect(await resolveMarketCountryCodes(admin, "gid://deleted")).toEqual([]);
  });

  it("drops region nodes without a resolvable country code", async () => {
    const admin = fakeAdmin({
      data: { market: { regions: { nodes: [{ code: "US" }, {}] } } },
    });

    expect(await resolveMarketCountryCodes(admin, "gid://shopify/Market/1")).toEqual(["US"]);
  });
});

describe("listProductTags", () => {
  it("returns the nodes array directly", async () => {
    const admin = fakeAdmin({ data: { productTags: { nodes: ["VIP", "Sale"] } } });
    expect(await listProductTags(admin)).toEqual(["VIP", "Sale"]);
  });
});

describe("hydrateProductRefs / hydrateCollectionRefs", () => {
  it("returns [] without calling the API when given no ids", async () => {
    const admin = fakeAdmin({});
    expect(await hydrateProductRefs(admin, [])).toEqual([]);
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("maps a hydrated product node to a HydratedResourceRef", async () => {
    const admin = fakeAdmin({
      data: {
        nodes: [
          {
            id: "gid://shopify/Product/1",
            title: "Jacket",
            media: { nodes: [{ preview: { image: { url: "https://cdn/jacket.jpg" } } }] },
          },
        ],
      },
    });

    expect(await hydrateProductRefs(admin, ["gid://shopify/Product/1"])).toEqual([
      { id: "gid://shopify/Product/1", title: "Jacket", imageUrl: "https://cdn/jacket.jpg" },
    ]);
  });

  it("drops deleted products (null nodes) instead of throwing", async () => {
    const admin = fakeAdmin({
      data: {
        nodes: [
          null,
          { id: "gid://shopify/Product/2", title: "Still here", media: { nodes: [] } },
        ],
      },
    });

    const results = await hydrateProductRefs(admin, [
      "gid://shopify/Product/deleted",
      "gid://shopify/Product/2",
    ]);

    expect(results).toEqual([
      { id: "gid://shopify/Product/2", title: "Still here", imageUrl: null },
    ]);
  });

  it("hydrates collections with their image", async () => {
    const admin = fakeAdmin({
      data: {
        nodes: [
          { id: "gid://shopify/Collection/1", title: "Summer", image: { url: "https://cdn/summer.jpg" } },
        ],
      },
    });

    expect(await hydrateCollectionRefs(admin, ["gid://shopify/Collection/1"])).toEqual([
      { id: "gid://shopify/Collection/1", title: "Summer", imageUrl: "https://cdn/summer.jpg" },
    ]);
  });
});
