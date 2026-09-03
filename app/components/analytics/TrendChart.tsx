import { useMemo, useState } from "react";
import type { AnalyticsTrendDay } from "../../services/analytics.server";
import "../../styles/analytics-trend.css";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const CHART_PADDING_LEFT = 44;
const CHART_PADDING_RIGHT = 8;
const CHART_PADDING_TOP = 12;
const CHART_PADDING_BOTTOM = 28;

// Bar/column spec (dataviz skill's marks-and-anatomy.md): capped
// thickness, 4px rounded top / square baseline, a fixed gap between
// adjacent bars.
const BAR_MAX_THICKNESS = 24;
const BAR_CORNER_RADIUS = 4;
const MAX_X_AXIS_LABELS = 8;

type Metric = "orders" | "discount" | "revenue";

const METRIC_LABELS: Record<Metric, string> = {
  orders: "Orders",
  discount: "Discount given",
  revenue: "Revenue influenced",
};

function metricValue(day: AnalyticsTrendDay, metric: Metric): number {
  if (metric === "orders") return day.ordersCount;
  if (metric === "discount") return day.totalDiscount;
  return day.totalRevenue;
}

function formatMetricValue(value: number, metric: Metric): string {
  return metric === "orders" ? value.toLocaleString() : `$${value.toFixed(2)}`;
}

function formatShortDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

/** Rounds up to a "clean" axis-tick number (1/2/5 × a power of ten) instead of ending on the raw data max. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/** Least-squares line through (index, value) — an honest "overall direction" summary, not a decorative flourish. Only meaningful with at least 2 points and a non-flat spread. */
function computeLinearTrend(values: number[]): { intercept: number; slope: number } | null {
  const n = values.length;
  if (n < 2) return null;

  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - xMean;
    numerator += dx * (values[index]! - yMean);
    denominator += dx * dx;
  }

  if (denominator === 0) return null;
  const slope = numerator / denominator;
  return { intercept: yMean - slope * xMean, slope };
}

function computeYAxisTicks(niceMax: number): number[] {
  const rawTicks = [0, niceMax / 4, niceMax / 2, (niceMax * 3) / 4, niceMax];
  return Array.from(new Set(rawTicks.map((tick) => Math.round(tick * 100) / 100))).sort((a, b) => a - b);
}

/** A rect path with rounded top corners and a square baseline. */
function roundedTopBarPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return "";
  const radius = Math.min(BAR_CORNER_RADIUS, width / 2, height);
  if (radius <= 0) return `M ${x} ${y} h ${width} v ${height} h ${-width} Z`;
  return `
    M ${x} ${y + radius}
    Q ${x} ${y} ${x + radius} ${y}
    H ${x + width - radius}
    Q ${x + width} ${y} ${x + width} ${y + radius}
    V ${y + height}
    H ${x}
    Z
  `;
}

const ARROWHEAD_LENGTH = 9;
const ARROWHEAD_WIDTH = 7;

/** A small filled triangle at (endX, endY), pointing along the line from (startX, startY). */
function arrowheadPath(startX: number, startY: number, endX: number, endY: number): string {
  const angle = Math.atan2(endY - startY, endX - startX);
  const backX = endX - ARROWHEAD_LENGTH * Math.cos(angle);
  const backY = endY - ARROWHEAD_LENGTH * Math.sin(angle);
  const perpX = (ARROWHEAD_WIDTH / 2) * Math.cos(angle + Math.PI / 2);
  const perpY = (ARROWHEAD_WIDTH / 2) * Math.sin(angle + Math.PI / 2);

  return `M ${endX} ${endY} L ${backX + perpX} ${backY + perpY} L ${backX - perpX} ${backY - perpY} Z`;
}

/**
 * A single-series bar chart for one metric at a time (orders,
 * discount, or revenue) — never combined on one axis, since they're
 * different scales entirely (see the dataviz skill's "one axis" rule).
 * A single series needs no legend box; the metric selector itself
 * names it. Bars over a line since daily counts are sparse (often 0,
 * occasionally a spike), where a thin line would read as nearly
 * invisible.
 */
