import { describe, expect, it } from "vitest";
import { evaluateConditionNode } from "./campaign-types";
import {
  addChildToGroup,
  createEditableGroup,
  createEditableLeaf,
  editableEmptyGroup,
  removeNodeById,
  replaceNode,
  toConditionTree,
  toEditableTree,
  type EditableGroup,
} from "./condition-tree-edit";

describe("toEditableTree / toConditionTree round-trip", () => {
  it("round-trips a scalar condition", () => {
    const original = toConditionTree({
      id: "c1",
      type: "condition",
      field: "customer.tag",
      operator: "equals",
      value: "VIP",
    });

    const editable = toEditableTree(original);
    expect(editable).toEqual({ id: "c1", type: "condition", field: "customer.tag", operator: "equals", value: "VIP" });

    const back = toConditionTree(editable);
    expect(back).toEqual(original);
  });

  it("round-trips an array-valued operator (in) through comma-separated text", () => {
    const original = {
      id: "c1",
      type: "condition" as const,
      field: "market.countryCode",
      operator: "in" as const,
      value: ["US", "CA", "GB"],
    };

    const editable = toEditableTree(original);
    expect(editable.type === "condition" && editable.value).toBe("US, CA, GB");

    const back = toConditionTree(editable);
    expect(back).toEqual({
      id: "c1",
      type: "condition",
      field: "market.countryCode",
      operator: "in",
      value: ["US", "CA", "GB"],
    });
  });

  it("round-trips 'between' as a two-element array, dropping extras", () => {
    const editable = createEditableLeaf("cart.subtotal", "between");
    editable.value = "100, 200, 300";
    const tree = toConditionTree(editable);
    expect(tree.type === "condition" && tree.value).toEqual(["100", "200"]);
  });

  it("drops the value entirely for is_empty/is_not_empty regardless of text", () => {
    const editable = createEditableLeaf("customer.tag", "is_empty");
    editable.value = "should be ignored";
    const tree = toConditionTree(editable);
    expect(tree.type === "condition" && "value" in tree).toBe(false);
  });

  it("an empty/whitespace value serializes to no value key", () => {
    const editable = createEditableLeaf("customer.tag", "equals");
    editable.value = "   ";
    const tree = toConditionTree(editable);
    expect(tree.type === "condition" && "value" in tree).toBe(false);
  });

  it("round-trips nested groups", () => {
    const original = toConditionTree({
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
          ],
        },
      ],
    });

    expect(toConditionTree(toEditableTree(original))).toEqual(original);
  });
});

describe("editableEmptyGroup", () => {
  it("produces an editable ALL group with no children", () => {
    const group = editableEmptyGroup();
    expect(group.type).toBe("group");
    expect(group.combinator).toBe("ALL");
    expect(group.children).toEqual([]);
  });
});

describe("replaceNode / removeNodeById / addChildToGroup", () => {
  function sampleTree(): EditableGroup {
    return {
      id: "root",
      type: "group",
      combinator: "ALL",
      children: [
        createEditableLeaf("cart.subtotal", "greater_than_or_equal"),
        createEditableGroup("ANY"),
      ],
    };
  }

  it("replaceNode updates only the targeted node, leaving siblings untouched", () => {
    const tree = sampleTree();
    const leafId = tree.children[0]!.id;

    const updated = replaceNode(tree, leafId, (node) =>
      node.type === "condition" ? { ...node, value: "150" } : node,
    );

    expect(updated.children[0]).toMatchObject({ value: "150" });
    expect(updated.children[1]).toEqual(tree.children[1]);
    // original is untouched (immutable update)
    expect((tree.children[0] as { value: string }).value).toBe("");
  });

  it("replaceNode reaches into nested groups", () => {
    const tree = sampleTree();
    const nestedGroupId = tree.children[1]!.id;
    const withChild = addChildToGroup(tree, nestedGroupId, createEditableLeaf("customer.tag", "equals"));
    const nestedLeafId = (withChild.children[1] as EditableGroup).children[0]!.id;

    const updated = replaceNode(withChild, nestedLeafId, (node) =>
      node.type === "condition" ? { ...node, value: "VIP" } : node,
    );

    expect((updated.children[1] as EditableGroup).children[0]).toMatchObject({ value: "VIP" });
  });

  it("removeNodeById removes a top-level child", () => {
    const tree = sampleTree();
    const idToRemove = tree.children[0]!.id;
    const updated = removeNodeById(tree, idToRemove);
    expect(updated.children).toHaveLength(1);
    expect(updated.children.find((c) => c.id === idToRemove)).toBeUndefined();
  });

  it("removeNodeById removes a deeply nested child without touching siblings", () => {
    const tree = sampleTree();
    const nestedGroupId = tree.children[1]!.id;
    const withChildren = addChildToGroup(
      addChildToGroup(tree, nestedGroupId, createEditableLeaf("customer.tag", "equals")),
      nestedGroupId,
      createEditableLeaf("cart.quantity", "greater_than"),
    );

    const toRemove = (withChildren.children[1] as EditableGroup).children[0]!.id;
    const updated = removeNodeById(withChildren, toRemove);

    expect((updated.children[1] as EditableGroup).children).toHaveLength(1);
    expect(updated.children[0]).toEqual(withChildren.children[0]);
  });

  it("addChildToGroup appends without mutating the original tree", () => {
    const tree = sampleTree();
    const newLeaf = createEditableLeaf("product.vendor", "equals");
    const updated = addChildToGroup(tree, "root", newLeaf);

    expect(updated.children).toHaveLength(3);
    expect(tree.children).toHaveLength(2);
  });

  it("end-to-end: builder edits produce a tree that evaluates correctly", () => {
    let tree = editableEmptyGroup();
    tree = { ...tree, id: "root" };
    tree = addChildToGroup(tree, "root", { ...createEditableLeaf("market.countryCode", "equals"), value: "UK" });
    const anyGroup = createEditableGroup("ANY");
    tree = addChildToGroup(tree, "root", anyGroup);
    tree = addChildToGroup(tree, anyGroup.id, { ...createEditableLeaf("customer.tag", "equals"), value: "VIP" });
    tree = addChildToGroup(tree, anyGroup.id, {
      ...createEditableLeaf("customer.lifetimeSpend", "greater_than"),
      value: "500",
    });

    const conditionTree = toConditionTree(tree);

    expect(
      evaluateConditionNode(conditionTree, {
        "market.countryCode": "UK",
        "customer.tag": "Regular",
        "customer.lifetimeSpend": 600,
      }),
    ).toBe(true);

    expect(
      evaluateConditionNode(conditionTree, {
        "market.countryCode": "US",
        "customer.tag": "VIP",
        "customer.lifetimeSpend": 0,
      }),
    ).toBe(false);
  });
});
