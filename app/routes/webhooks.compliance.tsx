import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { eraseShopData } from "../services/shop.server";

/**
 * The three mandatory GDPR compliance webhooks — customers/data_request,
 * customers/redact, shop/redact — share ONE route because Shopify
 * registers them via `compliance_topics` in shopify.app.toml, not the
 * normal per-topic `topics` field; declaring them as regular
 * subscriptions (the original one-route-per-topic layout this app
 * started with) is rejected as an invalid topic at app-preview/deploy
 * time. `topic` on the authenticated webhook tells us which of the
 * three actually fired.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // Winslet never stores customer-identifying data beyond a "$app"
      // metafield mirroring the buyer's own tags/usage counts (see
      // app/services/buyer-data.server.ts) — there is nothing else to
      // export. Acknowledging with 200 is the complete, correct response.
      break;

    case "CUSTOMERS_REDACT": {
      // Erase that one customer's "$app"/"buyer_data" metafield — see
      // buyer-data.server.ts. Campaign targeting rules themselves
      // (which tags/segments to match) are shop-level configuration,
      // not this specific customer's data.
      if (!admin) break;

      const customerId = payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : undefined;
      if (!customerId) break;

      await admin.graphql(
        `#graphql
          mutation WinsletRedactBuyerData($ownerId: ID!) {
            metafieldsDelete(metafields: [{ ownerId: $ownerId, namespace: "$app", key: "buyer_data" }]) {
              userErrors { field message }
            }
          }`,
        { variables: { ownerId: customerId } },
      );
      break;
    }

    case "SHOP_REDACT":
      // Permanently erase everything stored for the shop — deleting
      // the Shop row cascades to every Campaign, CampaignVersion,
      // DiscountExecution, CampaignAnalyticsDaily and WebhookEvent row
      // (see schema.prisma's onDelete: Cascade relations).
      await eraseShopData(shop);
      break;

    default:
      console.warn(`[Winslet] Unexpected compliance topic: ${topic}`);
  }

  return new Response();
};
