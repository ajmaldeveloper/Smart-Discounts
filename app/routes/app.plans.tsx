import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getAppPlans, getShopifyAppHandle, type AppPlan } from "../config/plans";
import { getFreshShopEntitlements } from "../services/entitlements.server";
import { getShopifyPricingUrl } from "../services/shopify-pricing.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const entitlements = await getFreshShopEntitlements(admin, session.shop);
  const plans = getAppPlans();

  return {
    plans,
    currentPlanCode: entitlements.effectivePlanCode,
    currentPlanName: entitlements.plan.name,
    planStatus: entitlements.storedPlanStatus,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "manage-plans") {
    return Response.json({ error: "Unsupported plans action." }, { status: 400 });
  }

  const requestedPlanCode = formData.get("planCode");
  const plans = getAppPlans();
  if (typeof requestedPlanCode !== "string" || !plans.some((plan) => plan.code === requestedPlanCode)) {
    return Response.json({ error: "The selected plan is invalid." }, { status: 400 });
  }

  const pricingUrl = getShopifyPricingUrl({ shopDomain: session.shop, appHandle: getShopifyAppHandle() });
  return redirect(pricingUrl, { target: "_top" });
};

type BillingPeriod = "monthly" | "yearly";

/** Only shown when true for that plan — a plan with no yearly price (Free) or a non-cheaper yearly price never gets a "Save X%" badge. */
function getYearlySavingsPercent(plan: AppPlan): number | null {
  if (plan.monthlyPrice <= 0 || plan.yearlyPrice === null || plan.yearlyPrice <= 0) return null;
  const savingsRatio = 1 - plan.yearlyPrice / (plan.monthlyPrice * 12);
  return savingsRatio > 0 ? Math.round(savingsRatio * 100) : null;
}

/** Human-readable feature lines per plan, built from the same limits.* booleans plans.server.ts enforces — never a separately-maintained copy. */
function getFeatureLines(plan: AppPlan): string[] {
  const lines: string[] = [plan.limits.activeCampaigns === null ? "Unlimited campaigns" : `Up to ${plan.limits.activeCampaigns} campaigns`];

  if (plan.limits.tiers) lines.push("Tiers and Buy X, get Y free");
  if (plan.limits.freeGiftBogo) lines.push("Free-gift BOGO (a different product)");
  if (plan.limits.codeDiscounts) lines.push("Discount codes");
  if (plan.limits.customerTargeting) lines.push("Customer targeting");
  if (plan.limits.productTargeting) lines.push("Product targeting");
  if (plan.limits.marketTargeting) lines.push("Market targeting");
  if (plan.limits.minimumRequirement) lines.push("Minimum purchase/quantity requirement");
  if (plan.limits.stacking) lines.push("Stacking priority and exclusivity");
  if (plan.limits.analytics) lines.push("Analytics");

  return lines;
}

function formatPrice(price: number): string {
  if (price === 0) return "$0";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
}

