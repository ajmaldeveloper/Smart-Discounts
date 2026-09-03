/**
 * Mirrors app/lib/usage-limits.ts exactly. See condition-engine.ts's
 * module comment for why this is a duplicate, not a cross-package
 * import, and how parity is enforced.
 */

export function hasReachedTotalLimit(usageCount: number, usageLimitTotal: number | undefined): boolean {
  return usageLimitTotal !== undefined && usageCount >= usageLimitTotal;
}

export function hasReachedPerCustomerLimit(customerUsageCount: number, usageLimitPerCustomer: number | undefined): boolean {
  return usageLimitPerCustomer !== undefined && customerUsageCount >= usageLimitPerCustomer;
}

export function isWithinUsageLimits(params: {
  usageCount: number;
  usageLimitTotal: number | undefined;
  customerUsageCount: number;
  usageLimitPerCustomer: number | undefined;
}): boolean {
  return (
    !hasReachedTotalLimit(params.usageCount, params.usageLimitTotal) &&
    !hasReachedPerCustomerLimit(params.customerUsageCount, params.usageLimitPerCustomer)
  );
}
