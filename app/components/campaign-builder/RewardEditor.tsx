import type { ReactNode } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import type {
  DiscountValue,
  OrderReward,
  ProductReward,
  RewardConfig,
  ShippingReward,
  TierBreak,
  TierMetric,
} from "../../lib/reward-types";
import { currencySymbol } from "../../lib/currency-display";
import type { HydratedResourceRef } from "../../services/shopify-resources.server";

// Mirrors product-options's LogicTab.tsx convention: s-select/s-checkbox
// fire onChange, s-text-field fires onInput, both read the same way.
type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}
function readChecked(event: ControlEvent): boolean {
  const target = (event.target ?? event.currentTarget) as { checked?: unknown } | null;
  return Boolean(target?.checked);
}

interface Props {
  value: RewardConfig;
  onChange: (next: RewardConfig) => void;
  currencyCode: string;
  productRefs: HydratedResourceRef[];
  onProductRefsChange: (next: HydratedResourceRef[]) => void;
  // Shopify's own cart/checkout always displays the CODE itself for a
  // redeemed discount code — a DiscountCodeApplication has no
  // customizable title the way an automatic discount's does (see
  // order-processing.server.ts's applicationName, which already reads
  // `.code` for this exact reason). Every "Discount name" field below
  // is a no-op for a CODE campaign as a result; the banner says so
  // instead of leaving a merchant to discover it at checkout.
  campaignKind: "CODE" | "AUTOMATIC";
  // Plan gates (see entitlements.server.ts) — disabled controls stay
  // visible with an "(upgrade required)" label rather than hidden, and
  // app.campaigns.$id.tsx's saveReward action enforces the same gate
  // server-side by inspecting the submitted reward for actual usage.
  hasTiers: boolean;
  hasFreeGiftBogo: boolean;
  hasMinimumRequirement: boolean;
}

type Tiered = { tierMetric?: TierMetric; tiers?: TierBreak[] };

// A quantity threshold and a subtotal threshold live in completely
// different units — a leftover "3" from quantity tiers reads as a
// nonsensical "$3" once the merchant switches "Tier based on" to
// subtotal, so both the initial default and a metric switch itself
// reset to whichever of these actually fits the newly-selected metric.
function defaultMinValueFor(metric: TierMetric): number {
  return metric === "cart.subtotal" ? 100 : 3;
}

