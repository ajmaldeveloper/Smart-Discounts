/**
 * Discount analytics (M13), built entirely from data
 * order-processing.server.ts records after real completed orders —
 * nothing here is estimated or simulated.
 */

import db from "../db.server";
import type { AnalyticsRangeDays } from "../lib/analytics-ranges";

export interface CampaignAnalyticsSummary {
  campaignId: string;
  campaignName: string;
  ordersCount: number;
  totalDiscount: number;
  totalRevenue: number;
  averageDiscount: number;
}

export interface AnalyticsOverview {
  totalOrders: number;
  totalDiscountGiven: number;
  totalRevenueInfluenced: number;
  averageDiscountPerOrder: number;
  campaigns: CampaignAnalyticsSummary[];
}

export async function getAnalyticsOverview(shopId: string): Promise<AnalyticsOverview> {
  // Every campaign gets a row — including ones that haven't processed an
  // order yet — so the Performance by campaign table always shows the
  // shop's real campaigns with $0.00/0 rather than omitting them until
  // their first order (see app/routes/app.analytics.tsx's empty-state
  // philosophy: show the real widget at zero, not a placeholder message).
  const [rows, campaigns] = await Promise.all([
    db.campaignAnalyticsDaily.groupBy({
      by: ["campaignId"],
      where: { campaign: { shopId } },
      _sum: { ordersCount: true, totalDiscount: true, totalRevenue: true },
    }),
    db.campaign.findMany({ where: { shopId }, select: { id: true, name: true } }),
  ]);

  const aggregateByCampaignId = new Map(rows.map((row) => [row.campaignId, row]));
  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));
  const allCampaignIds = new Set([...nameById.keys(), ...aggregateByCampaignId.keys()]);

  const summaries: CampaignAnalyticsSummary[] = [...allCampaignIds].map((campaignId) => {
    const aggregate = aggregateByCampaignId.get(campaignId);
    const ordersCount = aggregate?._sum.ordersCount ?? 0;
    const totalDiscount = Number(aggregate?._sum.totalDiscount ?? 0);
    const totalRevenue = Number(aggregate?._sum.totalRevenue ?? 0);

    return {
      campaignId,
      campaignName: nameById.get(campaignId) ?? "(deleted campaign)",
      ordersCount,
      totalDiscount,
      totalRevenue,
      averageDiscount: ordersCount > 0 ? totalDiscount / ordersCount : 0,
    };
  });

  summaries.sort((a, b) => b.totalDiscount - a.totalDiscount);

  const totalOrders = summaries.reduce((sum, s) => sum + s.ordersCount, 0);
  const totalDiscountGiven = summaries.reduce((sum, s) => sum + s.totalDiscount, 0);
  const totalRevenueInfluenced = summaries.reduce((sum, s) => sum + s.totalRevenue, 0);

  return {
    totalOrders,
    totalDiscountGiven,
    totalRevenueInfluenced,
    averageDiscountPerOrder: totalOrders > 0 ? totalDiscountGiven / totalOrders : 0,
    campaigns: summaries,
  };
}

/** Same shape/columns as getAnalyticsOverview's per-campaign rows, scoped to a specific set of campaigns (e.g. the two variants of an A/B test) instead of the whole shop. Returned in the same order as `campaignIds`. */
export async function getCampaignAnalyticsSummaries(shopId: string, campaignIds: string[]): Promise<CampaignAnalyticsSummary[]> {
  if (campaignIds.length === 0) return [];

  const [rows, campaigns] = await Promise.all([
    db.campaignAnalyticsDaily.groupBy({
      by: ["campaignId"],
      where: { campaign: { shopId }, campaignId: { in: campaignIds } },
      _sum: { ordersCount: true, totalDiscount: true, totalRevenue: true },
    }),
    db.campaign.findMany({ where: { shopId, id: { in: campaignIds } }, select: { id: true, name: true } }),
  ]);

  const aggregateByCampaignId = new Map(rows.map((row) => [row.campaignId, row]));
  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));

  return campaignIds.map((campaignId) => {
    const aggregate = aggregateByCampaignId.get(campaignId);
    const ordersCount = aggregate?._sum.ordersCount ?? 0;
    const totalDiscount = Number(aggregate?._sum.totalDiscount ?? 0);
    const totalRevenue = Number(aggregate?._sum.totalRevenue ?? 0);

    return {
      campaignId,
      campaignName: nameById.get(campaignId) ?? "(deleted campaign)",
      ordersCount,
      totalDiscount,
      totalRevenue,
      averageDiscount: ordersCount > 0 ? totalDiscount / ordersCount : 0,
    };
  });
}

export interface AnalyticsTrendDay {
  date: string;
  ordersCount: number;
  totalDiscount: number;
  totalRevenue: number;
}

