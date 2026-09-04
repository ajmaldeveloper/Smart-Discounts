import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { utcIsoToZonedParts, zonedTimeToUtcIso } from "../lib/timezone";
import {
  normalizeWidgetSettings,
  type AnnouncementBarSettings,
  type BarSizingSettings,
  type BogoGiftSettings,
  type FreeShippingBarSettings,
  type CountdownTimerSettings,
  type OrderDiscountBarSettings,
  type TierListSettings,
  type TierProgressBarSettings,
} from "../lib/widget-settings";

type ActionData = { error?: string; notice?: string };
type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// Hosted from our own app (not the theme extension's asset pipeline)
// so it can be pasted into ANY theme file — the cart drawer, above the
// footer, wherever a merchant wants it — instead of being confined to
// wherever a "target: body" app embed happens to land in the DOM.
const WIDGETS_BASE_URL = "https://winslet-smart-discounts.fly.dev/widgets";

// Split in two deliberately: a cart drawer's own AJAX refresh usually
// replaces its markup via innerHTML, and browsers never execute a
// <script> tag inserted that way — only a real full-page load does.
// The loader script only ever needs to run once (it just registers
// the custom element), so it goes in theme.liquid where a real page
// load always executes it; the placement tag is pure HTML with no
// <script> of its own, so it's safe to paste anywhere, including
// somewhere that gets AJAX-refreshed repeatedly.
function buildLoaderSnippet(file: string): string {
  return `<script src="${WIDGETS_BASE_URL}/${file}" defer></script>`;
}
function buildPlacementSnippet(tag: string, includeCurrency = true): string {
  const currencyAttr = includeCurrency ? ` data-currency="{{ cart.currency.iso_code }}"` : "";
  return `<${tag} data-proxy-root="/apps/winslet"${currencyAttr}></${tag}>`;
}

const PIXEL_FIELDS = [
  ["barThickness", "Bar thickness", 48],
  ["mobileBarThickness", "Mobile bar thickness", 48],
  ["barRoundness", "Bar roundness", 999],
  ["mobileBarRoundness", "Mobile bar roundness", 999],
  ["messageFontSize", "Message font size", 48],
  ["mobileMessageFontSize", "Mobile message font size", 48],
  ["barMessageGap", "Bar-to-message gap", 64],
  ["mobileBarMessageGap", "Mobile bar-to-message gap", 64],
  ["paddingTop", "Top padding", 200],
  ["paddingBottom", "Bottom padding", 200],
  ["paddingLeft", "Left padding", 200],
  ["paddingRight", "Right padding", 200],
  ["mobilePaddingTop", "Mobile top padding", 200],
  ["mobilePaddingBottom", "Mobile bottom padding", 200],
  ["mobilePaddingLeft", "Mobile left padding", 200],
  ["mobilePaddingRight", "Mobile right padding", 200],
] as const;

/** Shared by both widgets — parses+validates the BarSizingSettings fields + barPosition out of a submitted form. */
function parseBarSizing(formData: FormData): BarSizingSettings | { error: string } {
  const values: Record<string, number> = {};
  for (const [key, label, max] of PIXEL_FIELDS) {
    const parsed = Number(String(formData.get(key) ?? "").trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
      return { error: `${label} must be a number between 0 and ${max}.` };
    }
    values[key] = parsed;
  }

  return {
    barThickness: values.barThickness,
    mobileBarThickness: values.mobileBarThickness,
    barRoundness: values.barRoundness,
    mobileBarRoundness: values.mobileBarRoundness,
    messageFontSize: values.messageFontSize,
    mobileMessageFontSize: values.mobileMessageFontSize,
    barMessageGap: values.barMessageGap,
    mobileBarMessageGap: values.mobileBarMessageGap,
    paddingTop: values.paddingTop,
    paddingBottom: values.paddingBottom,
    paddingLeft: values.paddingLeft,
    paddingRight: values.paddingRight,
    mobilePaddingTop: values.mobilePaddingTop,
    mobilePaddingBottom: values.mobilePaddingBottom,
    mobilePaddingLeft: values.mobilePaddingLeft,
    mobilePaddingRight: values.mobilePaddingRight,
    barPosition: formData.get("barPosition") === "bottom" ? "bottom" : "top",
  };
}

const ANNOUNCEMENT_PIXEL_FIELDS = [
  ["messageFontSize", "Message font size", 48],
  ["mobileMessageFontSize", "Mobile message font size", 48],
  ["paddingTop", "Top padding", 200],
  ["paddingBottom", "Bottom padding", 200],
  ["paddingLeft", "Left padding", 200],
  ["paddingRight", "Right padding", 200],
  ["mobilePaddingTop", "Mobile top padding", 200],
  ["mobilePaddingBottom", "Mobile bottom padding", 200],
  ["mobilePaddingLeft", "Mobile left padding", 200],
  ["mobilePaddingRight", "Mobile right padding", 200],
] as const;

