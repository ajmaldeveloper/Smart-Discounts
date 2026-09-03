/**
 * Auto-publishes a Draft campaign the moment its own configured
 * scheduleStartAt arrives, so a merchant doesn't have to be watching
 * the clock and click Publish themselves. Runs as an in-process
 * interval — this app has one long-lived server process (no
 * serverless cold-starts to worry about), so a simple setInterval is
 * enough; no external cron infrastructure needed.
 *
 * Only ever touches a campaign that is still DRAFT with no
 * shopifyDiscountId yet — an already-published (Scheduled: ACTIVE +
 * future startsAt) campaign is Shopify's own responsibility to flip on
 * at the right time, exactly like any native discount.
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { publishCampaign } from "./discount-publish.server";
import { apiVersion } from "../shopify.server";

const CHECK_INTERVAL_MS = 20_000;

function buildAdminClient(shopDomain: string, accessToken: string): AdminApiContext {
  return {
    graphql: (query: string, options?: { variables?: Record<string, unknown> }) =>
      fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      }),
  } as unknown as AdminApiContext;
}

export async function publishDueScheduledCampaigns(): Promise<void> {
  const dueCampaigns = await db.campaign.findMany({
    where: { status: "DRAFT", shopifyDiscountId: null, scheduleStartAt: { lte: new Date() } },
  });

  if (dueCampaigns.length === 0) return;

  const shops = await db.shop.findMany({ where: { id: { in: [...new Set(dueCampaigns.map((c) => c.shopId))] } } });
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));

  for (const campaign of dueCampaigns) {
    const shop = shopById.get(campaign.shopId);
    if (!shop) continue;

    const session = await db.session.findFirst({ where: { shop: shop.domain, isOnline: false } });
    if (!session) {
      console.error(`[scheduled-publish] No offline session for ${shop.domain}; can't auto-publish campaign ${campaign.id}.`);
      continue;
    }

    try {
      const admin = buildAdminClient(shop.domain, session.accessToken);
      const result = await publishCampaign(admin, campaign);
      if (!result.ok) {
        console.error(`[scheduled-publish] Auto-publish failed for campaign ${campaign.id}: ${result.message}`);
      }
    } catch (error) {
      console.error(`[scheduled-publish] Auto-publish threw for campaign ${campaign.id}:`, error);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var -- `declare global` only accepts `var`, not `let`/`const`.
  var __winsletScheduledPublishStarted: boolean | undefined;
}

// Guarded against Vite/dev-server HMR re-evaluating this module and
// stacking up duplicate intervals — this should start exactly once per
// actual server process.
if (!global.__winsletScheduledPublishStarted) {
  global.__winsletScheduledPublishStarted = true;
  setInterval(() => {
    publishDueScheduledCampaigns().catch((error) => console.error("[scheduled-publish] tick failed:", error));
  }, CHECK_INTERVAL_MS);
}