export default function RewardEditor({ value, onChange, currencyCode, productRefs, onProductRefsChange, campaignKind, hasTiers, hasFreeGiftBogo, hasMinimumRequirement }: Props) {
  const currency = currencySymbol(currencyCode);
  return (
    <s-stack direction="block" gap="base">
      <RewardSection
        title="Product discount"
        enabled={Boolean(value.product)}
        onToggle={(enabled) =>
          onChange({
            ...value,
            product: enabled ? { value: { type: "percentage", value: 10 }, appliesTo: "ALL_MATCHING_LINES" } : undefined,
          })
        }
      >
        {value.product && (
          <s-stack direction="block" gap="base">
            <TieredValueEditor
              name={value.product.name}
              onNameChange={(name) => onChange({ ...value, product: { ...(value.product as ProductReward), name } })}
              reward={value.product}
              currency={currency}
              bogo
              productRefs={productRefs}
              onProductRefsChange={onProductRefsChange}
              hideName={campaignKind === "CODE"}
              hasTiers={hasTiers}
              hasFreeGiftBogo={hasFreeGiftBogo}
              hasMinimumRequirement={hasMinimumRequirement}
              onChange={(patch) => onChange({ ...value, product: { ...(value.product as ProductReward), ...patch } })}
            />
          </s-stack>
        )}
      </RewardSection>

      <RewardSection
        title="Order discount"
        enabled={Boolean(value.order)}
        onToggle={(enabled) => onChange({ ...value, order: enabled ? { value: { type: "percentage", value: 10 } } : undefined })}
      >
        {value.order && (
          <s-stack direction="block" gap="base">
            <TieredValueEditor
              name={value.order.name}
              onNameChange={(name) => onChange({ ...value, order: { ...(value.order as OrderReward), name } })}
              reward={value.order}
              currency={currency}
              hideName={campaignKind === "CODE"}
              hasTiers={hasTiers}
              hasMinimumRequirement={hasMinimumRequirement}
              onChange={(patch) => onChange({ ...value, order: { ...(value.order as OrderReward), ...patch } })}
            />
          </s-stack>
        )}
      </RewardSection>

      <RewardSection
        title="Shipping discount"
        enabled={Boolean(value.shipping)}
        onToggle={(enabled) => onChange({ ...value, shipping: enabled ? { value: { type: "percentage", value: 100 } } : undefined })}
      >
        {value.shipping && (
          <s-stack direction="block" gap="base">
            <s-grid
              gridTemplateColumns={`repeat(${(campaignKind === "CODE" ? 1 : 2) + (value.shipping.minimumValue !== undefined ? 2 : 1)}, minmax(160px, 1fr))`}
              gap="base"
              alignItems="end"
            >
              {campaignKind !== "CODE" && (
                <NameField
                  value={value.shipping.name}
                  onChange={(name) => onChange({ ...value, shipping: { ...(value.shipping as ShippingReward), name } })}
                />
              )}

              <s-text-field
                label="Only this delivery option (optional)"
                value={value.shipping.optionTitle ?? ""}
                placeholder="e.g. Standard — leave blank for all"
                onInput={(event: ControlEvent) =>
                  onChange({ ...value, shipping: { ...(value.shipping as ShippingReward), optionTitle: readValue(event) || undefined } })
                }
              />

              <MinimumRequirementFields
                metric={value.shipping.minimumMetric}
                value={value.shipping.minimumValue}
                currency={currency}
                disabled={!hasMinimumRequirement}
                onChange={(minimumMetric, minimumValue) =>
                  onChange({ ...value, shipping: { ...(value.shipping as ShippingReward), minimumMetric, minimumValue } })
                }
              />
            </s-grid>

            <s-grid gridTemplateColumns="repeat(3, minmax(160px, 1fr))" gap="base" alignItems="end">
              <DiscountValueFields
                value={value.shipping.value}
                currency={currency}
                onChange={(next) => onChange({ ...value, shipping: { ...(value.shipping as ShippingReward), value: next } })}
              />

              <CapField
                value={value.shipping.maxDiscountAmount}
                currency={currency}
                onChange={(cap) => onChange({ ...value, shipping: { ...(value.shipping as ShippingReward), maxDiscountAmount: cap } })}
              />
            </s-grid>

            <s-text tone="neutral">100% = free shipping</s-text>
          </s-stack>
        )}
      </RewardSection>
    </s-stack>
  );
}

function RewardSection({
  title,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: ReactNode;
}) {
  return (
    <s-box borderWidth="base" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-switch label={title} checked={enabled} onChange={(event: ControlEvent) => onToggle(readChecked(event))} />
        {enabled && children}
      </s-stack>
    </s-box>
  );
}

type DiscountShape = "SIMPLE" | "TIERS" | "BOGO";
type Minimum = { minimumMetric?: TierMetric; minimumValue?: number };
type TieredReward = { value: DiscountValue; maxDiscountAmount?: number; appliesTo?: ProductReward["appliesTo"] } & Tiered & Minimum;

/**
 * Shared by Product and Order rewards (M7): a flat value/cap, a ladder
 * of quantity/subtotal breaks ("Tiers"), or — Product only — "Buy X,
 * get Y free" (BogoEditor below), which is really just a single tier
 * with `getQuantity` set, wearing a purpose-built UI. All three modes
 * write into the exact same `tiers`/`tierMetric` shape, so switching
 * between Tiers and BOGO round-trips the same single-tier data.
 */
