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

describe("normalizeWidgetSettings — orderDiscountBar", () => {
  it("normalizes a full valid orderDiscountBar config, independent of the other widgets", () => {
    const settings = normalizeWidgetSettings({
      orderDiscountBar: {
        trackColor: "#aaaaaa",
        startColor: "#bbbbbb",
        nearColor: "#cccccc",
        reachedColor: "#dddddd",
        nearThresholdPercent: 60,
        progressMessage: "Spend more for {discount} off!",
        completeMessage: "{discount} off unlocked!",
        barThickness: 12,
        barPosition: "bottom",
      },
    });

    expect(settings.orderDiscountBar.trackColor).toBe("#aaaaaa");
    expect(settings.orderDiscountBar.startColor).toBe("#bbbbbb");
    expect(settings.orderDiscountBar.nearColor).toBe("#cccccc");
    expect(settings.orderDiscountBar.reachedColor).toBe("#dddddd");
    expect(settings.orderDiscountBar.nearThresholdPercent).toBe(60);
    expect(settings.orderDiscountBar.progressMessage).toBe("Spend more for {discount} off!");
    expect(settings.orderDiscountBar.completeMessage).toBe("{discount} off unlocked!");
    expect(settings.orderDiscountBar.barThickness).toBe(12);
    expect(settings.orderDiscountBar.barPosition).toBe("bottom");
  });

  it("returns orderDiscountBar defaults for a missing/malformed value, without disturbing freeShippingBar", () => {
    const settings = normalizeWidgetSettings({
      freeShippingBar: { startColor: "#123123" },
      orderDiscountBar: "garbage",
    });

    expect(settings.freeShippingBar.startColor).toBe("#123123");
    expect(settings.orderDiscountBar.trackColor).toBe("#f1f2f3");
    expect(settings.orderDiscountBar.startColor).toBe("#8c9196");
    expect(settings.orderDiscountBar.nearColor).toBe("#ffc453");
    expect(settings.orderDiscountBar.reachedColor).toBe("#008060");
    expect(settings.orderDiscountBar.nearThresholdPercent).toBe(75);
    expect(settings.orderDiscountBar.barPosition).toBe("top");
  });
});

describe("normalizeWidgetSettings — announcementBar", () => {
  it("normalizes a full valid announcementBar config", () => {
    const settings = normalizeWidgetSettings({
      announcementBar: {
        enabled: true,
        message: "20% off everything today!",
        ctaLabel: "Shop now",
        ctaUrl: "https://example.com/sale",
        dismissible: false,
        backgroundColor: "#123456",
        textColor: "#abcdef",
        messageFontSize: 18,
        mobileMessageFontSize: 12,
        paddingTop: 20,
        paddingBottom: 20,
        paddingLeft: 24,
        paddingRight: 24,
        mobilePaddingTop: 10,
        mobilePaddingBottom: 10,
        mobilePaddingLeft: 8,
        mobilePaddingRight: 8,
      },
    });

    expect(settings.announcementBar).toEqual({
      enabled: true,
      message: "20% off everything today!",
      ctaLabel: "Shop now",
      ctaUrl: "https://example.com/sale",
      dismissible: false,
      backgroundColor: "#123456",
      textColor: "#abcdef",
      messageFontSize: 18,
      mobileMessageFontSize: 12,
      paddingTop: 20,
      paddingBottom: 20,
      paddingLeft: 24,
      paddingRight: 24,
      mobilePaddingTop: 10,
      mobilePaddingBottom: 10,
      mobilePaddingLeft: 8,
      mobilePaddingRight: 8,
    });
  });

  it("returns defaults for a missing/malformed value", () => {
    const settings = normalizeWidgetSettings({ announcementBar: "garbage" });

    expect(settings.announcementBar.enabled).toBe(false);
    expect(settings.announcementBar.dismissible).toBe(true);
    expect(settings.announcementBar.backgroundColor).toBe("#1a1a1a");
    expect(settings.announcementBar.textColor).toBe("#ffffff");
    expect(settings.announcementBar.ctaUrl).toBe("");
  });

  it("drops a ctaUrl that isn't http(s) or a relative path (e.g. javascript:)", () => {
    const settings = normalizeWidgetSettings({
      announcementBar: { ctaUrl: "javascript:alert(1)" },
    });

    expect(settings.announcementBar.ctaUrl).toBe("");
  });

  it("accepts a relative ctaUrl", () => {
    const settings = normalizeWidgetSettings({
      announcementBar: { ctaUrl: "/collections/sale" },
    });

    expect(settings.announcementBar.ctaUrl).toBe("/collections/sale");
  });
});

