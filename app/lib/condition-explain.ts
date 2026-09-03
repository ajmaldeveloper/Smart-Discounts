/**
 * Explainability layer (M11) on top of evaluateConditionNode: instead
 * of just true/false, walks the same tree and annotates every node
 * with its own result, so the Promotion Simulator can render "why did
 * this apply" / "why didn't this apply" down to the exact failing leaf
 * — e.g. "Customer condition failed — requires VIP tag" — rather than
 * a single opaque yes/no for the whole campaign.
 *
 * Deliberately NOT mirrored into the Shopify Function: explanation is
 * an admin-only, human-facing concern. The Function only ever needs
 * the plain boolean from evaluateConditionNode.
 */

import { evaluateCondition, operatorLabel, type ConditionContext, type ConditionLeaf, type ConditionNode } from "./campaign-types";

export interface ExplainedLeaf {
  type: "condition";
  field: string;
  operator: string;
  value: ConditionLeaf["value"];
  actual: unknown;
  passed: boolean;
  description: string;
}

export interface ExplainedGroup {
  type: "group";
  combinator: "ALL" | "ANY";
  passed: boolean;
  children: ExplainedNode[];
}

export type ExplainedNode = ExplainedLeaf | ExplainedGroup;

function describeLeaf(leaf: ConditionLeaf): string {
  const valueText = Array.isArray(leaf.value) ? leaf.value.join(", ") : String(leaf.value ?? "");
  return `${leaf.field} ${operatorLabel(leaf.operator)}${valueText ? ` ${valueText}` : ""}`;
}

export function explainConditionNode(node: ConditionNode, context: ConditionContext): ExplainedNode {
  if (node.type === "condition") {
    return {
      type: "condition",
      field: node.field,
      operator: node.operator,
      value: node.value,
      actual: context[node.field],
      passed: evaluateCondition(node, context),
      description: describeLeaf(node),
    };
  }

  const children = node.children.map((child) => explainConditionNode(child, context));
  const passed =
    children.length === 0
      ? node.combinator === "ALL"
      : node.combinator === "ANY"
        ? children.some((child) => child.passed)
        : children.every((child) => child.passed);

  return { type: "group", combinator: node.combinator, passed, children };
}

/** Flattens an explained tree into just the FAILING leaves, in tree order — the "why didn't this match" list a merchant actually wants, without making them read the whole passing tree too. */
export function failingLeaves(node: ExplainedNode): ExplainedLeaf[] {
  if (node.type === "condition") {
    return node.passed ? [] : [node];
  }

  // Only surface failures from a failing group. Inside a passing ANY
  // group, sibling branches that didn't match aren't why anything
  // failed overall — that group already passed via another branch.
  if (node.passed) return [];

  return node.children.flatMap((child) => failingLeaves(child));
}
