import { describe, expect, it } from "vitest";
import { normalizeWidgetSettings } from "./widget-settings";

describe("normalizeWidgetSettings", () => {
  it("normalizes a full valid config", () => {
    const settings = normalizeWidgetSettings({
      freeShippingBar: {
        trackColor: "#000000",
        startColor: "#111111",
        nearColor: "#222222",
        reachedColor: "#333333",
        nearThresholdPercent: 60,
        progressMessage: "Almost there: {remaining} left",
        completeMessage: "Free shipping unlocked",
      },
    });

    expect(settings.freeShippingBar).toEqual({
      trackColor: "#000000",
      startColor: "#111111",
      nearColor: "#222222",
      reachedColor: "#333333",
      nearThresholdPercent: 60,
      progressMessage: "Almost there: {remaining} left",
      completeMessage: "Free shipping unlocked",
    });
  });

  it("falls back to defaults field-by-field for missing/malformed values, rather than rejecting the whole object", () => {
    const settings = normalizeWidgetSettings({
      freeShippingBar: {
        startColor: "not-a-hex-color",
        nearThresholdPercent: 999,
        progressMessage: "   ",
      },
    });

    expect(settings.freeShippingBar.trackColor).toBe("#f1f2f3");
    expect(settings.freeShippingBar.startColor).toBe("#8c9196");
    expect(settings.freeShippingBar.nearColor).toBe("#ffc453");
    expect(settings.freeShippingBar.reachedColor).toBe("#008060");
    expect(settings.freeShippingBar.nearThresholdPercent).toBe(100);
    expect(settings.freeShippingBar.progressMessage).toBe("Spend {remaining} more for free shipping!");
    expect(settings.freeShippingBar.completeMessage).toBe("You've unlocked free shipping!");
  });

  it("clamps nearThresholdPercent below 0 up to 0", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { nearThresholdPercent: -20 } });
    expect(settings.freeShippingBar.nearThresholdPercent).toBe(0);
  });

  it("returns all defaults for null, undefined, or a non-object", () => {
    expect(normalizeWidgetSettings(null).freeShippingBar.startColor).toBe("#8c9196");
    expect(normalizeWidgetSettings(undefined).freeShippingBar.startColor).toBe("#8c9196");
    expect(normalizeWidgetSettings("garbage").freeShippingBar.startColor).toBe("#8c9196");
    expect(normalizeWidgetSettings({}).freeShippingBar.startColor).toBe("#8c9196");
  });

  it("accepts a short 3-digit hex color", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { startColor: "#fff" } });
    expect(settings.freeShippingBar.startColor).toBe("#fff");
  });
});
