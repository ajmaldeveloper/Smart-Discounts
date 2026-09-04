import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import db from "../db.server";
import { createEmptyGroup, normalizeConditionNode } from "../lib/campaign-types";
import { normalizeRewardConfig } from "../lib/reward-types";
import { normalizeRecurrenceRule } from "../lib/recurrence";

export type CampaignKind = "AUTOMATIC" | "CODE";

export async function listCampaigns(shopId: string) {
  return db.campaign.findMany({
    where: { shopId },
    orderBy: { updatedAt: "desc" },
  });
}

export async function getCampaign(shopId: string, id: string) {
  return db.campaign.findFirst({ where: { id, shopId } });
}

/**
 * Copies a campaign's targeting/reward/stacking configuration into a
 * new DRAFT — never its Shopify Discount node or discount code, both
 * of which must be unique per shop. A duplicated CODE campaign needs
 * its own code entered on the General tab before it can be published.
 */
export async function duplicateCampaign(shopId: string, id: string) {
  const original = await getCampaign(shopId, id);
  if (!original) return null;

  return db.campaign.create({
    data: {
      shopId,
      name: `${original.name} (copy)`,
      kind: original.kind,
      discountCode: null,
      status: "DRAFT",
      priority: original.priority,
      isExclusive: original.isExclusive,
      usageLimitTotal: original.usageLimitTotal,
      usageLimitPerCustomer: original.usageLimitPerCustomer,
      audienceJson: original.audienceJson as Prisma.InputJsonValue | undefined,
      marketJson: original.marketJson as Prisma.InputJsonValue | undefined,
      productScopeJson: original.productScopeJson as Prisma.InputJsonValue | undefined,
      conditionsJson: original.conditionsJson as Prisma.InputJsonValue,
      rewardJson: original.rewardJson as Prisma.InputJsonValue,
      stackingJson: original.stackingJson as Prisma.InputJsonValue | undefined,
    },
  });
}

const VARIANT_SUFFIX = /\s+—\s+Variant [AB]$/;

function baseExperimentName(name: string): string {
  return name.replace(VARIANT_SUFFIX, "").trim();
}

/**
 * Turns a campaign into "Variant A" of a new A/B test and creates an
 * independent DRAFT "Variant B" duplicate sharing the same targeting/
 * schedule — only its reward is meant to then be edited differently,
 * that's the whole point of the test. A shopper's cart attribute (set
 * by public/widgets/ab-test-bootstrap.js) decides which variant, if
 * either, actually applies at checkout — see
 * extensions/winslet-discounts/src/cart_lines_discounts_generate_run.ts.
 */
export async function startExperiment(shopId: string, id: string) {
  const original = await getCampaign(shopId, id);
  if (!original || original.experimentId) return null;

  const experimentId = crypto.randomUUID();
  const baseName = baseExperimentName(original.name);

  const variantA = await db.campaign.update({
    where: { id: original.id },
    data: { name: `${baseName} — Variant A`, experimentId, experimentVariant: "A", experimentWeight: 50 },
  });

  const variantB = await db.campaign.create({
    data: {
      shopId,
      name: `${baseName} — Variant B`,
      kind: original.kind,
      discountCode: null,
      status: "DRAFT",
      priority: original.priority,
      isExclusive: original.isExclusive,
      usageLimitTotal: original.usageLimitTotal,
      usageLimitPerCustomer: original.usageLimitPerCustomer,
      audienceJson: original.audienceJson as Prisma.InputJsonValue | undefined,
      marketJson: original.marketJson as Prisma.InputJsonValue | undefined,
      productScopeJson: original.productScopeJson as Prisma.InputJsonValue | undefined,
      conditionsJson: original.conditionsJson as Prisma.InputJsonValue,
      rewardJson: original.rewardJson as Prisma.InputJsonValue,
      stackingJson: original.stackingJson as Prisma.InputJsonValue | undefined,
      experimentId,
      experimentVariant: "B",
    },
  });

  return { variantA, variantB };
}

/** The other campaign sharing this one's experimentId, if any. */
export async function getExperimentSibling(shopId: string, campaign: { id: string; experimentId: string | null }) {
  if (!campaign.experimentId) return null;
  return db.campaign.findFirst({ where: { shopId, experimentId: campaign.experimentId, id: { not: campaign.id } } });
}

/** Percent of traffic sent to Variant A only ever lives on the "A" row — read/write through whichever variant the merchant happens to be viewing. */
export async function updateExperimentWeight(shopId: string, id: string, weight: number) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign?.experimentId) return null;

  const clamped = Math.max(0, Math.min(100, Math.round(weight)));
  const variantA =
    campaign.experimentVariant === "A"
      ? campaign
      : await db.campaign.findFirst({ where: { shopId, experimentId: campaign.experimentId, experimentVariant: "A" } });
  if (!variantA) return null;

  return db.campaign.update({ where: { id: variantA.id }, data: { experimentWeight: clamped } });
}

