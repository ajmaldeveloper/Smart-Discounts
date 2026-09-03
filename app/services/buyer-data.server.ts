/**
 * A buyer's tags and per-campaign usage counts, both mirrored into ONE
 * customer metafield ("$app"/"buyer_data") rather than two separate
 * ones. Each metafield a Function's input query fetches costs a fixed
 * amount against Shopify's 30-point query complexity budget — with
 * this plus the discount node's own config+usage-count metafields, a
 * 4th and 5th metafield pushed the query over that limit in practice.
 *
 * Merging is safe here specifically because both fields are additive,
 * independent facts about the SAME customer written by two different
 * webhooks (customers/update, orders/paid) that essentially never fire
 * for the same customer at the exact same instant — unlike the
 * discount node's config+usage-count, which deliberately stay
 * separate: merging THOSE would risk a real order webhook clobbering a
 * merchant's just-published campaign change (see order-processing.server.ts).
 * Every write here still reads-modifies-writes to avoid discarding the
 * other field on the rare actual collision.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const NAMESPACE = "$app";
const KEY = "buyer_data";

export interface BuyerData {
  tags: string[];
  usage: Record<string, number>;
}

const EMPTY: BuyerData = { tags: [], usage: {} };

export function parseBuyerData(raw: string | null | undefined): BuyerData {
  if (!raw) return { ...EMPTY };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...EMPTY };

    const record = parsed as Record<string, unknown>;
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const usage =
      typeof record.usage === "object" && record.usage !== null && !Array.isArray(record.usage)
        ? Object.fromEntries(
            Object.entries(record.usage as Record<string, unknown>).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
          )
        : {};

    return { tags, usage };
  } catch {
    return { ...EMPTY };
  }
}

async function readBuyerData(admin: AdminApiContext, customerId: string): Promise<BuyerData> {
  const response = await admin.graphql(
    `#graphql
      query WinsletReadBuyerData($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
            value
          }
        }
      }`,
    { variables: { id: customerId } },
  );

  const payload = (await response.json()) as { data?: { customer?: { metafield?: { value?: string } | null } | null } };
  return parseBuyerData(payload.data?.customer?.metafield?.value);
}

async function writeBuyerData(admin: AdminApiContext, customerId: string, data: BuyerData): Promise<void> {
  await admin.graphql(
    `#graphql
      mutation WinsletWriteBuyerData($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [{ ownerId: customerId, namespace: NAMESPACE, key: KEY, type: "json", value: JSON.stringify(data) }],
      },
    },
  );
}

export async function updateBuyerTags(admin: AdminApiContext, customerId: string, tags: string[]): Promise<void> {
  const current = await readBuyerData(admin, customerId);
  await writeBuyerData(admin, customerId, { ...current, tags });
}

export async function incrementBuyerCampaignUsage(admin: AdminApiContext, customerId: string, campaignId: string): Promise<void> {
  const current = await readBuyerData(admin, customerId);
  const usage = { ...current.usage, [campaignId]: (current.usage[campaignId] ?? 0) + 1 };
  await writeBuyerData(admin, customerId, { ...current, usage });
}
