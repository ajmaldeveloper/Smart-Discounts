import { describe, expect, it } from "vitest";
import { estimateMixAndMatchDiscount } from "./cart_lines_discounts_generate_run";
import type { ContextCartLine } from "./context";

function line(id: string, quantity: number, unitPrice: number): ContextCartLine {
  return {
    id,
    quantity,
    cost: { subtotalAmount: { amount: String(quantity * unitPrice) } },
    merchandise: { __typename: "ProductVariant", id: `variant-${id}`, product: { id: `product-${id}` } },
  };
}

describe("estimateMixAndMatchDiscount", () => {
  it("discounts a single complete bundle from one line", () => {
    // 3 units @ $20 = $60 actual; bundle of 3 for $50 -> $10 discount.
    const result = estimateMixAndMatchDiscount({ bundleSize: 3, bundlePrice: 50 }, [line("A", 3, 20)], undefined);

    expect(result.totalAmount).toBe(10);
    expect(result.targetLines).toEqual([{ line: expect.objectContaining({ id: "A" }), quantity: 3, amount: 10 }]);
  });

  it("returns no discount when there aren't enough units for one complete bundle", () => {
    const result = estimateMixAndMatchDiscount({ bundleSize: 3, bundlePrice: 50 }, [line("A", 2, 20)], undefined);
    expect(result).toEqual({ targetLines: [], totalAmount: 0 });
  });

  it("only discounts complete bundles, leaving leftover units at full price", () => {
    // 4 units @ $20 = one bundle of 3 ($60 -> $50, $10 off) + 1 leftover unit untouched.
    const result = estimateMixAndMatchDiscount({ bundleSize: 3, bundlePrice: 50 }, [line("A", 4, 20)], undefined);

    expect(result.totalAmount).toBe(10);
    expect(result.targetLines).toEqual([{ line: expect.objectContaining({ id: "A" }), quantity: 3, amount: 10 }]);
  });

  it("fills bundles cheapest-unit-first across multiple lines", () => {
    // Line A: 2 units @ $10 (cheap). Line B: 2 units @ $30 (expensive). Bundle of 3 for $15.
    // Cheapest 3 units: both $10 units from A + one $30 unit from B = $50 actual -> $35 discount.
    const result = estimateMixAndMatchDiscount(
      { bundleSize: 3, bundlePrice: 15 },
      [line("A", 2, 10), line("B", 2, 30)],
      undefined,
    );

    expect(result.totalAmount).toBe(35);
    const byLine = new Map(result.targetLines.map((t) => [t.line.id, t]));
    // A contributed 2 units worth $20 of the $50 actual total -> 20/50 * 35 = 14.
    expect(byLine.get("A")).toEqual({ line: expect.objectContaining({ id: "A" }), quantity: 2, amount: 14 });
    // B contributed 1 unit worth $30 of the $50 actual total -> 30/50 * 35 = 21.
    expect(byLine.get("B")).toEqual({ line: expect.objectContaining({ id: "B" }), quantity: 1, amount: 21 });
  });

  it("fills multiple complete bundles when there are enough units", () => {
    // 6 units @ $20 = two bundles of 3 for $50 each -> $120 actual, $100 bundle total, $20 discount.
    const result = estimateMixAndMatchDiscount({ bundleSize: 3, bundlePrice: 50 }, [line("A", 6, 20)], undefined);

    expect(result.totalAmount).toBe(20);
    expect(result.targetLines).toEqual([{ line: expect.objectContaining({ id: "A" }), quantity: 6, amount: 20 }]);
  });

  it("never produces a negative discount when the bundle price is above the actual price", () => {
    // 3 units @ $10 = $30 actual; bundle price $50 is more than the items cost — no discount, not a surcharge.
    const result = estimateMixAndMatchDiscount({ bundleSize: 3, bundlePrice: 50 }, [line("A", 3, 10)], undefined);
    expect(result).toEqual({ targetLines: [], totalAmount: 0 });
  });

  it("passes the reward name through untouched", () => {
    const result = estimateMixAndMatchDiscount({ bundleSize: 2, bundlePrice: 10 }, [line("A", 2, 20)], "Mix & match deal");
    expect(result.name).toBe("Mix & match deal");
  });
});
