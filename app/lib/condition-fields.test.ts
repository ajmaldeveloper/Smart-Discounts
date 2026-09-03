import { describe, expect, it } from "vitest";
import { CONDITION_OPERATORS } from "./campaign-types";
import {
  CONDITION_FIELDS,
  buildProductMetafieldField,
  getConditionField,
  operatorsForField,
} from "./condition-fields";

const VALID_OPERATORS = new Set<string>(CONDITION_OPERATORS);

describe("CONDITION_FIELDS registry", () => {
  it("has unique field keys", () => {
    const keys = CONDITION_FIELDS.map((def) => def.field);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every declared operator is a real ConditionOperator", () => {
    for (const def of CONDITION_FIELDS) {
      for (const operator of def.operators) {
        expect(VALID_OPERATORS.has(operator)).toBe(true);
      }
    }
  });

  it("every field declares at least one operator", () => {
    for (const def of CONDITION_FIELDS) {
      expect(def.operators.length).toBeGreaterThan(0);
    }
  });

  it("resource-list fields declare a resourceType", () => {
    for (const def of CONDITION_FIELDS) {
      if (def.valueType === "resource-list") {
        expect(def.resourceType).toBeDefined();
      }
    }
  });
});

describe("getConditionField / operatorsForField", () => {
  it("resolves a static field", () => {
    expect(getConditionField("cart.subtotal")?.valueType).toBe("number");
    expect(operatorsForField("cart.subtotal")).toContain("between");
  });

  it("returns undefined/empty for an unknown field", () => {
    expect(getConditionField("not.a.real.field")).toBeUndefined();
    expect(operatorsForField("not.a.real.field")).toEqual([]);
  });

  it("resolves a dynamic product metafield field built via the naming convention", () => {
    const field = buildProductMetafieldField("custom", "material");
    expect(field).toBe("product.metafield:custom.material");
    expect(getConditionField(field)?.category).toBe("product");
    expect(operatorsForField(field)).toContain("contains");
  });
});
