/**
 * Mirrors app/lib/campaign-types.ts's ConditionNode/evaluateConditionNode
 * EXACTLY. Duplicated (not imported) rather than shared across the
 * app/extension package boundary, matching wholesale-registration's own
 * documented choice to keep a Shopify Function fully self-contained
 * (extensions/wholesale-pricing-discount/src/run.ts's own comments)
 * rather than depend on the main app's build graph. Parity between the
 * two copies is enforced by app/lib/campaign-types.parity.test.ts,
 * which runs BOTH implementations against the same table of cases and
 * fails if they ever disagree — so drift here breaks the main app's
 * test suite, not just a comment nobody reads.
 *
 * Must be kept byte-for-byte semantically identical to the source of
 * truth. Any change here needs the matching change there.
 */

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "between"
  | "contains"
  | "not_contains"
  | "in"
  | "not_in"
  | "is_empty"
  | "is_not_empty";

const CONDITION_OPERATORS: readonly ConditionOperator[] = [
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
];
const OPERATOR_SET = new Set<string>(CONDITION_OPERATORS);

export type ConditionCombinator = "ALL" | "ANY";
export type ConditionValue = string | number | boolean | (string | number)[];
export type ConditionContext = Record<string, ConditionValue | undefined>;

export interface ConditionLeaf {
  id: string;
  type: "condition";
  field: string;
  operator: ConditionOperator;
  value?: ConditionValue;
  label?: string;
  // Defaults to true when absent. A disabled ("paused") condition is
  // skipped entirely by evaluateConditionNode — see the matching
  // comment in app/lib/campaign-types.ts (must stay identical between
  // the two copies; enforced by app/lib/campaign-types.parity.test.ts).
  enabled?: boolean;
}

export interface ConditionGroup {
  id: string;
  type: "group";
  combinator: ConditionCombinator;
  children: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

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

function lower(value: ConditionValue): string {
  return toComparable(value).toLowerCase();
}

// A context value that's itself an array (e.g. "customer.tag" holding
// every tag a buyer carries) needs set-overlap semantics for in/
// contains, not "does the whole joined string equal one option" — see
// app/lib/campaign-types.ts's evaluateCondition for the full rationale
// (must stay identical between the two copies; enforced by
// app/lib/campaign-types.parity.test.ts).
function toItems(value: ConditionValue | undefined): (string | number)[] | null {
  return Array.isArray(value) ? value : null;
}

function overlapsAny(actualItems: (string | number)[], options: (string | number)[]): boolean {
  return actualItems.some((item) => options.some((option) => lower(option) === lower(item)));
}

export function evaluateCondition(leaf: ConditionLeaf, context: ConditionContext): boolean {
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
      return options.some((option) => toComparable(option).toLowerCase() === toComparable(actual).toLowerCase());
    }

    case "not_in": {
      const options = Array.isArray(leaf.value) ? leaf.value : [];
      if (actualItems) return !overlapsAny(actualItems, options);
      return !options.some((option) => toComparable(option).toLowerCase() === toComparable(actual).toLowerCase());
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

export function evaluateConditionNode(node: ConditionNode, context: ConditionContext): boolean {
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

/**
 * Defensive, non-throwing normalization of whatever JSON came back out
 * of the discount node's metafield. A stale/malformed metafield must
 * degrade to "no conditions configured" (an ALL group with no
 * children, which is vacuously true — see evaluateConditionNode) rather
 * than crash the Function and break checkout for the whole store.
 */
export function normalizeConditionNode(raw: unknown, index = 0): ConditionNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  if (record.type === "group") {
    const combinator: ConditionCombinator = record.combinator === "ANY" ? "ANY" : "ALL";
    const children = (Array.isArray(record.children) ? record.children : [])
      .map((child, childIndex) => normalizeConditionNode(child, childIndex))
      .filter((child): child is ConditionNode => child !== null);

    return { id: typeof record.id === "string" ? record.id : `group-${index}`, type: "group", combinator, children };
  }

  const field = typeof record.field === "string" ? record.field.trim() : "";
  const operator = typeof record.operator === "string" ? record.operator : "";
  if (!field || !OPERATOR_SET.has(operator)) return null;

  const value = record.value as ConditionValue | undefined;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
  const enabled = record.enabled === false ? false : undefined;

  return {
    id: typeof record.id === "string" ? record.id : `condition-${index}`,
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
  return { id: "root", type: "group", combinator: "ALL", children: [] };
}