export default function TrendChart({ days }: { days: AnalyticsTrendDay[] }) {
  const [metric, setMetric] = useState<Metric>("discount");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const values = useMemo(() => days.map((day) => metricValue(day, metric)), [days, metric]);
  const total = values.reduce((sum, value) => sum + value, 0);

  const plotWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

  const niceMax = niceCeil(Math.max(1, ...values));
  const yAxisTicks = computeYAxisTicks(niceMax);

  const bandWidth = days.length === 0 ? plotWidth : plotWidth / days.length;
  const barWidth = Math.max(1, Math.min(BAR_MAX_THICKNESS, bandWidth * 0.7));

  const xForBand = (index: number) => CHART_PADDING_LEFT + index * bandWidth + (bandWidth - barWidth) / 2;
  const yForValue = (value: number) => CHART_PADDING_TOP + plotHeight - (value / niceMax) * plotHeight;
  const barHeightForValue = (value: number) => (value / niceMax) * plotHeight;

  const linearTrend = total > 0 ? computeLinearTrend(values) : null;
  const trendLine = linearTrend
    ? (() => {
        const startValue = Math.max(0, Math.min(niceMax, linearTrend.intercept));
        const endValue = Math.max(0, Math.min(niceMax, linearTrend.intercept + linearTrend.slope * (values.length - 1)));
        const startX = xForBand(0) + barWidth / 2;
        const endX = xForBand(values.length - 1) + barWidth / 2;
        return { startX, startY: yForValue(startValue), endX, endY: yForValue(endValue) };
      })()
    : null;

  const xAxisLabelStep = Math.max(1, Math.ceil(days.length / MAX_X_AXIS_LABELS));
  const xAxisLabelIndices = new Set<number>();
  for (let index = 0; index < days.length; index += xAxisLabelStep) {
    xAxisLabelIndices.add(index);
  }
  if (days.length > 0) {
    const lastIndex = days.length - 1;
    // The regular step doesn't always land exactly on the last day — forcing
    // it in always keeps "today" visible, but if the nearest regular label
    // is too close, the two date strings overlap (e.g. "Aug 31"/"Sep 1"
    // rendering on top of each other). Drop that neighbor instead of
    // showing both.
    const minGapDays = Math.max(1, Math.floor(xAxisLabelStep / 2));
    for (let index = lastIndex - 1; index >= 0 && index > lastIndex - minGapDays; index -= 1) {
      xAxisLabelIndices.delete(index);
    }
    xAxisLabelIndices.add(lastIndex);
  }

  function handlePointerMove(event: React.PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = bounds.width === 0 ? 0 : (event.clientX - bounds.left) / bounds.width;
    const nearestIndex = Math.round(ratio * (days.length - 1));
    setHoverIndex(Math.min(days.length - 1, Math.max(0, nearestIndex)));
  }

  const hoveredDay = hoverIndex === null ? null : days[hoverIndex];

  return (
    <div className="wsd-trend">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small">
            {(Object.keys(METRIC_LABELS) as Metric[]).map((key) => (
              <s-button key={key} variant={metric === key ? "primary" : "secondary"} onClick={() => setMetric(key)}>
                {METRIC_LABELS[key]}
              </s-button>
            ))}
          </s-stack>
          <s-text color="subdued">{metric === "orders" ? `${total.toLocaleString()} total` : `$${total.toFixed(2)} total`}</s-text>
        </s-stack>

        {showTable ? (
          <div className="wsd-trend-table-scroll">
            <table className="wsd-trend-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>{METRIC_LABELS[metric]}</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day, index) => (
                  <tr key={day.date}>
                    <td>{formatShortDate(day.date)}</td>
                    <td>{formatMetricValue(values[index]!, metric)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              style={{ width: "100%", height: "200px", display: "block" }}
              role="img"
              aria-label={`${METRIC_LABELS[metric]} by day — use the View as table switch below for exact values`}
            >
              {yAxisTicks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={CHART_PADDING_LEFT}
                    x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                    y1={yForValue(tick)}
                    y2={yForValue(tick)}
                    stroke="var(--wsd-grid)"
                    strokeWidth={1}
                  />
                  <text
                    x={CHART_PADDING_LEFT - 8}
                    y={yForValue(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize="10"
                    fill="var(--wsd-axis-text)"
                  >
                    {metric === "orders" ? tick.toLocaleString() : `$${tick.toLocaleString()}`}
                  </text>
                </g>
              ))}

              <line
                x1={CHART_PADDING_LEFT}
                x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                y1={CHART_PADDING_TOP + plotHeight}
                y2={CHART_PADDING_TOP + plotHeight}
                stroke="var(--wsd-baseline)"
                strokeWidth={1}
              />

              {days.map((day, index) =>
                xAxisLabelIndices.has(index) ? (
                  <text
                    key={day.date}
                    x={xForBand(index) + barWidth / 2}
                    y={CHART_HEIGHT - 8}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--wsd-axis-text)"
                  >
                    {formatShortDate(day.date)}
                  </text>
                ) : null,
              )}

              {hoverIndex !== null ? (
                <rect
                  x={CHART_PADDING_LEFT + hoverIndex * bandWidth}
                  y={CHART_PADDING_TOP}
                  width={bandWidth}
                  height={plotHeight}
                  fill="var(--wsd-hover-fill)"
                />
              ) : null}

              {values.map((value, index) =>
                value > 0 ? (
                  <path
                    key={days[index]!.date}
                    d={roundedTopBarPath(xForBand(index), yForValue(value), barWidth, barHeightForValue(value))}
                    fill="var(--wsd-series-1)"
                  />
                ) : null,
              )}

              {trendLine ? (
                <g pointerEvents="none">
                  <line
                    x1={trendLine.startX}
                    y1={trendLine.startY}
                    x2={trendLine.endX}
                    y2={trendLine.endY}
                    stroke="var(--wsd-trend-line)"
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    strokeLinecap="round"
                  />
                  <path
                    d={arrowheadPath(trendLine.startX, trendLine.startY, trendLine.endX, trendLine.endY)}
                    fill="var(--wsd-trend-line)"
                  />
                </g>
              ) : null}

              <rect
                x={CHART_PADDING_LEFT}
                y={0}
                width={plotWidth}
                height={CHART_HEIGHT}
                fill="transparent"
                onPointerMove={handlePointerMove}
                onPointerLeave={() => setHoverIndex(null)}
              />
            </svg>

            {hoverIndex !== null && hoveredDay ? (
              <div
                className="wsd-trend-tooltip"
                style={{
                  left: `${((xForBand(hoverIndex) + barWidth / 2) / CHART_WIDTH) * 100}%`,
                  transform: hoverIndex > days.length / 2 ? "translateX(-100%)" : "translateX(8px)",
                }}
              >
                <div style={{ opacity: 0.75, marginBottom: "2px" }}>{formatShortDate(hoveredDay.date)}</div>
                <strong>{formatMetricValue(values[hoverIndex]!, metric)}</strong>
              </div>
            ) : null}
          </div>
        )}

        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="center">
          <s-switch label="View as table" checked={showTable} onChange={(event) => setShowTable(event.currentTarget.checked)} />
        </s-stack>
      </s-stack>
    </div>
  );
}
