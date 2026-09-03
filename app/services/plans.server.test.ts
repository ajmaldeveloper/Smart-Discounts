import { describe, expect, it } from "vitest";
import { assertPlanFeature, assertPlanLimit, getPlanDefinition, isWithinPlanLimit, PLAN_CODES, PLANS, planHasFeature, PlanAccessError, PlanLimitError } from "./plans.server";

describe("plans.server", () => {
  it("builds all three plans from .env", () => {
    expect(PLAN_CODES).toEqual(["FREE", "GROWTH", "PRO"]);
    for (const code of PLAN_CODES) {
      expect(PLANS[code].code).toBe(code);
    }
  });

  it("Free plan has no advanced features besides Analytics, and a 5-campaign limit", () => {
    const free = getPlanDefinition("FREE");
    expect(free.limits.activeCampaigns).toBe(5);
    expect(free.features.has("TIERS")).toBe(false);
    expect(free.features.has("CODE_DISCOUNTS")).toBe(false);
    expect(free.features.has("ANALYTICS")).toBe(true);
  });

  it("Growth plan has Tiers/BOGO, codes, targeting, and analytics but not free-gift BOGO or stacking", () => {
    const growth = getPlanDefinition("GROWTH");
    expect(growth.limits.activeCampaigns).toBe(10);
    expect(growth.features.has("TIERS")).toBe(true);
    expect(growth.features.has("CODE_DISCOUNTS")).toBe(true);
    expect(growth.features.has("CUSTOMER_TARGETING")).toBe(true);
    expect(growth.features.has("ANALYTICS")).toBe(true);
    expect(growth.features.has("FREE_GIFT_BOGO")).toBe(false);
    expect(growth.features.has("STACKING")).toBe(false);
  });

  it("Pro plan is unlimited and has every feature", () => {
    const pro = getPlanDefinition("PRO");
    expect(pro.limits.activeCampaigns).toBeNull();
    expect(pro.features.has("FREE_GIFT_BOGO")).toBe(true);
    expect(pro.features.has("STACKING")).toBe(true);
    expect(pro.features.has("MINIMUM_REQUIREMENT")).toBe(true);
  });

  it("falls back to Free for an unknown/missing plan code", () => {
    expect(getPlanDefinition("NOT_A_PLAN").code).toBe("FREE");
    expect(getPlanDefinition(undefined).code).toBe("FREE");
    expect(getPlanDefinition(null).code).toBe("FREE");
  });

  it("planHasFeature and assertPlanFeature agree", () => {
    expect(planHasFeature("FREE", "TIERS")).toBe(false);
    expect(() => assertPlanFeature("FREE", "TIERS")).toThrow(PlanAccessError);
    expect(planHasFeature("GROWTH", "TIERS")).toBe(true);
    expect(() => assertPlanFeature("GROWTH", "TIERS")).not.toThrow();
  });

  it("isWithinPlanLimit and assertPlanLimit agree, with null meaning unlimited", () => {
    expect(isWithinPlanLimit("FREE", "activeCampaigns", 1, 1)).toBe(true);
    expect(isWithinPlanLimit("FREE", "activeCampaigns", 5, 1)).toBe(false);
    expect(() => assertPlanLimit("FREE", "activeCampaigns", 5, 1)).toThrow(PlanLimitError);
    expect(isWithinPlanLimit("PRO", "activeCampaigns", 10_000, 1)).toBe(true);
    expect(() => assertPlanLimit("PRO", "activeCampaigns", 10_000, 1)).not.toThrow();
  });
});
