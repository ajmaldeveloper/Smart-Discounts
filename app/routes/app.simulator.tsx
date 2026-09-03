import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { runSimulation, type SimulatorScenario, type SimulatorResult } from "../services/simulator.server";

type ActionData = { error: string } | { result: SimulatorResult };

function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberField(value: FormDataEntryValue | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) return { error: "Shop not found." } satisfies ActionData;

  const scenario: SimulatorScenario = {
    countryCode: String(formData.get("countryCode") ?? "US"),
    languageCode: String(formData.get("languageCode") ?? "EN"),
    currencyCode: String(formData.get("currencyCode") ?? "USD"),
    customerLoggedIn: formData.get("customerLoggedIn") === "true",
    customerTags: splitList(formData.get("customerTags")),
    customerTotalSpent: numberField(formData.get("customerTotalSpent")),
    customerOrderCount: numberField(formData.get("customerOrderCount")),
    cartSubtotal: numberField(formData.get("cartSubtotal")),
    cartQuantity: numberField(formData.get("cartQuantity")),
    cartTotalWeight: numberField(formData.get("cartTotalWeight")),
    productVendor: String(formData.get("productVendor") ?? ""),
    productType: String(formData.get("productType") ?? ""),
    productTags: splitList(formData.get("productTags")),
    variantSku: String(formData.get("variantSku") ?? ""),
    productIds: splitList(formData.get("productIds")),
    variantIds: splitList(formData.get("variantIds")),
    collectionIds: splitList(formData.get("collectionIds")),
    marketIds: splitList(formData.get("marketIds")),
  };

  const result = await runSimulation(shop.id, scenario);
  return { result } satisfies ActionData;
};

export default function Simulator() {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const isRunning = navigation.state !== "idle";

  const [customerLoggedIn, setCustomerLoggedIn] = useState(false);

  const result = actionData && "result" in actionData ? actionData.result : null;
  const error = actionData && "error" in actionData ? actionData.error : null;

  const run = (form: HTMLFormElement) => {
    const data = new FormData(form);
    data.set("customerLoggedIn", customerLoggedIn ? "true" : "false");
    submit(data, { method: "post" });
  };

  return (
    <s-page heading="Promotion Simulator">
      <s-section heading="Scenario">
        <s-paragraph>
          Describe a hypothetical checkout and see exactly which campaigns
          would apply, why, and what the final outcome would be — run
          against the exact same evaluation logic checkout uses.
        </s-paragraph>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(event.currentTarget);
          }}
        >
          <s-stack direction="block" gap="base">
            <s-box borderWidth="base" borderRadius="base" padding="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Location</s-text>
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="small">
                  <s-text-field label="Country code" name="countryCode" placeholder="US" defaultValue="US" />
                  <s-text-field label="Language code" name="languageCode" placeholder="EN" defaultValue="EN" />
                  <s-text-field label="Currency code" name="currencyCode" placeholder="USD" defaultValue="USD" />
                </s-grid>
              </s-stack>
            </s-box>

            <s-box borderWidth="base" borderRadius="base" padding="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Customer</s-text>
                <s-checkbox
                  label="Logged in"
                  checked={customerLoggedIn}
                  onChange={(event: { target: EventTarget | null }) => {
                    const target = event.target as { checked?: boolean } | null;
                    setCustomerLoggedIn(Boolean(target?.checked));
                  }}
                />
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="small">
                  <s-text-field label="Customer tags" name="customerTags" placeholder="VIP, Wholesale" />
                  <s-number-field label="Lifetime spend" name="customerTotalSpent" min={0} defaultValue="0" />
                  <s-number-field label="Order count" name="customerOrderCount" min={0} defaultValue="0" />
                </s-grid>
              </s-stack>
            </s-box>

            <s-box borderWidth="base" borderRadius="base" padding="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Cart</s-text>
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="small">
                  <s-number-field label="Subtotal" name="cartSubtotal" min={0} defaultValue="100" />
                  <s-number-field label="Quantity" name="cartQuantity" min={0} defaultValue="1" />
                  <s-number-field label="Total weight" name="cartTotalWeight" min={0} defaultValue="0" />
                </s-grid>
              </s-stack>
            </s-box>

            <s-box borderWidth="base" borderRadius="base" padding="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Product</s-text>
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="small">
                  <s-text-field label="Vendor" name="productVendor" />
                  <s-text-field label="Type" name="productType" />
                  <s-text-field label="SKU" name="variantSku" />
                </s-grid>
                <s-text-field label="Product tags" name="productTags" placeholder="Summer, Sale" />
              </s-stack>
            </s-box>

            <s-box>
              <s-button variant="primary" type="submit" loading={isRunning} disabled={isRunning}>
                Run simulation
              </s-button>
            </s-box>
          </s-stack>
        </form>
      </s-section>

      {error && (
        <s-section heading="Error">
          <s-text tone="critical">{error}</s-text>
        </s-section>
      )}

      {result && (
        <s-section heading="Results">
          <s-stack direction="block" gap="base">
            <s-box borderWidth="base" borderRadius="base" padding="base">
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">Total savings</s-text>
                <s-heading>${result.totalSavings.toFixed(2)}</s-heading>
                <s-text color="subdued">
                  Product: ${result.totalProductDiscount.toFixed(2)} · Order: ${result.totalOrderDiscount.toFixed(2)}
                </s-text>
              </s-stack>
            </s-box>

            {result.campaigns.length === 0 ? (
              <s-paragraph>No campaigns exist yet.</s-paragraph>
            ) : (
              result.campaigns.map((campaign) => (
                <s-box key={campaign.campaignId} borderWidth="base" borderRadius="base" padding="base">
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-badge tone={campaign.matched ? "success" : "neutral"}>
                        {campaign.matched ? "Matched" : "Did not match"}
                      </s-badge>
                      <s-text>{campaign.campaignName}</s-text>
                      <s-text color="subdued">({campaign.status})</s-text>
                      {campaign.suppressedByConflict && <s-badge tone="warning">Suppressed by conflict resolution</s-badge>}
                    </s-stack>

                    {campaign.matched ? (
                      <s-text color="subdued">
                        {campaign.appliedProductAmount !== undefined &&
                          `Product discount: $${campaign.appliedProductAmount.toFixed(2)}. `}
                        {campaign.appliedOrderAmount !== undefined &&
                          `Order discount: $${campaign.appliedOrderAmount.toFixed(2)}.`}
                        {campaign.appliedProductAmount === undefined && campaign.appliedOrderAmount === undefined && "No discount configured."}
                      </s-text>
                    ) : (
                      <s-stack direction="block" gap="small">
                        <s-text color="subdued">Why not:</s-text>
                        {campaign.failingFieldSummaries.length === 0 ? (
                          <s-text color="subdued">No discount configured, or no matching conditions.</s-text>
                        ) : (
                          campaign.failingFieldSummaries.map((summary, index) => (
                            <s-text key={index} tone="critical">
                              ✕ {summary}
                            </s-text>
                          ))
                        )}
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              ))
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