function TieredValueEditor({
  name,
  onNameChange,
  reward,
  currency,
  onChange,
  bogo = false,
  productRefs,
  onProductRefsChange,
  hideName = false,
  hasTiers,
  hasFreeGiftBogo = false,
  hasMinimumRequirement,
}: {
  name: string | undefined;
  onNameChange: (next: string | undefined) => void;
  reward: TieredReward;
  currency: string;
  onChange: (patch: Partial<TieredReward>) => void;
  // Only Product rewards get the BOGO shape — it caps the discount to
  // a specific number of UNITS on one cart line (TierBreak.getQuantity),
  // a concept that only makes sense once there's a "line" to speak of.
  // Order rewards discount the whole cart subtotal as one flat amount.
  bogo?: boolean;
  productRefs?: HydratedResourceRef[];
  onProductRefsChange?: (next: HydratedResourceRef[]) => void;
  // A code campaign's cart/checkout always shows the CODE itself, never
  // a custom message — see RewardEditor's own Props comment. Every name
  // field here (reward-level and per-tier) is a no-op for one, so all
  // of them are hidden entirely rather than left sitting there unused.
  hideName?: boolean;
  hasTiers: boolean;
  hasFreeGiftBogo?: boolean;
  hasMinimumRequirement: boolean;
}) {
  const tiers = reward.tiers ?? [];
  const isTiered = tiers.length > 0;
  const isBogo = bogo && isTiered && tiers.length === 1 && tiers[0].getQuantity !== undefined;
  const shape: DiscountShape = !isTiered ? "SIMPLE" : isBogo ? "BOGO" : "TIERS";
  const metric = reward.tierMetric ?? "cart.quantity";

  const setShape = (next: DiscountShape) => {
    if (next === "SIMPLE") {
      onChange({ tierMetric: undefined, tiers: undefined });
      return;
    }

    if (next === "TIERS") {
      onChange({
        tierMetric: metric,
        tiers: isTiered && !isBogo ? tiers : [{ minValue: defaultMinValueFor(metric), value: reward.value }],
      });
      return;
    }

    onChange({
      tierMetric: "cart.quantity",
      tiers: [{ minValue: 2, value: { type: "percentage", value: 100 }, getQuantity: 1 }],
      // A separate minimum requirement would either sit below the BOGO's
      // own Buy+Get threshold (reward-engine.ts's resolveDiscountValue
      // checks it before ever looking at tiers, so it'd be dead weight)
      // or silently ABOVE it, making the real qualifying quantity higher
      // than what "Buy X" visibly promises. Clearing it keeps "Buy X"
      // the one and only quantity gate for this shape.
      minimumMetric: undefined,
      minimumValue: undefined,
      ...(bogo ? { appliesTo: "CHEAPEST_MATCHING_LINE" as const } : {}),
    });
  };

  // BOGO always has exactly one tier, and BogoEditor already renders its
  // own name field bound to that tier — showing this reward-level name
  // too just duplicates the same "Discount name (optional)" field with
  // no way to tell which one actually does anything (Tiers keeps both:
  // this is the default, each tier row can still override it).
  const showTopLevelName = !hideName && shape !== "BOGO";
  // See setShape's BOGO branch above — "Buy X" already IS the minimum
  // requirement for this shape, so a second, separate minimum-quantity
  // field here is redundant at best and silently conflicting at worst.
  const showMinimumRequirement = shape !== "BOGO";

  // Exactly as many equal tracks as fields actually rendered below —
  // MinimumRequirementFields renders 1 field ("None") or 2 (a type set)
  // — a fixed 4-track template with an unfilled 4th track leaves the
  // whole row shrink-wrapped short of the container's full width
  // instead of stretching to fill it, unlike a fully-populated grid.
  const nameShapeMinimumColumns =
    (showTopLevelName ? 2 : 1) + (showMinimumRequirement ? (reward.minimumValue !== undefined ? 2 : 1) : 0);

  return (
    <s-stack direction="block" gap="base">
      <s-grid gridTemplateColumns={`repeat(${nameShapeMinimumColumns}, minmax(160px, 1fr))`} gap="base" alignItems="end">
        {showTopLevelName && <NameField value={name} onChange={onNameChange} />}

        <s-select label="Discount shape" value={shape} onChange={(event: ControlEvent) => setShape(readValue(event) as DiscountShape)}>
          <s-option value="SIMPLE">Simple</s-option>
          <s-option value="TIERS" disabled={!hasTiers}>
            {hasTiers ? "Tiers (buy more, save more)" : "Tiers (upgrade required)"}
          </s-option>
          {bogo && (
            <s-option value="BOGO" disabled={!hasTiers}>
              {hasTiers ? "Buy X, get Y free" : "Buy X, get Y free (upgrade required)"}
            </s-option>
          )}
        </s-select>

        {showMinimumRequirement && (
          <MinimumRequirementFields
            metric={reward.minimumMetric}
            value={reward.minimumValue}
            currency={currency}
            disabled={!hasMinimumRequirement}
            onChange={(minimumMetric, minimumValue) => onChange({ minimumMetric, minimumValue })}
          />
        )}
      </s-grid>

      {shape !== "BOGO" && reward.appliesTo !== undefined && (
        <s-select
          label="Applies to"
          value={reward.appliesTo}
          onChange={(event: ControlEvent) => onChange({ appliesTo: readValue(event) as ProductReward["appliesTo"] })}
        >
          <s-option value="ALL_MATCHING_LINES">All matching lines</s-option>
          <s-option value="CHEAPEST_MATCHING_LINE">Cheapest matching line</s-option>
          <s-option value="MOST_EXPENSIVE_MATCHING_LINE">Most expensive matching line</s-option>
        </s-select>
      )}

      {shape === "SIMPLE" && (
        <>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <DiscountValueFields value={reward.value} currency={currency} onChange={(next) => onChange({ value: next })} />
          </s-grid>
          <CapField value={reward.maxDiscountAmount} currency={currency} onChange={(cap) => onChange({ maxDiscountAmount: cap })} />
        </>
      )}

      {shape === "TIERS" && (
        <TierListEditor
          tierMetric={metric}
          tiers={tiers}
          currency={currency}
          hideName={hideName}
          onChange={(tierMetric, nextTiers) => onChange({ tierMetric, tiers: nextTiers })}
        />
      )}

      {shape === "BOGO" && (
        <BogoEditor
          tier={tiers[0]}
          productRefs={productRefs ?? []}
          onProductRefsChange={onProductRefsChange ?? (() => {})}
          hideName={hideName}
          hasFreeGiftBogo={hasFreeGiftBogo}
          onChange={(nextTier) => onChange({ tierMetric: "cart.quantity", tiers: [nextTier] })}
        />
      )}
    </s-stack>
  );
}

