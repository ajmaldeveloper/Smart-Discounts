import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { updateBuyerTags } from "../services/buyer-data.server";

/**
 * Keeps a buyer's tags mirrored into their own "$app"/"buyer_data"
 * metafield, read directly by the Discount Function at checkout (see
 * extensions/winslet-discounts/src/context.ts).
 *
 * Why a webhook-synced metafield instead of resolving "customers with
 * tag X" into an id list at publish time, the way product.tag and
 * collection.id conditions work (see campaign-compiler.server.ts):
 * VIP/wholesale tagging is an approval-style event that needs to take
 * effect on the customer's very next order, not "whenever a merchant
 * next republishes a campaign" — and a shop can have far more
 * customers than products carrying a given promotional tag, making a
 * pre-resolved id list both stale-prone and potentially huge. Real-time
 * sync trades a `write_customers` scope for correctness here.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  const customerId = payload.admin_graphql_api_id as string | undefined;
  if (!customerId) return new Response();

  const tagsField = typeof payload.tags === "string" ? payload.tags : "";
  const tags = tagsField
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  await updateBuyerTags(admin, customerId, tags);

  return new Response();
};
