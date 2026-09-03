/**
 * Mirrors app/lib/compiled-campaign.ts. See condition-engine.ts's
 * module comment for why this is a duplicate, not a cross-package
 * import, and how parity is enforced.
 */

import type { ConditionGroup } from "./condition-engine";
import type { RewardConfig } from "./reward-engine";
import type { ConflictStrategy } from "./conflict-resolution";

export interface CompiledSiblingCampaign {
  id: string;
  priority: number;
  isExclusive: boolean;
  conditions: ConditionGroup;
  reward: RewardConfig;
  usageLimitTotal?: number;
  usageLimitPerCustomer?: number;
  usageCountAsOfPublish?: number;
}

export interface CompiledCampaignConfig {
  id: string;
  priority: number;
  isExclusive: boolean;
  conditions: ConditionGroup;
  reward: RewardConfig;
  siblings: CompiledSiblingCampaign[];
  conflictStrategy: ConflictStrategy;
  // Only one of these two is ever set, mirroring Shop.maxTotalDiscountType.
  maxTotalDiscountPercent?: number;
  maxTotalDiscountAmount?: number;
  usageLimitTotal?: number;
  usageLimitPerCustomer?: number;
}

export const RESOLVED_PRODUCT_IDS_FIELD = "_resolvedProductIds";
