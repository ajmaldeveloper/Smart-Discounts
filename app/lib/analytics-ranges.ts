export const ANALYTICS_RANGE_DAYS = [7, 30, 90] as const;

export type AnalyticsRangeDays = (typeof ANALYTICS_RANGE_DAYS)[number];

export function isAnalyticsRangeDays(value: unknown): value is AnalyticsRangeDays {
  return ANALYTICS_RANGE_DAYS.includes(value as AnalyticsRangeDays);
}