/** The announcement bar has no bar to size (no thickness/roundness/gap/position) — just typography + padding. */
function parseAnnouncementSizing(
  formData: FormData,
):
  | Pick<
      AnnouncementBarSettings,
      | "messageFontSize"
      | "mobileMessageFontSize"
      | "paddingTop"
      | "paddingBottom"
      | "paddingLeft"
      | "paddingRight"
      | "mobilePaddingTop"
      | "mobilePaddingBottom"
      | "mobilePaddingLeft"
      | "mobilePaddingRight"
    >
  | { error: string } {
  const values: Record<string, number> = {};
  for (const [key, label, max] of ANNOUNCEMENT_PIXEL_FIELDS) {
    const parsed = Number(String(formData.get(key) ?? "").trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
      return { error: `${label} must be a number between 0 and ${max}.` };
    }
    values[key] = parsed;
  }

  return {
    messageFontSize: values.messageFontSize,
    mobileMessageFontSize: values.mobileMessageFontSize,
    paddingTop: values.paddingTop,
    paddingBottom: values.paddingBottom,
    paddingLeft: values.paddingLeft,
    paddingRight: values.paddingRight,
    mobilePaddingTop: values.mobilePaddingTop,
    mobilePaddingBottom: values.mobilePaddingBottom,
    mobilePaddingLeft: values.mobilePaddingLeft,
    mobilePaddingRight: values.mobilePaddingRight,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  const settings = normalizeWidgetSettings(shop?.widgetSettingsJson);

  return {
    freeShippingBar: settings.freeShippingBar,
    bogoGift: settings.bogoGift,
    announcementBar: settings.announcementBar,
    orderDiscountBar: settings.orderDiscountBar,
    tierProgressBar: settings.tierProgressBar,
    tierList: settings.tierList,
    countdownTimer: settings.countdownTimer,
    shopTimezone: shop?.timezone ?? "UTC",
    shop: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const widgetKeyRaw = formData.get("widgetKey");
  const validWidgetKeys = ["bogoGift", "announcementBar", "orderDiscountBar", "tierProgressBar", "tierList", "countdownTimer"] as const;
  const widgetKey = (validWidgetKeys as readonly string[]).includes(String(widgetKeyRaw))
    ? (widgetKeyRaw as (typeof validWidgetKeys)[number])
    : "freeShippingBar";

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  const current = normalizeWidgetSettings(shop?.widgetSettingsJson);

  if (widgetKey === "announcementBar") {
    const sizing = parseAnnouncementSizing(formData);
    if ("error" in sizing) return { error: sizing.error } satisfies ActionData;

    const message = String(formData.get("message") ?? "").trim();
    const ctaLabel = String(formData.get("ctaLabel") ?? "").trim();
    const ctaUrlRaw = String(formData.get("ctaUrl") ?? "").trim();
    const backgroundColor = String(formData.get("backgroundColor") ?? "").trim();
    const textColor = String(formData.get("textColor") ?? "").trim();
    const enabled = formData.get("enabled") === "true";
    const dismissible = formData.get("dismissible") === "true";

    if (!message) return { error: "Enter a message." } satisfies ActionData;
    for (const [label, value] of [
      ["Background", backgroundColor],
      ["Text", textColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }
    if (ctaUrlRaw && !/^https?:\/\//i.test(ctaUrlRaw) && !ctaUrlRaw.startsWith("/")) {
      return { error: "CTA link must start with http://, https://, or /." } satisfies ActionData;
    }

    const announcementBar: AnnouncementBarSettings = {
      ...sizing,
      enabled,
      message,
      ctaLabel,
      ctaUrl: ctaUrlRaw,
      dismissible,
      backgroundColor,
      textColor,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, announcementBar } as unknown as object },
    });

    return { notice: "Storefront widget settings saved." } satisfies ActionData;
  }

  if (widgetKey === "tierList") {
    const heading = String(formData.get("heading") ?? "").trim();
    const triggerLabel = String(formData.get("triggerLabel") ?? "").trim();
    const rowTemplate = String(formData.get("rowTemplate") ?? "").trim();
    const backgroundColor = String(formData.get("backgroundColor") ?? "").trim();
    const textColor = String(formData.get("textColor") ?? "").trim();
    const accentColor = String(formData.get("accentColor") ?? "").trim();
    const fontSize = Number(String(formData.get("fontSize") ?? "").trim());
    const mobileFontSize = Number(String(formData.get("mobileFontSize") ?? "").trim());

    if (!heading) return { error: "Enter a heading." } satisfies ActionData;
    if (!triggerLabel) return { error: "Enter a trigger label." } satisfies ActionData;
    if (!rowTemplate) return { error: "Enter a row template." } satisfies ActionData;
    for (const [label, value] of [
      ["Background", backgroundColor],
      ["Text", textColor],
      ["Accent", accentColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }
    if (!Number.isFinite(fontSize) || fontSize < 0 || fontSize > 48) return { error: "Font size must be a number between 0 and 48." } satisfies ActionData;
    if (!Number.isFinite(mobileFontSize) || mobileFontSize < 0 || mobileFontSize > 48) {
      return { error: "Mobile font size must be a number between 0 and 48." } satisfies ActionData;
    }

    const paddingFieldNames = [
      "paddingTop",
      "paddingBottom",
      "paddingLeft",
      "paddingRight",
      "mobilePaddingTop",
      "mobilePaddingBottom",
      "mobilePaddingLeft",
      "mobilePaddingRight",
    ] as const;
    const padding: Record<string, number> = {};
    for (const key of paddingFieldNames) {
      const parsed = Number(String(formData.get(key) ?? "").trim());
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
        return { error: "Padding fields must be numbers between 0 and 200." } satisfies ActionData;
      }
      padding[key] = parsed;
    }

    const tierList: TierListSettings = {
      heading,
      triggerLabel,
      rowTemplate,
      backgroundColor,
      textColor,
      accentColor,
      fontSize,
      mobileFontSize,
      paddingTop: padding.paddingTop,
      paddingBottom: padding.paddingBottom,
      paddingLeft: padding.paddingLeft,
      paddingRight: padding.paddingRight,
      mobilePaddingTop: padding.mobilePaddingTop,
      mobilePaddingBottom: padding.mobilePaddingBottom,
      mobilePaddingLeft: padding.mobilePaddingLeft,
      mobilePaddingRight: padding.mobilePaddingRight,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, tierList } as unknown as object },
    });

    return { notice: "Storefront widget settings saved." } satisfies ActionData;
  }

  if (widgetKey === "countdownTimer") {
    const sizing = parseAnnouncementSizing(formData);
    if ("error" in sizing) return { error: sizing.error } satisfies ActionData;

    const restartModeRaw = formData.get("restartMode");
    const restartMode = restartModeRaw === "fixed" || restartModeRaw === "weekly" ? restartModeRaw : "daily";
    const endAt = String(formData.get("endAt") ?? "").trim();
    const restartAfterEnd = formData.get("restartAfterEnd") === "true";
    const repeatHours = Number(String(formData.get("repeatHours") ?? "").trim());
    const dailyResetTime = String(formData.get("dailyResetTime") ?? "").trim();
    const weeklyResetDay = Number(String(formData.get("weeklyResetDay") ?? "").trim());
    const weeklyResetTime = String(formData.get("weeklyResetTime") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const expiredMessage = String(formData.get("expiredMessage") ?? "").trim();
    const backgroundColor = String(formData.get("backgroundColor") ?? "").trim();
    const textColor = String(formData.get("textColor") ?? "").trim();
    const digitBackgroundColor = String(formData.get("digitBackgroundColor") ?? "").trim();
    const digitTextColor = String(formData.get("digitTextColor") ?? "").trim();
    const labelColor = String(formData.get("labelColor") ?? "").trim();
    const showLabels = formData.get("showLabels") === "true";
    const digitRadius = Number(String(formData.get("digitRadius") ?? "").trim());
    const mobileDigitRadius = Number(String(formData.get("mobileDigitRadius") ?? "").trim());
    const digitGap = Number(String(formData.get("digitGap") ?? "").trim());
    const mobileDigitGap = Number(String(formData.get("mobileDigitGap") ?? "").trim());

    if (!message) return { error: "Enter a message." } satisfies ActionData;
    for (const [label, value] of [
      ["Background", backgroundColor],
      ["Text", textColor],
      ["Digit background", digitBackgroundColor],
      ["Digit text", digitTextColor],
      ["Label", labelColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }
    for (const [label, value, max] of [
      ["Digit box roundness", digitRadius, 999],
      ["Mobile digit box roundness", mobileDigitRadius, 999],
      ["Gap between digits", digitGap, 64],
      ["Mobile gap between digits", mobileDigitGap, 64],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > max) {
        return { error: `${label} must be a number between 0 and ${max}.` } satisfies ActionData;
      }
    }
    if (restartMode === "fixed") {
      if (!endAt || Number.isNaN(new Date(endAt).getTime())) return { error: "Choose a valid end date/time." } satisfies ActionData;
      if (restartAfterEnd && (!Number.isFinite(repeatHours) || repeatHours < 1 || repeatHours > 8760)) {
        return { error: "Repeat length must be a number between 1 and 8760 hours." } satisfies ActionData;
      }
    }
    if (restartMode === "daily" && !HH_MM_PATTERN.test(dailyResetTime)) {
      return { error: "Choose a valid daily reset time." } satisfies ActionData;
    }
    if (restartMode === "weekly") {
      if (!Number.isInteger(weeklyResetDay) || weeklyResetDay < 0 || weeklyResetDay > 6) {
        return { error: "Choose a valid weekly reset day." } satisfies ActionData;
      }
      if (!HH_MM_PATTERN.test(weeklyResetTime)) return { error: "Choose a valid weekly reset time." } satisfies ActionData;
    }

    const countdownTimer: CountdownTimerSettings = {
      ...sizing,
      enabled: formData.get("enabled") === "true",
      restartMode,
      endAt: endAt || new Date(Date.now() + 7 * 86400000).toISOString(),
      restartAfterEnd,
      repeatHours: Number.isFinite(repeatHours) ? repeatHours : 24,
      dailyResetTime: dailyResetTime || "00:00",
      weeklyResetDay: Number.isInteger(weeklyResetDay) ? weeklyResetDay : 0,
      weeklyResetTime: weeklyResetTime || "00:00",
      message,
      expiredMessage,
      backgroundColor,
      textColor,
      digitBackgroundColor,
      digitTextColor,
      labelColor,
      showLabels,
      digitRadius,
      mobileDigitRadius,
      digitGap,
      mobileDigitGap,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, countdownTimer } as unknown as object },
    });

    return { notice: "Storefront widget settings saved." } satisfies ActionData;
  }

  const sizing = parseBarSizing(formData);
  if ("error" in sizing) return { error: sizing.error } satisfies ActionData;

  if (widgetKey === "freeShippingBar") {
    const trackColor = String(formData.get("trackColor") ?? "").trim();
    const startColor = String(formData.get("startColor") ?? "").trim();
    const nearColor = String(formData.get("nearColor") ?? "").trim();
    const reachedColor = String(formData.get("reachedColor") ?? "").trim();
    const nearThresholdPercentRaw = String(formData.get("nearThresholdPercent") ?? "").trim();
    const progressMessage = String(formData.get("progressMessage") ?? "").trim();
    const completeMessage = String(formData.get("completeMessage") ?? "").trim();

    for (const [label, value] of [
      ["Background", trackColor],
      ["Starting", startColor],
      ["Nearly-reached", nearColor],
      ["Reached", reachedColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }

    const nearThresholdPercent = Number(nearThresholdPercentRaw);
    if (!Number.isFinite(nearThresholdPercent) || nearThresholdPercent < 0 || nearThresholdPercent > 100) {
      return { error: "Nearly-reached breakpoint must be a percent between 0 and 100." } satisfies ActionData;
    }
    if (!progressMessage) return { error: "Enter a progress message." } satisfies ActionData;
    if (!completeMessage) return { error: "Enter a complete message." } satisfies ActionData;

    const freeShippingBar: FreeShippingBarSettings = {
      ...sizing,
      trackColor,
      startColor,
      nearColor,
      reachedColor,
      nearThresholdPercent,
      progressMessage,
      completeMessage,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, freeShippingBar } as unknown as object },
    });
  } else if (widgetKey === "orderDiscountBar") {
    const trackColor = String(formData.get("trackColor") ?? "").trim();
    const startColor = String(formData.get("startColor") ?? "").trim();
    const nearColor = String(formData.get("nearColor") ?? "").trim();
    const reachedColor = String(formData.get("reachedColor") ?? "").trim();
    const nearThresholdPercentRaw = String(formData.get("nearThresholdPercent") ?? "").trim();
    const progressMessage = String(formData.get("progressMessage") ?? "").trim();
    const completeMessage = String(formData.get("completeMessage") ?? "").trim();

    for (const [label, value] of [
      ["Background", trackColor],
      ["Starting", startColor],
      ["Nearly-reached", nearColor],
      ["Reached", reachedColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }

    const nearThresholdPercent = Number(nearThresholdPercentRaw);
    if (!Number.isFinite(nearThresholdPercent) || nearThresholdPercent < 0 || nearThresholdPercent > 100) {
      return { error: "Nearly-reached breakpoint must be a percent between 0 and 100." } satisfies ActionData;
    }
    if (!progressMessage) return { error: "Enter a progress message." } satisfies ActionData;
    if (!completeMessage) return { error: "Enter a complete message." } satisfies ActionData;

    const orderDiscountBar: OrderDiscountBarSettings = {
      ...sizing,
      trackColor,
      startColor,
      nearColor,
      reachedColor,
      nearThresholdPercent,
      progressMessage,
      completeMessage,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, orderDiscountBar } as unknown as object },
    });
  } else if (widgetKey === "tierProgressBar") {
    const trackColor = String(formData.get("trackColor") ?? "").trim();
    const progressColor = String(formData.get("progressColor") ?? "").trim();
    const reachedColor = String(formData.get("reachedColor") ?? "").trim();
    const messageTemplate = String(formData.get("messageTemplate") ?? "").trim();
    const completeMessage = String(formData.get("completeMessage") ?? "").trim();

    for (const [label, value] of [
      ["Background", trackColor],
      ["Progress", progressColor],
      ["Reached", reachedColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }
    if (!messageTemplate) return { error: "Enter a progress message." } satisfies ActionData;
    if (!completeMessage) return { error: "Enter a complete message." } satisfies ActionData;

    const tierProgressBar: TierProgressBarSettings = {
      ...sizing,
      trackColor,
      progressColor,
      reachedColor,
      messageTemplate,
      completeMessage,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, tierProgressBar } as unknown as object },
    });
  } else {
    const trackColor = String(formData.get("trackColor") ?? "").trim();
    const progressColor = String(formData.get("progressColor") ?? "").trim();
    const unlockedColor = String(formData.get("unlockedColor") ?? "").trim();
    const addButtonColor = String(formData.get("addButtonColor") ?? "").trim();
    const addButtonTextColor = String(formData.get("addButtonTextColor") ?? "").trim();
    const lockedMessage = String(formData.get("lockedMessage") ?? "").trim();
    const unlockedMessage = String(formData.get("unlockedMessage") ?? "").trim();
    const addedMessage = String(formData.get("addedMessage") ?? "").trim();
    const addButtonLabel = String(formData.get("addButtonLabel") ?? "").trim();

    for (const [label, value] of [
      ["Background", trackColor],
      ["Progress", progressColor],
      ["Unlocked", unlockedColor],
      ["Add button", addButtonColor],
      ["Add button text", addButtonTextColor],
    ] as const) {
      if (!HEX_COLOR.test(value)) return { error: `${label} color must be a valid hex color (e.g. #008060).` } satisfies ActionData;
    }
    if (!lockedMessage) return { error: "Enter a locked message." } satisfies ActionData;
    if (!unlockedMessage) return { error: "Enter an unlocked message." } satisfies ActionData;
    if (!addedMessage) return { error: "Enter a product added message." } satisfies ActionData;
    if (!addButtonLabel) return { error: "Enter an Add button label." } satisfies ActionData;

    const bogoGift: BogoGiftSettings = {
      ...sizing,
      trackColor,
      progressColor,
      unlockedColor,
      addButtonColor,
      addButtonTextColor,
      lockedMessage,
      unlockedMessage,
      addedMessage,
      addButtonLabel,
    };

    await db.shop.update({
      where: { domain: session.shop },
      data: { widgetSettingsJson: { ...current, bogoGift } as unknown as object },
    });
  }

  return { notice: "Storefront widget settings saved." } satisfies ActionData;
};

