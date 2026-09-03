import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { synchronizeShopSubscription } from "../services/subscriptions.server";

/** Fired whenever Shopify Managed Pricing activates, changes, or cancels a subscription — keeps Shop.planCode/planStatus in sync without waiting for the merchant to revisit the Plans page. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  try {
    await synchronizeShopSubscription(shop, admin);
  } catch (error) {
    console.error(`[Winslet] Failed to synchronize subscription for ${shop}:`, error);
  }

  return new Response();
};
