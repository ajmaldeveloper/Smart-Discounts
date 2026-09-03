/**
 * The REWARD facet of a campaign (M4/M7/M8): what a matching cart
 * actually gets. Kept deliberately flat for M4 — no tiers yet
 * (that's M7's job, layering a `tiers` array on top of this same
 * value/cap shape once it ships).
 */

export type DiscountValue =
  | { type: "percentage"; value: number }
  | { type: "fixedAmount"; value: number };

/**
 * M7's tier engine: instead of one flat value, a reward can supply a
 * ladder of breaks keyed on cart quantity or cart subtotal — "3-5
 * units -> 10%, 6-9 -> 15%, 10+ -> 20%". The highest-threshold break
 * the cart actually qualifies for wins (mirrors wholesale-
 * registration's own selectBreak: "the most specific/generous tier the
 * quantity qualifies for"). No qualifying break means no discount from
 * this reward at all, even if `tiers` is non-empty.
 */
export type TierMetric = "cart.quantity" | "cart.subtotal";

export interface TierBreak {
  minValue: number;
  value: DiscountValue;
  maxDiscountAmount?: number;
  // Overrides the reward's own `name` for the cart/checkout message
  // when THIS tier is the one selected (see selectTier) — e.g. "Buy 2
  // get 1 free" for one tier, "Buy 3 get 3 free" for the next. Falls
  // back to the reward's own name, then the Function's generic
  // default, when unset.
  name?: string;
  // Mirrors wholesale-registration's PriceBreak.exactMatch: when set,
  // this tier only qualifies at exactly `minValue` (not `minValue` or
  // more) — e.g. a "buy exactly 3, get X" bundle break that shouldn't
  // also fire at 4+. Competes with threshold tiers on minValue exactly
  // like selectTier's normal "highest minValue wins" rule; it's just
  // the match test itself that differs.
  exactMatch?: boolean;
  // "Buy X, get Y free" (ProductReward only — see RewardEditor.tsx's
  // BogoEditor): caps the discount to this many UNITS of the targeted
  // cart line instead of the whole line, so buying more than X+Y only
  // ever gives Y away free rather than discounting every unit in the
  // line. Unset means "the whole line", today's existing behavior.
  getQuantity?: number;
  // "Buy X, get Y free" with a pool of DIFFERENT free-gift products (a
  // set of Product GIDs) — e.g. buy 2 shirts, get a free tote bag OR
  // cap, whichever the shopper already has. When set, this overrides
  // the reward's own `appliesTo`: the Function targets whichever cart
  // line(s) carry any of these products, found across the WHOLE cart
  // (not just lines the campaign's conditions match — the gift doesn't
  // have to satisfy the buy conditions), and the "buy" quantity is
  // measured against the campaign's own matching lines rather than the
  // whole cart. Free units are allocated across eligible lines
  // cheapest-first, up to getQuantity total. No discount fires unless
  // the customer has already added at least one of these products to
  // their cart themselves — a Discount Function can only reprice
  // existing cart lines, never add a new one.
  freeProductIds?: string[];
}

export interface ProductReward {
  value: DiscountValue;
  // ALL_MATCHING_LINES: every cart line the campaign's conditions/scope
  // match gets discounted. CHEAPEST/MOST_EXPENSIVE: only one line does
  // — the common "cheapest item free" / highest-value-item promo shape.
  appliesTo: "ALL_MATCHING_LINES" | "CHEAPEST_MATCHING_LINE" | "MOST_EXPENSIVE_MATCHING_LINE";
  maxDiscountAmount?: number;
  // When `tiers` is non-empty, it overrides `value`/`maxDiscountAmount`
  // above — those stay as the fallback/default tier shape a merchant
  // edits before turning tiering on.
  tierMetric?: TierMetric;
  tiers?: TierBreak[];
  // Shown to the customer in their cart and at checkout next to the
  // discounted line (Shopify's own discountApplication "message").
  // Falls back to a generic default in the Function when blank — see
  // extensions/winslet-discounts/src/cart_lines_discounts_generate_run.ts.
  name?: string;
  // "Minimum requirement" for the Simple (non-tiered) shape — see
  // resolveDiscountValue's own comment. Ignored once `tiers` is
  // non-empty; a tier's own minValue already serves this purpose.
  minimumMetric?: TierMetric;
  minimumValue?: number;
}

