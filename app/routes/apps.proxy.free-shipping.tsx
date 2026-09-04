import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";
import { getActiveFreeShippingThreshold } from "../services/storefront-widgets.server";

/**
 * Backs extensions/winslet-storefront's free-shipping-bar app embed —
 * called directly by browser JS (fetch, not React Router's own client),
 * so this must return a real JSON Response, not the framework's
 * internal loader-data format. No CORS/embedded-admin CSP headers
 * needed: Shopify's App Proxy forwards this same-origin from the
 * storefront's own perspective, and this route is never rendered
 * inside the admin iframe.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const threshold = await getActiveFreeShippingThreshold(shop.id);
  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);

  return Response.json({ ...threshold, ...settings.freeShippingBar });
};
