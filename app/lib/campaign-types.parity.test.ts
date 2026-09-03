/**
 * extensions/winslet-discounts/src/condition-engine.ts is a deliberate
 * duplicate of this module (see its own module comment for why a
 * Shopify Function can't just import across the app/extension package
 * boundary the way the rest of this app shares code). This test is
 * what makes that duplication safe: it runs the exact same table of
 * cases through BOTH implementations and fails the moment they
 * disagree, so drift breaks CI here — not silently at checkout.
 */
import { describe, expect, it } from "vitest";
import * as adminEngine from "./campaign-types";
// eslint-disable-next-line import/no-relative-packages -- deliberate cross-package import, test-only (see module comment above)
import * as functionEngine from "../../extensions/winslet-discounts/src/condition-engine";
import type { ConditionContext } from "./campaign-types";

type AnyConditionNode = adminEngine.ConditionNode;

const CASES: Array<{ name: string; tree: AnyConditionNode; context: ConditionContext }> = [
  {
    name: "simple equals match",
    tree: { id: "c1", type: "condition", field: "product.vendor", operator: "equals", value: "Nike" },
    context: { "product.vendor": "Nike" },
  },
  {
    name: "simple equals mismatch (case-insensitive)",
    tree: { id: "c1", type: "condition", field: "product.vendor", operator: "equals", value: "nike" },
    context: { "product.vendor": "NIKE" },
  },
  {
    name: "numeric comparisons",
    tree: {
      id: "root",
      type: "group",
      combinator: "ALL",
      children: [
        { id: "c1", type: "condition", field: "cart.subtotal", operator: "greater_than_or_equal", value: 100 },
        { id: "c2", type: "condition", field: "cart.quantity", operator: "less_than", value: 10 },
      ],
    },
    context: { "cart.subtotal": 150, "cart.quantity": 3 },
  },
  {
    name: "between (inclusive bounds)",
    tree: { id: "c1", type: "condition", field: "cart.subtotal", operator: "between", value: [100, 200] },
    context: { "cart.subtotal": 200 },
  },
  {
    name: "in / not_in against a resolved id list",
    tree: { id: "c1", type: "condition", field: "_resolvedProductIds", operator: "in", value: ["gid://1", "gid://2"] },
    context: { _resolvedProductIds: "gid://2" },
  },
  {
    name: "not_in with no match",
    tree: { id: "c1", type: "condition", field: "_resolvedProductIds", operator: "not_in", value: ["gid://1"] },
    context: { _resolvedProductIds: "gid://9" },
  },
  {
    name: "is_empty / is_not_empty on a missing field",
    tree: {
      id: "root",
      type: "group",
      combinator: "ALL",
      children: [{ id: "c1", type: "condition", field: "variant.sku", operator: "is_empty" }],
    },
    context: {},
  },
  {
    name: "nested ALL(ANY, ALL) — the plan's worked example",
    tree: {
      id: "root",
      type: "group",
      combinator: "ALL",
      children: [
        { id: "c1", type: "condition", field: "market.countryCode", operator: "equals", value: "UK" },
        {
          id: "g1",
          type: "group",
          combinator: "ANY",
          children: [
            { id: "c2", type: "condition", field: "customer.tag", operator: "equals", value: "VIP" },
            { id: "c3", type: "condition", field: "customer.lifetimeSpend", operator: "greater_than", value: 500 },
          ],
        },
        {
          id: "g2",
          type: "group",
          combinator: "ALL",
          children: [
            { id: "c4", type: "condition", field: "cart.quantity", operator: "greater_than_or_equal", value: 3 },
            { id: "c5", type: "condition", field: "cart.subtotal", operator: "greater_than_or_equal", value: 100 },
          ],
        },
      ],
    },
    context: {
      "market.countryCode": "UK",
      "customer.tag": "Regular",
      "customer.lifetimeSpend": 501,
      "cart.quantity": 3,
      "cart.subtotal": 100,
    },
  },
  {
    name: "empty ALL group is vacuously true",
    tree: { id: "root", type: "group", combinator: "ALL", children: [] },
    context: {},
  },
  {
    name: "empty ANY group is false",
    tree: { id: "root", type: "group", combinator: "ANY", children: [] },
    context: {},
  },
  {
    name: "malformed leaf value for a numeric operator fails closed",
    tree: { id: "c1", type: "condition", field: "cart.subtotal", operator: "greater_than", value: "not-a-number" },
    context: { "cart.subtotal": 200 },
  },
  {
    name: "multi-valued context field: 'in' overlap match",
    tree: { id: "c1", type: "condition", field: "customer.tag", operator: "in", value: ["Gold", "VIP"] },
    context: { "customer.tag": ["VIP", "Newsletter"] },
  },
  {
    name: "multi-valued context field: 'in' no overlap",
    tree: { id: "c1", type: "condition", field: "customer.tag", operator: "in", value: ["Gold", "Silver"] },
    context: { "customer.tag": ["VIP", "Newsletter"] },
  },
  {
    name: "multi-valued context field: 'contains' is exact membership, not substring",
    tree: { id: "c1", type: "condition", field: "customer.tag", operator: "contains", value: "VI" },
    context: { "customer.tag": ["VIP", "Newsletter"] },
  },
  {
    name: "multi-valued context field: 'not_in' negation",
    tree: { id: "c1", type: "condition", field: "customer.tag", operator: "not_in", value: ["Gold"] },
    context: { "customer.tag": [] },
  },
  {
    name: "disabled leaf is skipped, unblocking an otherwise-failing ALL group",
    tree: {
      id: "root",
      type: "group",
      combinator: "ALL",
      children: [
        { id: "c1", type: "condition", field: "cart.subtotal", operator: "greater_than_or_equal", value: 999, enabled: false },
        { id: "c2", type: "condition", field: "cart.quantity", operator: "greater_than_or_equal", value: 1 },
      ],
    },
    context: { "cart.subtotal": 10, "cart.quantity": 5 },
  },
  {
    name: "disabled leaf is skipped, so an otherwise-true ANY group with only that leaf is false",
    tree: {
      id: "root",
      type: "group",
      combinator: "ANY",
      children: [{ id: "c1", type: "condition", field: "cart.subtotal", operator: "greater_than_or_equal", value: 1, enabled: false }],
    },
    context: { "cart.subtotal": 500 },
  },
];

describe("condition engine parity: app/lib/campaign-types.ts vs extensions/winslet-discounts/src/condition-engine.ts", () => {
  it.each(CASES)("$name", ({ tree, context }) => {
    const adminResult = adminEngine.evaluateConditionNode(tree, context);
    const functionResult = functionEngine.evaluateConditionNode(tree as functionEngine.ConditionNode, context);
    expect(functionResult).toBe(adminResult);
  });

  it("normalizeConditionNode agrees on malformed input", () => {
    const malformed = {
      type: "group",
      combinator: "ALL",
      children: [
        { type: "condition", field: "cart.subtotal", operator: "greater_than", value: 100 },
        { type: "condition", field: "", operator: "greater_than", value: 100 },
        { type: "condition", field: "cart.quantity", operator: "not_a_real_operator", value: 1 },
        null,
      ],
    };

    const adminNormalized = adminEngine.normalizeConditionNode(malformed);
    const functionNormalized = functionEngine.normalizeConditionNode(malformed);

    expect(adminNormalized?.type).toBe("group");
    expect(functionNormalized?.type).toBe("group");
    expect((functionNormalized as { children: unknown[] }).children).toHaveLength(
      (adminNormalized as { children: unknown[] }).children.length,
    );
  });
});
