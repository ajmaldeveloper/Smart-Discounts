/**
 * The registry of condition fields available to the generic Conditions
 * tab's Add/Edit condition modal — what a merchant can pick in a
 * WHAT/WHEN/CONDITIONS row, and which operators + value shape apply to
 * each. Keyed by the same namespaced strings evaluateConditionNode()
 * reads out of a ConditionContext (see app/lib/campaign-types.ts), so
 * adding a field here is the only step needed to make it selectable —
 * the evaluator itself never changes.
 *
 * Deliberately excludes any field with its own dedicated tab —
 * product.id/collection.id/product.tag (Products tab), market.id/
 * market.countryCode (Markets tab), and every customer.* field
 * (Customers/AudienceEditor tab). Those tabs write into the exact same
 * underlying condition tree, just a specific managed subgroup within
 * it (see AUDIENCE_GROUP_ID/PRODUCTS_GROUP_ID/MARKETS_GROUP_ID in
 * app.campaigns.$id.tsx) — surfacing the same field here too would let
 * a merchant configure the same targeting twice through two different,
 * unsynchronized UIs. What remains here is either genuinely unmanaged
 * anywhere else (variant.id, product.vendor, product.type,
 * variant.sku, cart.*, currency.code, market.languageCode) or a raw
 * escape hatch the dedicated tab's own comment already points back to.
 */

import type { ConditionOperator } from "./campaign-types";

export type ConditionFieldValueType =
  | "text"
  | "number"
  | "select"
  | "multi-select"
  | "resource-list";

export type ConditionFieldCategory = "product" | "cart" | "currency" | "market";

export interface ConditionFieldDefinition {
  field: string;
  label: string;
  category: ConditionFieldCategory;
  valueType: ConditionFieldValueType;
  operators: readonly ConditionOperator[];
  // Set on resource-backed fields (products/variants/collections) —
  // tells the builder UI which Shopify resource picker to open, and
  // tells shopify-resources.server.ts's hydrate functions which query
  // to run when redisplaying an already-selected value.
  resourceType?: "product" | "variant" | "collection" | "market";
  helpText?: string;
  // Shown as the Value field's placeholder in ConditionsEditor.tsx's
  // Add/Edit condition modal — the ONLY place a merchant learns what
  // format this field actually expects, since the field is always a
  // plain text input here regardless of valueType (no per-type widget
  // switching). Write it exactly as it should appear, "e.g. ..." and
  // all; ConditionsEditor falls back to a generic placeholder only
  // when this is unset.
  placeholder?: string;
}

const RESOURCE_OPERATORS: readonly ConditionOperator[] = ["in", "not_in"];
const SET_MEMBERSHIP_OPERATORS: readonly ConditionOperator[] = [
  "in",
  "not_in",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
];
const EXACT_TEXT_OPERATORS: readonly ConditionOperator[] = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
];
const PARTIAL_TEXT_OPERATORS: readonly ConditionOperator[] = [
  ...EXACT_TEXT_OPERATORS,
  "contains",
  "not_contains",
];
const NUMERIC_OPERATORS: readonly ConditionOperator[] = [
  "equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "between",
];

export const CONDITION_FIELDS: ConditionFieldDefinition[] = [
  {
    field: "variant.id",
    label: "Specific variant",
    category: "product",
    valueType: "resource-list",
    resourceType: "variant",
    operators: RESOURCE_OPERATORS,
    placeholder: "e.g. gid://shopify/ProductVariant/123456789",
    helpText: "Comma-separated Shopify variant GIDs, found in the variant's admin URL.",
  },
  {
    field: "product.vendor",
    label: "Vendor",
    category: "product",
    valueType: "select",
    operators: EXACT_TEXT_OPERATORS,
    placeholder: "e.g. Acme Co",
    helpText: "Match against the product's Vendor field exactly as set in Shopify, e.g. Acme Co. Not case-sensitive.",
  },
  {
    field: "product.type",
    label: "Product type",
    category: "product",
    valueType: "select",
    operators: EXACT_TEXT_OPERATORS,
    placeholder: "e.g. Snowboard",
    helpText: "Match against the product's Type field exactly as set in Shopify, e.g. Snowboard. Not case-sensitive.",
  },
  {
    field: "variant.sku",
    label: "SKU",
    category: "product",
    valueType: "text",
    operators: PARTIAL_TEXT_OPERATORS,
    placeholder: "e.g. SHIRT-RED-M",
    helpText: "Matches part or all of the variant's SKU, e.g. SHIRT-RED-M. Not case-sensitive.",
  },
  {
    field: "cart.subtotal",
    label: "Cart subtotal",
    category: "cart",
    valueType: "number",
    operators: NUMERIC_OPERATORS,
    placeholder: "e.g. 100",
  },
  {
    field: "cart.quantity",
    label: "Cart quantity",
    category: "cart",
    valueType: "number",
    operators: NUMERIC_OPERATORS,
    placeholder: "e.g. 3",
  },
  {
    field: "cart.totalWeight",
    label: "Cart weight",
    category: "cart",
    valueType: "number",
    operators: NUMERIC_OPERATORS,
    placeholder: "e.g. 5",
  },
  {
    field: "currency.code",
    label: "Currency",
    category: "currency",
    valueType: "select",
    operators: EXACT_TEXT_OPERATORS,
    placeholder: "e.g. USD",
    helpText: "ISO currency code, e.g. USD, EUR, GBP. Not case-sensitive.",
  },
  {
    field: "market.languageCode",
    label: "Buyer language",
    category: "market",
    valueType: "multi-select",
    operators: SET_MEMBERSHIP_OPERATORS,
    placeholder: "e.g. en, fr, de",
    helpText:
      "ISO language code, e.g. en, fr, de. Not case-sensitive. Not evaluable in a shipping-only campaign — dropped from that query to stay under Shopify's Function complexity budget (see extensions/winslet-discounts/src/context.ts).",
  },
];

/**
 * Product metafield conditions don't get one static registry entry —
 * a merchant picks a namespace + key at build time, which then becomes
 * a concrete condition field string following this convention (e.g.
 * "product.metafield:custom.material"). The condition engine already
 * evaluates any field string against whatever ConditionContext the
 * caller supplies, so no evaluator change is needed once the M3/M9
 * picker UI composes keys this way — only the UI and the context
 * builder (M4) need to know this convention.
 */
export const PRODUCT_METAFIELD_FIELD_PREFIX = "product.metafield:";

export function buildProductMetafieldField(namespace: string, key: string): string {
  return `${PRODUCT_METAFIELD_FIELD_PREFIX}${namespace}.${key}`;
}

const FIELD_INDEX = new Map(CONDITION_FIELDS.map((def) => [def.field, def]));

export function getConditionField(field: string): ConditionFieldDefinition | undefined {
  if (field.startsWith(PRODUCT_METAFIELD_FIELD_PREFIX)) {
    return {
      field,
      label: "Product metafield",
      category: "product",
      valueType: "text",
      operators: PARTIAL_TEXT_OPERATORS,
    };
  }

  return FIELD_INDEX.get(field);
}

export function operatorsForField(field: string): readonly ConditionOperator[] {
  return getConditionField(field)?.operators ?? [];
}
