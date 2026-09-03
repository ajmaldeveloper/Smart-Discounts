/** Builds the link to Shopify's own hosted Managed Pricing page — the only place a merchant actually chooses/changes/cancels a plan; this app never calls appSubscriptionCreate directly. */
export function getShopifyPricingUrl({ shopDomain, appHandle }: { shopDomain: string; appHandle: string }): string {
  const storeHandle = getStoreHandle(shopDomain);
  const normalizedAppHandle = appHandle.trim();
  if (!normalizedAppHandle) throw new Error("SHOPIFY_APP_HANDLE is not configured.");

  return ["https://admin.shopify.com/store", encodeURIComponent(storeHandle), "charges", encodeURIComponent(normalizedAppHandle), "pricing_plans"].join("/");
}

function getStoreHandle(shopDomain: string): string {
  const normalizedDomain = shopDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const storeHandle = normalizedDomain.replace(/\.myshopify\.com$/, "");
  if (!storeHandle) throw new Error("A valid Shopify shop domain is required.");
  return storeHandle;
}