type PickerImage = { originalSrc?: string; url?: string };
type PickerItem = { id: string; title: string; images?: PickerImage[] };

function pickerImage(item: PickerItem): string | null {
  return item.images?.[0]?.originalSrc || item.images?.[0]?.url || null;
}

/**
 * "Buy X, get Y free": a single tier stored at minValue X+Y, value
 * fixed at 100% off, capped to Y units via getQuantity — the merchant
 * only ever sees "Buy" and "Get free" counts. Free units ramp in
 * PROGRESSIVELY once the cart passes X, not all at once at X+Y: at
 * X+1 the shopper already gets 1 free, at X+2 they get 2, and so on up
 * to the Y cap (see selectTier/resolveDiscountValue in reward-types.ts
 * for the actual ramp math — mirrored byte-for-byte in reward-engine.ts). The free
 * product picker below sets TierBreak.freeProductIds — a POOL of
 * eligible products (a DIFFERENT set than whatever the campaign's own
 * conditions match — e.g. buy 2 shirts, get a free tote bag OR cap,
 * whichever the shopper already has). getQuantity is shared across the
 * whole pool, allocated cheapest-line-first at checkout — "get 2 free"
 * never gives away more than 2 units total even with several eligible
 * products in cart. Left empty, the discount falls back to the
 * cheapest line among the campaign's own matching products instead
 * (the reward's appliesTo, defaulted to CHEAPEST_MATCHING_LINE when
 * this shape is picked — see TieredValueEditor's setShape).
 */
