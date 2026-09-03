import { describe, expect, it } from "vitest";
import {
  createEmptyGroup,
  evaluateCondition,
  evaluateConditionNode,
  normalizeConditionNode,
  parseConditionTree,
  type ConditionContext,
  type ConditionGroup,
  type ConditionLeaf,
} from "./campaign-types";

function leaf(partial: Partial<ConditionLeaf> & Pick<ConditionLeaf, "field" | "operator">): ConditionLeaf {
  return { id: `c-${Math.random()}`, type: "condition", ...partial };
}

function group(
  combinator: ConditionGroup["combinator"],
  children: ConditionGroup["children"],
): ConditionGroup {
  return { id: `g-${Math.random()}`, type: "group", combinator, children };
}

describe("evaluateCondition", () => {
  const context: ConditionContext = {
    "customer.tag": "VIP",
    "cart.subtotal": 150,
    "cart.quantity": 3,
    "market.countryCode": "CA",
  };

  it("equals is case-insensitive", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "equals", value: "vip" }), context)).toBe(true);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "equals", value: "Gold" }), context)).toBe(false);
  });

  it("not_equals inverts equals", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_equals", value: "VIP" }), context)).toBe(false);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_equals", value: "Gold" }), context)).toBe(true);
  });

  it("numeric comparisons coerce string values", () => {
    expect(evaluateCondition(leaf({ field: "cart.subtotal", operator: "greater_than_or_equal", value: "150" }), context)).toBe(true);
    expect(evaluateCondition(leaf({ field: "cart.subtotal", operator: "greater_than", value: "150" }), context)).toBe(false);
    expect(evaluateCondition(leaf({ field: "cart.subtotal", operator: "less_than", value: 200 }), context)).toBe(true);
  });

  it("numeric comparisons fail closed on non-numeric input", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "greater_than", value: 1 }), context)).toBe(false);
  });

  it("between is inclusive on both ends", () => {
    expect(evaluateCondition(leaf({ field: "cart.subtotal", operator: "between", value: [100, 150] }), context)).toBe(true);
    expect(evaluateCondition(leaf({ field: "cart.subtotal", operator: "between", value: [151, 200] }), context)).toBe(false);
  });

  it("in / not_in match against a list case-insensitively", () => {
    expect(evaluateCondition(leaf({ field: "market.countryCode", operator: "in", value: ["US", "ca", "GB"] }), context)).toBe(true);
    expect(evaluateCondition(leaf({ field: "market.countryCode", operator: "not_in", value: ["US", "ca", "GB"] }), context)).toBe(false);
  });

  it("is_empty / is_not_empty read missing fields correctly", () => {
    expect(evaluateCondition(leaf({ field: "customer.email", operator: "is_empty" }), context)).toBe(true);
    expect(evaluateCondition(leaf({ field: "customer.email", operator: "is_not_empty" }), context)).toBe(false);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "is_not_empty" }), context)).toBe(true);
  });

  it("contains / not_contains are case-insensitive substring checks on a scalar field", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "contains", value: "vi" }), context)).toBe(true);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_contains", value: "gold" }), context)).toBe(true);
  });
});

describe("evaluateCondition — multi-valued context fields (e.g. a buyer's own tags)", () => {
  const multiTagContext: ConditionContext = { "customer.tag": ["VIP", "Newsletter"] };

  it("'in' matches if ANY of the buyer's values is in the allowed list", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "in", value: ["Gold", "VIP"] }), multiTagContext)).toBe(true);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "in", value: ["Gold", "Silver"] }), multiTagContext)).toBe(false);
  });

  it("'not_in' is the exact negation of 'in'", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_in", value: ["Gold", "VIP"] }), multiTagContext)).toBe(false);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_in", value: ["Gold", "Silver"] }), multiTagContext)).toBe(true);
  });

  it("'contains' on a multi-valued field means array membership, not substring", () => {
    // "VI" is a substring of "VIP" but not an exact tag the buyer has.
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "contains", value: "VI" }), multiTagContext)).toBe(false);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "contains", value: "vip" }), multiTagContext)).toBe(true);
  });

  it("'not_contains' on a multi-valued field is the exact negation", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_contains", value: "vip" }), multiTagContext)).toBe(false);
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "not_contains", value: "gold" }), multiTagContext)).toBe(true);
  });

  it("an empty array of buyer values never matches 'in'", () => {
    expect(evaluateCondition(leaf({ field: "customer.tag", operator: "in", value: ["VIP"] }), { "customer.tag": [] })).toBe(false);
  });
});

