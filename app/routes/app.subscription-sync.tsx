import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getFreshShopEntitlements } from "../services/entitlements.server";

/**
 * Shopify Managed Pricing has no app-controlled confirmationUrl — after
 * a merchant picks a plan on Shopify's hosted pricing page, Shopify
 * always drops them back at the app's default entry point, not here.
 * This route exists so a link (from support docs, or the pricing
 * flow's "Return to app" step) can force an immediate resync instead
 * of waiting for the app_subscriptions/update webhook or the next
 * cached read.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, redirect } = await authenticate.admin(request);
  const entitlements = await getFreshShopEntitlements(admin, session.shop);

  const params = new URLSearchParams({ billing: "subscription-synchronized", plan: entitlements.effectivePlanCode });
  return redirect(`/app?${params.toString()}`);
};