function BogoEditor({
  tier,
  productRefs,
  onProductRefsChange,
  onChange,
  hideName = false,
  hasFreeGiftBogo = false,
}: {
  tier: TierBreak;
  productRefs: HydratedResourceRef[];
  onProductRefsChange: (next: HydratedResourceRef[]) => void;
  onChange: (next: TierBreak) => void;
  hideName?: boolean;
  hasFreeGiftBogo?: boolean;
}) {
  const shopify = useAppBridge();
  const getQuantity = tier.getQuantity ?? 1;
  const buyQuantity = Math.max(0, tier.minValue - getQuantity);
  const freeProductIds = tier.freeProductIds ?? [];
  const freeProductRefs = freeProductIds.map((id) => productRefs.find((ref) => ref.id === id) ?? null);

  const rebuild = (nextBuy: number, nextGet: number) => {
    const safeGet = Math.max(1, Math.floor(nextGet) || 1);
    const safeBuy = Math.max(0, Math.floor(nextBuy) || 0);
    onChange({ ...tier, minValue: safeBuy + safeGet, getQuantity: safeGet, value: { type: "percentage", value: 100 } });
  };

  const chooseFreeProducts = async () => {
    const selected = (await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds: freeProductIds.map((id) => ({ id })),
      filter: { variants: false, archived: false },
    })) as PickerItem[] | undefined;
    if (!selected) return;

    const chosenIds = selected.map((item) => item.id);
    const existingRefsById = new Map(productRefs.map((ref) => [ref.id, ref]));
    for (const item of selected) existingRefsById.set(item.id, { id: item.id, title: item.title, imageUrl: pickerImage(item) });
    onProductRefsChange([...existingRefsById.values()]);
    onChange({ ...tier, freeProductIds: chosenIds });
  };

  const removeFreeProduct = (id: string) => {
    onChange({ ...tier, freeProductIds: freeProductIds.filter((existingId) => existingId !== id) });
  };

  return (
    <s-stack direction="block" gap="base">
      <s-grid gridTemplateColumns={`repeat(${hideName ? 2 : 3}, minmax(120px, 1fr))`} gap="base" alignItems="end">
        <s-number-field
          label="Buy"
          min={0}
          value={String(buyQuantity)}
          onInput={(event: ControlEvent) => rebuild(Number(readValue(event)) || 0, getQuantity)}
        />

        <s-number-field
          label="Get free"
          min={1}
          value={String(getQuantity)}
          onInput={(event: ControlEvent) => rebuild(buyQuantity, Number(readValue(event)) || 1)}
        />

        {!hideName && <NameField value={tier.name} onChange={(name) => onChange({ ...tier, name })} />}
      </s-grid>

      <s-text color="subdued">
        Free units scale in gradually past the buy quantity — e.g. buying {buyQuantity + 1} already gets 1 free, up to {getQuantity} free at{" "}
        {buyQuantity + getQuantity}.
      </s-text>

      <s-stack direction="block" gap="small">
        <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
          <s-text>{hasFreeGiftBogo ? "Free products (optional)" : "Free products (upgrade required)"}</s-text>
          <s-button icon="product" disabled={!hasFreeGiftBogo} onClick={chooseFreeProducts}>
            {freeProductIds.length > 0 ? "Change products" : "Choose products"}
          </s-button>
        </s-grid>

        {freeProductIds.length > 0 ? (
          <s-stack direction="block" gap="small-200">
            {freeProductIds.map((id, index) => {
              const ref = freeProductRefs[index];
              return (
                <s-box key={id} borderWidth="base" borderColor="subdued" borderRadius="base" padding="small">
                  <s-grid gridTemplateColumns="auto 1fr auto" gap="small" alignItems="center">
                    <s-thumbnail src={ref?.imageUrl ?? undefined} alt={ref?.title ?? "Product unavailable"} size="small" />
                    {ref ? (
                      <s-text>{ref.title}</s-text>
                    ) : (
                      <s-stack direction="block" gap="small-400">
                        <s-text tone="critical">Product unavailable</s-text>
                        <s-text color="subdued">This product may have been deleted. Remove it and choose again.</s-text>
                      </s-stack>
                    )}
                    <s-button
                      icon="delete"
                      tone="critical"
                      variant="tertiary"
                      accessibilityLabel={`Remove ${ref?.title ?? "unavailable product"}`}
                      onClick={() => removeFreeProduct(id)}
                    />
                  </s-grid>
                </s-box>
              );
            })}

            {freeProductIds.length > 1 ? (
              <s-select
                label="When the shopper has more than one of these"
                value={tier.freeGiftAllocation ?? "CHEAPEST"}
                onChange={(event: ControlEvent) =>
                  onChange({ ...tier, freeGiftAllocation: readValue(event) === "MOST_EXPENSIVE" ? "MOST_EXPENSIVE" : undefined })
                }
              >
                <s-option value="CHEAPEST">Give away the cheapest one first</s-option>
                <s-option value="MOST_EXPENSIVE">Give away the most expensive one first</s-option>
              </s-select>
            ) : (
              <s-text color="subdued">
                &ldquo;Get free&rdquo; units are shared across all {freeProductIds.length} products above.
              </s-text>
            )}
          </s-stack>
        ) : (
          <s-text tone="neutral">No products chosen — the cheapest matching item will be free instead.</s-text>
        )}
      </s-stack>
    </s-stack>
  );
}

