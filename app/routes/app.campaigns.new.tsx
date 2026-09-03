import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createCampaign, type CampaignKind } from "../models/campaign.server";
import { getShopEntitlements, requireActiveCampaignCapacity, requireCodeDiscountsAccess } from "../services/entitlements.server";
import { PlanAccessError, PlanLimitError } from "../services/plans.server";

type ActionData = { error?: string; field?: "name" | "discountCode" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const entitlements = await getShopEntitlements(session.shop);
  return { hasCodeDiscounts: entitlements.plan.features.includes("CODE_DISCOUNTS") };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);

  const formData = await request.formData();
  const name = String(formData.get("name") ?? "").trim();
  const kind = formData.get("kind") === "CODE" ? "CODE" : "AUTOMATIC";
  const discountCode = String(formData.get("discountCode") ?? "").trim();

  if (!name) {
    return { error: "Enter a name for this campaign.", field: "name" } satisfies ActionData;
  }

  if (kind === "CODE" && !discountCode) {
    return { error: "Enter a discount code, or switch to Automatic.", field: "discountCode" } satisfies ActionData;
  }

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) {
    throw new Response("Shop not found.", { status: 404 });
  }

  try {
    await requireActiveCampaignCapacity(session.shop, shop.id);
    if (kind === "CODE") await requireCodeDiscountsAccess(session.shop);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return { error: `Your plan allows up to ${error.limit} campaigns. Visit Plans to upgrade for more.` } satisfies ActionData;
    }
    if (error instanceof PlanAccessError) {
      return { error: "Discount codes require an upgrade. Visit Plans to unlock them.", field: "discountCode" } satisfies ActionData;
    }
    throw error;
  }

  const campaign = await createCampaign(shop.id, {
    name,
    kind: kind as CampaignKind,
    discountCode,
  });

  return redirect(`/app/campaigns/${campaign.id}?notice=created`);
};

export default function NewCampaign() {
  const { hasCodeDiscounts } = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const isCreating = navigation.state !== "idle";

  const [kind, setKind] = useState<CampaignKind>("AUTOMATIC");
  const [name, setName] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [discountCodeError, setDiscountCodeError] = useState<string | undefined>(undefined);

  const serverNameError = actionData?.field === "name" ? actionData.error : undefined;
  const serverDiscountCodeError = actionData?.field === "discountCode" ? actionData.error : undefined;

  return (
    <s-page heading="New campaign" inlineSize="small">
      <s-link slot="breadcrumb-actions" href="/app/campaigns">
        Campaigns
      </s-link>

      <Form
        method="post"
        onSubmit={(event) => {
          if (!name.trim()) {
            event.preventDefault();
            setNameError("Enter a name for this campaign.");
            return;
          }
          if (kind === "CODE" && !discountCode.trim()) {
            event.preventDefault();
            setDiscountCodeError("Enter a discount code, or switch to Automatic.");
          }
        }}
      >
        <s-section heading="Campaign details">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Internal name"
              name="name"
              required
              placeholder="Summer VIP promotion"
              value={name}
              error={nameError ?? serverNameError}
              onInput={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                setName(target?.value ?? "");
                setNameError(undefined);
              }}
            />

            <s-select
              label="Type"
              name="kind"
              value={kind}
              onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                setKind(target?.value === "CODE" ? "CODE" : "AUTOMATIC");
              }}
            >
              <s-option value="AUTOMATIC">Automatic</s-option>
              <s-option value="CODE" disabled={!hasCodeDiscounts}>
                {hasCodeDiscounts ? "Code" : "Code (upgrade required)"}
              </s-option>
            </s-select>

            {kind === "CODE" && (
              <s-text-field
                label="Discount code"
                name="discountCode"
                placeholder="SUMMER15"
                value={discountCode}
                error={discountCodeError ?? serverDiscountCodeError}
                onInput={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                  const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                  setDiscountCode(target?.value ?? "");
                  setDiscountCodeError(undefined);
                }}
              />
            )}

            <s-button variant="primary" type="submit" loading={isCreating} disabled={isCreating}>
              Create campaign
            </s-button>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
