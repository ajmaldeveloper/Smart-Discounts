import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processOrderForWinslet } from "../services/order-processing.server";

/** Drives both usage-limit tracking and M13's discount analytics — see order-processing.server.ts. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  const orderId = payload.admin_graphql_api_id as string | undefined;
  if (!orderId) return new Response();

  try {
    await processOrderForWinslet(admin, shop, orderId);
  } catch (error) {
    console.error("[Winslet] Failed to process order:", error);
  }

  return new Response();
};
