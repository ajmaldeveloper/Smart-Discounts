import { describe, expect, it } from "vitest";
import { hasReachedPerCustomerLimit, hasReachedTotalLimit, isWithinUsageLimits } from "./usage-limits";

describe("hasReachedTotalLimit", () => {
  it("is false when unlimited", () => {
    expect(hasReachedTotalLimit(1000, undefined)).toBe(false);
  });

  it("is true once usage reaches the limit (not just exceeds it)", () => {
    expect(hasReachedTotalLimit(9, 10)).toBe(false);
    expect(hasReachedTotalLimit(10, 10)).toBe(true);
    expect(hasReachedTotalLimit(11, 10)).toBe(true);
  });
});

describe("hasReachedPerCustomerLimit", () => {
  it("is false when unlimited", () => {
    expect(hasReachedPerCustomerLimit(50, undefined)).toBe(false);
  });

  it("is true once the customer's own count reaches the limit", () => {
    expect(hasReachedPerCustomerLimit(1, 2)).toBe(false);
    expect(hasReachedPerCustomerLimit(2, 2)).toBe(true);
  });
});

describe("isWithinUsageLimits", () => {
  it("is true when both caps are unlimited", () => {
    expect(isWithinUsageLimits({ usageCount: 999, usageLimitTotal: undefined, customerUsageCount: 999, usageLimitPerCustomer: undefined })).toBe(true);
  });

  it("total=10, per-customer=2: the 11th total use is blocked regardless of that customer's own count", () => {
    expect(isWithinUsageLimits({ usageCount: 10, usageLimitTotal: 10, customerUsageCount: 0, usageLimitPerCustomer: 2 })).toBe(false);
  });

  it("total=10, per-customer=2: a customer at their own cap is blocked even with total uses remaining", () => {
    expect(isWithinUsageLimits({ usageCount: 3, usageLimitTotal: 10, customerUsageCount: 2, usageLimitPerCustomer: 2 })).toBe(false);
  });

  it("total=10, per-customer=2: allowed when under both caps", () => {
    expect(isWithinUsageLimits({ usageCount: 9, usageLimitTotal: 10, customerUsageCount: 1, usageLimitPerCustomer: 2 })).toBe(true);
  });
});
