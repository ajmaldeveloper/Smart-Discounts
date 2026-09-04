import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";
import { getActiveTieredDiscount } from "../services/storefront-widgets.server";

/**
 * Backs the tier-progress bar snippet — same shape as the other bar
 * endpoints, but the campaign data is a full tier LIST (see
 * storefront-widgets.server.ts's getActiveTieredDiscount) rather than
 * a single threshold, since the bar itself marks every tier's
 * breakpoint along the track.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const tiered = await getActiveTieredDiscount(shop.id);
  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);

  if (!tiered.active) return Response.json({ active: false, ...settings.tierProgressBar });

  return Response.json({
    active: true,
    tierMetric: tiered.tierMetric,
    tiers: tiered.tiers,
    ...settings.tierProgressBar,
  });
};
