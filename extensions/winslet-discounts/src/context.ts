/**
 * Builds the ConditionContext objects the shared evaluator
 * (condition-engine.ts) checks a compiled campaign against. Shared
 * between both run targets since they query structurally identical
 * cart/line shapes (see the two .graphql input query files).
 */

import type { ConditionContext } from "./condition-engine";
import { RESOLVED_PRODUCT_IDS_FIELD } from "./compiled-campaign";

export interface ContextCartLine {
  id: string;
  quantity: number;
  cost: { subtotalAmount: { amount: string } };
  merchandise:
    | { __typename: "CustomProduct" }
    | {
        __typename: "ProductVariant";
        id: string;
        sku?: string | null;
        weight?: number | null;
        product: { id: string; vendor?: string | null; productType?: string | null };
      };
}

export interface ContextBuyerIdentity {
  isAuthenticated: boolean;
  customer?: {
    id: string;
    numberOfOrders: number;
    amountSpent: { amount: string };
    buyerDataMetafield?: { value: string } | null;
  } | null;
}

export interface ContextCart {
  cost: { subtotalAmount: { amount: string; currencyCode: string } };
  buyerIdentity?: ContextBuyerIdentity | null;
  lines: ContextCartLine[];
}

export interface ContextLocalization {
  country: { isoCode: string };
  // Only fetched by cart_lines_discounts_generate_run.graphql, not the
  // delivery-options query — see buildCartContext's own comment.
  language?: { isoCode: string };
}

export interface BuyerData {
  tags: string[];
  usage: Record<string, number>;
}

/**
 * Parses the buyer's own "$app"/"buyer_data" metafield: their tags
 * (mirrored by webhooks.customers.update.tsx, not read via
 * Customer.hasAnyTag — that only supports a static tag list fixed at
 * query-authoring time, the same constraint that drove
 * product.tag/collection.id resolution) plus a JSON map of
 * campaignId -> how many times THIS buyer has used that campaign
 * (updated by order-processing.server.ts after each completed order).
 * Both live in ONE metafield rather than two — each additional
 * metafield a Function's input query fetches counts against Shopify's
 * 30-point query-complexity budget, and this app was already at that
 * ceiling. Malformed/missing values fall back to empty rather than
 * throwing — one bad metafield must only cost this buyer their
 * tag/usage matching, never crash the whole Function.
 *
 * Being on the CUSTOMER (not any one discount node) is also what
 * makes campaign usage the one piece of cross-campaign data every
 * Function invocation CAN read live for every candidate, self and
 * siblings alike — unlike total usage count, which only exists on
 * each campaign's own discount node and so can only be read live for
 * self (see compiled-campaign.ts's CompiledSiblingCampaign.usageCountAsOfPublish).
 */
export function parseBuyerData(value: string | null | undefined): BuyerData {
  if (!value) return { tags: [], usage: {} };

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { tags: [], usage: {} };

    const record = parsed as Record<string, unknown>;
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const usage: Record<string, number> = {};
    if (typeof record.usage === "object" && record.usage !== null && !Array.isArray(record.usage)) {
      for (const [key, entry] of Object.entries(record.usage as Record<string, unknown>)) {
        if (typeof entry === "number") usage[key] = entry;
      }
    }

    return { tags, usage };
  } catch {
    return { tags: [], usage: {} };
  }
}

/**
 * Cart-level fields available to every line's context: cart.subtotal,
 * cart.quantity, cart.totalWeight, currency.code, market.countryCode,
 * customer.loggedIn, customer.tag, customer.totalSpent,
 * customer.orderCount, and market.languageCode where available.
 * Country/language come from input.localization, not
 * input.localization.market — that field is deprecated and headed for
 * removal (see campaign-compiler.server.ts's module comment on
 * market.id resolution for the full rationale).
 *
 * market.languageCode is fetched by cart_lines_discounts_generate_run
 * (product/order campaigns) but NOT by cart_delivery_options_
 * discounts_generate_run (shipping campaigns) — that query already
 * carries extra fields (deliveryGroups/deliveryOptions) pushing it
 * closer to Shopify's 30-point Function query-complexity budget, and
 * language was the lowest-value field to drop from just that one
 * target. A shipping campaign's conditions simply can't reference
 * market.languageCode as a result — context[field] resolves to
 * undefined there, which evaluateCondition already treats as a clean
 * non-match rather than an error (see campaign-types.ts).
 */
export function buildCartContext(cart: ContextCart, localization: ContextLocalization): ConditionContext {
  const quantity = cart.lines.reduce((sum, line) => sum + line.quantity, 0);

  const totalWeight = cart.lines.reduce((sum, line) => {
    if (line.merchandise.__typename !== "ProductVariant") return sum;
    return sum + (line.merchandise.weight ?? 0) * line.quantity;
  }, 0);

  const customer = cart.buyerIdentity?.customer;
  const buyerData = parseBuyerData(customer?.buyerDataMetafield?.value);

  return {
    "cart.subtotal": Number(cart.cost.subtotalAmount.amount),
    "cart.quantity": quantity,
    "cart.totalWeight": totalWeight,
    "currency.code": cart.cost.subtotalAmount.currencyCode,
    "market.countryCode": localization.country.isoCode,
    ...(localization.language ? { "market.languageCode": localization.language.isoCode } : {}),
    "customer.loggedIn": Boolean(cart.buyerIdentity?.isAuthenticated),
    "customer.tag": buyerData.tags,
    "customer.totalSpent": customer ? Number(customer.amountSpent.amount) : 0,
    "customer.orderCount": customer ? customer.numberOfOrders : 0,
  };
}

/**
 * Per-line context: cart-level fields plus this line's own product
 * fields. `_resolvedProductIds` is set to the line's own product GID —
 * a condition that resolved a product.tag/collection.id at publish
 * time into an in/not_in check against a list of GIDs (see
 * app/services/campaign-compiler.server.ts) is satisfied exactly when
 * THIS line's product id appears in that list, so a plain field lookup
 * is all evaluateConditionNode needs — no special-casing here.
 *
 * Returns null for a custom/manual cart line (no product behind it —
 * nothing to match against), which the caller filters out.
 */
export function buildLineContext(line: ContextCartLine, cartContext: ConditionContext): ConditionContext | null {
  if (line.merchandise.__typename !== "ProductVariant") return null;

  return {
    ...cartContext,
    "product.id": line.merchandise.product.id,
    "variant.id": line.merchandise.id,
    "product.vendor": line.merchandise.product.vendor ?? "",
    "product.type": line.merchandise.product.productType ?? "",
    "variant.sku": line.merchandise.sku ?? "",
    [RESOLVED_PRODUCT_IDS_FIELD]: line.merchandise.product.id,
  };
}

export function lineSubtotal(line: ContextCartLine): number {
  return Number(line.cost.subtotalAmount.amount);
}
