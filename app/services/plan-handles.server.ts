import { getAppPlans, getPlanByHandle } from "../config/plans";
import { PLAN_CODES, type PlanCode } from "./plans.server";

function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

/**
 * Returns our internal plan code for a Shopify Managed Pricing plan
 * handle, resolved against the same PLAN_<CODE>_HANDLE configuration
 * every other part of the app already uses (app/config/plans.ts) — so
 * a handle change in .env can never leave this lookup silently out of
 * sync with a second, separately-configured copy.
 *
 * Unknown handles return null instead of accidentally granting access.
 */
export function getPlanCodeFromShopifyHandle(value: string | null | undefined): PlanCode | null {
  if (!value) return null;

  const matchedPlan = getPlanByHandle(getAppPlans(), value);
  if (!matchedPlan || !isPlanCode(matchedPlan.code)) return null;

  return matchedPlan.code;
}
