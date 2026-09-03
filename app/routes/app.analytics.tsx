import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { derivePromotionHealthInsights, getAnalyticsComparison, getAnalyticsOverview, getAnalyticsTrend } from "../services/analytics.server";
import { ANALYTICS_RANGE_DAYS, isAnalyticsRangeDays, type AnalyticsRangeDays } from "../lib/analytics-ranges";
import { getShopEntitlements } from "../services/entitlements.server";
import TrendChart from "../components/analytics/TrendChart";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const entitlements = await getShopEntitlements(session.shop);
  const hasAnalytics = entitlements.plan.features.includes("ANALYTICS");

  const url = new URL(request.url);
  const requestedRange = Number(url.searchParams.get("range"));
  const rangeDays: AnalyticsRangeDays = isAnalyticsRangeDays(requestedRange) ? requestedRange : 30;

  const zeroTotals = { totalOrders: 0, totalDiscountGiven: 0, totalRevenueInfluenced: 0, averageDiscountPerOrder: 0 };

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop || !hasAnalytics) {
    return {
      hasAnalytics,
      rangeDays,
      overview: { ...zeroTotals, campaigns: [] },
      insights: [] as string[],
      trend: { windowDays: rangeDays, days: [] },
      comparison: {
        windowDays: rangeDays,
        current: zeroTotals,
        previous: zeroTotals,
        changePercent: { totalOrders: null, totalDiscountGiven: null, totalRevenueInfluenced: null, averageDiscountPerOrder: null },
      },
    };
  }

  const [overview, trend, comparison] = await Promise.all([
    getAnalyticsOverview(shop.id),
    getAnalyticsTrend(shop.id, rangeDays),
    getAnalyticsComparison(shop.id, rangeDays),
  ]);
  const insights = derivePromotionHealthInsights(overview);

  return { hasAnalytics, rangeDays, overview, insights, trend, comparison };
};

/** "7d"/"30d"/"90d" read naturally as "this week"/"this month"/"this quarter" in the click-to-expand comparison text. */
function periodLabel(rangeDays: AnalyticsRangeDays): string {
  if (rangeDays === 7) return "week";
  if (rangeDays === 30) return "month";
  return "quarter";
}

/** Period-over-period delta, styled like YouTube Studio/TikTok Analytics: an up/down arrow + percent, colored by direction, floating in the tile's top-right corner. Renders nothing when there's no baseline AND no current activity — that case has no change to announce. */
function ChangeBadge({ percent, hasCurrentActivity }: { percent: number | null; hasCurrentActivity: boolean }) {
  if (percent === null) {
    if (!hasCurrentActivity) return null;
    return <s-badge tone="info">New</s-badge>;
  }

  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) {
    return (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon type="arrow-right" color="subdued" />
        <s-text color="subdued">0%</s-text>
      </s-stack>
    );
  }

  const isUp = rounded > 0;
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-icon type={isUp ? "arrow-up" : "arrow-down"} tone={isUp ? "success" : "critical"} />
      <s-text tone={isUp ? "success" : "critical"}>{Math.abs(rounded)}%</s-text>
    </s-stack>
  );
}

