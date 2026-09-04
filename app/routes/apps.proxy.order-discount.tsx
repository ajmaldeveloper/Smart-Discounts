import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";
import { getActiveOrderDiscountThreshold } from "../services/storefront-widgets.server";

/**
 * Backs the order-discount bar snippet — same shape as
 * apps.proxy.free-shipping.tsx, just reading the campaign's Order
 * reward instead of its Shipping reward, and additionally surfacing
 * the reward's own discount value/type so the bar's message can show
 * the actual %/amount unlocked (see order-discount-bar.js's {discount}
 * token).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const threshold = await getActiveOrderDiscountThreshold(shop.id);
  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);

  if (!threshold.active) return Response.json({ active: false, ...settings.orderDiscountBar });

  return Response.json({
    active: true,
    minimumValue: threshold.minimumValue,
    minimumMetric: threshold.minimumMetric,
    discountType: threshold.discountValue.type,
    discountValue: threshold.discountValue.value,
    ...settings.orderDiscountBar,
  });
};
