/**
 * Verifies and persists a shop's real Shopify Managed Pricing
 * subscription. Mirrors wholesale-registration's own
 * subscriptions.server.ts — see that file's module comment for the
 * full rationale. Requires SHOPIFY_PARTNER_ORGANIZATION_ID,
 * SHOPIFY_PARTNER_API_ACCESS_TOKEN and SHOPIFY_APP_GID in .env (real
 * Partner API credentials, generated from the Partner Dashboard) —
 * until those are configured, every call here throws, which
 * entitlements.server.ts's getFreshShopEntitlements catches and falls
 * back to the shop's cached plan for, rather than breaking the page.
 */
import type { Subscription } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getPlanCodeFromShopifyHandle } from "./plan-handles.server";
import { getPlanDefinition, type PlanCode } from "./plans.server";

const PARTNER_API_VERSION = "2026-07";
const CURRENT_SUBSCRIPTION_STATUSES = ["ACTIVE", "PENDING", "FROZEN"];

const SHOP_IDENTITY_QUERY = `#graphql
  query WinsletShopIdentity {
    shop {
      id
      myshopifyDomain
    }
  }
`;

/** Standard Admin API query (no Partner API credentials needed), used only as a safety cross-check — see confirmNoActiveSubscription below. */
const CURRENT_APP_INSTALLATION_SUBSCRIPTIONS_QUERY = `#graphql
  query WinsletCurrentInstallationSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
      }
    }
  }
`;

const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query WinsletActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      shop {
        id
        myshopifyDomain
      }
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle {
        startTime
        endTime
      }
      items {
        handle
        description
        price {
          __typename
          active
          currency
          ... on FlatRatePrice {
            amount
          }
        }
      }
      pendingUpdate {
        billingPeriod
        items {
          handle
        }
        legacySubscriptionId
      }
      legacySubscriptionId
    }
  }
`;

type GraphqlError = { message?: string };

function normalizeShopDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

type ShopIdentityResponse = {
  data?: { shop?: { id?: string; myshopifyDomain?: string } };
  errors?: GraphqlError[];
};

type PricingItem = {
  handle?: string;
  description?: string | null;
  price?: { __typename?: string; active?: boolean; currency?: string | null; amount?: string | null } | null;
};

export type ActiveSubscription = {
  shop?: { id?: string; myshopifyDomain?: string };
  billingPeriod?: string | null;
  cancelAtEndOfCycle?: boolean;
  trialEndsAt?: string | null;
  currentBillingCycle?: { startTime?: string | null; endTime?: string | null } | null;
  items?: PricingItem[];
  pendingUpdate?: { billingPeriod?: string | null; items?: Array<{ handle?: string }>; legacySubscriptionId?: string | null } | null;
  legacySubscriptionId?: string | null;
};

type ActiveSubscriptionResponse = { data?: { activeSubscription?: ActiveSubscription | null }; errors?: GraphqlError[] };
type CurrentInstallationSubscriptionsResponse = {
  data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ id?: string; name?: string; status?: string }> } };
  errors?: GraphqlError[];
};

export type SubscriptionSyncResult = {
  shopDomain: string;
  planCode: PlanCode;
  planStatus: string;
  subscription: Subscription | null;
  source: "SHOPIFY_APP_PRICING" | "FREE_FALLBACK" | "UNVERIFIED_SKIP";
};

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getGraphqlErrorMessage(errors: GraphqlError[] | undefined): string | null {
  if (!errors || errors.length === 0) return null;
  return errors.map((error) => error.message || "Unknown GraphQL error.").join(" ");
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolves our internal plan from Shopify's active pricing-item
 * handles. When multiple recognized items are active, the highest
 * entitlement wins. price.active is NOT a signal of whether the
 * subscription itself is current — a line item still in its free
 * trial can legitimately report price.active: false while the
 * subscription is real, so no extra filtering happens here.
 */
export function resolvePlanCode(activeSubscription: ActiveSubscription): PlanCode | null {
  const items = activeSubscription.items ?? [];
  const recognizedPlans = items.map((item) => getPlanCodeFromShopifyHandle(item.handle)).filter((planCode): planCode is PlanCode => planCode !== null);

  const priority: PlanCode[] = ["PRO", "GROWTH", "FREE"];
  const resolved = priority.find((planCode) => recognizedPlans.includes(planCode));

  if (!resolved) {
    console.warn(
      "resolvePlanCode found no recognized plan handle. Raw items:",
      JSON.stringify(items.map((item) => ({ handle: item.handle, priceActive: item.price?.active, priceType: item.price?.__typename }))),
    );
  }

  return resolved ?? null;
}

async function getShopGid(admin: AdminApiContext, expectedShopDomain: string): Promise<string> {
  const response = await admin.graphql(SHOP_IDENTITY_QUERY);
  if (!response.ok) throw new Error(`Shopify Admin API returned HTTP ${response.status}.`);

  const result = (await response.json()) as ShopIdentityResponse;
  const graphqlError = getGraphqlErrorMessage(result.errors);
  if (graphqlError) throw new Error(`Shopify Admin API error: ${graphqlError}`);

  const shopId = result.data?.shop?.id;
  const returnedDomain = result.data?.shop?.myshopifyDomain;
  if (!shopId || !returnedDomain) throw new Error("Shopify Admin API did not return the shop identity.");

  if (normalizeShopDomain(expectedShopDomain) !== normalizeShopDomain(returnedDomain)) {
    throw new Error("The authenticated shop does not match the returned shop identity.");
  }

  return shopId;
}

async function fetchActiveSubscription(shopId: string): Promise<ActiveSubscription | null> {
  const organizationId = getRequiredEnvironmentVariable("SHOPIFY_PARTNER_ORGANIZATION_ID");
  const partnerAccessToken = getRequiredEnvironmentVariable("SHOPIFY_PARTNER_API_ACCESS_TOKEN");
  const appId = getRequiredEnvironmentVariable("SHOPIFY_APP_GID");

  const endpoint = `https://partners.shopify.com/${organizationId}/api/${PARTNER_API_VERSION}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": partnerAccessToken },
    body: JSON.stringify({ query: ACTIVE_SUBSCRIPTION_QUERY, variables: { appId, shopId } }),
  });

  if (!response.ok) throw new Error(`Shopify Partner API returned HTTP ${response.status}.`);

  const result = (await response.json()) as ActiveSubscriptionResponse;
  const graphqlError = getGraphqlErrorMessage(result.errors);
  if (graphqlError) throw new Error(`Shopify Partner API error: ${graphqlError}`);

  return result.data?.activeSubscription ?? null;
}

