import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
  type CartLinesDiscountsGenerateRunInput,
  type CartLinesDiscountsGenerateRunResult,
} from "../generated/api";
import { evaluateConditionNode, parseConditionTree, type ConditionContext, type ConditionGroup } from "./condition-engine";
import { computeDiscountAmount, DEFAULT_DISCOUNT_MESSAGE, resolveDiscountValue, type ProductReward, type RewardConfig } from "./reward-engine";
import { buildCartContext, buildLineContext, lineSubtotal, parseBuyerData, type ContextCartLine } from "./context";
import type { CompiledCampaignConfig, CompiledSiblingCampaign } from "./compiled-campaign";
import { resolveConflicts, type CampaignCandidate } from "./conflict-resolution";
import { isWithinUsageLimits } from "./usage-limits";

const EMPTY_RESULT: CartLinesDiscountsGenerateRunResult = { operations: [] };

function parseCompiledConfig(rawValue: string | undefined): CompiledCampaignConfig | null {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue) as Partial<CompiledCampaignConfig> & { conditions?: unknown };
    return {
      id: parsed.id ?? "self",
      priority: parsed.priority ?? 0,
      isExclusive: parsed.isExclusive ?? false,
      conditions: parseConditionTree(parsed.conditions),
      reward: (parsed.reward as RewardConfig) ?? {},
      siblings: parsed.siblings ?? [],
      conflictStrategy: parsed.conflictStrategy ?? "STACK",
      ...(parsed.maxTotalDiscountPercent !== undefined ? { maxTotalDiscountPercent: parsed.maxTotalDiscountPercent } : {}),
      ...(parsed.maxTotalDiscountAmount !== undefined ? { maxTotalDiscountAmount: parsed.maxTotalDiscountAmount } : {}),
      ...(parsed.usageLimitTotal !== undefined ? { usageLimitTotal: parsed.usageLimitTotal } : {}),
      ...(parsed.usageLimitPerCustomer !== undefined ? { usageLimitPerCustomer: parsed.usageLimitPerCustomer } : {}),
    };
  } catch {
    // A malformed metafield must degrade to "no discount" for this one
    // campaign, never crash the Function and break checkout entirely.
    return null;
  }
}

interface ProductEstimate {
  // `quantity` is only set for a "Buy X, get Y free" tier
  // (TierBreak.getQuantity) — it caps both the discount amount AND the
  // eventual ProductDiscountCandidateTarget to that many units of the
  // line, instead of the whole line, so buying more than X+Y still
  // only gives Y away free. Undefined preserves today's whole-line
  // behavior everywhere else.
  targetLines: Array<{ line: ContextCartLine; amount: number; quantity?: number }>;
  totalAmount: number;
  // The selected tier's own name when set, else the reward's own name
  // — see resolveDiscountValue's own comment. Only self's estimate is
  // ever emitted as an actual discount message; siblings only feed
  // resolveConflicts's arbitration, so their name is never read.
  name?: string;
}

