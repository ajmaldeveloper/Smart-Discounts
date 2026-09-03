import { describe, expect, it } from "vitest";
import { relativeDayLabel, utcIsoToZonedParts, zonedTimeToUtcIso } from "./timezone";

describe("zonedTimeToUtcIso", () => {
  it("converts a wall-clock time in a negative-offset zone (EDT, UTC-4 in September) to the correct UTC instant", () => {
    const iso = zonedTimeToUtcIso("2026-09-01", "18:30", "America/New_York");
    expect(iso).toBe("2026-09-01T22:30:00.000Z");
  });

  it("converts a wall-clock time in a positive-offset zone (PKT, UTC+5) to the correct UTC instant", () => {
    const iso = zonedTimeToUtcIso("2026-09-01", "18:30", "Asia/Karachi");
    expect(iso).toBe("2026-09-01T13:30:00.000Z");
  });

  it("treats UTC as a no-op", () => {
    const iso = zonedTimeToUtcIso("2026-09-01", "18:30", "UTC");
    expect(iso).toBe("2026-09-01T18:30:00.000Z");
  });

  it("handles a date that rolls into the next UTC day", () => {
    const iso = zonedTimeToUtcIso("2026-09-01", "23:00", "America/New_York");
    expect(iso).toBe("2026-09-02T03:00:00.000Z");
  });

  it("respects DST in winter (EST, UTC-5) vs. the summer EDT case above", () => {
    const iso = zonedTimeToUtcIso("2026-01-15", "18:30", "America/New_York");
    expect(iso).toBe("2026-01-15T23:30:00.000Z");
  });
});

describe("utcIsoToZonedParts", () => {
  it("round-trips a zonedTimeToUtcIso conversion back to the original wall-clock date/time", () => {
    const iso = zonedTimeToUtcIso("2026-09-01", "18:30", "America/New_York");
    expect(utcIsoToZonedParts(iso, "America/New_York")).toEqual({ date: "2026-09-01", time: "18:30" });
  });

  it("returns empty strings for an empty input", () => {
    expect(utcIsoToZonedParts("", "America/New_York")).toEqual({ date: "", time: "" });
  });

  it("shows the same UTC instant differently across two different zones", () => {
    const iso = "2026-09-01T22:30:00.000Z";
    expect(utcIsoToZonedParts(iso, "America/New_York")).toEqual({ date: "2026-09-01", time: "18:30" });
    expect(utcIsoToZonedParts(iso, "Asia/Karachi")).toEqual({ date: "2026-09-02", time: "03:30" });
  });
});

describe("relativeDayLabel", () => {
  it("returns \"Today\" for the current calendar day in the given zone", () => {
    expect(relativeDayLabel(new Date(), "UTC")).toBe("Today");
  });

  it("returns \"Yesterday\" for the previous calendar day", () => {
    expect(relativeDayLabel(new Date(Date.now() - 86400000), "UTC")).toBe("Yesterday");
  });

  it("returns \"Tomorrow\" for the next calendar day", () => {
    expect(relativeDayLabel(new Date(Date.now() + 86400000), "UTC")).toBe("Tomorrow");
  });

  it("returns null for a date further away than a day either side", () => {
    expect(relativeDayLabel(new Date(Date.now() + 5 * 86400000), "UTC")).toBeNull();
    expect(relativeDayLabel(new Date(Date.now() - 5 * 86400000), "UTC")).toBeNull();
  });

  it("can disagree across two zones near a day boundary", () => {
    // 11:30 PM UTC on a given day is already the next calendar day in Asia/Karachi (UTC+5).
    const now = new Date();
    const lateUtcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 30));
    expect(relativeDayLabel(lateUtcToday, "UTC")).toBe("Today");
    expect(relativeDayLabel(lateUtcToday, "Asia/Karachi")).toBe("Tomorrow");
  });
});