function PixelPair({
  label,
  mobileLabel,
  value,
  mobileValue,
  max,
  onChange,
  onMobileChange,
}: {
  label: string;
  mobileLabel: string;
  value: number;
  mobileValue: number;
  max: number;
  onChange: (next: number) => void;
  onMobileChange: (next: number) => void;
}) {
  return (
    <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
      <s-number-field
        label={label}
        min={0}
        max={max}
        suffix="px"
        value={String(value)}
        onInput={(event: ControlEvent) => onChange(Number(readValue(event)) || 0)}
      />
      <s-number-field
        label={mobileLabel}
        min={0}
        max={max}
        suffix="px"
        value={String(mobileValue)}
        onInput={(event: ControlEvent) => onMobileChange(Number(readValue(event)) || 0)}
      />
    </s-grid>
  );
}

/** The sizing/layout fields shared by both widgets — one instance per section, working on that section's own draft slice. */
function BarSizingFields<T extends BarSizingSettings>({ draft, update }: { draft: T; update: <K extends keyof T>(key: K, value: T[K]) => void }) {
  return (
    <>
      <s-select
        label="Layout"
        value={draft.barPosition}
        onChange={(event: ControlEvent) => update("barPosition" as keyof T, (readValue(event) === "bottom" ? "bottom" : "top") as T[keyof T])}
      >
        <s-option value="top">Bar on top, message below</s-option>
        <s-option value="bottom">Message on top, bar below</s-option>
      </s-select>

      <PixelPair
        label="Bar thickness"
        mobileLabel="Mobile bar thickness"
        value={draft.barThickness}
        mobileValue={draft.mobileBarThickness}
        max={48}
        onChange={(v) => update("barThickness" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobileBarThickness" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Bar roundness"
        mobileLabel="Mobile bar roundness"
        value={draft.barRoundness}
        mobileValue={draft.mobileBarRoundness}
        max={999}
        onChange={(v) => update("barRoundness" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobileBarRoundness" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Message font size"
        mobileLabel="Mobile message font size"
        value={draft.messageFontSize}
        mobileValue={draft.mobileMessageFontSize}
        max={48}
        onChange={(v) => update("messageFontSize" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobileMessageFontSize" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Bar-to-message gap"
        mobileLabel="Mobile bar-to-message gap"
        value={draft.barMessageGap}
        mobileValue={draft.mobileBarMessageGap}
        max={64}
        onChange={(v) => update("barMessageGap" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobileBarMessageGap" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Top padding"
        mobileLabel="Mobile top padding"
        value={draft.paddingTop}
        mobileValue={draft.mobilePaddingTop}
        max={200}
        onChange={(v) => update("paddingTop" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobilePaddingTop" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Bottom padding"
        mobileLabel="Mobile bottom padding"
        value={draft.paddingBottom}
        mobileValue={draft.mobilePaddingBottom}
        max={200}
        onChange={(v) => update("paddingBottom" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobilePaddingBottom" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Left padding"
        mobileLabel="Mobile left padding"
        value={draft.paddingLeft}
        mobileValue={draft.mobilePaddingLeft}
        max={200}
        onChange={(v) => update("paddingLeft" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobilePaddingLeft" as keyof T, v as T[keyof T])}
      />

      <PixelPair
        label="Right padding"
        mobileLabel="Mobile right padding"
        value={draft.paddingRight}
        mobileValue={draft.mobilePaddingRight}
        max={200}
        onChange={(v) => update("paddingRight" as keyof T, v as T[keyof T])}
        onMobileChange={(v) => update("mobilePaddingRight" as keyof T, v as T[keyof T])}
      />
    </>
  );
}

function useCopyToClipboard() {
  const shopify = useAppBridge();
  return async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      shopify.toast.show(`${label} copied.`, { duration: 2000 });
    } catch {
      shopify.toast.show("Couldn't copy — select and copy the code manually.", { isError: true });
    }
  };
}

function SnippetModal({
  id,
  heading,
  loaderFile,
  placements,
}: {
  id: string;
  heading: string;
  loaderFile: string;
  placements: Array<{ tag: string; title: string; description: string; includeCurrency?: boolean }>;
}) {
  const copyToClipboard = useCopyToClipboard();
  const loaderSnippet = buildLoaderSnippet(loaderFile);

  return (
    <s-modal id={id} heading={heading}>
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">1. Paste once in theme.liquid</s-text>
          <s-text color="subdued">Anywhere before &lt;/body&gt; — just once, ever.</s-text>
          <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
            <s-text-area label="" value={loaderSnippet} readOnly rows={2} />
            <s-button onClick={() => copyToClipboard(loaderSnippet, "Loader script")}>Copy</s-button>
          </s-grid>
        </s-stack>

        {placements.map((placement, index) => {
          const placementSnippet = buildPlacementSnippet(placement.tag, placement.includeCurrency ?? true);
          return (
            <s-stack direction="block" gap="small-200" key={placement.tag}>
              <s-text type="strong">{`${index + 2}. ${placement.title}`}</s-text>
              <s-text color="subdued">{placement.description}</s-text>
              <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
                <s-text-area label="" value={placementSnippet} readOnly rows={2} />
                <s-button onClick={() => copyToClipboard(placementSnippet, placement.title)}>Copy</s-button>
              </s-grid>
            </s-stack>
          );
        })}
      </s-stack>

      <s-button slot="secondary-actions" commandFor={id} command="--hide">
        Close
      </s-button>
    </s-modal>
  );
}

function AddToStoreCallout({ modalId }: { modalId: string }) {
  return (
    <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack direction="block" gap="small-400">
          <s-text type="strong">Add to your store</s-text>
          <s-text color="subdued">Short snippets to paste into your theme&apos;s code.</s-text>
        </s-stack>
        <s-button variant="primary" commandFor={modalId} command="--show">
          Copy snippet code
        </s-button>
      </s-stack>
    </s-box>
  );
}

function FreeShippingBarSection({ initial }: { initial: FreeShippingBarSettings }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<FreeShippingBarSettings>(initial);
  const update = <K extends keyof FreeShippingBarSettings>(key: K, value: FreeShippingBarSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "freeShippingBar";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <s-section heading="Free shipping bar">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Shows live progress toward whichever active campaign has a free-shipping minimum — always in sync with the
          real discount, no manual re-entry.
        </s-paragraph>

        <AddToStoreCallout modalId="free-shipping-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-number-field
              label="Switch to nearly-reached color at (% of threshold)"
              min={0}
              max={100}
              suffix="%"
              value={String(draft.nearThresholdPercent)}
              onInput={(event: ControlEvent) => update("nearThresholdPercent", Number(readValue(event)) || 0)}
            />

            <s-text-field
              label="Progress message"
              details="Shown below the threshold. Tokens: {{remaining}} (bare number), {{currency_symbol}} (e.g. $), {{currency_code}} (e.g. USD)."
              value={draft.progressMessage}
              onInput={(event: ControlEvent) => update("progressMessage", readValue(event))}
            />

            <s-text-field
              label="Complete message"
              details="Shown once the threshold is met."
              value={draft.completeMessage}
              onInput={(event: ControlEvent) => update("completeMessage", readValue(event))}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.trackColor}
                onInput={(event: ControlEvent) => update("trackColor", readValue(event))}
              />
              <s-color-field
                label="Starting color"
                value={draft.startColor}
                onInput={(event: ControlEvent) => update("startColor", readValue(event))}
              />
              <s-color-field
                label="Nearly-reached color"
                value={draft.nearColor}
                onInput={(event: ControlEvent) => update("nearColor", readValue(event))}
              />
              <s-color-field
                label="Reached color"
                value={draft.reachedColor}
                onInput={(event: ControlEvent) => update("reachedColor", readValue(event))}
              />
            </s-grid>

            <BarSizingFields draft={draft} update={update} />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "freeShippingBar");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="free-shipping-snippet-modal"
        heading="Free shipping bar — snippet code"
        loaderFile="free-shipping-bar.js"
        placements={[
          {
            tag: "winslet-free-shipping-bar",
            title: "Paste wherever you want it to show",
            description: "Cart drawer, cart page, anywhere — paste it as many times as you like.",
          },
        ]}
      />
    </s-section>
  );
}

function OrderDiscountBarSection({ initial }: { initial: OrderDiscountBarSettings }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<OrderDiscountBarSettings>(initial);
  const update = <K extends keyof OrderDiscountBarSettings>(key: K, value: OrderDiscountBarSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "orderDiscountBar";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <s-section heading="Order discount bar">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Shows live progress toward whichever active campaign gives a percent/fixed-amount discount on the whole order —
          always in sync with the real discount, no manual re-entry.
        </s-paragraph>

        <AddToStoreCallout modalId="order-discount-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-number-field
              label="Switch to nearly-reached color at (% of threshold)"
              min={0}
              max={100}
              suffix="%"
              value={String(draft.nearThresholdPercent)}
              onInput={(event: ControlEvent) => update("nearThresholdPercent", Number(readValue(event)) || 0)}
            />

            <s-text-field
              label="Progress message"
              details="Shown below the threshold. Tokens: {{remaining}} (bare number), {{currency_symbol}} (e.g. $), {{currency_code}} (e.g. USD), {{discount}} (e.g. 15% or $10)."
              value={draft.progressMessage}
              onInput={(event: ControlEvent) => update("progressMessage", readValue(event))}
            />

            <s-text-field
              label="Complete message"
              details="Shown once the threshold is met. Same tokens as above."
              value={draft.completeMessage}
              onInput={(event: ControlEvent) => update("completeMessage", readValue(event))}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.trackColor}
                onInput={(event: ControlEvent) => update("trackColor", readValue(event))}
              />
              <s-color-field
                label="Starting color"
                value={draft.startColor}
                onInput={(event: ControlEvent) => update("startColor", readValue(event))}
              />
              <s-color-field
                label="Nearly-reached color"
                value={draft.nearColor}
                onInput={(event: ControlEvent) => update("nearColor", readValue(event))}
              />
              <s-color-field
                label="Reached color"
                value={draft.reachedColor}
                onInput={(event: ControlEvent) => update("reachedColor", readValue(event))}
              />
            </s-grid>

            <BarSizingFields draft={draft} update={update} />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "orderDiscountBar");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="order-discount-snippet-modal"
        heading="Order discount bar — snippet code"
        loaderFile="order-discount-bar.js"
        placements={[
          {
            tag: "winslet-order-discount-bar",
            title: "Paste wherever you want it to show",
            description: "Cart drawer, cart page, anywhere — paste it as many times as you like.",
          },
        ]}
      />
    </s-section>
  );
}

function TierProgressBarSection({ initial }: { initial: TierProgressBarSettings }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<TierProgressBarSettings>(initial);
  const update = <K extends keyof TierProgressBarSettings>(key: K, value: TierProgressBarSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "tierProgressBar";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <s-section heading="Tier progress bar">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Shows live progress toward every tier of your active volume/quantity discount, with a tick mark for each
          breakpoint — always in sync with the real discount, no manual re-entry.
        </s-paragraph>

        <AddToStoreCallout modalId="tier-progress-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-text-field
              label="Progress message"
              details="Shown below the highest tier. Tokens: {{remaining}} (to the next tier), {{currency_symbol}}, {{currency_code}}, {{discount}} (the next tier's %/amount)."
              value={draft.messageTemplate}
              onInput={(event: ControlEvent) => update("messageTemplate", readValue(event))}
            />

            <s-text-field
              label="Complete message"
              details="Shown once the highest tier is met. Token: {{discount}} (the highest tier's %/amount)."
              value={draft.completeMessage}
              onInput={(event: ControlEvent) => update("completeMessage", readValue(event))}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.trackColor}
                onInput={(event: ControlEvent) => update("trackColor", readValue(event))}
              />
              <s-color-field
                label="Progress color"
                value={draft.progressColor}
                onInput={(event: ControlEvent) => update("progressColor", readValue(event))}
              />
              <s-color-field
                label="Reached color"
                value={draft.reachedColor}
                onInput={(event: ControlEvent) => update("reachedColor", readValue(event))}
              />
            </s-grid>

            <BarSizingFields draft={draft} update={update} />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "tierProgressBar");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="tier-progress-snippet-modal"
        heading="Tier progress bar — snippet code"
        loaderFile="tier-progress-bar.js"
        placements={[
          {
            tag: "winslet-tier-progress-bar",
            title: "Paste wherever you want it to show",
            description: "Cart drawer, cart page, anywhere — paste it as many times as you like.",
          },
        ]}
      />
    </s-section>
  );
}

function BogoGiftSection({ initial }: { initial: BogoGiftSettings }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<BogoGiftSettings>(initial);
  const update = <K extends keyof BogoGiftSettings>(key: K, value: BogoGiftSettings[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "bogoGift";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <s-section heading="Buy X get Y free — gift picker">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Shows live progress toward whichever active campaign has a free-gift pool, with an Add button for each
          eligible product — enabled only once the shopper has actually qualified.
        </s-paragraph>

        <AddToStoreCallout modalId="bogo-gift-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-text-field
              label="Locked message"
              details="Shown before the shopper qualifies. Tokens: {{remaining}} (units still needed), {{product_title}}, {{price}}, {{currency_symbol}}, {{currency_code}}."
              value={draft.lockedMessage}
              onInput={(event: ControlEvent) => update("lockedMessage", readValue(event))}
            />

            <s-text-field
              label="Unlocked message"
              details="Shown once they qualify for at least one free unit. Same tokens as above."
              value={draft.unlockedMessage}
              onInput={(event: ControlEvent) => update("unlockedMessage", readValue(event))}
            />

            <s-text-field
              label="Product added message"
              details="Shown once the free gift is actually in their cart. Same tokens as above."
              value={draft.addedMessage}
              onInput={(event: ControlEvent) => update("addedMessage", readValue(event))}
            />

            <s-text-field
              label="Add button label"
              details="Shown on the free-gift product card's button."
              value={draft.addButtonLabel}
              onInput={(event: ControlEvent) => update("addButtonLabel", readValue(event))}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.trackColor}
                onInput={(event: ControlEvent) => update("trackColor", readValue(event))}
              />
              <s-color-field
                label="Progress color"
                value={draft.progressColor}
                onInput={(event: ControlEvent) => update("progressColor", readValue(event))}
              />
              <s-color-field
                label="Unlocked color"
                value={draft.unlockedColor}
                onInput={(event: ControlEvent) => update("unlockedColor", readValue(event))}
              />
              <s-color-field
                label="Add button color"
                value={draft.addButtonColor}
                onInput={(event: ControlEvent) => update("addButtonColor", readValue(event))}
              />
              <s-color-field
                label="Add button text color"
                value={draft.addButtonTextColor}
                onInput={(event: ControlEvent) => update("addButtonTextColor", readValue(event))}
              />
            </s-grid>

            <BarSizingFields draft={draft} update={update} />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "bogoGift");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="bogo-gift-snippet-modal"
        heading="Buy X get Y free — snippet code"
        loaderFile="bogo-gift-picker.js"
        placements={[
          {
            tag: "winslet-bogo-gift-bar",
            title: "Progress bar",
            description: "Shows progress toward the free gift — paste wherever you want the bar to show.",
          },
          {
            tag: "winslet-bogo-gift-products",
            title: "Free gift products",
            description: "Shows the free-gift product cards with Add buttons — paste wherever shoppers should pick their gift.",
          },
        ]}
      />
    </s-section>
  );
}

function AnnouncementBarSection({ initial }: { initial: AnnouncementBarSettings }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<AnnouncementBarSettings>(initial);
  const update = <K extends keyof AnnouncementBarSettings>(key: K, value: AnnouncementBarSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "announcementBar";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <s-section heading="Announcement bar">
      <s-stack direction="block" gap="base">
        <s-paragraph>A static banner you write yourself — a promo line, a policy note, a link — shown wherever you paste it.</s-paragraph>

        <AddToStoreCallout modalId="announcement-bar-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-checkbox
              label="Show the bar"
              checked={draft.enabled}
              onChange={(event: { target: EventTarget | null }) => {
                const target = event.target as { checked?: boolean } | null;
                update("enabled", Boolean(target?.checked));
              }}
            />

            <s-text-field label="Message" value={draft.message} onInput={(event: ControlEvent) => update("message", readValue(event))} />

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-text-field
                label="CTA label"
                details="Leave both CTA fields empty for no link."
                value={draft.ctaLabel}
                onInput={(event: ControlEvent) => update("ctaLabel", readValue(event))}
              />
              <s-text-field
                label="CTA link"
                details="Must start with http://, https://, or /."
                value={draft.ctaUrl}
                onInput={(event: ControlEvent) => update("ctaUrl", readValue(event))}
              />
            </s-grid>

            <s-checkbox
              label="Let shoppers dismiss it"
              checked={draft.dismissible}
              onChange={(event: { target: EventTarget | null }) => {
                const target = event.target as { checked?: boolean } | null;
                update("dismissible", Boolean(target?.checked));
              }}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.backgroundColor}
                onInput={(event: ControlEvent) => update("backgroundColor", readValue(event))}
              />
              <s-color-field label="Text color" value={draft.textColor} onInput={(event: ControlEvent) => update("textColor", readValue(event))} />
            </s-grid>

            <PixelPair
              label="Message font size"
              mobileLabel="Mobile message font size"
              value={draft.messageFontSize}
              mobileValue={draft.mobileMessageFontSize}
              max={48}
              onChange={(v) => update("messageFontSize", v)}
              onMobileChange={(v) => update("mobileMessageFontSize", v)}
            />

            <PixelPair
              label="Top padding"
              mobileLabel="Mobile top padding"
              value={draft.paddingTop}
              mobileValue={draft.mobilePaddingTop}
              max={200}
              onChange={(v) => update("paddingTop", v)}
              onMobileChange={(v) => update("mobilePaddingTop", v)}
            />

            <PixelPair
              label="Bottom padding"
              mobileLabel="Mobile bottom padding"
              value={draft.paddingBottom}
              mobileValue={draft.mobilePaddingBottom}
              max={200}
              onChange={(v) => update("paddingBottom", v)}
              onMobileChange={(v) => update("mobilePaddingBottom", v)}
            />

            <PixelPair
              label="Left padding"
              mobileLabel="Mobile left padding"
              value={draft.paddingLeft}
              mobileValue={draft.mobilePaddingLeft}
              max={200}
              onChange={(v) => update("paddingLeft", v)}
              onMobileChange={(v) => update("mobilePaddingLeft", v)}
            />

            <PixelPair
              label="Right padding"
              mobileLabel="Mobile right padding"
              value={draft.paddingRight}
              mobileValue={draft.mobilePaddingRight}
              max={200}
              onChange={(v) => update("paddingRight", v)}
              onMobileChange={(v) => update("mobilePaddingRight", v)}
            />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "announcementBar");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="announcement-bar-snippet-modal"
        heading="Announcement bar — snippet code"
        loaderFile="announcement-bar.js"
        placements={[
          {
            tag: "winslet-announcement-bar",
            title: "Paste wherever you want it to show",
            description: "Top of the page, above the footer, anywhere — paste it as many times as you like.",
            includeCurrency: false,
          },
        ]}
      />
    </s-section>
  );
}

function TierListSection({ initial }: { initial: TierListSettings }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<TierListSettings>(initial);
  const update = <K extends keyof TierListSettings>(key: K, value: TierListSettings[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "tierList";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <s-section heading="Tier list popup">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          A click-to-open popup listing every tier of your active volume/quantity discount, with the shopper&apos;s
          current tier highlighted.
        </s-paragraph>

        <AddToStoreCallout modalId="tier-list-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-text-field label="Trigger label" value={draft.triggerLabel} onInput={(event: ControlEvent) => update("triggerLabel", readValue(event))} />

            <s-text-field label="Popup heading" value={draft.heading} onInput={(event: ControlEvent) => update("heading", readValue(event))} />

            <s-text-field
              label="Row template"
              details="Repeated once per tier. Tokens: {{quantity}} (that tier's threshold), {{discount}} (its %/amount)."
              value={draft.rowTemplate}
              onInput={(event: ControlEvent) => update("rowTemplate", readValue(event))}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.backgroundColor}
                onInput={(event: ControlEvent) => update("backgroundColor", readValue(event))}
              />
              <s-color-field label="Text color" value={draft.textColor} onInput={(event: ControlEvent) => update("textColor", readValue(event))} />
              <s-color-field
                label="Current-tier accent color"
                value={draft.accentColor}
                onInput={(event: ControlEvent) => update("accentColor", readValue(event))}
              />
            </s-grid>

            <PixelPair
              label="Font size"
              mobileLabel="Mobile font size"
              value={draft.fontSize}
              mobileValue={draft.mobileFontSize}
              max={48}
              onChange={(v) => update("fontSize", v)}
              onMobileChange={(v) => update("mobileFontSize", v)}
            />

            <PixelPair
              label="Top padding"
              mobileLabel="Mobile top padding"
              value={draft.paddingTop}
              mobileValue={draft.mobilePaddingTop}
              max={200}
              onChange={(v) => update("paddingTop", v)}
              onMobileChange={(v) => update("mobilePaddingTop", v)}
            />

            <PixelPair
              label="Bottom padding"
              mobileLabel="Mobile bottom padding"
              value={draft.paddingBottom}
              mobileValue={draft.mobilePaddingBottom}
              max={200}
              onChange={(v) => update("paddingBottom", v)}
              onMobileChange={(v) => update("mobilePaddingBottom", v)}
            />

            <PixelPair
              label="Left padding"
              mobileLabel="Mobile left padding"
              value={draft.paddingLeft}
              mobileValue={draft.mobilePaddingLeft}
              max={200}
              onChange={(v) => update("paddingLeft", v)}
              onMobileChange={(v) => update("mobilePaddingLeft", v)}
            />

            <PixelPair
              label="Right padding"
              mobileLabel="Mobile right padding"
              value={draft.paddingRight}
              mobileValue={draft.mobilePaddingRight}
              max={200}
              onChange={(v) => update("paddingRight", v)}
              onMobileChange={(v) => update("mobilePaddingRight", v)}
            />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "tierList");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="tier-list-snippet-modal"
        heading="Tier list popup — snippet code"
        loaderFile="tier-list.js"
        placements={[
          {
            tag: "winslet-tier-list",
            title: "Paste wherever you want the trigger to show",
            description: "Product page, cart page, anywhere — paste it as many times as you like.",
          },
        ]}
      />
    </s-section>
  );
}

const HOUR12_OPTIONS = Array.from({ length: 12 }, (_, index) => String(index + 1));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
const HOUR24_OPTIONS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function splitTime24(value: string): { hour12: string; minute: string; period: "AM" | "PM" } {
  const [hourRaw, minuteRaw] = (value || "00:00").split(":");
  const hour24 = Number(hourRaw) || 0;
  const period: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour12: String(hour12), minute: (minuteRaw ?? "00").padStart(2, "0"), period };
}

function joinTime24(hour12: string, minute: string, period: "AM" | "PM"): string {
  const hour24 = (Number(hour12) % 12) + (period === "PM" ? 12 : 0);
  return `${String(hour24).padStart(2, "0")}:${minute}`;
}

/** A 12-hour hour/minute/AM-PM picker for the "fixed" end time — shown/stored in the shop's own timezone, matching campaign scheduling elsewhere in this app. */
function ShopTimeFields({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const { hour12, minute, period } = splitTime24(value);

  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-grid gridTemplateColumns="repeat(3, minmax(64px, 1fr))" gap="small-200">
        <s-select label="Hour" value={hour12} onChange={(event: ControlEvent) => onChange(joinTime24(readValue(event) || hour12, minute, period))}>
          {HOUR12_OPTIONS.map((hour) => (
            <s-option key={hour} value={hour}>
              {hour}
            </s-option>
          ))}
        </s-select>
        <s-select label="Minute" value={minute} onChange={(event: ControlEvent) => onChange(joinTime24(hour12, readValue(event) || minute, period))}>
          {MINUTE_OPTIONS.map((min) => (
            <s-option key={min} value={min}>
              {min}
            </s-option>
          ))}
        </s-select>
        <s-select
          label="AM/PM"
          value={period}
          onChange={(event: ControlEvent) => onChange(joinTime24(hour12, minute, (readValue(event) as "AM" | "PM") || period))}
        >
          <s-option value="AM">AM</s-option>
          <s-option value="PM">PM</s-option>
        </s-select>
      </s-grid>
    </s-stack>
  );
}

/** A 24-hour hour/minute picker for the daily/weekly reset time — read against each shopper's own local device clock, not the store's timezone. */
function LocalTimeField({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const [hour, minute] = (value || "00:00").split(":");

  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-grid gridTemplateColumns="repeat(2, minmax(64px, 1fr))" gap="small-200">
        <s-select label="Hour" value={hour} onChange={(event: ControlEvent) => onChange(`${readValue(event) || hour}:${minute}`)}>
          {HOUR24_OPTIONS.map((h) => (
            <s-option key={h} value={h}>
              {h}
            </s-option>
          ))}
        </s-select>
        <s-select label="Minute" value={minute} onChange={(event: ControlEvent) => onChange(`${hour}:${readValue(event) || minute}`)}>
          {MINUTE_OPTIONS.map((m) => (
            <s-option key={m} value={m}>
              {m}
            </s-option>
          ))}
        </s-select>
      </s-grid>
    </s-stack>
  );
}

function CountdownTimerSection({ initial, shopTimezone }: { initial: CountdownTimerSettings; shopTimezone: string }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<CountdownTimerSettings>(initial);
  const update = <K extends keyof CountdownTimerSettings>(key: K, value: CountdownTimerSettings[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const pending = navigation.state !== "idle" && navigation.formData?.get("widgetKey") === "countdownTimer";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!actionData || pending) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  const endAtParts = utcIsoToZonedParts(draft.endAt, shopTimezone);
  const setEndAtDate = (date: string) => update("endAt", zonedTimeToUtcIso(date, endAtParts.time || "00:00", shopTimezone));
  const setEndAtTime = (time: string) => update("endAt", zonedTimeToUtcIso(endAtParts.date, time, shopTimezone));

  return (
    <s-section heading="Countdown timer">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          A live Days : Hours : Min : Sec countdown — one-time, or automatically repeating daily/weekly.
        </s-paragraph>

        <AddToStoreCallout modalId="countdown-timer-snippet-modal" />

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Content</s-text>

            <s-checkbox
              label="Show the timer"
              checked={draft.enabled}
              onChange={(event: { target: EventTarget | null }) => {
                const target = event.target as { checked?: boolean } | null;
                update("enabled", Boolean(target?.checked));
              }}
            />

            <s-select
              label="Restart"
              value={draft.restartMode}
              onChange={(event: ControlEvent) => {
                const next = readValue(event);
                update("restartMode", (next === "fixed" || next === "weekly" ? next : "daily") as CountdownTimerSettings["restartMode"]);
              }}
            >
              <s-option value="fixed">Fixed — one end date/time</s-option>
              <s-option value="daily">Restart daily</s-option>
              <s-option value="weekly">Restart weekly</s-option>
            </s-select>

            {draft.restartMode === "fixed" && (
              <>
                <s-grid gridTemplateColumns="repeat(2, minmax(140px, 1fr))" gap="base" alignItems="end">
                  <s-date-field label="End date" value={endAtParts.date} onInput={(event: ControlEvent) => setEndAtDate(readValue(event))} />
                  <ShopTimeFields label="End time" value={endAtParts.time} onChange={setEndAtTime} />
                </s-grid>

                <s-checkbox
                  label="Restart automatically after it ends"
                  checked={draft.restartAfterEnd}
                  onChange={(event: { target: EventTarget | null }) => {
                    const target = event.target as { checked?: boolean } | null;
                    update("restartAfterEnd", Boolean(target?.checked));
                  }}
                />

                {draft.restartAfterEnd && (
                  <s-number-field
                    label="Repeat every (hours)"
                    details="e.g. 24 for daily, 72 for every 3 days."
                    min={1}
                    max={8760}
                    value={String(draft.repeatHours)}
                    onInput={(event: ControlEvent) => update("repeatHours", Number(readValue(event)) || 24)}
                  />
                )}
              </>
            )}

            {draft.restartMode === "daily" && (
              <LocalTimeField
                label="Resets daily at"
                value={draft.dailyResetTime}
                onChange={(v) => update("dailyResetTime", v)}
              />
            )}
            {draft.restartMode === "daily" && (
              <s-text color="subdued">Based on each shopper&apos;s own device clock, not your store&apos;s timezone.</s-text>
            )}

            {draft.restartMode === "weekly" && (
              <>
                <s-select
                  label="Resets on"
                  value={String(draft.weeklyResetDay)}
                  onChange={(event: ControlEvent) => update("weeklyResetDay", Number(readValue(event)) || 0)}
                >
                  {WEEKDAY_OPTIONS.map((day) => (
                    <s-option key={day.value} value={String(day.value)}>
                      {day.label}
                    </s-option>
                  ))}
                </s-select>
                <LocalTimeField label="Resets at" value={draft.weeklyResetTime} onChange={(v) => update("weeklyResetTime", v)} />
                <s-text color="subdued">Based on each shopper&apos;s own device clock, not your store&apos;s timezone.</s-text>
              </>
            )}

            <s-text-field label="Message" value={draft.message} onInput={(event: ControlEvent) => update("message", readValue(event))} />

            <s-text-field
              label="Expired message"
              details="Shown once a fixed (non-restarting) countdown ends. Leave blank to hide the timer entirely instead."
              value={draft.expiredMessage}
              onInput={(event: ControlEvent) => update("expiredMessage", readValue(event))}
            />
          </s-stack>
        </s-box>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Style</s-text>

            <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
              <s-color-field
                label="Background color"
                value={draft.backgroundColor}
                onInput={(event: ControlEvent) => update("backgroundColor", readValue(event))}
              />
              <s-color-field label="Text color" value={draft.textColor} onInput={(event: ControlEvent) => update("textColor", readValue(event))} />
              <s-color-field
                label="Digit background color"
                value={draft.digitBackgroundColor}
                onInput={(event: ControlEvent) => update("digitBackgroundColor", readValue(event))}
              />
              <s-color-field
                label="Digit text color"
                value={draft.digitTextColor}
                onInput={(event: ControlEvent) => update("digitTextColor", readValue(event))}
              />
              <s-color-field
                label="Label color"
                value={draft.labelColor}
                onInput={(event: ControlEvent) => update("labelColor", readValue(event))}
              />
            </s-grid>

            <s-checkbox
              label="Show Days/Hrs/Min/Sec labels"
              checked={draft.showLabels}
              onChange={(event: { target: EventTarget | null }) => {
                const target = event.target as { checked?: boolean } | null;
                update("showLabels", Boolean(target?.checked));
              }}
            />

            <PixelPair
              label="Font size"
              mobileLabel="Mobile font size"
              value={draft.messageFontSize}
              mobileValue={draft.mobileMessageFontSize}
              max={48}
              onChange={(v) => update("messageFontSize", v)}
              onMobileChange={(v) => update("mobileMessageFontSize", v)}
            />

            <PixelPair
              label="Digit box roundness"
              mobileLabel="Mobile digit box roundness"
              value={draft.digitRadius}
              mobileValue={draft.mobileDigitRadius}
              max={999}
              onChange={(v) => update("digitRadius", v)}
              onMobileChange={(v) => update("mobileDigitRadius", v)}
            />

            <PixelPair
              label="Gap between digits"
              mobileLabel="Mobile gap between digits"
              value={draft.digitGap}
              mobileValue={draft.mobileDigitGap}
              max={64}
              onChange={(v) => update("digitGap", v)}
              onMobileChange={(v) => update("mobileDigitGap", v)}
            />

            <PixelPair
              label="Top padding"
              mobileLabel="Mobile top padding"
              value={draft.paddingTop}
              mobileValue={draft.mobilePaddingTop}
              max={200}
              onChange={(v) => update("paddingTop", v)}
              onMobileChange={(v) => update("mobilePaddingTop", v)}
            />

            <PixelPair
              label="Bottom padding"
              mobileLabel="Mobile bottom padding"
              value={draft.paddingBottom}
              mobileValue={draft.mobilePaddingBottom}
              max={200}
              onChange={(v) => update("paddingBottom", v)}
              onMobileChange={(v) => update("mobilePaddingBottom", v)}
            />

            <PixelPair
              label="Left padding"
              mobileLabel="Mobile left padding"
              value={draft.paddingLeft}
              mobileValue={draft.mobilePaddingLeft}
              max={200}
              onChange={(v) => update("paddingLeft", v)}
              onMobileChange={(v) => update("mobilePaddingLeft", v)}
            />

            <PixelPair
              label="Right padding"
              mobileLabel="Mobile right padding"
              value={draft.paddingRight}
              mobileValue={draft.mobilePaddingRight}
              max={200}
              onChange={(v) => update("paddingRight", v)}
              onMobileChange={(v) => update("mobilePaddingRight", v)}
            />
          </s-stack>
        </s-box>

        <s-stack direction="inline" justifyContent="end">
          <s-button
            variant="primary"
            loading={pending}
            disabled={pending || !isDirty}
            onClick={() => {
              const data = new FormData();
              data.set("widgetKey", "countdownTimer");
              for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
              submit(data, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>

      <SnippetModal
        id="countdown-timer-snippet-modal"
        heading="Countdown timer — snippet code"
        loaderFile="countdown-timer.js"
        placements={[
          {
            tag: "winslet-countdown-timer",
            title: "Paste wherever you want it to show",
            description: "Cart drawer, cart page, product page, anywhere — paste it as many times as you like.",
            includeCurrency: false,
          },
        ]}
      />
    </s-section>
  );
}

function AbTestingSection({ shop }: { shop: string }) {
  return (
    <s-section heading="A/B testing">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Splitting shoppers between two campaign variants needs one small, invisible piece running on your
          storefront — it doesn&apos;t show anything itself, it just decides which variant each shopper sees and
          remembers it for their cart. Unlike the other widgets, this one&apos;s a Theme Editor toggle, not a
          copy-paste snippet — it has no visual output, so there&apos;s no positioning to get wrong.
        </s-paragraph>

        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="block" gap="small-400">
              <s-text type="strong">Turn it on</s-text>
              <s-text color="subdued">Theme Editor → App embeds → enable &quot;Winslet — A/B testing&quot;.</s-text>
            </s-stack>
            <s-button variant="primary" href={`https://${shop}/admin/themes/current/editor?context=apps`} target="_blank">
              Open Theme Editor
            </s-button>
          </s-stack>
        </s-box>

        <s-banner tone="info">
          Start and manage a test from a campaign&apos;s own <s-text type="strong">A/B Test</s-text> tab.{" "}
          <s-link href="/app/campaigns">Go to Campaigns</s-link>
        </s-banner>
      </s-stack>
    </s-section>
  );
}

type WidgetKey =
  | "freeShippingBar"
  | "bogoGift"
  | "announcementBar"
  | "orderDiscountBar"
  | "tierProgressBar"
  | "tierList"
  | "countdownTimer"
  | "abTesting";

function WidgetCard({
  icon,
  iconBackground,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: "cart-discount" | "gift-card" | "megaphone" | "discount" | "chart-stacked" | "price-list" | "clock" | "split";
  iconBackground: string;
  title: string;
  description: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="start">
          <div
            style={{
              width: "40px",
              height: "40px",
              minWidth: "40px",
              borderRadius: "8px",
              padding: "8px",
              background: iconBackground,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
            }}
          >
            <s-icon type={icon} tone="neutral" />
          </div>

          <s-stack direction="block" gap="small-400">
            <s-text type="strong">{title}</s-text>
            <s-text color="subdued">{description}</s-text>
          </s-stack>
        </s-stack>

        <s-button variant={disabled ? "secondary" : "primary"} disabled={disabled} onClick={onClick} inlineSize="fill">
          {disabled ? "Coming soon" : "Add"}
        </s-button>
      </s-stack>
    </s-box>
  );
}

export default function StorefrontWidgets() {
  const { freeShippingBar, bogoGift, announcementBar, orderDiscountBar, tierProgressBar, tierList, countdownTimer, shopTimezone, shop } =
    useLoaderData<typeof loader>();
  const [selected, setSelected] = useState<WidgetKey | null>(null);

  if (selected === "freeShippingBar") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <FreeShippingBarSection initial={freeShippingBar} />
      </s-page>
    );
  }

  if (selected === "bogoGift") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <BogoGiftSection initial={bogoGift} />
      </s-page>
    );
  }

  if (selected === "announcementBar") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <AnnouncementBarSection initial={announcementBar} />
      </s-page>
    );
  }

  if (selected === "orderDiscountBar") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <OrderDiscountBarSection initial={orderDiscountBar} />
      </s-page>
    );
  }

  if (selected === "tierProgressBar") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <TierProgressBarSection initial={tierProgressBar} />
      </s-page>
    );
  }

  if (selected === "tierList") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <TierListSection initial={tierList} />
      </s-page>
    );
  }

  if (selected === "countdownTimer") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <CountdownTimerSection initial={countdownTimer} shopTimezone={shopTimezone} />
      </s-page>
    );
  }

  if (selected === "abTesting") {
    return (
      <s-page heading="Widgets" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Widgets
        </s-button>
        <AbTestingSection shop={shop} />
      </s-page>
    );
  }

  return (
    <s-page heading="Widgets" inlineSize="small">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>Pick a widget to style it and grab its copy-paste snippet.</s-paragraph>

          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
            <WidgetCard
              icon="cart-discount"
              iconBackground="#d9f2e6"
              title="Free shipping bar"
              description="Live progress toward your free-shipping threshold."
              onClick={() => setSelected("freeShippingBar")}
            />
            <WidgetCard
              icon="gift-card"
              iconBackground="#dbe9fb"
              title="Buy X get Y free"
              description="Gift picker with an Add button, enabled once qualified."
              onClick={() => setSelected("bogoGift")}
            />
            <WidgetCard
              icon="megaphone"
              iconBackground="#f1f2f3"
              title="Announcement bar"
              description="A static banner with your own message and link."
              onClick={() => setSelected("announcementBar")}
            />
            <WidgetCard
              icon="discount"
              iconBackground="#fbe6d9"
              title="Order discount bar"
              description="Live progress toward your order-wide percent/amount discount."
              onClick={() => setSelected("orderDiscountBar")}
            />
            <WidgetCard
              icon="chart-stacked"
              iconBackground="#e8ddf7"
              title="Tier progress bar"
              description="One bar with a tick mark for every volume-discount breakpoint."
              onClick={() => setSelected("tierProgressBar")}
            />
            <WidgetCard
              icon="price-list"
              iconBackground="#fde8ee"
              title="Tier list popup"
              description="A click-to-open list of every volume-discount tier."
              onClick={() => setSelected("tierList")}
            />
            <WidgetCard
              icon="clock"
              iconBackground="#fdf0d5"
              title="Countdown timer"
              description="A live Days:Hours:Min:Sec countdown — fixed, daily, or weekly."
              onClick={() => setSelected("countdownTimer")}
            />
            <WidgetCard
              icon="split"
              iconBackground="#e1ecf7"
              title="A/B testing"
              description="One invisible script that splits shoppers between two campaign variants."
              onClick={() => setSelected("abTesting")}
            />
          </s-grid>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
