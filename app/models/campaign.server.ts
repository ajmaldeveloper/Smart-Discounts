import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { createEmptyGroup, normalizeConditionNode } from "../lib/campaign-types";
import { normalizeRewardConfig } from "../lib/reward-types";

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