export default function PlansRoute() {
  const { plans, currentPlanCode, planStatus } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submittedPlanCode = navigation.formData?.get("planCode");
  const isChoosingPlan = navigation.state === "submitting" && navigation.formData?.get("intent") === "manage-plans";

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("monthly");
  const anyPlanSupportsYearly = plans.some((plan) => plan.yearlyPrice !== null && plan.yearlyPrice > 0);

  return (
    <s-page heading="Plans" inlineSize="large">
      {planStatus !== "ACTIVE" ? (
        <s-banner tone="warning">
          Your current billing status is {planStatus.toLowerCase()}. Open Shopify pricing to confirm or update your subscription.
        </s-banner>
      ) : null}

      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small">
          {anyPlanSupportsYearly ? (
            <s-stack direction="inline" gap="none" justifyContent="center">
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  background: "rgba(0, 0, 0, 0.06)",
                  borderRadius: "100px",
                  padding: "2px",
                  gap: "2px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setBillingPeriod("monthly")}
                  style={{
                    appearance: "none",
                    border: "none",
                    cursor: "pointer",
                    borderRadius: "100px",
                    padding: "6px 16px",
                    fontSize: "13px",
                    fontFamily: "inherit",
                    lineHeight: "1.4",
                    background: billingPeriod === "monthly" ? "#ffffff" : "transparent",
                    color: billingPeriod === "monthly" ? "#1a1a1a" : "#6b6f76",
                    fontWeight: billingPeriod === "monthly" ? 600 : 400,
                    boxShadow: billingPeriod === "monthly" ? "0 1px 2px rgba(0, 0, 0, 0.12)" : "none",
                  }}
                >
                  Pay monthly
                </button>
                <button
                  type="button"
                  onClick={() => setBillingPeriod("yearly")}
                  style={{
                    appearance: "none",
                    border: "none",
                    cursor: "pointer",
                    borderRadius: "100px",
                    padding: "6px 16px",
                    fontSize: "13px",
                    fontFamily: "inherit",
                    lineHeight: "1.4",
                    background: billingPeriod === "yearly" ? "#ffffff" : "transparent",
                    color: billingPeriod === "yearly" ? "#1a1a1a" : "#6b6f76",
                    fontWeight: billingPeriod === "yearly" ? 600 : 400,
                    boxShadow: billingPeriod === "yearly" ? "0 1px 2px rgba(0, 0, 0, 0.12)" : "none",
                  }}
                >
                  Pay yearly
                </button>
              </div>
            </s-stack>
          ) : null}

          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))" gap="small">
            {plans.map((plan) => {
              const isCurrentPlan = plan.code === currentPlanCode;
              const isThisPlanSubmitting = isChoosingPlan && submittedPlanCode === plan.code;
              const planSupportsYearly = plan.yearlyPrice !== null && plan.yearlyPrice > 0;
              const usesYearly = planSupportsYearly && billingPeriod === "yearly";
              const displayedMonthlyPrice = usesYearly ? (plan.yearlyPrice as number) / 12 : plan.monthlyPrice;
              const savingsPercent = planSupportsYearly ? getYearlySavingsPercent(plan) : null;

              return (
                <div key={plan.code} style={{ position: "relative", height: "100%" }}>
                  {plan.recommended ? (
                    <div style={{ position: "absolute", insetBlockStart: "-11px", insetInlineEnd: "20px", zIndex: 1 }}>
                      <s-badge tone="info">Recommended</s-badge>
                    </div>
                  ) : null}

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                      background: "var(--p-color-bg-surface, #ffffff)",
                      borderRadius: "12px",
                      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)",
                      overflow: "hidden",
                    }}
                  >
                    <div style={{ flex: "1 0 auto" }}>
                      <s-box padding="large">
                        <s-stack direction="block" gap="base">
                          <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="start">
                            <s-stack direction="block" gap="small-200">
                              <s-text color="subdued">{plan.name}</s-text>
                              <s-heading>{formatPrice(displayedMonthlyPrice)}</s-heading>
                            </s-stack>
                            {isCurrentPlan ? <s-badge tone="success">Current</s-badge> : null}
                          </s-grid>

                          <s-stack direction="block" gap="small-200">
                            <s-text tone="neutral">
                              {plan.monthlyPrice === 0 ? "forever" : usesYearly ? "per month, billed yearly" : "per month"}
                            </s-text>
                            {usesYearly ? (
                              <s-text tone="neutral">Billed {formatPrice(plan.yearlyPrice as number)} per year</s-text>
                            ) : planSupportsYearly && savingsPercent !== null ? (
                              <s-text tone="success">
                                or {formatPrice(plan.yearlyPrice as number)}/year and save {savingsPercent}%
                              </s-text>
                            ) : null}
                          </s-stack>

                          <s-stack direction="block" gap="small">
                            <s-text type="strong">Features</s-text>
                            <s-stack direction="block" gap="small-200">
                              {getFeatureLines(plan).map((line) => (
                                <s-stack key={line} direction="inline" gap="small-200" alignItems="start">
                                  <s-icon type="check" tone="success" />
                                  <s-text>{line}</s-text>
                                </s-stack>
                              ))}
                            </s-stack>
                          </s-stack>

                          {isCurrentPlan ? (
                            <s-button variant="secondary" disabled>
                              Selected
                            </s-button>
                          ) : (
                            <Form method="post">
                              <input type="hidden" name="intent" value="manage-plans" />
                              <input type="hidden" name="planCode" value={plan.code} />
                              <s-button type="submit" variant="primary" loading={isThisPlanSubmitting}>
                                {`Choose ${plan.name}`}
                              </s-button>
                            </Form>
                          )}
                        </s-stack>
                      </s-box>
                    </div>

                    {plan.trialDays > 0 ? (
                      <s-box background="subdued" padding="base">
                        <s-text color="subdued">{plan.trialDays}-day free trial</s-text>
                      </s-box>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </s-grid>
        </s-stack>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
