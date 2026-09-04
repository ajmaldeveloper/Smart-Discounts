import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";
import { getActiveBogoGiftCampaign } from "../services/storefront-widgets.server";

interface StorefrontProductNode {
  id: string;
  title: string;
  featuredImage?: { url: string } | null;
  variants: { nodes: Array<{ id: string; availableForSale: boolean; price: { amount: string; currencyCode: string } }> };
}

/**
 * Backs extensions/winslet-storefront's BOGO gift-picker snippet —
 * called directly by browser JS (fetch, not React Router's own
 * client), so this must return a real JSON Response. Resolves live
 * product data (title/image/price/the first available variant, for
 * the widget's own Add-to-cart button) via the Storefront API — not
 * the Admin API, so pricing/availability always match what a shopper
 * would actually see and can buy.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, storefront } = await authenticate.public.appProxy(request);
  if (!session || !storefront) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const campaign = await getActiveBogoGiftCampaign(shop.id);
  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);

  if (!campaign.active) return Response.json({ active: false, ...settings.bogoGift });

  const response = await storefront.graphql(
    `#graphql
      query WinsletBogoGiftProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            featuredImage { url }
            variants(first: 1) {
              nodes { id availableForSale price { amount currencyCode } }
            }
          }
        }
      }`,
    { variables: { ids: campaign.freeProductIds } },
  );
  const payload = (await response.json()) as { data?: { nodes?: (StorefrontProductNode | null)[] } };

  const products = (payload.data?.nodes ?? [])
    .filter((node): node is StorefrontProductNode => node !== null && node.variants.nodes.length > 0)
    .map((node) => {
      const variant = node.variants.nodes[0];
      return {
        productId: node.id,
        title: node.title,
        image: node.featuredImage?.url ?? null,
        variantId: variant.id,
        availableForSale: variant.availableForSale,
        price: variant.price.amount,
        currencyCode: variant.price.currencyCode,
      };
    });

  return Response.json({
    active: true,
    conditions: campaign.conditions,
    buyQuantity: campaign.buyQuantity,
    getQuantity: campaign.getQuantity,
    products,
    ...settings.bogoGift,
  });
};
