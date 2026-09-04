/**
 * Turns a recurring campaign (see app/lib/recurrence.ts's
 * RecurrenceRule) on and off to match its own daily/weekly window,
 * without the merchant clicking Pause/Resume themselves. Runs as an
 * in-process interval, same rationale as scheduled-publish.server.ts
 * (one long-lived server process, no external cron infrastructure
 * needed) — deliberately a separate file/interval from that one since
 * it's a distinct concern (recurring on/off vs. one-time auto-publish).
 *
 * Unlike scheduleStartAt/scheduleEndAt (Shopify's own native
 * startsAt/endsAt, enforced with no lag by Shopify itself), a
 * recurrence window has no native Shopify equivalent — this poll is
 * the only thing enforcing it, so there's up to CHECK_INTERVAL_MS of
 * lag around each on/off transition. Documented in the admin UI, not
 * hidden.
 */
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { pauseCampaign, resumeCampaign } from "./discount-publish.server";
import { shouldBeActiveNow } from "../lib/recurrence";
import { apiVersion } from "../shopify.server";

const CHECK_INTERVAL_MS = 60_000;

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

export async function syncRecurringCampaigns(): Promise<void> {
  const now = new Date();
  const candidates = await db.campaign.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] }, recurrenceJson: { not: Prisma.JsonNull } },
  });
  if (candidates.length === 0) return;

  const shops = await db.shop.findMany({ where: { id: { in: [...new Set(candidates.map((c) => c.shopId))] } } });
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));

  for (const campaign of candidates) {
    const wantsActive = shouldBeActiveNow(campaign, now);
    if (wantsActive === null) continue; // malformed rule — leave the campaign exactly as it is
    if (wantsActive === (campaign.status === "ACTIVE")) continue; // already in the right state

    const shop = shopById.get(campaign.shopId);
    if (!shop) continue;

    const session = await db.session.findFirst({ where: { shop: shop.domain, isOnline: false } });
    if (!session) {
      console.error(`[recurring-campaigns] No offline session for ${shop.domain}; can't sync campaign ${campaign.id}.`);
      continue;
    }

    try {
      const admin = buildAdminClient(shop.domain, session.accessToken);
      const result = wantsActive ? await resumeCampaign(admin, campaign) : await pauseCampaign(admin, campaign);
      if (!result.ok) {
        console.error(`[recurring-campaigns] ${wantsActive ? "Resume" : "Pause"} failed for campaign ${campaign.id}: ${result.message}`);
      }
    } catch (error) {
      console.error(`[recurring-campaigns] Sync threw for campaign ${campaign.id}:`, error);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var -- `declare global` only accepts `var`, not `let`/`const`.
  var __winsletRecurringCampaignsStarted: boolean | undefined;
}

// Guarded against Vite/dev-server HMR re-evaluating this module and
// stacking up duplicate intervals — this should start exactly once per
// actual server process.
if (!global.__winsletRecurringCampaignsStarted) {
  global.__winsletRecurringCampaignsStarted = true;
  setInterval(() => {
    syncRecurringCampaigns().catch((error) => console.error("[recurring-campaigns] tick failed:", error));
  }, CHECK_INTERVAL_MS);
}