/** Evaluates ONE campaign's (self or sibling) product reward against this cart. Reused for every candidate so self and siblings are judged by byte-identical logic. */
function estimateProductDiscount(
  conditions: ConditionGroup,
  reward: ProductReward | undefined,
  lines: ContextCartLine[],
  cartContext: ConditionContext,
  tierMetrics: { quantity: number; subtotal: number },
): ProductEstimate {
  if (!reward) return { targetLines: [], totalAmount: 0 };

  const matchedLines = lines.filter((line) => {
    const lineContext = buildLineContext(line, cartContext);
    return lineContext ? evaluateConditionNode(conditions, lineContext) : false;
  });

  if (matchedLines.length === 0) return { targetLines: [], totalAmount: 0 };

  // A free-gift tier's "buy X" is measured against the campaign's own
  // matching lines, not the whole cart — "buy 2 of the assigned
  // product" should mean exactly that, even if the cart also holds
  // unrelated items. Every other tier (plain ladders, and the
  // cheapest/most-expensive-line BOGO variant) keeps the existing
  // whole-cart metric — unaffected, since this only branches for tiers
  // that actually set freeProductIds.
  const usesFreeGift = reward.tiers?.some((tier) => tier.freeProductIds?.length) ?? false;
  const effectiveMetrics = usesFreeGift
    ? {
        quantity: matchedLines.reduce((sum, line) => sum + line.quantity, 0),
        subtotal: matchedLines.reduce((sum, line) => sum + lineSubtotal(line), 0),
      }
    : tierMetrics;

  const resolved = resolveDiscountValue(reward, effectiveMetrics);
  if (!resolved) return { targetLines: [], totalAmount: 0 };

  if (resolved.freeProductIds && resolved.freeProductIds.length > 0) {
    // None of these have to satisfy the buy conditions, so eligible
    // lines are found across the WHOLE cart, not just matchedLines —
    // and no discount fires unless the customer has already added at
    // least one of them themselves (a Discount Function can only
    // reprice existing cart lines, never add a new one).
    const freeProductIdSet = new Set(resolved.freeProductIds);
    const eligibleLines = lines.filter(
      (line) => line.merchandise.__typename === "ProductVariant" && freeProductIdSet.has(line.merchandise.product.id),
    );
    if (eligibleLines.length === 0) return { targetLines: [], totalAmount: 0 };

    // Cheapest-first by default (mirrors this app's own
    // CHEAPEST_MATCHING_LINE convention), or most-expensive-first when
    // the merchant picked that instead — either way, getQuantity is a
    // pool shared across every eligible product, not per-product —
    // "get 2 free" from a 2-product pool never gives away more than 2
    // units total, however they're split across the two lines.
    const allocationDirection = resolved.freeGiftAllocation === "MOST_EXPENSIVE" ? -1 : 1;
    const sortedEligibleLines = [...eligibleLines].sort(
      (a, b) => allocationDirection * (lineSubtotal(a) / a.quantity - lineSubtotal(b) / b.quantity),
    );

    let remainingFreeQuantity = resolved.getQuantity ?? Infinity;
    const allocations: { line: ContextCartLine; quantity: number; unitPrice: number }[] = [];

    for (const line of sortedEligibleLines) {
      if (remainingFreeQuantity <= 0) break;
      const unitPrice = lineSubtotal(line) / line.quantity;
      const quantity = Math.min(remainingFreeQuantity, line.quantity);
      allocations.push({ line, quantity, unitPrice });
      remainingFreeQuantity -= quantity;
    }

    const totalBaseAmount = allocations.reduce((sum, allocation) => sum + allocation.unitPrice * allocation.quantity, 0);
    const totalAmount = computeDiscountAmount(resolved.value, totalBaseAmount, resolved.maxDiscountAmount);
    // maxDiscountAmount caps the COMBINED free-gift value across every
    // allocated line, not each one independently — scale each line's
    // own share proportionally so they still sum exactly to that
    // (possibly capped) total.
    const scale = totalBaseAmount > 0 ? totalAmount / totalBaseAmount : 0;

    return {
      targetLines: allocations.map((allocation) => ({
        line: allocation.line,
        amount: allocation.unitPrice * allocation.quantity * scale,
        quantity: allocation.quantity,
      })),
      totalAmount,
      name: resolved.name ?? reward.name,
    };
  }

  const targetLineSet =
    reward.appliesTo === "ALL_MATCHING_LINES"
      ? matchedLines
      : [
          matchedLines.reduce((best, line) => {
            const better =
              reward.appliesTo === "CHEAPEST_MATCHING_LINE"
                ? lineSubtotal(line) < lineSubtotal(best)
                : lineSubtotal(line) > lineSubtotal(best);
            return better ? line : best;
          }),
        ];

  const targetLines = targetLineSet.map((line) => {
    // Buy X get Y free: only Y units of the line are ever discounted,
    // even if the cart holds more than X+Y — the base amount is that
    // many units' worth of the line's own (pre-discount) unit price,
    // never the whole line's subtotal.
    if (resolved.getQuantity !== undefined) {
      const cappedQuantity = Math.min(resolved.getQuantity, line.quantity);
      const unitPrice = lineSubtotal(line) / line.quantity;
      const amount = computeDiscountAmount(resolved.value, unitPrice * cappedQuantity, resolved.maxDiscountAmount);
      return { line, amount, quantity: cappedQuantity };
    }

    return { line, amount: computeDiscountAmount(resolved.value, lineSubtotal(line), resolved.maxDiscountAmount) };
  });

  return {
    targetLines,
    totalAmount: targetLines.reduce((sum, t) => sum + t.amount, 0),
    name: resolved.name ?? reward.name,
  };
}