function TierListEditor({
  tierMetric,
  tiers,
  currency,
  onChange,
  hideName = false,
}: {
  tierMetric: TierMetric;
  tiers: TierBreak[];
  currency: string;
  onChange: (tierMetric: TierMetric, tiers: TierBreak[]) => void;
  hideName?: boolean;
}) {
  return (
    <s-stack direction="block" gap="small">
      <s-select
        label="Tier based on"
        value={tierMetric}
        onChange={(event: ControlEvent) => {
          const nextMetric = readValue(event) as TierMetric;
          const nextDefault = defaultMinValueFor(nextMetric);
          onChange(nextMetric, tiers.map((tier) => ({ ...tier, minValue: nextDefault })));
        }}
      >
        <s-option value="cart.quantity">Cart quantity</s-option>
        <s-option value="cart.subtotal">Cart subtotal</s-option>
      </s-select>

      {tiers.map((tier, index) => {
        const quantityLabel = tier.exactMatch
          ? tierMetric === "cart.quantity" ? "Exact quantity" : "Exact subtotal"
          : tierMetric === "cart.quantity" ? "At quantity ≥" : "At subtotal ≥";

        return (
          <s-box key={index} borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
            <s-stack direction="block" gap="base">
              <s-grid gridTemplateColumns={hideName ? "auto" : "1fr auto"} gap="base" alignItems="start" justifyContent="end">
                {!hideName && (
                  <NameField
                    value={tier.name}
                    onChange={(name) => {
                      const next = [...tiers];
                      next[index] = { ...tier, name };
                      onChange(tierMetric, next);
                    }}
                  />
                )}

                <s-button
                  type="button"
                  icon="delete"
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel={`Remove tier ${index + 1}`}
                  onClick={() => onChange(tierMetric, tiers.filter((_, i) => i !== index))}
                />
              </s-grid>

              <s-grid gridTemplateColumns="repeat(4, minmax(120px, 200px))" gap="base" alignItems="end">
                <s-number-field
                  label={quantityLabel}
                  prefix={tierMetric === "cart.subtotal" ? currency : undefined}
                  min={0}
                  value={String(tier.minValue)}
                  onInput={(event: ControlEvent) => {
                    const next = [...tiers];
                    next[index] = { ...tier, minValue: Number(readValue(event)) || 0 };
                    onChange(tierMetric, next);
                  }}
                />

                <DiscountValueFields
                  value={tier.value}
                  currency={currency}
                  onChange={(nextValue) => {
                    const next = [...tiers];
                    next[index] = { ...tier, value: nextValue };
                    onChange(tierMetric, next);
                  }}
                />

                <CapField
                  value={tier.maxDiscountAmount}
                  currency={currency}
                  onChange={(cap) => {
                    const next = [...tiers];
                    next[index] = { ...tier, maxDiscountAmount: cap };
                    onChange(tierMetric, next);
                  }}
                />
              </s-grid>

              <s-checkbox
                label={tierMetric === "cart.quantity" ? "Exact quantity only" : "Exact subtotal only"}
                checked={Boolean(tier.exactMatch)}
                onChange={(event: ControlEvent) => {
                  const next = [...tiers];
                  next[index] = { ...tier, exactMatch: readChecked(event) };
                  onChange(tierMetric, next);
                }}
              />
            </s-stack>
          </s-box>
        );
      })}

      <div>
        <s-button
          type="button"
          onClick={() => onChange(tierMetric, [...tiers, { minValue: defaultMinValueFor(tierMetric), value: { type: "percentage", value: 10 } }])}
        >
          Add tier
        </s-button>
      </div>
    </s-stack>
  );
}

/**
 * Returns the two fields as siblings, not wrapped in their own grid —
 * every caller already places this inside its own grid/stack (a plain
 * 2-column one for the flat case, or one shared row alongside the
 * quantity field and delete button for a tier row). Nesting a second
 * grid here instead would make the outer grid treat both fields as one
 * opaque block, throwing off column-wrapping math there (the exact bug
 * that made the delete button land alone on its own row in a tier).
 */
