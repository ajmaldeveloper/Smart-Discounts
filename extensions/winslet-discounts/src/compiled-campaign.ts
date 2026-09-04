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
  // Set only when this sibling is one variant of an A/B test — see
  // CompiledCampaignConfig's own field below.
  experimentVariant?: "A" | "B";
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
  // Set only when this campaign is one variant ("A" or "B") of an A/B
  // test — see cart_lines_discounts_generate_run.ts's
  // abBucketFor/matchesBucket for how the cart's own
  // "_winslet_ab_bucket" attribute decides eligibility.
  experimentVariant?: "A" | "B";
}

export const RESOLVED_PRODUCT_IDS_FIELD = "_resolvedProductIds";