describe("normalizeWidgetSettings — tierProgressBar", () => {
  it("normalizes a full valid tierProgressBar config", () => {
    const settings = normalizeWidgetSettings({
      tierProgressBar: {
        trackColor: "#111111",
        progressColor: "#222222",
        reachedColor: "#333333",
        messageTemplate: "Add {remaining} for {discount}!",
        completeMessage: "{discount} unlocked!",
        barThickness: 12,
        barPosition: "bottom",
      },
    });

    expect(settings.tierProgressBar.trackColor).toBe("#111111");
    expect(settings.tierProgressBar.progressColor).toBe("#222222");
    expect(settings.tierProgressBar.reachedColor).toBe("#333333");
    expect(settings.tierProgressBar.messageTemplate).toBe("Add {remaining} for {discount}!");
    expect(settings.tierProgressBar.completeMessage).toBe("{discount} unlocked!");
    expect(settings.tierProgressBar.barThickness).toBe(12);
    expect(settings.tierProgressBar.barPosition).toBe("bottom");
  });

  it("returns defaults for a missing/malformed value", () => {
    const settings = normalizeWidgetSettings({ tierProgressBar: "garbage" });

    expect(settings.tierProgressBar.trackColor).toBe("#f1f2f3");
    expect(settings.tierProgressBar.progressColor).toBe("#8c9196");
    expect(settings.tierProgressBar.reachedColor).toBe("#008060");
    expect(settings.tierProgressBar.barPosition).toBe("top");
  });
});

describe("normalizeWidgetSettings — tierList", () => {
  it("normalizes a full valid tierList config", () => {
    const settings = normalizeWidgetSettings({
      tierList: {
        heading: "Volume savings",
        triggerLabel: "View tiers",
        rowTemplate: "{quantity}+, {discount}",
        backgroundColor: "#111111",
        textColor: "#222222",
        accentColor: "#333333",
        fontSize: 16,
        mobileFontSize: 12,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        paddingRight: 10,
        mobilePaddingTop: 8,
        mobilePaddingBottom: 8,
        mobilePaddingLeft: 8,
        mobilePaddingRight: 8,
      },
    });

    expect(settings.tierList).toEqual({
      heading: "Volume savings",
      triggerLabel: "View tiers",
      rowTemplate: "{quantity}+, {discount}",
      backgroundColor: "#111111",
      textColor: "#222222",
      accentColor: "#333333",
      fontSize: 16,
      mobileFontSize: 12,
      paddingTop: 10,
      paddingBottom: 10,
      paddingLeft: 10,
      paddingRight: 10,
      mobilePaddingTop: 8,
      mobilePaddingBottom: 8,
      mobilePaddingLeft: 8,
      mobilePaddingRight: 8,
    });
  });

  it("returns defaults for a missing/malformed value", () => {
    const settings = normalizeWidgetSettings({ tierList: "garbage" });

    expect(settings.tierList.heading).toBe("Bulk discounts");
    expect(settings.tierList.triggerLabel).toBe("See bulk pricing");
    expect(settings.tierList.rowTemplate).toBe("Buy {quantity}+, save {discount}");
    expect(settings.tierList.backgroundColor).toBe("#ffffff");
  });
});

