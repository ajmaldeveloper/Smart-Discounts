/**
 * Pure tree-editing helpers behind the Conditions tab UI
 * (app/components/campaign-builder/ConditionsEditor.tsx). Kept separate
 * from the React component and from the canonical ConditionNode type
 * (app/lib/campaign-types.ts) because the editor needs one extra thing
 * the canonical type doesn't: a leaf's value edited as a single raw
 * text field (comma-separated for in/not_in/between) rather than an
 * already-typed ConditionValue. Converting at the boundary
 * (toEditableTree on load, toConditionTree on save) keeps the
 * evaluator's own types simple while the UI stays a plain text input.
 */

import {
  createEmptyGroup,
  type ConditionCombinator,
  type ConditionLeaf,
  type ConditionNode,
  type ConditionOperator,
  type ConditionValue,
} from "./campaign-types";

export interface EditableLeaf {
  id: string;
  type: "condition";
  field: string;
  operator: ConditionOperator;
  value: string;
  label?: string;
  enabled?: boolean;
}

export interface EditableGroup {
  id: string;
  type: "group";
  combinator: ConditionCombinator;
  children: EditableNode[];
}

export type EditableNode = EditableLeaf | EditableGroup;

function localId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id ? `${prefix}-${id}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function valueToText(value: ConditionValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const ARRAY_OPERATORS = new Set<ConditionOperator>(["in", "not_in", "between"]);
const NO_VALUE_OPERATORS = new Set<ConditionOperator>(["is_empty", "is_not_empty"]);

function textToValue(operator: ConditionOperator, text: string): ConditionValue | undefined {
  if (NO_VALUE_OPERATORS.has(operator)) return undefined;

  const trimmed = text.trim();
  if (trimmed === "") return undefined;

  if (ARRAY_OPERATORS.has(operator)) {
    const parts = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return operator === "between" ? parts.slice(0, 2) : parts;
  }

  return trimmed;
}

export function toEditableTree(node: ConditionNode): EditableNode {
  if (node.type === "condition") {
    return {
      id: node.id,
      type: "condition",
      field: node.field,
      operator: node.operator,
      value: valueToText(node.value),
      ...(node.label ? { label: node.label } : {}),
      ...(node.enabled === false ? { enabled: false } : {}),
    };
  }

  return {
    id: node.id,
    type: "group",
    combinator: node.combinator,
    children: node.children.map(toEditableTree),
  };
}

export function toConditionTree(node: EditableNode): ConditionNode {
  if (node.type === "condition") {
    const leaf: ConditionLeaf = {
      id: node.id,
      type: "condition",
      field: node.field,
      operator: node.operator,
      ...(node.label ? { label: node.label } : {}),
      ...(node.enabled === false ? { enabled: false } : {}),
    };
    const value = textToValue(node.operator, node.value);
    return value !== undefined ? { ...leaf, value } : leaf;
  }

  return {
    id: node.id,
    type: "group",
    combinator: node.combinator,
    children: node.children.map(toConditionTree),
  };
}

export function createEditableLeaf(field: string, operator: ConditionOperator): EditableLeaf {
  return { id: localId("condition"), type: "condition", field, operator, value: "" };
}

export function createEditableGroup(combinator: ConditionCombinator = "ALL"): EditableGroup {
  return { id: localId("group"), type: "group", combinator, children: [] };
}

export function editableEmptyGroup(): EditableGroup {
  return toEditableTree(createEmptyGroup("ALL")) as EditableGroup;
}

/** Replaces the node with the given id anywhere in the tree by applying `updater` to it. No-op if the id isn't found. */
export function replaceNode(
  tree: EditableGroup,
  id: string,
  updater: (node: EditableNode) => EditableNode,
): EditableGroup {
  function walk(node: EditableNode): EditableNode {
    if (node.id === id) return updater(node);
    if (node.type === "group") return { ...node, children: node.children.map(walk) };
    return node;
  }

  return walk(tree) as EditableGroup;
}

/** Removes the node with the given id anywhere in the tree. No-op if the id isn't found (e.g. it's the tree root, which can't remove itself). */
export function removeNodeById(tree: EditableGroup, id: string): EditableGroup {
  function walk(node: EditableGroup): EditableGroup {
    return {
      ...node,
      children: node.children
        .filter((child) => child.id !== id)
        .map((child) => (child.type === "group" ? walk(child) : child)),
    };
  }

  return walk(tree);
}

/** Appends a child to the group with the given id, wherever it is in the tree. */
export function addChildToGroup(
  tree: EditableGroup,
  groupId: string,
  child: EditableNode,
): EditableGroup {
  function walk(node: EditableGroup): EditableGroup {
    if (node.id === groupId) {
      return { ...node, children: [...node.children, child] };
    }
    return { ...node, children: node.children.map((c) => (c.type === "group" ? walk(c) : c)) };
  }

  return walk(tree);
}

/**
 * The Audience/Products/Markets tabs each own one direct child of the
 * root, identified by a fixed id (e.g. "managed:audience") rather than
 * a randomly generated one, so a tab can find and replace exactly its
 * own leaves on every render without disturbing whatever the generic
 * Conditions tab (or another managed tab) has built elsewhere in the
 * same tree — all four tabs are views onto the one conditionsJson tree,
 * not separate storage.
 */
export function findManagedGroup(tree: EditableGroup, groupId: string): EditableGroup | undefined {
  const found = tree.children.find((child) => child.id === groupId);
  return found && found.type === "group" ? found : undefined;
}

/** The Audience/Products/Markets tabs' own managed group ids (see app.campaigns.$id.tsx) — the generic Conditions tab hides these from its own tree view since each already has a dedicated, friendlier tab. */
export const MANAGED_GROUP_IDS = ["managed:audience", "managed:products", "managed:markets"];

export function setManagedLeaves(tree: EditableGroup, groupId: string, leaves: EditableLeaf[]): EditableGroup {
  const withoutExisting = removeNodeById(tree, groupId);
  if (leaves.length === 0) return withoutExisting;

  const group: EditableGroup = { id: groupId, type: "group", combinator: "ALL", children: leaves };
  return { ...withoutExisting, children: [...withoutExisting.children, group] };
}