function StatTile({
  label,
  current,
  previous,
  percent,
  format,
  period,
}: {
  label: string;
  current: number;
  previous: number;
  percent: number | null;
  format: (value: number) => string;
  period: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasCurrentActivity = current > 0;
  const hasChange = percent !== null || hasCurrentActivity;

  return (
    <div style={{ position: "relative" }}>
      {hasChange && (
        <div style={{ position: "absolute", insetBlockStart: "8px", insetInlineEnd: "8px", zIndex: 1 }}>
          <ChangeBadge percent={percent} hasCurrentActivity={hasCurrentActivity} />
        </div>
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event: React.KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") setExpanded((value) => !value);
        }}
        style={{ cursor: "pointer" }}
      >
        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">{label}</s-text>
            <s-heading>{format(current)}</s-heading>

            {!hasChange && <s-text color="subdued">No data in this period yet.</s-text>}

            {expanded ? (
              <s-stack direction="block" gap="small-400">
                <s-text color="subdued">This {period}: {format(current)}</s-text>
                <s-text color="subdued">Previous {period}: {format(previous)}</s-text>
              </s-stack>
            ) : (
              <s-text color="subdued">Tap for details</s-text>
            )}
          </s-stack>
        </s-box>
      </div>
    </div>
  );
}

export default function Analytics() {
  const { hasAnalytics, rangeDays, overview, insights, trend, comparison } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const hasData = comparison.current.totalOrders > 0;

  if (!hasAnalytics) {
    return (
      <s-page heading="Analytics">
        <s-section>
          <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="large-500">
            <s-stack direction="block" gap="small" alignItems="center">
              <s-text type="strong">Analytics needs an upgrade</s-text>
              <s-text color="subdued">Track orders, discount given, and revenue per campaign with the Growth plan or higher.</s-text>
              <s-button variant="primary" href="/app/plans">
                View plans
              </s-button>
            </s-stack>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Analytics">
      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" alignItems="center" justifyContent="space-between">
            <s-paragraph>Revenue and discount totals for the last {rangeDays} days, vs the {rangeDays} days before that.</s-paragraph>
            <s-stack direction="inline" gap="small">
              {ANALYTICS_RANGE_DAYS.map((days) => (
                <s-button
                  key={days}
                  variant={rangeDays === days ? "primary" : "secondary"}
                  onClick={() => navigate(`/app/analytics?range=${days}`)}
                >
                  {days}d
                </s-button>
              ))}
            </s-stack>
          </s-stack>

          {!hasData && (
            <s-paragraph color="subdued">
              No orders yet in this range. Once a discount applies to a paid order, your totals will show up here.
            </s-paragraph>
          )}

          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <StatTile
              label="Orders using Winslet"
              current={comparison.current.totalOrders}
              previous={comparison.previous.totalOrders}
              percent={comparison.changePercent.totalOrders}
              format={(value) => String(value)}
              period={periodLabel(rangeDays)}
            />
            <StatTile
              label="Total discount given"
              current={comparison.current.totalDiscountGiven}
              previous={comparison.previous.totalDiscountGiven}
              percent={comparison.changePercent.totalDiscountGiven}
              format={(value) => `$${value.toFixed(2)}`}
              period={periodLabel(rangeDays)}
            />
            <StatTile
              label="Revenue influenced"
              current={comparison.current.totalRevenueInfluenced}
              previous={comparison.previous.totalRevenueInfluenced}
              percent={comparison.changePercent.totalRevenueInfluenced}
              format={(value) => `$${value.toFixed(2)}`}
              period={periodLabel(rangeDays)}
            />
            <StatTile
              label="Average discount / order"
              current={comparison.current.averageDiscountPerOrder}
              previous={comparison.previous.averageDiscountPerOrder}
              percent={comparison.changePercent.averageDiscountPerOrder}
              format={(value) => `$${value.toFixed(2)}`}
              period={periodLabel(rangeDays)}
            />
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Trend">
        <s-stack direction="block" gap="base">
          <s-paragraph>Daily orders, discount given, and revenue influenced.</s-paragraph>

          {trend.days.length === 0 ? (
            <s-paragraph color="subdued">No data yet for this range.</s-paragraph>
          ) : (
            <TrendChart days={trend.days} />
          )}
        </s-stack>
      </s-section>

      {insights.length > 0 && (
        <s-section heading="Promotion Health">
          <s-stack direction="block" gap="small">
            {insights.map((insight, index) => (
              <s-paragraph key={index}>{insight}</s-paragraph>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Performance by campaign">
        <s-paragraph color="subdued">All-time totals per campaign, regardless of the range selected above.</s-paragraph>
        {overview.campaigns.length === 0 ? (
          <s-paragraph color="subdued">
            No campaigns have processed an order yet. Each campaign&apos;s orders, discount given and revenue
            influenced will appear here once it does.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Campaign</s-table-header>
              <s-table-header>Orders</s-table-header>
              <s-table-header>Total discount</s-table-header>
              <s-table-header>Revenue influenced</s-table-header>
              <s-table-header>Avg. discount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {overview.campaigns.map((campaign) => (
                <s-table-row key={campaign.campaignId}>
                  <s-table-cell>{campaign.campaignName}</s-table-cell>
                  <s-table-cell>{campaign.ordersCount}</s-table-cell>
                  <s-table-cell>${campaign.totalDiscount.toFixed(2)}</s-table-cell>
                  <s-table-cell>${campaign.totalRevenue.toFixed(2)}</s-table-cell>
                  <s-table-cell>${campaign.averageDiscount.toFixed(2)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
