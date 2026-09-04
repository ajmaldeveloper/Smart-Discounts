import type { ConditionGroup } from "./campaign-types";
import type { RewardConfig } from "./reward-types";
import type { ConflictStrategy } from "./conflict-resolution";

/**
 * The exact shape written into a Discount node's "$app" /
 * "function-configuration" metafield — what the Shopify Function
 * actually reads. `conditions` here is NOT the same tree the builder
 * UI edits: product.tag and collection.id leaves have already been
 * rewritten into concrete "_resolvedProductIds" in/not_in checks by
 * app/services/campaign-compiler.server.ts, because the Function API
 * only exposes tag/collection membership via hasAnyTag/inAnyCollection
 * with a STATIC tag/id list — it cannot take a per-campaign dynamic
 * list at query time. Every other field (product.id, variant.id,
 * variant.sku, product.vendor, product.type, cart.*, currency.code) is
 * a plain queryable field and passes through unchanged. See that
 * service's module comment for the full rationale.
 */
/**
 * A sibling campaign's own compiled shape, embedded (not referenced)
 * in every OTHER active campaign's metafield — see
 * app/lib/conflict-resolution.ts's module comment for why: each
 * Campaign's Function invocation can only read ITS OWN discount node's
 * metafield, so full sibling data has to be duplicated into every
 * campaign at publish time rather than centralized anywhere.
 * Snapshotted as of that campaign's own last publish — adding a new
 * campaign doesn't retroactively update already-published siblings
 * until they're republished (a documented v1 limitation).
 */
export interface CompiledSiblingCampaign {
  id: string;
  priority: number;
  isExclusive: boolean;
  conditions: ConditionGroup;
  reward: RewardConfig;
  usageLimitTotal?: number;
  usageLimitPerCustomer?: number;
  // A sibling's TOTAL usage count as of the compiling campaign's own
  // last publish — NOT live. A Function invocation can only read its
  // OWN discount node's metafield, never another discount node's, so
  // there is no way to check a sibling's live usage count at runtime;
  // this snapshot is the best available (same staleness class already
  // accepted for a sibling's conditions/reward — see this file's own
  // module comment). Per-customer usage has no such gap: it lives on
  // the BUYER's own metafield (see CompiledCampaignConfig's own note),
  // readable live for every campaign, self or sibling, in one lookup.
  usageCountAsOfPublish?: number;
  // Set only when this sibling is one variant of an A/B test — see
  // CompiledCampaignConfig's own field below for the full mechanism.
  // Needed here too so that when some OTHER, unrelated campaign builds
  // its own candidate list, a losing (non-matching-bucket) variant is
  // excluded from ITS arbitration as well, not just from its own
  // invocation's self-check.
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
  // Set only when this campaign is one variant ("A" or "B") of an A/B
  // test. A shopper's cart carries a "_winslet_ab_bucket" attribute
  // (written once by public/widgets/ab-test-bootstrap.js); the
  // Function reads it and only lets a campaign whose experimentVariant
  // matches (or a campaign with none at all) be a candidate — see
  // cart_lines_discounts_generate_run.ts's abBucketFor/matchesBucket.
  experimentVariant?: "A" | "B";
  // Only one of these two is ever set, mirroring Shop.maxTotalDiscountType
  // (PERCENTAGE vs FIXED_AMOUNT) at compile time. Percent is kept raw
  // (unconverted) because it must be turned into an absolute money cap
  // against EACH cart's own subtotal at runtime, not a fixed figure
  // computed once at publish time; the fixed amount needs no such
  // conversion — see the Function's own conflict-resolution usage.
  maxTotalDiscountPercent?: number;
  maxTotalDiscountAmount?: number;
  // Declared limits only — live counts are read from separate
  // metafields at runtime (not embedded here, since this config is
  // only refreshed at publish time and usage changes far more often):
  // self's own total count from this discount node's own
  // "$app"/"usage-count" metafield, and every campaign's (self AND
  // every sibling's) per-customer count from the buyer's own
  // "$app"/"campaign_usage" metafield, keyed by campaign id.
  usageLimitTotal?: number;
  usageLimitPerCustomer?: number;
}

/** The pseudo-field a compiled tree's tag/collection leaves are rewritten into — matches RESOLVED_PRODUCT_IDS_FIELD in campaign-compiler.server.ts. Exported so the Function's context builder and tests share one literal. */
export const RESOLVED_PRODUCT_IDS_FIELD = "_resolvedProductIds";