export interface OrderReward {
  value: DiscountValue;
  maxDiscountAmount?: number;
  tierMetric?: TierMetric;
  tiers?: TierBreak[];
  name?: string;
  minimumMetric?: TierMetric;
  minimumValue?: number;
}

export interface ShippingReward {
  // 100% + "percentage" is how "free shipping" is expressed.
  value: DiscountValue;
  maxDiscountAmount?: number;
  // Case-insensitive exact match against a CartDeliveryOption's own
  // title (e.g. "Standard", "Express"). Undefined/empty discounts
  // every delivery option in every delivery group — set this to
  // target one specific option instead, e.g. "free Standard Shipping,
  // Express Shipping stays full price" (M8's own headline example).
  optionTitle?: string;
  name?: string;
  minimumMetric?: TierMetric;
  minimumValue?: number;
}

export interface RewardConfig {
  product?: ProductReward;
  order?: OrderReward;
  shipping?: ShippingReward;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeDiscountValue(raw: unknown): DiscountValue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  if (record.type === "percentage" && isFiniteNumber(record.value)) {
    return { type: "percentage", value: Math.min(100, Math.max(0, record.value)) };
  }

  if (record.type === "fixedAmount" && isFiniteNumber(record.value)) {
    return { type: "fixedAmount", value: Math.max(0, record.value) };
  }

  return null;
}

const PRODUCT_APPLIES_TO = new Set(["ALL_MATCHING_LINES", "CHEAPEST_MATCHING_LINE", "MOST_EXPENSIVE_MATCHING_LINE"]);
const TIER_METRICS = new Set(["cart.quantity", "cart.subtotal"]);

function normalizeTierMetric(raw: unknown): TierMetric {
  return typeof raw === "string" && TIER_METRICS.has(raw) ? (raw as TierMetric) : "cart.quantity";
}

/** Reads the current array shape, but also migrates an older campaign's single `freeProductId` string (pre-multi-select) — never written again, but never silently dropped from existing data either. */
function normalizeFreeProductIds(record: Record<string, unknown>): string[] {
  const raw: unknown[] = Array.isArray(record.freeProductIds)
    ? record.freeProductIds
    : typeof record.freeProductId === "string" && record.freeProductId.trim()
      ? [record.freeProductId]
      : [];

  return [...new Set(raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()))];
}

/** Drops any tier missing a valid minValue/value rather than rejecting the whole list — one bad row shouldn't cost a merchant every other tier they configured. */
function normalizeTiers(raw: unknown): TierBreak[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item): TierBreak | null => {
      if (typeof item !== "object" || item === null) return null;
      const record = item as Record<string, unknown>;
      const value = normalizeDiscountValue(record.value);
      if (!value || !isFiniteNumber(record.minValue)) return null;

      const name = normalizeRewardName(record.name);
      const freeProductIds = normalizeFreeProductIds(record);

      return {
        minValue: Math.max(0, record.minValue),
        value,
        ...(isFiniteNumber(record.maxDiscountAmount) ? { maxDiscountAmount: record.maxDiscountAmount } : {}),
        ...(name ? { name } : {}),
        ...(record.exactMatch === true ? { exactMatch: true } : {}),
        ...(isFiniteNumber(record.getQuantity) && record.getQuantity > 0 ? { getQuantity: Math.floor(record.getQuantity) } : {}),
        ...(freeProductIds.length > 0 ? { freeProductIds } : {}),
      };
    })
    .filter((tier): tier is TierBreak => tier !== null)
    .sort((a, b) => a.minValue - b.minValue);
}