interface OrderEstimate {
  amount: number;
  // See ProductEstimate's matching comment — only self's estimate is
  // ever emitted as an actual discount message.
  name?: string;
}

/** Evaluates ONE campaign's order reward against this cart. */
function estimateOrderDiscount(
  conditions: ConditionGroup,
  reward: RewardConfig["order"],
  lines: ContextCartLine[],
  cartContext: ConditionContext,
  cartSubtotal: number,
  tierMetrics: { quantity: number; subtotal: number },
): OrderEstimate {
  if (!reward) return { amount: 0 };

  const matches = lines.some((line) => {
    const lineContext = buildLineContext(line, cartContext);
    return lineContext ? evaluateConditionNode(conditions, lineContext) : false;
  });

  if (!matches) return { amount: 0 };

  const resolved = resolveDiscountValue(reward, tierMetrics);
  if (!resolved) return { amount: 0 };

  return {
    amount: computeDiscountAmount(resolved.value, cartSubtotal, resolved.maxDiscountAmount),
    name: resolved.name ?? reward.name,
  };
}

function candidateFrom(id: string, priority: number, isExclusive: boolean, estimatedAmount: number): CampaignCandidate {
  return { id, priority, isExclusive, estimatedAmount };
}

export function cartLinesDiscountsGenerateRun(
  input: CartLinesDiscountsGenerateRunInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) return EMPTY_RESULT;

  const hasProductClass = input.discount.discountClasses.includes(DiscountClass.Product);
  const hasOrderClass = input.discount.discountClasses.includes(DiscountClass.Order);
  if (!hasProductClass && !hasOrderClass) return EMPTY_RESULT;

  const compiled = parseCompiledConfig(input.discount.metafield?.value);
  if (!compiled) return EMPTY_RESULT;

  // Usage limits: self's own total count is live (this discount node's
  // own metafield); a sibling's total count is only as fresh as this
  // campaign's own last publish (see CompiledSiblingCampaign's own
  // comment). Per-customer counts are live for EVERY campaign, self or
  // sibling, since they live on the buyer's own metafield.
  const selfUsageCount = Number(input.discount.usageCountMetafield?.value ?? "0") || 0;
  const campaignUsageMap = parseBuyerData(input.cart.buyerIdentity?.customer?.buyerDataMetafield?.value).usage;

  const selfWithinLimits = isWithinUsageLimits({
    usageCount: selfUsageCount,
    usageLimitTotal: compiled.usageLimitTotal,
    customerUsageCount: campaignUsageMap[compiled.id] ?? 0,
    usageLimitPerCustomer: compiled.usageLimitPerCustomer,
  });

  function siblingWithinLimits(sibling: CompiledSiblingCampaign): boolean {
    return isWithinUsageLimits({
      usageCount: sibling.usageCountAsOfPublish ?? 0,
      usageLimitTotal: sibling.usageLimitTotal,
      customerUsageCount: campaignUsageMap[sibling.id] ?? 0,
      usageLimitPerCustomer: sibling.usageLimitPerCustomer,
    });
  }

  if (!selfWithinLimits) return EMPTY_RESULT;

  const cartContext = buildCartContext(input.cart, input.localization);
  const cartSubtotal = Number(input.cart.cost.subtotalAmount.amount);
  const tierMetrics = { quantity: cartContext["cart.quantity"] as number, subtotal: cartContext["cart.subtotal"] as number };
  const maxTotalDiscountAmount =
    compiled.maxTotalDiscountAmount !== undefined
      ? compiled.maxTotalDiscountAmount
      : compiled.maxTotalDiscountPercent !== undefined
        ? cartSubtotal * (compiled.maxTotalDiscountPercent / 100)
        : undefined;

  const operations: CartLinesDiscountsGenerateRunResult["operations"] = [];

  // M10 Smart Conflict Engine: every candidate (self + every sibling
  // whose reward touches this class and is within its own usage
  // limits) is evaluated against THIS cart through byte-identical
  // logic, then resolveConflicts decides who actually wins. Every
  // sibling campaign's OWN invocation runs this exact same computation
  // over the exact same data, so they all independently converge on
  // the same answer without ever communicating — see
  // conflict-resolution.ts's module comment.
  if (hasProductClass && compiled.reward.product) {
    const self = estimateProductDiscount(compiled.conditions, compiled.reward.product, input.cart.lines, cartContext, tierMetrics);

    if (self.targetLines.length > 0) {
      const siblingEstimates = compiled.siblings
        .filter((sibling): sibling is CompiledSiblingCampaign & { reward: { product: ProductReward } } => Boolean(sibling.reward.product))
        .filter(siblingWithinLimits)
        .map((sibling) => ({
          sibling,
          estimate: estimateProductDiscount(sibling.conditions, sibling.reward.product, input.cart.lines, cartContext, tierMetrics),
        }))
        .filter(({ estimate }) => estimate.targetLines.length > 0);

      const candidates: CampaignCandidate[] = [
        candidateFrom(compiled.id, compiled.priority, compiled.isExclusive, self.totalAmount),
        ...siblingEstimates.map(({ sibling, estimate }) =>
          candidateFrom(sibling.id, sibling.priority, sibling.isExclusive, estimate.totalAmount),
        ),
      ];

      const resolution = resolveConflicts({ strategy: compiled.conflictStrategy, maxTotalDiscountAmount, candidates });
      const factor = resolution.scalingFactors[compiled.id] ?? 0;

      if (factor > 0) {
        const candidatesToEmit = self.targetLines
          .map(({ line, amount, quantity }) => {
            const scaled = amount * factor;
            if (scaled <= 0) return null;
            return {
              message: self.name?.trim() || DEFAULT_DISCOUNT_MESSAGE,
              targets: [{ cartLine: { id: line.id, ...(quantity !== undefined ? { quantity } : {}) } }],
              value: { fixedAmount: { amount: scaled.toFixed(2) } },
            };
          })
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

        if (candidatesToEmit.length > 0) {
          operations.push({
            productDiscountsAdd: { candidates: candidatesToEmit, selectionStrategy: ProductDiscountSelectionStrategy.All },
          });
        }
      }
    }
  }

  if (hasOrderClass && compiled.reward.order) {
    const selfEstimate = estimateOrderDiscount(compiled.conditions, compiled.reward.order, input.cart.lines, cartContext, cartSubtotal, tierMetrics);
    const selfAmount = selfEstimate.amount;

    if (selfAmount > 0) {
      const siblingEstimates = compiled.siblings
        .filter((sibling) => sibling.reward.order)
        .filter(siblingWithinLimits)
        .map((sibling) => ({
          sibling,
          amount: estimateOrderDiscount(sibling.conditions, sibling.reward.order, input.cart.lines, cartContext, cartSubtotal, tierMetrics).amount,
        }))
        .filter(({ amount }) => amount > 0);

      const candidates: CampaignCandidate[] = [
        candidateFrom(compiled.id, compiled.priority, compiled.isExclusive, selfAmount),
        ...siblingEstimates.map(({ sibling, amount }) => candidateFrom(sibling.id, sibling.priority, sibling.isExclusive, amount)),
      ];

      const resolution = resolveConflicts({ strategy: compiled.conflictStrategy, maxTotalDiscountAmount, candidates });
      const factor = resolution.scalingFactors[compiled.id] ?? 0;
      const scaledAmount = selfAmount * factor;

      if (scaledAmount > 0) {
        operations.push({
          orderDiscountsAdd: {
            candidates: [
              {
                message: selfEstimate.name?.trim() || DEFAULT_DISCOUNT_MESSAGE,
                targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
                value: { fixedAmount: { amount: scaledAmount.toFixed(2) } },
              },
            ],
            selectionStrategy: OrderDiscountSelectionStrategy.First,
          },
        });
      }
    }
  }

  return operations.length > 0 ? { operations } : EMPTY_RESULT;
}
