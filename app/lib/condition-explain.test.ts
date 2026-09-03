import { describe, expect, it } from "vitest";
import { explainConditionNode, failingLeaves, type ExplainedGroup } from "./condition-explain";
import type { ConditionContext } from "./campaign-types";

describe("explainConditionNode", () => {
  it("annotates a passing leaf", () => {
    const explained = explainConditionNode(
      { id: "c1", type: "condition", field: "customer.tag", operator: "equals", value: "VIP" },
      { "customer.tag": "VIP" },
    );

    expect(explained).toMatchObject({ type: "condition", passed: true, description: "customer.tag is VIP" });
  });

  it("annotates a failing leaf with the actual value for display", () => {
    const explained = explainConditionNode(
      { id: "c1", type: "condition", field: "customer.tag", operator: "equals", value: "VIP" },
      { "customer.tag": "Regular" },
    );

    expect(explained).toMatchObject({ passed: false, actual: "Regular" });
  });

  it("propagates ALL/ANY correctly through nested groups", () => {
    const tree = {
      id: "root",
      type: "group" as const,
      combinator: "ALL" as const,
      children: [
        { id: "c1", type: "condition" as const, field: "market.countryCode", operator: "equals" as const, value: "UK" },
        {
          id: "g1",
          type: "group" as const,
          combinator: "ANY" as const,
          children: [
            { id: "c2", type: "condition" as const, field: "customer.tag", operator: "equals" as const, value: "VIP" },
            { id: "c3", type: "condition" as const, field: "customer.totalSpent", operator: "greater_than" as const, value: 500 },
          ],
        },
      ],
    };

    const matchingByCash: ConditionContext = { "market.countryCode": "UK", "customer.tag": "Regular", "customer.totalSpent": 600 };
    const explained = explainConditionNode(tree, matchingByCash) as ExplainedGroup;
    expect(explained.passed).toBe(true);
    expect((explained.children[1] as ExplainedGroup).passed).toBe(true);
    expect((explained.children[1] as ExplainedGroup).children[0]).toMatchObject({ passed: false }); // tag branch still failed
    expect((explained.children[1] as ExplainedGroup).children[1]).toMatchObject({ passed: true }); // spend branch passed

    const wrongCountry: ConditionContext = { ...matchingByCash, "market.countryCode": "US" };
    expect((explainConditionNode(tree, wrongCountry) as ExplainedGroup).passed).toBe(false);
  });
});

describe("failingLeaves", () => {
  it("returns an empty list when everything passed", () => {
    const explained = explainConditionNode(
      { id: "c1", type: "condition", field: "customer.tag", operator: "equals", value: "VIP" },
      { "customer.tag": "VIP" },
    );
    expect(failingLeaves(explained)).toEqual([]);
  });

  it("surfaces the single failing leaf for a simple failing condition", () => {
    const explained = explainConditionNode(
      { id: "c1", type: "condition", field: "customer.tag", operator: "equals", value: "VIP" },
      { "customer.tag": "Regular" },
    );
    expect(failingLeaves(explained)).toHaveLength(1);
    expect(failingLeaves(explained)[0]).toMatchObject({ field: "customer.tag" });
  });

  it("does not surface a failing branch inside an ANY group that passed via another branch", () => {
    const tree = {
      id: "root",
      type: "group" as const,
      combinator: "ANY" as const,
      children: [
        { id: "c1", type: "condition" as const, field: "customer.tag", operator: "equals" as const, value: "VIP" },
        { id: "c2", type: "condition" as const, field: "customer.totalSpent", operator: "greater_than" as const, value: 500 },
      ],
    };

    const explained = explainConditionNode(tree, { "customer.tag": "Regular", "customer.totalSpent": 600 });
    expect(failingLeaves(explained)).toEqual([]); // the group passed overall — nothing to blame
  });

  it("surfaces every failing leaf inside a failing ALL group", () => {
    const tree = {
      id: "root",
      type: "group" as const,
      combinator: "ALL" as const,
      children: [
        { id: "c1", type: "condition" as const, field: "customer.tag", operator: "equals" as const, value: "VIP" },
        { id: "c2", type: "condition" as const, field: "cart.subtotal", operator: "greater_than_or_equal" as const, value: 100 },
      ],
    };

    const explained = explainConditionNode(tree, { "customer.tag": "Regular", "cart.subtotal": 50 });
    const failures = failingLeaves(explained);
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.field)).toEqual(["customer.tag", "cart.subtotal"]);
  });

  it("real-world case: a passing ALL group with one failing nested ANY surfaces only that ANY's leaves", () => {
    const tree = {
      id: "root",
      type: "group" as const,
      combinator: "ALL" as const,
      children: [
        { id: "c1", type: "condition" as const, field: "cart.subtotal", operator: "greater_than_or_equal" as const, value: 100 },
        {
          id: "g1",
          type: "group" as const,
          combinator: "ANY" as const,
          children: [
            { id: "c2", type: "condition" as const, field: "customer.tag", operator: "equals" as const, value: "VIP" },
            { id: "c3", type: "condition" as const, field: "customer.totalSpent", operator: "greater_than" as const, value: 500 },
          ],
        },
      ],
    };

    const explained = explainConditionNode(tree, { "cart.subtotal": 150, "customer.tag": "Regular", "customer.totalSpent": 10 });
    const failures = failingLeaves(explained);
    expect(failures.map((f) => f.field)).toEqual(["customer.tag", "customer.totalSpent"]);
  });
});