/** Validates and repairs an arbitrary parsed-JSON value into a well-formed RewardConfig, dropping malformed sub-sections rather than throwing. */
function normalizeRewardName(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** Shared by all three reward sections' "Minimum requirement" gate (see resolveDiscountValue). */
function normalizeMinimum(record: Record<string, unknown>): { minimumMetric?: TierMetric; minimumValue?: number } {
  if (!isFiniteNumber(record.minimumValue) || record.minimumValue <= 0) return {};
  return { minimumMetric: normalizeTierMetric(record.minimumMetric), minimumValue: record.minimumValue };
}

export function normalizeRewardConfig(raw: unknown): RewardConfig {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const result: RewardConfig = {};

  if (typeof record.product === "object" && record.product !== null) {
    const productRecord = record.product as Record<string, unknown>;
    const value = normalizeDiscountValue(productRecord.value);
    const appliesTo = typeof productRecord.appliesTo === "string" && PRODUCT_APPLIES_TO.has(productRecord.appliesTo)
      ? (productRecord.appliesTo as ProductReward["appliesTo"])
      : "ALL_MATCHING_LINES";
    const tiers = normalizeTiers(productRecord.tiers);
    const name = normalizeRewardName(productRecord.name);

    if (value) {
      result.product = {
        value,
        appliesTo,
        ...(isFiniteNumber(productRecord.maxDiscountAmount) ? { maxDiscountAmount: productRecord.maxDiscountAmount } : {}),
        ...(tiers.length > 0 ? { tierMetric: normalizeTierMetric(productRecord.tierMetric), tiers } : {}),
        ...(name ? { name } : {}),
        ...normalizeMinimum(productRecord),
      };
    }
  }

  if (typeof record.order === "object" && record.order !== null) {
    const orderRecord = record.order as Record<string, unknown>;
    const value = normalizeDiscountValue(orderRecord.value);
    const tiers = normalizeTiers(orderRecord.tiers);
    const name = normalizeRewardName(orderRecord.name);

    if (value) {
      result.order = {
        value,
        ...(isFiniteNumber(orderRecord.maxDiscountAmount) ? { maxDiscountAmount: orderRecord.maxDiscountAmount } : {}),
        ...(tiers.length > 0 ? { tierMetric: normalizeTierMetric(orderRecord.tierMetric), tiers } : {}),
        ...(name ? { name } : {}),
        ...normalizeMinimum(orderRecord),
      };
    }
  }

  if (typeof record.shipping === "object" && record.shipping !== null) {
    const shippingRecord = record.shipping as Record<string, unknown>;
    const value = normalizeDiscountValue(shippingRecord.value);
    const optionTitle = typeof shippingRecord.optionTitle === "string" ? shippingRecord.optionTitle.trim() : "";
    const name = normalizeRewardName(shippingRecord.name);

    if (value) {
      result.shipping = {
        value,
        ...(isFiniteNumber(shippingRecord.maxDiscountAmount) ? { maxDiscountAmount: shippingRecord.maxDiscountAmount } : {}),
        ...(optionTitle ? { optionTitle } : {}),
        ...(name ? { name } : {}),
        ...normalizeMinimum(shippingRecord),
      };
    }
  }

  return result;
}

export function hasAnyReward(reward: RewardConfig): boolean {
  return Boolean(reward.product || reward.order || reward.shipping);
}

/**
 * Picks the highest-threshold tier a metric value qualifies for — "the
 * most specific/generous tier the quantity qualifies for" (mirrors
 * wholesale-registration's own selectBreak, exactMatch included:
 * threshold tiers match at `minValue` or above, an exactMatch tier
 * only at exactly `minValue`, and both compete on minValue the same
 * way). Returns null if the metric doesn't clear/hit any tier.
 *
 * A "Buy X, get Y free" tier (getQuantity set, minValue = X+Y) is the
 * one exception: it starts qualifying as soon as the cart holds just
 * ONE more than X, not the full X+Y — see resolveDiscountValue's own
 * comment for why (the free units then ramp up from there).
 */
export function selectTier(tiers: TierBreak[], metricValue: number): TierBreak | null {
  let best: TierBreak | null = null;

  for (const tier of tiers) {
    const qualifyingThreshold = tier.getQuantity !== undefined ? tier.minValue - tier.getQuantity + 1 : tier.minValue;
    const matches = tier.exactMatch ? metricValue === tier.minValue : metricValue >= qualifyingThreshold;
    if (matches && (!best || tier.minValue > best.minValue)) {
      best = tier;
    }
  }

  return best;
}

/**
 * Resolves a reward's effective {value, maxDiscountAmount}: the flat
 * value/cap when no tiers are configured, or the selected tier's own
 * value/cap when they are. Returns null when tiers are configured but
 * none qualify — a merchant-configured tier ladder with a floor (e.g.
 * "3+ units") must produce NO discount below that floor, not silently
 * fall back to some other value.
 *
 * `minimumMetric`/`minimumValue` is a separate, independent floor that
 * applies REGARDLESS of shape (Simple, Tiers, or Buy X Get Y Free) —
 * "Minimum requirement" in RewardEditor.tsx. It's checked first and
 * blocks the reward outright below it, even if a tier's own (lower)
 * minValue would otherwise have qualified: a merchant setting an
 * overall $50 floor on a tiered reward means $50, full stop, not
 * "$50 unless some tier's threshold happens to be lower."
 */
export function resolveDiscountValue(
  reward: {
    value: DiscountValue;
    maxDiscountAmount?: number;
    tierMetric?: TierMetric;
    tiers?: TierBreak[];
    minimumMetric?: TierMetric;
    minimumValue?: number;
  },
  metrics: { quantity: number; subtotal: number },
): { value: DiscountValue; maxDiscountAmount?: number; name?: string; getQuantity?: number; freeProductIds?: string[] } | null {
  if (reward.minimumValue !== undefined && reward.minimumValue > 0) {
    const minimumMetricValue = reward.minimumMetric === "cart.subtotal" ? metrics.subtotal : metrics.quantity;
    if (minimumMetricValue < reward.minimumValue) return null;
  }

  if (reward.tiers && reward.tiers.length > 0) {
    const metricValue = reward.tierMetric === "cart.subtotal" ? metrics.subtotal : metrics.quantity;
    const tier = selectTier(reward.tiers, metricValue);
    if (!tier) return null;

    // Progressive "Buy X get Y free": once selectTier has confirmed the
    // cart cleared the tier's lowered qualifying threshold (X+1), the
    // ACTUAL number of free units ramps up from 1 toward the tier's own
    // Y cap as the cart grows from X+1 toward X+Y, rather than jumping
    // straight to Y the moment the tier qualifies at all.
    const getQuantity =
      tier.getQuantity !== undefined ? Math.max(0, Math.min(tier.getQuantity, metricValue - tier.minValue + tier.getQuantity)) : undefined;

    return { value: tier.value, maxDiscountAmount: tier.maxDiscountAmount, name: tier.name, getQuantity, freeProductIds: tier.freeProductIds };
  }

  return { value: reward.value, maxDiscountAmount: reward.maxDiscountAmount };
}

/** The line-total or order-total money amount a DiscountValue produces, clamped to never exceed the base amount or an optional cap. */
export function computeDiscountAmount(value: DiscountValue, baseAmount: number, maxDiscountAmount?: number): number {
  const raw = value.type === "percentage" ? baseAmount * (value.value / 100) : value.value;
  const capped = maxDiscountAmount !== undefined ? Math.min(raw, maxDiscountAmount) : raw;
  return Math.max(0, Math.min(capped, baseAmount));
}
