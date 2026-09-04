import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";
import { getActiveTieredDiscount } from "../services/storefront-widgets.server";

/**
 * Backs the tier-list popup snippet — shares its campaign data source
 * (getActiveTieredDiscount) with the tier-progress bar, but its own
 * settings slice (heading/triggerLabel/rowTemplate/colors), same
 * pattern as apps.proxy.tier-progress.tsx.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const tiered = await getActiveTieredDiscount(shop.id);
  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);

  if (!tiered.active) return Response.json({ active: false, ...settings.tierList });

  return Response.json({
    active: true,
    tierMetric: tiered.tierMetric,
    tiers: tiered.tiers,
    ...settings.tierList,
  });
};
