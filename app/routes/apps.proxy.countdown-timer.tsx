import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings } from "../lib/widget-settings";

/**
 * Backs the countdown-timer snippet. Like apps.proxy.announcement-bar.tsx,
 * there's no campaign data to resolve here — the merchant's own
 * restart mode/end time/colors ARE the whole payload. All the actual
 * "how much time is left" math happens client-side in
 * countdown-timer.js, computed fresh from these fields on every tick.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ active: false });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return Response.json({ active: false });

  const settings = normalizeWidgetSettings(shop.widgetSettingsJson);
  return Response.json({ active: settings.countdownTimer.enabled, ...settings.countdownTimer });
};
