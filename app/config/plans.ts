/**
 * Env-driven plan definitions (mirrors product-options/wholesale-
 * registration's own app/config/plans.ts) — .env is the single source
 * of truth for both what merchants see on the Plans page and what
 * plans.server.ts actually enforces, so the two can never drift apart.
 */

export type PlanCode = string;
export type PlanHandle = string;

export type AppPlan = {
  code: PlanCode;
  handle: PlanHandle;
  name: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number | null;
  trialDays: number;
  recommended: boolean;
  limits: {
    activeCampaigns: number | null;
    // Tiers discount shape (quantity/spend breaks + exact-match tiers)
    // and "Buy X, get Y free" (BOGO), gated as one flag — a merchant
    // needing one of the two ladder-based shapes needs the other just
    // as often, and splitting them bought no real independent value.
    tiers: boolean;
    // Sub-feature of `tiers`: BOGO's free-gift product picker (a
    // DIFFERENT product than the campaign's own conditions match).
    // Requires `tiers` first — checked independently so a merchant
    // can have plain BOGO/tiers without paying for the free-gift
    // picker specifically.
    freeGiftBogo: boolean;
    codeDiscounts: boolean;
    customerTargeting: boolean;
    productTargeting: boolean;
    marketTargeting: boolean;
    minimumRequirement: boolean;
    // Priority/exclusivity/usage-limit controls on the Stacking tab —
    // the Smart Conflict Engine's per-campaign knobs. The conflict
    // engine itself always runs (a shop's shop-wide conflictStrategy
    // default always applies); this flag gates only a campaign's
    // ability to override that default.
    stacking: boolean;
    analytics: boolean;
  };
};

type PlanPrefix = "FREE" | "GROWTH" | "PRO";

function getRequiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function getNumberEnv(key: string): number {
  const parsedValue = Number(getRequiredEnv(key));
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${key} must contain a valid non-negative number.`);
  }
  return parsedValue;
}

function getIntegerEnv(key: string): number {
  const value = getNumberEnv(key);
  if (!Number.isInteger(value)) throw new Error(`${key} must contain a whole number.`);
  return value;
}

function getNullablePriceEnv(key: string): number | null {
  const rawValue = getRequiredEnv(key);
  const normalizedValue = rawValue.toLowerCase();
  if (normalizedValue === "none" || normalizedValue === "null") return null;
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${key} must contain a valid non-negative number, null, or none.`);
  }
  return parsedValue;
}

function getBooleanEnv(key: string): boolean {
  const rawValue = getRequiredEnv(key).toLowerCase();
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${key} must be either true or false.`);
}

function getLimitEnv(key: string): number | null {
  const rawValue = getRequiredEnv(key);
  const normalizedValue = rawValue.toLowerCase();
  if (["unlimited", "null", "none"].includes(normalizedValue)) return null;
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${key} must contain a non-negative integer or unlimited.`);
  }
  return parsedValue;
}

function createPlan(prefix: PlanPrefix): AppPlan {
  return {
    code: getRequiredEnv(`PLAN_${prefix}_CODE`),
    handle: getRequiredEnv(`PLAN_${prefix}_HANDLE`),
    name: getRequiredEnv(`PLAN_${prefix}_NAME`),
    description: getRequiredEnv(`PLAN_${prefix}_DESCRIPTION`),
    monthlyPrice: getNumberEnv(`PLAN_${prefix}_MONTHLY_PRICE`),
    yearlyPrice: getNullablePriceEnv(`PLAN_${prefix}_YEARLY_PRICE`),
    trialDays: getIntegerEnv(`PLAN_${prefix}_TRIAL_DAYS`),
    recommended: getBooleanEnv(`PLAN_${prefix}_RECOMMENDED`),
    limits: {
      activeCampaigns: getLimitEnv(`PLAN_${prefix}_ACTIVE_CAMPAIGNS`),
      tiers: getBooleanEnv(`PLAN_${prefix}_TIERS`),
      freeGiftBogo: getBooleanEnv(`PLAN_${prefix}_FREE_GIFT_BOGO`),
      codeDiscounts: getBooleanEnv(`PLAN_${prefix}_CODE_DISCOUNTS`),
      customerTargeting: getBooleanEnv(`PLAN_${prefix}_CUSTOMER_TARGETING`),
      productTargeting: getBooleanEnv(`PLAN_${prefix}_PRODUCT_TARGETING`),
      marketTargeting: getBooleanEnv(`PLAN_${prefix}_MARKET_TARGETING`),
      minimumRequirement: getBooleanEnv(`PLAN_${prefix}_MINIMUM_REQUIREMENT`),
      stacking: getBooleanEnv(`PLAN_${prefix}_STACKING`),
      analytics: getBooleanEnv(`PLAN_${prefix}_ANALYTICS`),
    },
  };
}

function validatePlanConfiguration(plans: AppPlan[]): void {
  const codes = plans.map((plan) => plan.code.trim().toLowerCase());
  const handles = plans.map((plan) => plan.handle.trim().toLowerCase());
  if (new Set(codes).size !== codes.length) throw new Error("Plan codes must be unique.");
  if (new Set(handles).size !== handles.length) throw new Error("Plan handles must be unique.");
}

export function getAppPlans(): AppPlan[] {
  const plans = [createPlan("FREE"), createPlan("GROWTH"), createPlan("PRO")];
  validatePlanConfiguration(plans);
  return plans;
}

export function getShopifyAppHandle(): string {
  return getRequiredEnv("SHOPIFY_APP_HANDLE");
}

export function getPlanByHandle(plans: AppPlan[], handle: string | null | undefined): AppPlan | null {
  if (!handle?.trim()) return null;
  const normalizedHandle = handle.trim().toLowerCase();
  return plans.find((plan) => plan.handle.trim().toLowerCase() === normalizedHandle) ?? null;
}
