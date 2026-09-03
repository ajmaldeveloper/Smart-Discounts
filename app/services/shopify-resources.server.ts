/**
 * Reusable Shopify resource lookups for the targeting engine (M2).
 *
 * A Campaign's productScopeJson never stores more than {id, title} for
 * a picked product/collection/variant — the minimum needed to render
 * the builder's chosen-items list without a round trip. Everything
 * else (image, vendor, current title if renamed) is re-fetched on
 * demand via the hydrate* functions below, mirroring the pattern in
 * both sibling apps: capture id+title at selection time, hydrate the
 * rest only when actually displaying the picker/list. This is what
 * M2's "avoid storing unnecessary copies of Shopify data" means in
 * practice.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export interface ResourceRef {
  id: string;
  title: string;
}

export interface HydratedResourceRef extends ResourceRef {
  imageUrl: string | null;
}

function edgeNodes<T>(connection: { edges?: Array<{ node: T }> } | null | undefined): T[] {
  return connection?.edges?.map((edge) => edge.node) ?? [];
}

export async function searchProducts(
  admin: AdminApiContext,
  query: string,
  first = 20,
): Promise<ResourceRef[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletSearchProducts($query: String, $first: Int!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
            }
          }
        }
      }`,
    { variables: { query: query || null, first } },
  );

  const payload = (await response.json()) as {
    data?: { products?: { edges?: Array<{ node: ResourceRef }> } };
  };

  return edgeNodes(payload.data?.products);
}

export async function searchCollections(
  admin: AdminApiContext,
  query: string,
  first = 20,
): Promise<ResourceRef[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletSearchCollections($query: String, $first: Int!) {
        collections(first: $first, query: $query) {
          edges {
            node {
              id
              title
            }
          }
        }
      }`,
    { variables: { query: query || null, first } },
  );

  const payload = (await response.json()) as {
    data?: { collections?: { edges?: Array<{ node: ResourceRef }> } };
  };

  return edgeNodes(payload.data?.collections);
}

export async function searchProductVariants(
  admin: AdminApiContext,
  productId: string,
  query: string,
  first = 20,
): Promise<Array<ResourceRef & { sku: string | null }>> {
  const response = await admin.graphql(
    `#graphql
      query WinsletSearchProductVariants($productId: ID!, $query: String, $first: Int!) {
        product(id: $productId) {
          variants(first: $first, query: $query) {
            edges {
              node {
                id
                title
                sku
              }
            }
          }
        }
      }`,
    { variables: { productId, query: query || null, first } },
  );

  const payload = (await response.json()) as {
    data?: {
      product?: {
        variants?: { edges?: Array<{ node: ResourceRef & { sku: string | null } }> };
      };
    };
  };

  return edgeNodes(payload.data?.product?.variants);
}

/** Distinct product tags/vendors/types in the shop, used to populate filter dropdowns without a fixed enum. */
export async function listProductTags(admin: AdminApiContext, first = 250): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletProductTags($first: Int!) {
        productTags(first: $first) {
          nodes
        }
      }`,
    { variables: { first } },
  );

  const payload = (await response.json()) as { data?: { productTags?: { nodes?: string[] } } };
  return payload.data?.productTags?.nodes ?? [];
}

export async function listProductVendors(admin: AdminApiContext, first = 250): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletProductVendors($first: Int!) {
        productVendors(first: $first) {
          nodes
        }
      }`,
    { variables: { first } },
  );

  const payload = (await response.json()) as { data?: { productVendors?: { nodes?: string[] } } };
  return payload.data?.productVendors?.nodes ?? [];
}

export async function listProductTypes(admin: AdminApiContext, first = 250): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletProductTypes($first: Int!) {
        productTypes(first: $first) {
          nodes
        }
      }`,
    { variables: { first } },
  );

  const payload = (await response.json()) as { data?: { productTypes?: { nodes?: string[] } } };
  return payload.data?.productTypes?.nodes ?? [];
}

/**
 * Resolves already-selected product/collection GIDs into display data
 * (current title + image), for redrawing a builder's "chosen items"
 * list. Silently drops ids Shopify no longer recognizes (deleted
 * products) instead of throwing — a stale reference in a draft
 * campaign must not break the whole editor.
 */
export async function hydrateProductRefs(
  admin: AdminApiContext,
  ids: string[],
): Promise<HydratedResourceRef[]> {
  if (ids.length === 0) return [];

  const response = await admin.graphql(
    `#graphql
      query WinsletHydrateProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            media(first: 1) {
              nodes {
                preview {
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      }`,
    { variables: { ids } },
  );

  const payload = (await response.json()) as {
    data?: {
      nodes?: Array<{
        id: string;
        title: string;
        media?: { nodes?: Array<{ preview?: { image?: { url?: string } | null } | null }> };
      } | null>;
    };
  };

  return (payload.data?.nodes ?? [])
    .filter((node): node is NonNullable<typeof node> => node !== null)
    .map((node) => ({
      id: node.id,
      title: node.title,
      imageUrl: node.media?.nodes?.[0]?.preview?.image?.url ?? null,
    }));
}

export async function searchMarkets(admin: AdminApiContext, query: string, first = 20): Promise<ResourceRef[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletSearchMarkets($query: String, $first: Int!) {
        markets(first: $first, query: $query) {
          nodes {
            id
            title: name
          }
        }
      }`,
    { variables: { query: query || null, first } },
  );

  const payload = (await response.json()) as { data?: { markets?: { nodes?: ResourceRef[] } } };
  return payload.data?.markets?.nodes ?? [];
}

/**
 * Expands a Shopify Market into the concrete ISO country codes it
 * covers — Winslet never stores a bare Market ID as a condition value
 * (see app/services/campaign-compiler.server.ts's module comment):
 * Shopify's own Function API deprecated `localization.market` outright
 * (removal planned), and separately warns that a buyer can match
 * parent and child Markets, so a single stored Market ID was never a
 * robust target in the first place. Country code, resolved once here,
 * is the stable, non-deprecated signal.
 */
export async function resolveMarketCountryCodes(admin: AdminApiContext, marketId: string): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query WinsletMarketRegions($id: ID!) {
        market(id: $id) {
          regions(first: 250) {
            nodes {
              ... on MarketRegionCountry {
                code
              }
            }
          }
        }
      }`,
    { variables: { id: marketId } },
  );

  const payload = (await response.json()) as {
    data?: { market?: { regions?: { nodes?: Array<{ code?: string }> } } | null };
  };

  return (payload.data?.market?.regions?.nodes ?? [])
    .map((node) => node.code)
    .filter((code): code is string => Boolean(code));
}

export async function hydrateCollectionRefs(
  admin: AdminApiContext,
  ids: string[],
): Promise<HydratedResourceRef[]> {
  if (ids.length === 0) return [];

  const response = await admin.graphql(
    `#graphql
      query WinsletHydrateCollections($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Collection {
            id
            title
            image {
              url
            }
          }
        }
      }`,
    { variables: { ids } },
  );

  const payload = (await response.json()) as {
    data?: {
      nodes?: Array<{ id: string; title: string; image?: { url?: string } | null } | null>;
    };
  };

  return (payload.data?.nodes ?? [])
    .filter((node): node is NonNullable<typeof node> => node !== null)
    .map((node) => ({
      id: node.id,
      title: node.title,
      imageUrl: node.image?.url ?? null,
    }));
}
