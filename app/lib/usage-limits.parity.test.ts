/**
 * extensions/winslet-discounts/src/usage-limits.ts is a deliberate
 * duplicate of app/lib/usage-limits.ts (see condition-engine.ts's
 * module comment for the full rationale).
 */
import { describe, expect, it } from "vitest";
import * as adminEngine from "./usage-limits";
// eslint-disable-next-line import/no-relative-packages -- deliberate cross-package import, test-only
import * as functionEngine from "../../extensions/winslet-discounts/src/usage-limits";

describe("usage limits parity", () => {
  it.each([
    { usageCount: 9, usageLimitTotal: 10, customerUsageCount: 0, usageLimitPerCustomer: 2 },
    { usageCount: 10, usageLimitTotal: 10, customerUsageCount: 0, usageLimitPerCustomer: 2 },
    { usageCount: 3, usageLimitTotal: 10, customerUsageCount: 2, usageLimitPerCustomer: 2 },
    { usageCount: 999, usageLimitTotal: undefined, customerUsageCount: 999, usageLimitPerCustomer: undefined },
  ])("agrees for %j", (params) => {
    expect(functionEngine.isWithinUsageLimits(params)).toBe(adminEngine.isWithinUsageLimits(params));
  });
});
