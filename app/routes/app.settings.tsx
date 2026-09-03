import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { ConflictStrategy } from "../lib/conflict-resolution";

type ActionData = { error?: string; notice?: string };
type CapType = "PERCENTAGE" | "FIXED_AMOUNT";

const CONFLICT_STRATEGIES: ConflictStrategy[] = ["HIGHEST_DISCOUNT", "LOWEST_DISCOUNT", "STACK"];
const CAP_TYPES: CapType[] = ["PERCENTAGE", "FIXED_AMOUNT"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });

  return {
    conflictStrategy: (shop?.conflictStrategy as ConflictStrategy) ?? "HIGHEST_DISCOUNT",
    maxTotalDiscountType: (shop?.maxTotalDiscountType as CapType) ?? "PERCENTAGE",
    maxTotalDiscountPercent: shop?.maxTotalDiscountPercent ?? null,
    maxTotalDiscountAmount: shop?.maxTotalDiscountAmount ?? null,
    currencyCode: shop?.currencyCode ?? "USD",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const strategy = String(formData.get("conflictStrategy") ?? "");
  const capType = String(formData.get("maxTotalDiscountType") ?? "");
  const capRaw = String(formData.get("maxTotalDiscountValue") ?? "").trim();

  if (!CONFLICT_STRATEGIES.includes(strategy as ConflictStrategy)) {
    return { error: "Choose a valid conflict resolution strategy." } satisfies ActionData;
  }
  if (!CAP_TYPES.includes(capType as CapType)) {
    return { error: "Choose a valid cap type." } satisfies ActionData;
  }

  let maxTotalDiscountPercent: number | null = null;
  let maxTotalDiscountAmount: number | null = null;

  if (capRaw) {
    const parsed = Number(capRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: "Maximum total discount must be a positive number." } satisfies ActionData;
    }

    if (capType === "PERCENTAGE") {
      if (parsed > 100) {
        return { error: "Maximum total discount must be a percent between 0 and 100." } satisfies ActionData;
      }
      maxTotalDiscountPercent = parsed;
    } else {
      maxTotalDiscountAmount = parsed;
    }
  }

  await db.shop.update({
    where: { domain: session.shop },
    data: {
      conflictStrategy: strategy,
      maxTotalDiscountType: capType,
      maxTotalDiscountPercent,
      maxTotalDiscountAmount,
      // Lets already-published campaigns know their baked-in cap/
      // strategy is now stale — see the schema field's own comment.
      conflictSettingsUpdatedAt: new Date(),
    },
  });

  return { notice: "Conflict resolution settings saved." } satisfies ActionData;
};

export default function Settings() {
  const { conflictStrategy, maxTotalDiscountType, maxTotalDiscountPercent, maxTotalDiscountAmount, currencyCode } =
    useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const originalCap = maxTotalDiscountType === "PERCENTAGE" ? maxTotalDiscountPercent : maxTotalDiscountAmount;
  const originalCapText = originalCap !== null ? String(originalCap) : "";

  const [strategy, setStrategy] = useState<ConflictStrategy>(conflictStrategy);
  const [capType, setCapType] = useState<CapType>(maxTotalDiscountType);
  const [cap, setCap] = useState(originalCapText);

  // Switching cap type is a different measurement, not an edit of the
  // same value (e.g. "50" as a percent vs. "50" as a flat $50 mean
  // very different things) — clear the field instead of carrying the
  // old number over into the new unit.
  const changeCapType = (next: CapType) => {
    setCapType(next);
    setCap(next === maxTotalDiscountType ? originalCapText : "");
  };

  useEffect(() => {
    if (!actionData) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
  }, [actionData, shopify]);

  const isSaving = navigation.state !== "idle";
  const isDirty = strategy !== conflictStrategy || capType !== maxTotalDiscountType || cap !== originalCapText;

  return (
    <s-page heading="Settings" inlineSize="small">
      <s-section heading="When discounts overlap">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Default behavior when a shopper qualifies for more than one
            discount. Mark a campaign &quot;Exclusive&quot; (Stacking tab) to
            always let it win alone instead.
          </s-paragraph>

          <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
            <s-stack direction="block" gap="base">
              <s-select
                label="When multiple discounts match"
                value={strategy}
                onChange={(event: { target: EventTarget | null }) => {
                  const target = event.target as { value?: string } | null;
                  setStrategy((target?.value as ConflictStrategy) ?? "HIGHEST_DISCOUNT");
                }}
              >
                <s-option value="HIGHEST_DISCOUNT">Apply only the best discount</s-option>
                <s-option value="LOWEST_DISCOUNT">Apply only the smallest discount</s-option>
                <s-option value="STACK">Apply all matching discounts</s-option>
              </s-select>

              <s-text color="subdued">
                Maximum discount allowed (optional) — applies globally, across every campaign in this shop.
              </s-text>

              <s-grid gridTemplateColumns="140px 1fr" gap="small" alignItems="start">
                <s-select
                  label="Cap type"
                  value={capType}
                  onChange={(event: { target: EventTarget | null }) => {
                    const target = event.target as { value?: string } | null;
                    changeCapType((target?.value as CapType) ?? "PERCENTAGE");
                  }}
                >
                  <s-option value="PERCENTAGE">Percentage</s-option>
                  <s-option value="FIXED_AMOUNT">Fixed amount</s-option>
                </s-select>

                <s-number-field
                  label={capType === "PERCENTAGE" ? "Maximum percent of cart subtotal" : "Maximum amount"}
                  details={
                    capType === "PERCENTAGE"
                      ? "The most a customer's order can ever be discounted, as a share of the cart subtotal. Leave blank for no limit."
                      : "The most a customer's order can ever be discounted, as a flat amount. Leave blank for no limit."
                  }
                  prefix={capType === "PERCENTAGE" ? "%" : currencyCode}
                  min={0}
                  max={capType === "PERCENTAGE" ? 100 : undefined}
                  value={cap}
                  onInput={(event: { target: EventTarget | null }) => {
                    const target = event.target as { value?: string } | null;
                    setCap(target?.value ?? "");
                  }}
                />
              </s-grid>

              <s-box background="subdued" borderWidth="base" borderColor="subdued" borderRadius="base" padding="small">
                <s-stack direction="inline" gap="small-200" alignItems="start">
                  <s-icon type="info" tone="neutral" />
                  <s-text color="subdued">
                    Applies separately to <s-text type="strong">product</s-text> discounts and{" "}
                    <s-text type="strong">order</s-text> discounts — each is capped on its own, so a product discount and an
                    order discount active at once can each reach this limit rather than sharing it. Free{" "}
                    <s-text type="strong">shipping</s-text> discounts are never capped by this setting.
                  </s-text>
                </s-stack>
              </s-box>
            </s-stack>
          </s-box>

          <s-stack direction="inline" justifyContent="end">
            <s-button
              variant="primary"
              loading={isSaving}
              disabled={isSaving || !isDirty}
              onClick={() => {
                const data = new FormData();
                data.set("conflictStrategy", strategy);
                data.set("maxTotalDiscountType", capType);
                data.set("maxTotalDiscountValue", cap);
                submit(data, { method: "post" });
              }}
            >
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
