/**
 * The generic nested-condition engine at the heart of Winslet.
 *
 * Generalizes product-options's LogicRuleConfig (a single flat
 * combinator over a list of conditions — see
 * app/lib/logic-types.ts in that app) into an actual tree: a group can
 * contain either condition leaves or further nested groups, each with
 * its own ALL/ANY combinator. That's what lets a merchant express
 * "Country = UK AND (VIP tag OR lifetime spend > 500) AND (quantity>=3
 * AND subtotal>=100)" as one structure instead of one flat list.
 *
 * `field` is a plain namespaced string ("customer.tag", "cart.subtotal")
 * rather than an enumerated union, because the set of available fields
 * grows across milestones (M2 product targeting, M5 markets, M6
 * customer intelligence, M8 shipping) and this engine must not need
 * rebuilding each time — only the context passed into evaluate() grows.
 *
 * evaluateConditionNode() is deliberately pure and dependency-free so
 * the exact same function can run in three places without ever
 * disagreeing: the admin-side live preview, the Promotion Simulator
 * (M11), and — reimplemented in AssemblyScript/Rust/JS for the Shopify
 * Function runtime (M4) — checkout itself. Keeping the reference
 * implementation here in one small, fully-tested module is what makes
 * that reimplementation checkable for parity.
 */

export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "between",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

const OPERATOR_SET = new Set<string>(CONDITION_OPERATORS);

export type ConditionCombinator = "ALL" | "ANY";

// Value shapes accepted on the right-hand side of a condition. `between`
// expects exactly a [min, max] tuple; `in`/`not_in` expect a list;
// every other operator expects a single scalar.
export type ConditionValue = string | number | boolean | (string | number)[];

// What a condition is actually checked against at evaluation time. Only
// the fields a given campaign's conditions reference need to be
// present — evaluateConditionNode treats a missing key as `undefined`,
// never throws.
export type ConditionContext = Record<string, ConditionValue | undefined>;

export interface ConditionLeaf {
  id: string;
  type: "condition";
  // Namespaced field key, e.g. "customer.tag", "cart.subtotal",
  // "market.countryCode". Registered incrementally per milestone in
  // app/lib/condition-fields.ts (added in M2/M3).
  field: string;
  operator: ConditionOperator;
  // Absent for is_empty / is_not_empty, which need no comparison value.
  value?: ConditionValue;
  // Purely cosmetic — an optional merchant-facing name shown instead of
  // the auto-generated "Field operator value" summary. Never read by
  // evaluateCondition/evaluateConditionNode; safe to ignore anywhere
  // that doesn't render it (the compiled Function config carries it
  // along unused).
  label?: string;
  // Defaults to true when absent. A disabled ("paused") condition is
  // skipped entirely by evaluateConditionNode — as if it weren't in
  // the tree at all — rather than forced to true/false, so pausing one
  // leaf of an ALL group un-blocks the rest without the merchant
  // needing to delete and later recreate it.
  enabled?: boolean;
}

export interface ConditionGroup {
  id: string;
  type: "group";
  combinator: ConditionCombinator;
  children: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeValue(raw: unknown): ConditionValue | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (Array.isArray(raw)) {
    return raw.filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number",
    );
  }

  if (
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  ) {
    return raw;
  }

  return undefined;
}

/**
 * Recursively validates and repairs an arbitrary parsed-JSON value into
 * a well-formed ConditionNode tree, dropping anything malformed rather
 * than throwing — mirrors normalizeLogicRuleConfig's forgiving parse in
 * product-options, since this always runs on data coming back out of a
 * Json database column or a form submission.
 */
