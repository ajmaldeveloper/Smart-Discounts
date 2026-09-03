import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  type CartDeliveryOptionsDiscountsGenerateRunInput,
  type CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";
import { evaluateConditionNode, parseConditionTree, type ConditionGroup } from "./condition-engine";
import { computeDiscountAmount, DEFAULT_DISCOUNT_MESSAGE, type RewardConfig } from "./reward-engine";
import { buildCartContext, buildLineContext, parseBuyerData } from "./context";
import type { CompiledCampaignConfig } from "./compiled-campaign";
import { isWithinUsageLimits } from "./usage-limits";

const EMPTY_RESULT: CartDeliveryOptionsDiscountsGenerateRunResult = { operations: [] };

function parseCompiledConfig(rawValue: string | undefined): CompiledCampaignConfig | null {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as Partial<CompiledCampaignConfig> & { conditions?: unknown };
    return {
      id: parsed.id ?? "self",
      priority: parsed.priority ?? 0,
      isExclusive: parsed.isExclusive ?? false,
      conditions: parseConditionTree(parsed.conditions) as ConditionGroup,
      reward: (parsed.reward as RewardConfig) ?? {},
      siblings: parsed.siblings ?? [],
      conflictStrategy: parsed.conflictStrategy ?? "STACK",
      ...(parsed.usageLimitTotal !== undefined ? { usageLimitTotal: parsed.usageLimitTotal } : {}),
      ...(parsed.usageLimitPerCustomer !== undefined ? { usageLimitPerCustomer: parsed.usageLimitPerCustomer } : {}),
    };
  } catch {
    return null;
  }
}

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: CartDeliveryOptionsDiscountsGenerateRunInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  if (!input.cart.deliveryGroups.length) return EMPTY_RESULT;
  if (!input.discount.discountClasses.includes(DiscountClass.Shipping)) return EMPTY_RESULT;

  const compiled = parseCompiledConfig(input.discount.metafield?.value);
  if (!compiled?.reward.shipping) return EMPTY_RESULT;

  // Shipping isn't part of the M10 Smart Conflict Engine's cross-
  // campaign arbitration (a documented v1 scope boundary — see
  // conflict-resolution.ts's module comment), but self's own usage
  // limits still apply regardless.
  const selfUsageCount = Number(input.discount.usageCountMetafield?.value ?? "0") || 0;
  const campaignUsageMap = parseBuyerData(input.cart.buyerIdentity?.customer?.buyerDataMetafield?.value).usage;
  const selfWithinLimits = isWithinUsageLimits({
    usageCount: selfUsageCount,
    usageLimitTotal: compiled.usageLimitTotal,
    customerUsageCount: campaignUsageMap[compiled.id] ?? 0,
    usageLimitPerCustomer: compiled.usageLimitPerCustomer,
  });

  if (!selfWithinLimits) return EMPTY_RESULT;

  const cartContext = buildCartContext(input.cart, input.localization);
  const matches = input.cart.lines.some((line) => {
    const lineContext = buildLineContext(line, cartContext);
    return lineContext ? evaluateConditionNode(compiled.conditions, lineContext) : false;
  });

  if (!matches) return EMPTY_RESULT;

  const reward = compiled.reward.shipping;

  // "Minimum requirement" (see resolveDiscountValue's own comment in
  // reward-engine.ts) — shipping has no tiers to route this through,
  // so it's checked directly here against the same cart-wide
  // quantity/subtotal fields buildCartContext already computed.
  if (reward.minimumValue !== undefined && reward.minimumValue > 0) {
    const minimumMetricValue = reward.minimumMetric === "cart.subtotal" ? (cartContext["cart.subtotal"] as number) : (cartContext["cart.quantity"] as number);
    if (minimumMetricValue < reward.minimumValue) return EMPTY_RESULT;
  }

  const optionTitleFilter = reward.optionTitle?.trim().toLowerCase();

  // Targets the specific delivery OPTION (not the whole delivery
  // group) whenever optionTitle is set — "free Standard Shipping,
  // Express Shipping stays full price" (M8's headline example) needs
  // per-option targeting; DeliveryDiscountCandidateTarget supports
  // this directly via { deliveryOption: { handle } } alongside its
  // { deliveryGroup: { id } } form. Every option's own cost is used as
  // the discount's base amount, so a fixedAmount reward never exceeds
  // what that specific option actually costs.
  const candidates = input.cart.deliveryGroups.flatMap((group) =>
    group.deliveryOptions
      .filter((option) => !optionTitleFilter || (option.title ?? "").trim().toLowerCase() === optionTitleFilter)
      .map((option) => {
        const cost = Number(option.cost.amount);
        const amount = computeDiscountAmount(reward.value, cost, reward.maxDiscountAmount);
        if (amount <= 0) return null;

        return {
          message: reward.name?.trim() || DEFAULT_DISCOUNT_MESSAGE,
          targets: [{ deliveryOption: { handle: option.handle } }],
          value: { fixedAmount: { amount: amount.toFixed(2) } },
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null),
  );

  if (candidates.length === 0) return EMPTY_RESULT;

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates,
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
