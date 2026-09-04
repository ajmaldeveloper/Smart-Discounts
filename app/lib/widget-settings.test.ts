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
        barThickness: 10,
        mobileBarThickness: 6,
        barRoundness: 4,
        mobileBarRoundness: 2,
        messageFontSize: 16,
        mobileMessageFontSize: 12,
        barMessageGap: 10,
        mobileBarMessageGap: 6,
        paddingTop: 4,
        paddingBottom: 5,
        paddingLeft: 6,
        paddingRight: 7,
        mobilePaddingTop: 1,
        mobilePaddingBottom: 2,
        mobilePaddingLeft: 3,
        mobilePaddingRight: 4,
        barPosition: "bottom",
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
      barThickness: 10,
      mobileBarThickness: 6,
      barRoundness: 4,
      mobileBarRoundness: 2,
      messageFontSize: 16,
      mobileMessageFontSize: 12,
      barMessageGap: 10,
      mobileBarMessageGap: 6,
      paddingTop: 4,
      paddingBottom: 5,
      paddingLeft: 6,
      paddingRight: 7,
      mobilePaddingTop: 1,
      mobilePaddingBottom: 2,
      mobilePaddingLeft: 3,
      mobilePaddingRight: 4,
      barPosition: "bottom",
    });
  });

  it("falls back to defaults field-by-field for missing/malformed values, rather than rejecting the whole object", () => {
    const settings = normalizeWidgetSettings({
      freeShippingBar: {
        startColor: "not-a-hex-color",
        nearThresholdPercent: 999,
        progressMessage: "   ",
        barThickness: -5,
        mobileBarRoundness: "not-a-number",
      },
    });

    expect(settings.freeShippingBar.trackColor).toBe("#f1f2f3");
    expect(settings.freeShippingBar.startColor).toBe("#8c9196");
    expect(settings.freeShippingBar.nearColor).toBe("#ffc453");
    expect(settings.freeShippingBar.reachedColor).toBe("#008060");
    expect(settings.freeShippingBar.nearThresholdPercent).toBe(100);
    expect(settings.freeShippingBar.progressMessage).toBe("Spend {currency_symbol}{remaining} more for free shipping!");
    expect(settings.freeShippingBar.completeMessage).toBe("You've unlocked free shipping!");
    expect(settings.freeShippingBar.barThickness).toBe(0);
    expect(settings.freeShippingBar.mobileBarRoundness).toBe(999);
  });

  it("clamps nearThresholdPercent below 0 up to 0", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { nearThresholdPercent: -20 } });
    expect(settings.freeShippingBar.nearThresholdPercent).toBe(0);
  });

  it("clamps a pixel field above its max down to the max", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { barThickness: 500 } });
    expect(settings.freeShippingBar.barThickness).toBe(48);
  });

  it("returns all defaults for null, undefined, or a non-object", () => {
    for (const input of [null, undefined, "garbage", {}]) {
      const { freeShippingBar } = normalizeWidgetSettings(input);
      expect(freeShippingBar.startColor).toBe("#8c9196");
      expect(freeShippingBar.barThickness).toBe(8);
      expect(freeShippingBar.mobileMessageFontSize).toBe(14);
      expect(freeShippingBar.paddingTop).toBe(8);
      expect(freeShippingBar.paddingLeft).toBe(16);
      expect(freeShippingBar.barPosition).toBe("top");
    }
  });

  it("rejects an invalid barPosition, falling back to top", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { barPosition: "sideways" } });
    expect(settings.freeShippingBar.barPosition).toBe("top");
  });

  it("accepts barPosition bottom", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { barPosition: "bottom" } });
    expect(settings.freeShippingBar.barPosition).toBe("bottom");
  });

  it("accepts a short 3-digit hex color", () => {
    const settings = normalizeWidgetSettings({ freeShippingBar: { startColor: "#fff" } });
    expect(settings.freeShippingBar.startColor).toBe("#fff");
  });

  it("normalizes a full valid bogoGift config, independent of freeShippingBar", () => {
    const settings = normalizeWidgetSettings({
      bogoGift: {
        trackColor: "#aaaaaa",
        progressColor: "#bbbbbb",
        unlockedColor: "#cccccc",
        lockedMessage: "Add {remaining} more!",
        unlockedMessage: "Ready!",
        addButtonColor: "#dddddd",
        addButtonTextColor: "#eeeeee",
        addButtonLabel: "Claim gift",
        barThickness: 12,
        barPosition: "bottom",
      },
    });

    expect(settings.bogoGift.trackColor).toBe("#aaaaaa");
    expect(settings.bogoGift.progressColor).toBe("#bbbbbb");
    expect(settings.bogoGift.unlockedColor).toBe("#cccccc");
    expect(settings.bogoGift.lockedMessage).toBe("Add {remaining} more!");
    expect(settings.bogoGift.unlockedMessage).toBe("Ready!");
    expect(settings.bogoGift.addButtonColor).toBe("#dddddd");
    expect(settings.bogoGift.addButtonTextColor).toBe("#eeeeee");
    expect(settings.bogoGift.addButtonLabel).toBe("Claim gift");
    expect(settings.bogoGift.barThickness).toBe(12);
    expect(settings.bogoGift.barPosition).toBe("bottom");
  });

  it("returns bogoGift defaults for a missing/malformed value, without disturbing freeShippingBar", () => {
    const settings = normalizeWidgetSettings({
      freeShippingBar: { startColor: "#123123" },
      bogoGift: "garbage",
    });

    expect(settings.freeShippingBar.startColor).toBe("#123123");
    expect(settings.bogoGift.trackColor).toBe("#f1f2f3");
    expect(settings.bogoGift.progressColor).toBe("#8c9196");
    expect(settings.bogoGift.unlockedColor).toBe("#008060");
    expect(settings.bogoGift.lockedMessage).toBe("Add {remaining} more to unlock a free gift!");
    expect(settings.bogoGift.addButtonColor).toBe("#008060");
    expect(settings.bogoGift.addButtonTextColor).toBe("#ffffff");
    expect(settings.bogoGift.addButtonLabel).toBe("Add");
    expect(settings.bogoGift.barThickness).toBe(8);
    expect(settings.bogoGift.barPosition).toBe("top");
  });
});