export interface AnalyticsTrend {
  windowDays: AnalyticsRangeDays;
  days: AnalyticsTrendDay[];
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A shop-wide (summed across every campaign) daily series for the
 * requested window — every day in the window gets a row, zero-filled
 * where CampaignAnalyticsDaily has none, so the chart's X-axis is
 * always continuous rather than skipping quiet days. `date` on that
 * model is already UTC-midnight-truncated at write time (see
 * order-processing.server.ts's startOfDay), so comparing by the same
 * UTC day key here never drifts across a timezone boundary.
 */
export async function getAnalyticsTrend(shopId: string, windowDays: AnalyticsRangeDays): Promise<AnalyticsTrend> {
  const today = startOfUtcDay(new Date());
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - (windowDays - 1));

  const rows = await db.campaignAnalyticsDaily.groupBy({
    by: ["date"],
    where: { campaign: { shopId }, date: { gte: since } },
    _sum: { ordersCount: true, totalDiscount: true, totalRevenue: true },
  });

  const rowByDateKey = new Map(rows.map((row) => [dateKey(row.date), row]));

  const days: AnalyticsTrendDay[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    const day = new Date(since);
    day.setUTCDate(since.getUTCDate() + i);
    const key = dateKey(day);
    const row = rowByDateKey.get(key);

    days.push({
      date: key,
      ordersCount: row?._sum.ordersCount ?? 0,
      totalDiscount: Number(row?._sum.totalDiscount ?? 0),
      totalRevenue: Number(row?._sum.totalRevenue ?? 0),
    });
  }

  return { windowDays, days };
}

export interface AnalyticsRangeTotals {
  totalOrders: number;
  totalDiscountGiven: number;
  totalRevenueInfluenced: number;
  averageDiscountPerOrder: number;
}

export interface AnalyticsComparison {
  windowDays: AnalyticsRangeDays;
  current: AnalyticsRangeTotals;
  previous: AnalyticsRangeTotals;
  /** Percent change (current vs previous), per metric. Null when the previous period has no baseline (previous === 0) — a percentage off of zero is not meaningful, so the UI shows "New" instead of a number there. */
  changePercent: {
    totalOrders: number | null;
    totalDiscountGiven: number | null;
    totalRevenueInfluenced: number | null;
    averageDiscountPerOrder: number | null;
  };
}

async function sumRange(shopId: string, sinceInclusive: Date, untilExclusive: Date): Promise<AnalyticsRangeTotals> {
  const result = await db.campaignAnalyticsDaily.aggregate({
    where: { campaign: { shopId }, date: { gte: sinceInclusive, lt: untilExclusive } },
    _sum: { ordersCount: true, totalDiscount: true, totalRevenue: true },
  });

  const totalOrders = result._sum.ordersCount ?? 0;
  const totalDiscountGiven = Number(result._sum.totalDiscount ?? 0);
  const totalRevenueInfluenced = Number(result._sum.totalRevenue ?? 0);

  return {
    totalOrders,
    totalDiscountGiven,
    totalRevenueInfluenced,
    averageDiscountPerOrder: totalOrders > 0 ? totalDiscountGiven / totalOrders : 0,
  };
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * The current windowDays-day period against the immediately preceding
 * period of the same length (e.g. the last 7 days vs the 7 days before
 * that) — mirrors the period-over-period comparison pattern used by
 * YouTube Studio/TikTok Analytics, tied to the same range control as
 * getAnalyticsTrend so "7d" reads as "vs previous week" etc.
 */
export async function getAnalyticsComparison(shopId: string, windowDays: AnalyticsRangeDays): Promise<AnalyticsComparison> {
  const today = startOfUtcDay(new Date());

  const currentSince = new Date(today);
  currentSince.setUTCDate(currentSince.getUTCDate() - (windowDays - 1));
  const currentUntilExclusive = new Date(today);
  currentUntilExclusive.setUTCDate(currentUntilExclusive.getUTCDate() + 1);

  const previousUntilExclusive = new Date(currentSince);
  const previousSince = new Date(currentSince);
  previousSince.setUTCDate(previousSince.getUTCDate() - windowDays);

  const [current, previous] = await Promise.all([
    sumRange(shopId, currentSince, currentUntilExclusive),
    sumRange(shopId, previousSince, previousUntilExclusive),
  ]);

  return {
    windowDays,
    current,
    previous,
    changePercent: {
      totalOrders: percentChange(current.totalOrders, previous.totalOrders),
      totalDiscountGiven: percentChange(current.totalDiscountGiven, previous.totalDiscountGiven),
      totalRevenueInfluenced: percentChange(current.totalRevenueInfluenced, previous.totalRevenueInfluenced),
      averageDiscountPerOrder: percentChange(current.averageDiscountPerOrder, previous.averageDiscountPerOrder),
    },
  };
}

/**
 * A handful of real, threshold-based observations computed directly
 * from the same aggregates above — not narrative filler. Each rule
 * only fires when the underlying numbers actually support it, and
 * says exactly which campaign and why.
 */
export function derivePromotionHealthInsights(overview: AnalyticsOverview): string[] {
  const insights: string[] = [];

  for (const campaign of overview.campaigns) {
    if (campaign.totalRevenue > 0) {
      const discountRatio = campaign.totalDiscount / campaign.totalRevenue;
      if (discountRatio > 0.3) {
        insights.push(
          `"${campaign.campaignName}" is giving away ${(discountRatio * 100).toFixed(0)}% of the revenue it influences as discount — worth checking it isn't cutting into margin more than intended.`,
        );
      }
    }

    if (campaign.ordersCount >= 10 && campaign.averageDiscount > 0) {
      const shareOfTotal = overview.totalDiscountGiven > 0 ? campaign.totalDiscount / overview.totalDiscountGiven : 0;
      if (shareOfTotal > 0.5) {
        insights.push(
          `"${campaign.campaignName}" accounts for ${(shareOfTotal * 100).toFixed(0)}% of all discount given across every campaign — your biggest lever for tuning overall discount spend.`,
        );
      }
    }
  }

  return insights;
}