/**
 * Cross-checks the standard Admin API for an active subscription the
 * Partner API might have missed. Per Shopify's own guidance: if the
 * Active Subscription API returns null, don't treat the shop as unpaid
 * until currentAppInstallation also confirms it — a Partner API hiccup
 * must never silently cancel a paying merchant's subscription. Returns
 * true only when the Admin API positively confirms nothing is active;
 * never on error, so a failure here means "can't confirm," not
 * "confirmed unpaid."
 */
async function confirmNoActiveSubscription(admin: AdminApiContext): Promise<boolean> {
  try {
    const response = await admin.graphql(CURRENT_APP_INSTALLATION_SUBSCRIPTIONS_QUERY);
    if (!response.ok) return false;

    const result = (await response.json()) as CurrentInstallationSubscriptionsResponse;
    if (getGraphqlErrorMessage(result.errors)) return false;

    const activeSubscriptions = result.data?.currentAppInstallation?.activeSubscriptions ?? [];
    return !activeSubscriptions.some((subscription) => subscription.status === "ACTIVE");
  } catch {
    return false;
  }
}

async function synchronizeFreeFallback(shopId: string, shopDomain: string): Promise<SubscriptionSyncResult> {
  const now = new Date();

  await db.$transaction([
    db.subscription.updateMany({
      where: { shopId, status: { in: CURRENT_SUBSCRIPTION_STATUSES } },
      data: { status: "CANCELLED", cancelledAt: now },
    }),
    db.shop.update({ where: { id: shopId }, data: { planCode: "FREE", planStatus: "ACTIVE" } }),
  ]);

  return { shopDomain, planCode: "FREE", planStatus: "ACTIVE", subscription: null, source: "FREE_FALLBACK" };
}

