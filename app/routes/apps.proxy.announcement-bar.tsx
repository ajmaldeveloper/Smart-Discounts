import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";

/**
 * Backs the announcement-bar snippet — called directly by browser JS
 * (fetch, not React Router's own client), so this must return a real
 * JSON Response. Unlike the free-shipping bar and BOGO picker, there's
 * no campaign data to resolve here: the merchant's own message/colors
 * ARE the whole payload, so this is a straight settings read.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);
  return Response.json({ active: settings.announcementBar.enabled, ...settings.announcementBar });
};
