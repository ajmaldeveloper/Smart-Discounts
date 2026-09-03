/**
 * Usage limit checks (total + per-customer). Enforcement is
 * near-real-time, not atomic: Shopify only tracks usage limits
 * natively for non-app discounts. A Function-based discount has no way
 * to atomically reserve a usage slot at checkout — counts are updated
 * after an order completes (see app/services/usage-tracking.server.ts
 * and webhooks.orders.paid.tsx), so two checkouts racing at the exact
 * boundary could both succeed, overshooting the cap by a small margin
 * under real concurrency. This is an accepted, documented limitation
 * shared by every Function-based (non-native) discount app — there is
 * no platform primitive that does better for app discounts today.
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
