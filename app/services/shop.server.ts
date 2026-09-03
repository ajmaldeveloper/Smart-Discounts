import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

interface ShopifyShopInfoResponse {
  shop?: {
    name: string;
    email: string | null;
    currencyCode: string;
    ianaTimezone: string;
    billingAddress: { countryCodeV2: string | null } | null;
  };
}

/**
 * Creates or refreshes this shop's Shop row right after OAuth completes
 * (see shopify.server.ts's afterAuth hook) — the row every Campaign,
 * WebhookEvent and DiscountExecution hangs off of. Safe to call on
 * every re-auth, not just first install: an uninstall/reinstall clears
 * uninstalledAt rather than creating a duplicate row.
 */
export async function upsertShopFromSession(
  admin: AdminApiContext,
  shopDomain: string,
) {
  const response = await admin.graphql(
    `#graphql
      query WinsletShopInfo {
        shop {
          name
          email
          currencyCode
          ianaTimezone
          billingAddress {
            countryCodeV2
          }
        }
      }`,
  );

  const payload = (await response.json()) as { data?: ShopifyShopInfoResponse };
  const shopInfo = payload.data?.shop;

  await db.shop.upsert({
    where: { domain: shopDomain },
    create: {
      domain: shopDomain,
      name: shopInfo?.name ?? null,
      email: shopInfo?.email ?? null,
      currencyCode: shopInfo?.currencyCode ?? null,
      countryCode: shopInfo?.billingAddress?.countryCodeV2 ?? null,
      timezone: shopInfo?.ianaTimezone ?? null,
    },
    update: {
      name: shopInfo?.name,
      email: shopInfo?.email,
      currencyCode: shopInfo?.currencyCode,
      countryCode: shopInfo?.billingAddress?.countryCodeV2,
      timezone: shopInfo?.ianaTimezone,
      uninstalledAt: null,
    },
  });
}

/** Marks a shop uninstalled without deleting its data — GDPR erasure only happens on the shop/redact webhook, up to 48 hours later. */
export async function markShopUninstalled(shopDomain: string) {
  await db.shop.updateMany({
    where: { domain: shopDomain },
    data: { uninstalledAt: new Date() },
  });
}

/** Permanently erases a shop's data, per the mandatory shop/redact webhook. Cascades to every Campaign/CampaignVersion/DiscountExecution/CampaignAnalyticsDaily/WebhookEvent row. */
export async function eraseShopData(shopDomain: string) {
  await db.shop.deleteMany({ where: { domain: shopDomain } });
}

export async function getShopOverview(shopDomain: string) {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });

  if (!shop) return null;

  const [activeCampaigns, draftCampaigns] = await Promise.all([
    db.campaign.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
    db.campaign.count({ where: { shopId: shop.id, status: "DRAFT" } }),
  ]);

  return { shop, activeCampaigns, draftCampaigns };
}