describe("evaluateConditionNode — nested trees", () => {
  it("matches the plan's worked example", () => {
    // ALL(country=UK, ANY(vip tag, spend>500), ALL(qty>=3, subtotal>=100))
    const tree = group("ALL", [
      leaf({ field: "market.countryCode", operator: "equals", value: "UK" }),
      group("ANY", [
        leaf({ field: "customer.tag", operator: "equals", value: "VIP" }),
        leaf({ field: "customer.lifetimeSpend", operator: "greater_than", value: 500 }),
      ]),
      group("ALL", [
        leaf({ field: "cart.quantity", operator: "greater_than_or_equal", value: 3 }),
        leaf({ field: "cart.subtotal", operator: "greater_than_or_equal", value: 100 }),
      ]),
    ]);

    const qualifyingByTag: ConditionContext = {
      "market.countryCode": "UK",
      "customer.tag": "VIP",
      "customer.lifetimeSpend": 10,
      "cart.quantity": 3,
      "cart.subtotal": 100,
    };
    expect(evaluateConditionNode(tree, qualifyingByTag)).toBe(true);

    const qualifyingBySpend: ConditionContext = {
      "market.countryCode": "UK",
      "customer.tag": "Regular",
      "customer.lifetimeSpend": 501,
      "cart.quantity": 3,
      "cart.subtotal": 100,
    };
    expect(evaluateConditionNode(tree, qualifyingBySpend)).toBe(true);

    const wrongCountry: ConditionContext = { ...qualifyingByTag, "market.countryCode": "US" };
    expect(evaluateConditionNode(tree, wrongCountry)).toBe(false);

    const neitherVipNorSpend: ConditionContext = {
      ...qualifyingByTag,
      "customer.tag": "Regular",
      "customer.lifetimeSpend": 10,
    };
    expect(evaluateConditionNode(tree, neitherVipNorSpend)).toBe(false);

    const underQuantity: ConditionContext = { ...qualifyingByTag, "cart.quantity": 2 };
    expect(evaluateConditionNode(tree, underQuantity)).toBe(false);
  });

  it("an empty ALL group is vacuously true", () => {
    expect(evaluateConditionNode(createEmptyGroup("ALL"), {})).toBe(true);
  });

  it("an empty ANY group is false — nothing to match", () => {
    expect(evaluateConditionNode(createEmptyGroup("ANY"), {})).toBe(false);
  });
});

describe("normalizeConditionNode / parseConditionTree", () => {
  it("drops malformed leaves instead of throwing", () => {
    const parsed = normalizeConditionNode({
      type: "group",
      combinator: "ALL",
      children: [
        { type: "condition", field: "cart.subtotal", operator: "greater_than", value: 100 },
        { type: "condition", field: "", operator: "greater_than", value: 100 }, // missing field
        { type: "condition", field: "cart.quantity", operator: "not_a_real_operator", value: 1 }, // bad operator
        null,
        "garbage",
      ],
    });

    expect(parsed?.type).toBe("group");
    expect((parsed as ConditionGroup).children).toHaveLength(1);
  });

  it("falls back to an empty ALL group for non-group root input", () => {
    expect(parseConditionTree(null)).toMatchObject({ type: "group", combinator: "ALL", children: [] });
    expect(
      parseConditionTree({ type: "condition", field: "x", operator: "equals" }),
    ).toMatchObject({ type: "group", combinator: "ALL", children: [] });
  });

  it("round-trips through JSON serialization", () => {
    const tree = group("ANY", [
      leaf({ field: "customer.tag", operator: "equals", value: "VIP" }),
      group("ALL", [leaf({ field: "cart.quantity", operator: "between", value: [3, 5] })]),
    ]);

    const roundTripped = parseConditionTree(JSON.parse(JSON.stringify(tree)));
    expect(evaluateConditionNode(roundTripped, { "customer.tag": "VIP" })).toBe(true);
    expect(evaluateConditionNode(roundTripped, { "customer.tag": "Regular", "cart.quantity": 4 })).toBe(true);
    expect(evaluateConditionNode(roundTripped, { "customer.tag": "Regular", "cart.quantity": 1 })).toBe(false);
  });
});
