/**
 * Merchant-configured styling/copy for storefront widgets — currently
 * just the free-shipping progress bar. Stored as Shop.widgetSettingsJson
 * (one JSON blob, matching this schema's own preference for a single
 * Json? column over several scalar ones — see discountFunctionIds/
 * audienceJson elsewhere in schema.prisma). Read by both
 * app.storefront-widgets.tsx (the admin settings page) and
 * apps.proxy.free-shipping.tsx (the App Proxy endpoint the storefront's
 * app-embed script calls) — always through normalizeWidgetSettings, so
 * malformed/partial stored JSON never breaks either caller.
 */

export interface FreeShippingBarSettings {
  // Hex color strings (e.g. "#008060") — never anything else, so the
  // storefront script can set them directly as a CSS custom property
  // without its own validation.
  startColor: string;
  nearColor: string;
  reachedColor: string;
  // Percent of the threshold (cart subtotal or quantity, whichever the
  // qualifying campaign's shipping reward uses) at which the bar
  // switches from startColor to nearColor. 100% (threshold met)
  // always uses reachedColor regardless of this value.
  nearThresholdPercent: number;
  // Shown while below the threshold — "{remaining}" is replaced with
  // the formatted amount/quantity still needed, computed client-side
  // (the storefront script knows the shopper's live cart, this stored
  // string never does).
  progressMessage: string;
  // Shown once the threshold is met.
  completeMessage: string;
}

export interface WidgetSettings {
  freeShippingBar: FreeShippingBarSettings;
}

const DEFAULT_FREE_SHIPPING_BAR: FreeShippingBarSettings = {
  startColor: "#e1e3e5",
  nearColor: "#ffc453",
  reachedColor: "#008060",
  nearThresholdPercent: 75,
  progressMessage: "Spend {remaining} more for free shipping!",
  completeMessage: "You've unlocked free shipping!",
};

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function normalizeHexColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_COLOR.test(raw.trim()) ? raw.trim() : fallback;
}

function normalizeMessage(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

/** Validates and repairs an arbitrary parsed-JSON value into a well-formed WidgetSettings, falling back field-by-field rather than rejecting the whole object. */
export function normalizeWidgetSettings(raw: unknown): WidgetSettings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const barRecord =
    typeof record.freeShippingBar === "object" && record.freeShippingBar !== null
      ? (record.freeShippingBar as Record<string, unknown>)
      : {};

  const nearThresholdPercent =
    typeof barRecord.nearThresholdPercent === "number" && Number.isFinite(barRecord.nearThresholdPercent)
      ? Math.min(100, Math.max(0, barRecord.nearThresholdPercent))
      : DEFAULT_FREE_SHIPPING_BAR.nearThresholdPercent;

  return {
    freeShippingBar: {
      startColor: normalizeHexColor(barRecord.startColor, DEFAULT_FREE_SHIPPING_BAR.startColor),
      nearColor: normalizeHexColor(barRecord.nearColor, DEFAULT_FREE_SHIPPING_BAR.nearColor),
      reachedColor: normalizeHexColor(barRecord.reachedColor, DEFAULT_FREE_SHIPPING_BAR.reachedColor),
      nearThresholdPercent,
      progressMessage: normalizeMessage(barRecord.progressMessage, DEFAULT_FREE_SHIPPING_BAR.progressMessage),
      completeMessage: normalizeMessage(barRecord.completeMessage, DEFAULT_FREE_SHIPPING_BAR.completeMessage),
    },
  };
}