async function saveActiveSubscription(shopId: string, shopDomain: string, planCode: PlanCode, activeSubscription: ActiveSubscription): Promise<SubscriptionSyncResult> {
  const now = new Date();
  const legacySubscriptionId = activeSubscription.legacySubscriptionId || null;

  const existingSubscription = legacySubscriptionId
    ? await db.subscription.findUnique({ where: { shopifySubscriptionId: legacySubscriptionId } })
    : await db.subscription.findFirst({ where: { shopId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" } });

  if (existingSubscription && existingSubscription.shopId !== shopId) {
    throw new Error("The Shopify subscription is already associated with another shop.");
  }

  const detailsJson = JSON.stringify(activeSubscription);

  const subscription = await db.$transaction(async (transaction) => {
    await transaction.subscription.updateMany({
      where: { shopId, status: { in: CURRENT_SUBSCRIPTION_STATUSES }, ...(existingSubscription ? { id: { not: existingSubscription.id } } : {}) },
      data: { status: "CANCELLED", cancelledAt: now },
    });

    const savedSubscription = existingSubscription
      ? await transaction.subscription.update({
          where: { id: existingSubscription.id },
          data: {
            shopifySubscriptionId: legacySubscriptionId,
            planCode,
            status: "ACTIVE",
            trialEndsAt: parseOptionalDate(activeSubscription.trialEndsAt),
            currentPeriodEnd: parseOptionalDate(activeSubscription.currentBillingCycle?.endTime),
            activatedAt: existingSubscription.activatedAt || now,
            cancelledAt: null,
            detailsJson,
          },
        })
      : await transaction.subscription.create({
          data: {
            shopId,
            shopifySubscriptionId: legacySubscriptionId,
            planCode,
            status: "ACTIVE",
            trialEndsAt: parseOptionalDate(activeSubscription.trialEndsAt),
            currentPeriodEnd: parseOptionalDate(activeSubscription.currentBillingCycle?.endTime),
            activatedAt: now,
            detailsJson,
          },
        });

    await transaction.shop.update({ where: { id: shopId }, data: { planCode, planStatus: "ACTIVE" } });

    return savedSubscription;
  });

  return { shopDomain, planCode, planStatus: "ACTIVE", subscription, source: "SHOPIFY_APP_PRICING" };
}

/**
 * Queries Shopify and synchronizes the merchant's verified plan. Must
 * only be called after authenticate.admin(request) — a plan code
 * received from form data, URL parameters, or browser state must never
 * be trusted.
 */
export async function synchronizeShopSubscription(shopDomain: string, admin: AdminApiContext): Promise<SubscriptionSyncResult> {
  const shop = await db.shop.findUniqueOrThrow({ where: { domain: shopDomain } });
  const shopGid = await getShopGid(admin, shop.domain);
  const activeSubscription = await fetchActiveSubscription(shopGid);

  if (!activeSubscription) {
    const confirmedNoSubscriptionElsewhere = await confirmNoActiveSubscription(admin);

    if (!confirmedNoSubscriptionElsewhere) {
      console.warn(
        `[subscriptions] Partner API found no active subscription for ${shop.domain}, but the Admin API could not confirm the shop has none either. Skipping the Free downgrade.`,
      );
      return { shopDomain: shop.domain, planCode: getPlanDefinition(shop.planCode).code, planStatus: shop.planStatus, subscription: null, source: "UNVERIFIED_SKIP" };
    }

    return synchronizeFreeFallback(shop.id, shop.domain);
  }

  const returnedShopDomain = activeSubscription.shop?.myshopifyDomain;
  if (returnedShopDomain && normalizeShopDomain(returnedShopDomain) !== shop.domain) {
    throw new Error("The Partner API subscription belongs to a different shop.");
  }

  const planCode = resolvePlanCode(activeSubscription);

  if (!planCode) {
    // Fail closed — an unknown Shopify pricing handle must never retain or grant paid access.
    const now = new Date();
    await db.$transaction([
      db.subscription.updateMany({ where: { shopId: shop.id, status: { in: CURRENT_SUBSCRIPTION_STATUSES } }, data: { status: "CANCELLED", cancelledAt: now } }),
      db.shop.update({ where: { id: shop.id }, data: { planCode: "FREE", planStatus: "PENDING" } }),
    ]);

    const receivedHandles = (activeSubscription.items ?? [])
      .map((item) => item.handle)
      .filter((handle): handle is string => typeof handle === "string" && handle.length > 0)
      .join(", ");

    throw new Error(`Shopify returned an unrecognized pricing item handle. Received: ${receivedHandles || "none"}.`);
  }

  getPlanDefinition(planCode); // confirms the resolved internal plan definition exists

  return saveActiveSubscription(shop.id, shop.domain, planCode, activeSubscription);
}
