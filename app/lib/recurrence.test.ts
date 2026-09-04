import { describe, expect, it } from "vitest";
import { isWithinRecurrenceWindow, normalizeRecurrenceRule, shouldBeActiveNow, type RecurrenceRule } from "./recurrence";

describe("normalizeRecurrenceRule", () => {
  it("normalizes a valid daily rule", () => {
    const rule = normalizeRecurrenceRule({ frequency: "daily", startTime: "09:00", endTime: "17:00" });
    expect(rule).toEqual({ frequency: "daily", daysOfWeek: [], startTime: "09:00", endTime: "17:00" });
  });

  it("normalizes a valid weekly rule, deduping and sorting daysOfWeek", () => {
    const rule = normalizeRecurrenceRule({ frequency: "weekly", daysOfWeek: [5, 0, 5, 6], startTime: "18:00", endTime: "23:59" });
    expect(rule).toEqual({ frequency: "weekly", daysOfWeek: [0, 5, 6], startTime: "18:00", endTime: "23:59" });
  });

  it("returns null for a weekly rule with no days selected", () => {
    expect(normalizeRecurrenceRule({ frequency: "weekly", daysOfWeek: [], startTime: "09:00", endTime: "17:00" })).toBeNull();
  });

  it("returns null for an invalid frequency", () => {
    expect(normalizeRecurrenceRule({ frequency: "monthly", startTime: "09:00", endTime: "17:00" })).toBeNull();
  });

  it("returns null for a malformed time", () => {
    expect(normalizeRecurrenceRule({ frequency: "daily", startTime: "9am", endTime: "17:00" })).toBeNull();
    expect(normalizeRecurrenceRule({ frequency: "daily", startTime: "09:00", endTime: "25:00" })).toBeNull();
  });

  it("returns null for null/undefined/non-object input", () => {
    expect(normalizeRecurrenceRule(null)).toBeNull();
    expect(normalizeRecurrenceRule(undefined)).toBeNull();
    expect(normalizeRecurrenceRule("garbage")).toBeNull();
  });

  it("ignores out-of-range day numbers", () => {
    const rule = normalizeRecurrenceRule({ frequency: "weekly", daysOfWeek: [3, 9, -1], startTime: "09:00", endTime: "17:00" });
    expect(rule?.daysOfWeek).toEqual([3]);
  });
});

describe("isWithinRecurrenceWindow", () => {
  const daily: RecurrenceRule = { frequency: "daily", daysOfWeek: [], startTime: "09:00", endTime: "17:00" };

  it("matches inside a daily window", () => {
    // 2026-09-04 is a Friday; noon UTC.
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T12:00:00Z"), "UTC")).toBe(true);
  });

  it("does not match before the window opens", () => {
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T08:00:00Z"), "UTC")).toBe(false);
  });

  it("does not match at/after the window closes (end is exclusive)", () => {
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T17:00:00Z"), "UTC")).toBe(false);
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T18:00:00Z"), "UTC")).toBe(false);
  });

  it("matches at the exact start minute (start is inclusive)", () => {
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T09:00:00Z"), "UTC")).toBe(true);
  });

  it("respects weekly daysOfWeek", () => {
    // Friday = 5.
    const fridaysOnly: RecurrenceRule = { frequency: "weekly", daysOfWeek: [5], startTime: "09:00", endTime: "17:00" };
    expect(isWithinRecurrenceWindow(fridaysOnly, new Date("2026-09-04T12:00:00Z"), "UTC")).toBe(true); // Friday
    expect(isWithinRecurrenceWindow(fridaysOnly, new Date("2026-09-05T12:00:00Z"), "UTC")).toBe(false); // Saturday
  });

  it("handles an overnight window that wraps past midnight", () => {
    const overnight: RecurrenceRule = { frequency: "daily", daysOfWeek: [], startTime: "22:00", endTime: "02:00" };
    expect(isWithinRecurrenceWindow(overnight, new Date("2026-09-04T23:00:00Z"), "UTC")).toBe(true);
    expect(isWithinRecurrenceWindow(overnight, new Date("2026-09-04T01:00:00Z"), "UTC")).toBe(true);
    expect(isWithinRecurrenceWindow(overnight, new Date("2026-09-04T12:00:00Z"), "UTC")).toBe(false);
  });

  it("a zero-length window (start === end) never opens", () => {
    const zero: RecurrenceRule = { frequency: "daily", daysOfWeek: [], startTime: "09:00", endTime: "09:00" };
    expect(isWithinRecurrenceWindow(zero, new Date("2026-09-04T09:00:00Z"), "UTC")).toBe(false);
  });

  it("evaluates against the given timezone, not UTC", () => {
    // 09:00 UTC is 05:00 in America/New_York (EDT, UTC-4) — outside a 09:00-17:00 New York window.
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T09:00:00Z"), "America/New_York")).toBe(false);
    // 14:00 UTC is 10:00 in America/New_York — inside the window.
    expect(isWithinRecurrenceWindow(daily, new Date("2026-09-04T14:00:00Z"), "America/New_York")).toBe(true);
  });
});

describe("shouldBeActiveNow", () => {
  const dailyRule = { frequency: "daily", startTime: "09:00", endTime: "17:00" };

  it("returns null (nothing to enforce) when there's no recurrence rule at all", () => {
    expect(shouldBeActiveNow({ recurrenceJson: null, scheduleStartAt: null, scheduleEndAt: null, timezone: null }, new Date())).toBeNull();
  });

  it("returns null for a malformed recurrence rule, leaving the campaign untouched", () => {
    expect(
      shouldBeActiveNow({ recurrenceJson: { frequency: "monthly" }, scheduleStartAt: null, scheduleEndAt: null, timezone: null }, new Date()),
    ).toBeNull();
  });

  it("is true inside the daily window with no schedule bounds", () => {
    expect(
      shouldBeActiveNow(
        { recurrenceJson: dailyRule, scheduleStartAt: null, scheduleEndAt: null, timezone: "UTC" },
        new Date("2026-09-04T12:00:00Z"),
      ),
    ).toBe(true);
  });

  it("is false outside the daily window", () => {
    expect(
      shouldBeActiveNow(
        { recurrenceJson: dailyRule, scheduleStartAt: null, scheduleEndAt: null, timezone: "UTC" },
        new Date("2026-09-04T20:00:00Z"),
      ),
    ).toBe(false);
  });

  it("is false before scheduleStartAt even during the daily window", () => {
    expect(
      shouldBeActiveNow(
        { recurrenceJson: dailyRule, scheduleStartAt: new Date("2026-10-01T00:00:00Z"), scheduleEndAt: null, timezone: "UTC" },
        new Date("2026-09-04T12:00:00Z"),
      ),
    ).toBe(false);
  });

  it("is false after scheduleEndAt even during the daily window", () => {
    expect(
      shouldBeActiveNow(
        { recurrenceJson: dailyRule, scheduleStartAt: null, scheduleEndAt: new Date("2026-08-01T00:00:00Z"), timezone: "UTC" },
        new Date("2026-09-04T12:00:00Z"),
      ),
    ).toBe(false);
  });

  it("defaults to UTC when the campaign has no timezone set", () => {
    expect(
      shouldBeActiveNow(
        { recurrenceJson: dailyRule, scheduleStartAt: null, scheduleEndAt: null, timezone: null },
        new Date("2026-09-04T12:00:00Z"),
      ),
    ).toBe(true);
  });
});
