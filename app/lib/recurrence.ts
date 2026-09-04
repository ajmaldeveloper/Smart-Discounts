/**
 * A daily/weekly on-off window layered on top of a campaign's own
 * scheduleStartAt/scheduleEndAt — "every Friday 6pm-midnight, from
 * Sept 1 to Dec 31" instead of one continuous window. Unlike
 * scheduleStartAt/scheduleEndAt (Shopify's own native startsAt/endsAt,
 * enforced by Shopify itself with no lag), this has no native Shopify
 * equivalent: it's enforced by app/services/recurring-campaigns.server.ts's
 * own polling scheduler, so there's up to about a minute of lag around
 * each on/off transition — documented in the admin UI, not hidden.
 */

import { zonedWeekdayAndMinutes } from "./timezone";

/** The subset of Campaign fields shouldBeActiveNow needs — kept as a Pick-able shape so callers can pass either a full Prisma Campaign or a plain test fixture. */
export interface RecurrenceCampaignFields {
  recurrenceJson: unknown;
  scheduleStartAt: Date | null;
  scheduleEndAt: Date | null;
  timezone: string | null;
}

export interface RecurrenceRule {
  frequency: "daily" | "weekly";
  // 0 (Sunday) – 6 (Saturday). Ignored (and may be empty) for "daily".
  daysOfWeek: number[];
  // "HH:MM", in the campaign's own timezone (same field as
  // scheduleStartAt/scheduleEndAt use for display).
  startTime: string;
  endTime: string;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

/** Validates and repairs an arbitrary parsed-JSON value, or returns null (no recurrence) for anything unusable — mirrors this codebase's normalizeWidgetSettings/normalizeRewardConfig convention of degrading field-by-field rather than throwing. */
export function normalizeRecurrenceRule(raw: unknown): RecurrenceRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const frequency = record.frequency === "weekly" ? "weekly" : record.frequency === "daily" ? "daily" : null;
  if (!frequency) return null;

  const startTime = typeof record.startTime === "string" && HH_MM.test(record.startTime) ? record.startTime : null;
  const endTime = typeof record.endTime === "string" && HH_MM.test(record.endTime) ? record.endTime : null;
  if (!startTime || !endTime) return null;

  const daysOfWeek = Array.isArray(record.daysOfWeek)
    ? [...new Set(record.daysOfWeek.filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : [];
  if (frequency === "weekly" && daysOfWeek.length === 0) return null;

  return { frequency, daysOfWeek, startTime, endTime };
}

/**
 * Whether `now` (evaluated in `timeZone`) falls inside the rule's
 * active window. Handles an overnight window (e.g. 22:00-02:00) by
 * treating it as wrapping past midnight rather than an empty range —
 * though for "weekly", the wrapped portion after midnight is checked
 * against THAT calendar day's weekday, not the day the window started
 * on. A Friday-22:00-to-02:00 rule stops matching at midnight unless
 * Saturday is also selected — a known, narrow limitation of
 * overnight-spanning weekly windows, not something a typical "Friday
 * evening sale" or "weekend hours" rule runs into.
 */
export function isWithinRecurrenceWindow(rule: RecurrenceRule, now: Date, timeZone: string): boolean {
  const { weekday, minutesSinceMidnight } = zonedWeekdayAndMinutes(now, timeZone);

  if (rule.frequency === "weekly" && !rule.daysOfWeek.includes(weekday)) return false;

  const start = toMinutes(rule.startTime);
  const end = toMinutes(rule.endTime);

  if (start === end) return false; // a zero-length window never opens
  if (start < end) return minutesSinceMidnight >= start && minutesSinceMidnight < end;
  // Overnight: e.g. 22:00-02:00 is active from 22:00 through midnight, then 00:00-02:00 the next calendar day.
  return minutesSinceMidnight >= start || minutesSinceMidnight < end;
}

/**
 * Whether a campaign's recurrence window is open right now — null for
 * a non-recurring campaign (nothing to enforce) or one outside its own
 * scheduleStartAt/scheduleEndAt range. Pure/side-effect-free — safe to
 * unit test directly, unlike recurring-campaigns.server.ts's own
 * module (importing that starts a real setInterval).
 */
export function shouldBeActiveNow(campaign: RecurrenceCampaignFields, now: Date): boolean | null {
  const rule = normalizeRecurrenceRule(campaign.recurrenceJson);
  if (!rule) return null;

  if (campaign.scheduleStartAt && campaign.scheduleStartAt > now) return false;
  if (campaign.scheduleEndAt && campaign.scheduleEndAt < now) return false;

  return isWithinRecurrenceWindow(rule, now, campaign.timezone || "UTC");
}