function DiscountValueFields({
  value,
  currency,
  onChange,
}: {
  value: DiscountValue;
  currency: string;
  onChange: (next: DiscountValue) => void;
}) {
  return (
    <>
      <s-select
        label="Discount type"
        value={value.type}
        onChange={(event: ControlEvent) => {
          const type = readValue(event) === "fixedAmount" ? "fixedAmount" : "percentage";
          onChange({ type, value: value.value } as DiscountValue);
        }}
      >
        <s-option value="percentage">Percentage off</s-option>
        <s-option value="fixedAmount">Fixed amount off</s-option>
      </s-select>

      <s-number-field
        label={value.type === "percentage" ? "Percent off" : "Amount off"}
        prefix={value.type === "percentage" ? "%" : currency}
        min={0}
        max={value.type === "percentage" ? 100 : undefined}
        value={String(value.value)}
        onInput={(event: ControlEvent) => onChange({ ...value, value: Number(readValue(event)) || 0 })}
      />
    </>
  );
}

/** The message shown to the customer in their cart and at checkout next to this discount — falls back to a generic default in the Function when left blank (see cart_lines_discounts_generate_run.ts's DEFAULT_DISCOUNT_MESSAGE). */
function NameField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <s-text-field
      label="Discount name (optional)"
      value={value ?? ""}
      placeholder="e.g. Black Friday Sale"
      onInput={(event: ControlEvent) => onChange(readValue(event).trim() || undefined)}
    />
  );
}

function CapField({
  value,
  currency,
  onChange,
}: {
  value: number | undefined;
  currency: string;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <s-number-field
      label="Max discount (optional)"
      prefix={currency}
      min={0}
      value={value !== undefined ? String(value) : ""}
      onInput={(event: ControlEvent) => {
        const raw = readValue(event).trim();
        onChange(raw === "" ? undefined : Number(raw) || 0);
      }}
    />
  );
}

type MinimumType = "NONE" | "QUANTITY" | "PURCHASE";

/**
 * An independent floor on top of whatever shape (Simple/Tiers/BOGO) is
 * selected — see resolveDiscountValue's own comment on why it's
 * checked before any tier. Kept separate from the tier system rather
 * than reusing "just add a tier" so it applies uniformly across all
 * three shapes, including Simple (which has no tiers at all) and BOGO
 * (whose own Buy/Get counts serve a different purpose — the eligible
 * quantity for the free item, not a floor on the whole reward).
 *
 * Returns its field(s) as siblings, not wrapped in their own grid —
 * mirrors DiscountValueFields' own convention (see its comment): every
 * caller places this inside a shared outer grid alongside the name and
 * shape fields, and nesting a second grid here would break that
 * grid's column-wrapping math instead.
 */
function MinimumRequirementFields({
  metric,
  value,
  currency,
  onChange,
  disabled = false,
}: {
  metric: TierMetric | undefined;
  value: number | undefined;
  currency: string;
  onChange: (metric: TierMetric | undefined, value: number | undefined) => void;
  disabled?: boolean;
}) {
  const type: MinimumType = value === undefined ? "NONE" : metric === "cart.subtotal" ? "PURCHASE" : "QUANTITY";

  return (
    <>
      <s-select
        label={disabled ? "Minimum requirement (upgrade required)" : "Minimum requirement"}
        value={type}
        disabled={disabled}
        onChange={(event: ControlEvent) => {
          const next = readValue(event) as MinimumType;
          if (next === "NONE") {
            onChange(undefined, undefined);
            return;
          }
          onChange(next === "PURCHASE" ? "cart.subtotal" : "cart.quantity", value ?? (next === "PURCHASE" ? 100 : 1));
        }}
      >
        <s-option value="NONE">None</s-option>
        <s-option value="QUANTITY">Minimum quantity</s-option>
        <s-option value="PURCHASE">Minimum purchase amount</s-option>
      </s-select>

      {type !== "NONE" && (
        <s-number-field
          label={type === "PURCHASE" ? "Minimum amount" : "Minimum quantity"}
          prefix={type === "PURCHASE" ? currency : undefined}
          min={0}
          value={String(value ?? 0)}
          disabled={disabled}
          onInput={(event: ControlEvent) => onChange(metric, Number(readValue(event)) || 0)}
        />
      )}
    </>
  );
}