export function normalizeConditionNode(
  raw: unknown,
  index = 0,
): ConditionNode | null {
  if (!isPlainObject(raw)) return null;

  if (raw.type === "group") {
    const combinator: ConditionCombinator = raw.combinator === "ANY" ? "ANY" : "ALL";

    const children = (Array.isArray(raw.children) ? raw.children : [])
      .map((child, childIndex) => normalizeConditionNode(child, childIndex))
      .filter((child): child is ConditionNode => child !== null);

    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `group-${index}`,
      type: "group",
      combinator,
      children,
    };
  }

  const field = typeof raw.field === "string" ? raw.field.trim() : "";
  const operator = typeof raw.operator === "string" ? raw.operator : "";

  if (!field || !OPERATOR_SET.has(operator)) return null;

  const value = normalizeValue(raw.value);
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
  const enabled = raw.enabled === false ? false : undefined;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `condition-${index}`,
    type: "condition",
    field,
    operator: operator as ConditionOperator,
    ...(value !== undefined ? { value } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

export function parseConditionTree(raw: unknown): ConditionGroup {
  const normalized = normalizeConditionNode(raw);

  if (normalized && normalized.type === "group") return normalized;

  return createEmptyGroup();
}

export function createEmptyGroup(combinator: ConditionCombinator = "ALL"): ConditionGroup {
  return {
    id: `group-${Math.random().toString(36).slice(2, 10)}`,
    type: "group",
    combinator,
    children: [],
  };
}

/** Finds a direct child group by id — used to locate the Audience/Products/Markets tabs' own managed subgroups (see condition-tree-edit.ts's matching editable-tree helper) so the server can hydrate whatever resource IDs they've stored. */
export function findConditionGroupById(tree: ConditionGroup, id: string): ConditionGroup | undefined {
  const found = tree.children.find((child) => child.id === id);
  return found && found.type === "group" ? found : undefined;
}

function toNumber(value: ConditionValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toComparable(value: ConditionValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function lower(value: ConditionValue | number | string): string {
  return toComparable(value as ConditionValue).toLowerCase();
}

/**
 * A context value that's itself an array (e.g. "customer.tag" holding
 * every tag a buyer carries, not just one) needs different semantics
 * from a scalar: "in"/"contains" become "does ANY of the buyer's own
 * values appear in/equal the configured list", a set-overlap check —
 * not "does the whole joined string equal one option". A scalar
 * `actual` (e.g. a single product id) keeps the plain membership
 * check. This mirrors product-options's own convention of CONTAINS
 * meaning "array includes this element" for its multi-choice fields,
 * vs. a substring check for plain text fields.
 */
function toItems(value: ConditionValue | undefined): (string | number)[] | null {
  return Array.isArray(value) ? value : null;
}

function overlapsAny(actualItems: (string | number)[], options: (string | number)[]): boolean {
  return actualItems.some((item) => options.some((option) => lower(option) === lower(item)));
}

/**
 * Evaluates one condition leaf against a context. Never throws: a
 * missing field, a type mismatch, or an unparsable number all resolve
 * to `false` rather than raising — a malformed or not-yet-applicable
 * condition must fail closed, not crash discount evaluation for every
 * other campaign.
 */
export function evaluateCondition(
  leaf: ConditionLeaf,
  context: ConditionContext,
): boolean {
  const actual = context[leaf.field];
  const actualItems = toItems(actual);

  switch (leaf.operator) {
    case "is_empty":
      return actual === undefined || actual === null || toComparable(actual) === "";

    case "is_not_empty":
      return !(actual === undefined || actual === null || toComparable(actual) === "");

    case "equals":
      return toComparable(actual).toLowerCase() === toComparable(leaf.value).toLowerCase();

    case "not_equals":
      return toComparable(actual).toLowerCase() !== toComparable(leaf.value).toLowerCase();

    case "contains":
      if (actualItems) return overlapsAny(actualItems, leaf.value !== undefined ? [leaf.value as string | number] : []);
      return toComparable(actual).toLowerCase().includes(toComparable(leaf.value).toLowerCase());

    case "not_contains":
      if (actualItems) return !overlapsAny(actualItems, leaf.value !== undefined ? [leaf.value as string | number] : []);
      return !toComparable(actual).toLowerCase().includes(toComparable(leaf.value).toLowerCase());

    case "in": {
      const options = Array.isArray(leaf.value) ? leaf.value : [];
      if (actualItems) return overlapsAny(actualItems, options);
      return options.some(
        (option) => toComparable(option).toLowerCase() === toComparable(actual).toLowerCase(),
      );
    }

    case "not_in": {
      const options = Array.isArray(leaf.value) ? leaf.value : [];
      if (actualItems) return !overlapsAny(actualItems, options);
      return !options.some(
        (option) => toComparable(option).toLowerCase() === toComparable(actual).toLowerCase(),
      );
    }

    case "greater_than":
    case "greater_than_or_equal":
    case "less_than":
    case "less_than_or_equal": {
      const left = toNumber(actual);
      const right = toNumber(leaf.value);
      if (left === null || right === null) return false;

      if (leaf.operator === "greater_than") return left > right;
      if (leaf.operator === "greater_than_or_equal") return left >= right;
      if (leaf.operator === "less_than") return left < right;
      return left <= right;
    }

    case "between": {
      const left = toNumber(actual);
      const bounds = Array.isArray(leaf.value) ? leaf.value : [];
      const min = toNumber(bounds[0]);
      const max = toNumber(bounds[1]);
      if (left === null || min === null || max === null) return false;
      return left >= min && left <= max;
    }
  }
}

/**
 * Evaluates a full condition tree. An ALL group with zero children is
 * vacuously true (an empty "must match everything" scope matches
 * everything); an ANY group with zero children is false (there is
 * nothing to match) — mirrors evaluateLogicRule's
 * `conditions.length === 0 -> false` guard in product-options, applied
 * per-group instead of once globally.
 */
export function evaluateConditionNode(
  node: ConditionNode,
  context: ConditionContext,
): boolean {
  if (node.type === "condition") {
    return evaluateCondition(node, context);
  }

  const activeChildren = node.children.filter((child) => !(child.type === "condition" && child.enabled === false));

  if (activeChildren.length === 0) {
    return node.combinator === "ALL";
  }

  return node.combinator === "ANY"
    ? activeChildren.some((child) => evaluateConditionNode(child, context))
    : activeChildren.every((child) => evaluateConditionNode(child, context));
}

export function operatorLabel(operator: ConditionOperator): string {
  const labels: Record<ConditionOperator, string> = {
    equals: "is",
    not_equals: "is not",
    greater_than: "is greater than",
    greater_than_or_equal: "is at least",
    less_than: "is less than",
    less_than_or_equal: "is at most",
    between: "is between",
    contains: "contains",
    not_contains: "does not contain",
    in: "is one of",
    not_in: "is not one of",
    is_empty: "is empty",
    is_not_empty: "is not empty",
  };

  return labels[operator];
}