describe("normalizeWidgetSettings — countdownTimer", () => {
  it("normalizes a full valid fixed-mode config", () => {
    const settings = normalizeWidgetSettings({
      countdownTimer: {
        enabled: true,
        restartMode: "fixed",
        endAt: "2026-12-25T00:00:00.000Z",
        restartAfterEnd: true,
        repeatHours: 48,
        message: "Ends in:",
        expiredMessage: "Ended!",
        backgroundColor: "#111111",
        textColor: "#222222",
        digitBackgroundColor: "#333333",
        digitTextColor: "#444444",
        messageFontSize: 16,
      },
    });

    expect(settings.countdownTimer.enabled).toBe(true);
    expect(settings.countdownTimer.restartMode).toBe("fixed");
    expect(settings.countdownTimer.endAt).toBe("2026-12-25T00:00:00.000Z");
    expect(settings.countdownTimer.restartAfterEnd).toBe(true);
    expect(settings.countdownTimer.repeatHours).toBe(48);
    expect(settings.countdownTimer.message).toBe("Ends in:");
    expect(settings.countdownTimer.expiredMessage).toBe("Ended!");
    expect(settings.countdownTimer.backgroundColor).toBe("#111111");
    expect(settings.countdownTimer.digitBackgroundColor).toBe("#333333");
    expect(settings.countdownTimer.messageFontSize).toBe(16);
  });

  it("normalizes a valid daily/weekly reset time", () => {
    const settings = normalizeWidgetSettings({
      countdownTimer: { restartMode: "weekly", weeklyResetDay: 3, weeklyResetTime: "14:30", dailyResetTime: "09:15" },
    });

    expect(settings.countdownTimer.restartMode).toBe("weekly");
    expect(settings.countdownTimer.weeklyResetDay).toBe(3);
    expect(settings.countdownTimer.weeklyResetTime).toBe("14:30");
    expect(settings.countdownTimer.dailyResetTime).toBe("09:15");
  });

  it("rejects a malformed HH:MM and falls back to the default", () => {
    const settings = normalizeWidgetSettings({
      countdownTimer: { dailyResetTime: "25:99", weeklyResetTime: "not-a-time" },
    });

    expect(settings.countdownTimer.dailyResetTime).toBe("00:00");
    expect(settings.countdownTimer.weeklyResetTime).toBe("00:00");
  });

  it("rejects an invalid weeklyResetDay and falls back to Sunday", () => {
    const settings = normalizeWidgetSettings({ countdownTimer: { weeklyResetDay: 9 } });
    expect(settings.countdownTimer.weeklyResetDay).toBe(0);
  });

  it("rejects an unparseable endAt and falls back to a future default", () => {
    const settings = normalizeWidgetSettings({ countdownTimer: { endAt: "not-a-date" } });
    expect(new Date(settings.countdownTimer.endAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("clamps repeatHours to at least 1 and at most 8760", () => {
    expect(normalizeWidgetSettings({ countdownTimer: { repeatHours: 0 } }).countdownTimer.repeatHours).toBe(1);
    expect(normalizeWidgetSettings({ countdownTimer: { repeatHours: 999999 } }).countdownTimer.repeatHours).toBe(8760);
  });

  it("returns defaults for a missing/malformed value, without disturbing other widgets", () => {
    const settings = normalizeWidgetSettings({
      freeShippingBar: { startColor: "#123123" },
      countdownTimer: "garbage",
    });

    expect(settings.freeShippingBar.startColor).toBe("#123123");
    expect(settings.countdownTimer.enabled).toBe(false);
    expect(settings.countdownTimer.restartMode).toBe("daily");
    expect(settings.countdownTimer.dailyResetTime).toBe("00:00");
    expect(settings.countdownTimer.repeatHours).toBe(24);
    expect(settings.countdownTimer.backgroundColor).toBe("#1a1a1a");
  });
});