/**
 * Ends an A/B test: the winner becomes a normal standalone campaign
 * again (experiment fields cleared, the "— Variant A/B" suffix
 * stripped from its name); the loser's fields are cleared the same
 * way and returned so the caller can pause its live Shopify Discount,
 * if it has one — that Admin API call needs `admin`, which this
 * DB-only model layer doesn't have (see the route's own action()).
 */
export async function declareExperimentWinner(shopId: string, winnerId: string) {
  const winner = await getCampaign(shopId, winnerId);
  if (!winner?.experimentId) return null;

  const loser = await getExperimentSibling(shopId, winner);

  const cleanedWinner = await db.campaign.update({
    where: { id: winner.id },
    data: { name: baseExperimentName(winner.name), experimentId: null, experimentVariant: null, experimentWeight: null },
  });

  const cleanedLoser = loser
    ? await db.campaign.update({
        where: { id: loser.id },
        data: { name: baseExperimentName(loser.name), experimentId: null, experimentVariant: null, experimentWeight: null },
      })
    : null;

  return { winner: cleanedWinner, loser: cleanedLoser };
}

export async function createCampaign(
  shopId: string,
  input: { name: string; kind: CampaignKind; discountCode?: string | null },
) {
  return db.campaign.create({
    data: {
      shopId,
      name: input.name,
      kind: input.kind,
      discountCode: input.kind === "CODE" ? (input.discountCode?.trim() || null) : null,
      status: "DRAFT",
      conditionsJson: createEmptyGroup("ALL") as unknown as Prisma.InputJsonValue,
      // No reward configured yet — set once the Discount Function
      // Engine (M4) defines the shape. A campaign can't be activated
      // until it has one; that check lands alongside M4/M9's publish
      // flow, not here at creation time.
      rewardJson: {} as Prisma.InputJsonValue,
    },
  });
}

export async function updateCampaignGeneral(
  shopId: string,
  id: string,
  input: { name: string; discountCode?: string | null },
) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign) return null;

  return db.campaign.update({
    where: { id },
    data: {
      name: input.name,
      discountCode:
        campaign.kind === "CODE" ? (input.discountCode?.trim() || null) : null,
    },
  });
}

/** Normalizes and repairs whatever tree the builder submits before persisting — malformed rows never reach the database. */
export async function updateCampaignConditions(shopId: string, id: string, rawTree: unknown) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign) return null;

  const normalized = normalizeConditionNode(rawTree);
  const group = normalized && normalized.type === "group" ? normalized : createEmptyGroup("ALL");

  return db.campaign.update({
    where: { id },
    data: { conditionsJson: group as unknown as Prisma.InputJsonValue },
  });
}

export async function updateCampaignSchedule(
  shopId: string,
  id: string,
  input: { startsAt: string | null; endsAt: string | null },
) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign) return null;

  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;

  if (startsAt && Number.isNaN(startsAt.getTime())) return null;
  if (endsAt && Number.isNaN(endsAt.getTime())) return null;
  if (startsAt && endsAt && endsAt <= startsAt) return null;

  return db.campaign.update({
    where: { id },
    data: { scheduleStartAt: startsAt, scheduleEndAt: endsAt },
  });
}

/** `rawRule: null` turns recurrence off entirely (the campaign just runs continuously within scheduleStartAt/scheduleEndAt again); anything else is validated by normalizeRecurrenceRule, degrading to null (off) rather than throwing on malformed input. */
export async function updateCampaignRecurrence(shopId: string, id: string, rawRule: unknown, timezone?: string) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign) return null;

  const rule = rawRule === null ? null : normalizeRecurrenceRule(rawRule);

  return db.campaign.update({
    where: { id },
    data: {
      recurrenceJson: rule === null ? Prisma.JsonNull : (rule as unknown as Prisma.InputJsonValue),
      // Only set alongside a real rule — recurring times have no
      // meaning without a timezone to read them in (unlike
      // scheduleStartAt/scheduleEndAt, which are converted to an
      // absolute UTC instant at save time and never need to remember
      // which zone they came from).
      ...(rule !== null && timezone ? { timezone } : {}),
    },
  });
}

export async function updateCampaignStacking(
  shopId: string,
  id: string,
  input: {
    priority: number;
    isExclusive: boolean;
    usageLimitTotal: number | null;
    usageLimitPerCustomer: number | null;
  },
) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign) return null;

  return db.campaign.update({
    where: { id },
    data: {
      priority: input.priority,
      isExclusive: input.isExclusive,
      usageLimitTotal: input.usageLimitTotal,
      usageLimitPerCustomer: input.usageLimitPerCustomer,
    },
  });
}

export async function updateCampaignReward(shopId: string, id: string, rawReward: unknown) {
  const campaign = await getCampaign(shopId, id);
  if (!campaign) return null;

  const reward = normalizeRewardConfig(rawReward);

  return db.campaign.update({
    where: { id },
    data: { rewardJson: reward as unknown as Prisma.InputJsonValue },
  });
}
