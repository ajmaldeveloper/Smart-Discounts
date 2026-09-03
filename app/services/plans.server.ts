import { getAppPlans, type AppPlan } from "../config/plans";

export const PLAN_CODES = ["FREE", "GROWTH", "PRO"] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export const PLAN_FEATURES = [
  // Tiers discount shape (quantity/spend breaks + exact-match) and
  // Buy X Get Y Free share one flag — see AppPlan.limits.tiers's own
  // comment in config/plans.ts for why.
  "TIERS",
  // Sub-feature of TIERS: BOGO's free-gift product picker. Callers
  // must still hold TIERS first.
  "FREE_GIFT_BOGO",
  "CODE_DISCOUNTS",
  "CUSTOMER_TARGETING",
  "PRODUCT_TARGETING",
  "MARKET_TARGETING",
  "MINIMUM_REQUIREMENT",
  "STACKING",
  "ANALYTICS",
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

export type PlanLimits = {
  activeCampaigns: number | null;
};

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  description: string;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number | null;
  trialDays: number;
  recommended: boolean;
  limits: PlanLimits;
  features: ReadonlySet<PlanFeature>;
};

function isPlanCodeValue(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

/**
 * Derives the enforced feature flags directly from the same
 * environment-configured booleans shown on the Plans page, so the plan
 * a merchant sees always matches what is actually enforced.
 */
function buildFeatureSet(plan: AppPlan): ReadonlySet<PlanFeature> {
  const features = new Set<PlanFeature>();

  if (plan.limits.tiers) features.add("TIERS");
  if (plan.limits.freeGiftBogo) features.add("FREE_GIFT_BOGO");
  if (plan.limits.codeDiscounts) features.add("CODE_DISCOUNTS");
  if (plan.limits.customerTargeting) features.add("CUSTOMER_TARGETING");
  if (plan.limits.productTargeting) features.add("PRODUCT_TARGETING");
  if (plan.limits.marketTargeting) features.add("MARKET_TARGETING");
  if (plan.limits.minimumRequirement) features.add("MINIMUM_REQUIREMENT");
  if (plan.limits.stacking) features.add("STACKING");
  if (plan.limits.analytics) features.add("ANALYTICS");

  return features;
}

function buildPlanDefinition(plan: AppPlan): PlanDefinition {
  const normalizedCode = plan.code.trim().toUpperCase();

  if (!isPlanCodeValue(normalizedCode)) {
    throw new Error(`Unsupported PLAN_*_CODE "${plan.code}" in environment configuration. Expected one of: ${PLAN_CODES.join(", ")}.`);
  }

  return {
    code: normalizedCode,
    name: plan.name,
    description: plan.description,
    monthlyPriceUsd: plan.monthlyPrice,
    yearlyPriceUsd: plan.yearlyPrice,
    trialDays: plan.trialDays,
    recommended: plan.recommended,
    limits: { activeCampaigns: plan.limits.activeCampaigns },
    features: buildFeatureSet(plan),
  };
}

function buildPlans(): Record<PlanCode, PlanDefinition> {
  const definitions = getAppPlans().map(buildPlanDefinition);

  for (const code of PLAN_CODES) {
    if (!definitions.some((definition) => definition.code === code)) {
      throw new Error(`Missing required plan configuration for "${code}". Check the PLAN_${code}_* environment variables.`);
    }
  }

  return Object.fromEntries(definitions.map((definition) => [definition.code, definition])) as Record<PlanCode, PlanDefinition>;
}

export const PLANS: Record<PlanCode, PlanDefinition> = buildPlans();

export class PlanAccessError extends Error {
  readonly code = "PLAN_ACCESS_DENIED";
  readonly planCode: PlanCode;
  readonly requiredFeature?: PlanFeature;

  constructor(message: string, options: { planCode: PlanCode; requiredFeature?: PlanFeature }) {
    super(message);
    this.name = "PlanAccessError";
    this.planCode = options.planCode;
    this.requiredFeature = options.requiredFeature;
  }
}

export class PlanLimitError extends Error {
  readonly code = "PLAN_LIMIT_REACHED";
  readonly planCode: PlanCode;
  readonly limitName: keyof PlanLimits;
  readonly limit: number;

  constructor(message: string, options: { planCode: PlanCode; limitName: keyof PlanLimits; limit: number }) {
    super(message);
    this.name = "PlanLimitError";
    this.planCode = options.planCode;
    this.limitName = options.limitName;
    this.limit = options.limit;
  }
}

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && PLAN_CODES.includes(value as PlanCode);
}

/** Unknown/missing database values safely fall back to Free instead of accidentally granting paid access. */
export function getPlanDefinition(planCode: string | null | undefined): PlanDefinition {
  if (!isPlanCode(planCode)) return PLANS.FREE;
  return PLANS[planCode];
}

export function planHasFeature(planCode: string | null | undefined, feature: PlanFeature): boolean {
  return getPlanDefinition(planCode).features.has(feature);
}

export function assertPlanFeature(planCode: string | null | undefined, feature: PlanFeature): void {
  const plan = getPlanDefinition(planCode);
  if (!plan.features.has(feature)) {
    throw new PlanAccessError(`${plan.name} does not include the ${feature} feature.`, { planCode: plan.code, requiredFeature: feature });
  }
}

/** A null plan limit means unlimited. */
export function isWithinPlanLimit(planCode: string | null | undefined, limitName: keyof PlanLimits, currentUsage: number, additionalUsage = 1): boolean {
  const plan = getPlanDefinition(planCode);
  const limit = plan.limits[limitName];

  if (limit === null) return true;
  if (!Number.isFinite(currentUsage) || !Number.isFinite(additionalUsage) || currentUsage < 0 || additionalUsage < 0) return false;

  return currentUsage + additionalUsage <= limit;
}

export function assertPlanLimit(planCode: string | null | undefined, limitName: keyof PlanLimits, currentUsage: number, additionalUsage = 1): void {
  const plan = getPlanDefinition(planCode);
  const limit = plan.limits[limitName];

  if (limit === null) return;

  if (!isWithinPlanLimit(plan.code, limitName, currentUsage, additionalUsage)) {
    throw new PlanLimitError(`${plan.name} allows a maximum of ${limit} for ${limitName}.`, { planCode: plan.code, limitName, limit });
  }
}

/** Serializable plan data for route loaders — Set values become arrays. */
export function getSerializablePlan(planCode: PlanCode) {
  const plan = PLANS[planCode];
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    yearlyPriceUsd: plan.yearlyPriceUsd,
    trialDays: plan.trialDays,
    recommended: plan.recommended,
    limits: plan.limits,
    features: Array.from(plan.features),
  };
}

export function getSerializablePlans() {
  return PLAN_CODES.map(getSerializablePlan);
}
