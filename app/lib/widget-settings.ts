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
 *
 * The mobile-vs-desktop field pairing (mobileBarThickness vs.
 * barThickness, etc.) mirrors this developer's own product-options app
 * (see OptionSetDesignConfig) — a flat value per breakpoint rather than
 * a nested { desktop, mobile } shape, switched via a max-width:640px
 * media query on the storefront (matching that app's own breakpoint).
 */

export interface FreeShippingBarSettings {
  // Hex color strings (e.g. "#008060") — never anything else, so the
  // storefront script can set them directly as a CSS custom property
  // without its own validation.
  // The bar's own empty track — kept independently configurable since
  // a startColor too close to the default track color made the bar
  // look broken/invisible at low progress (merchant-reported).
  trackColor: string;
  startColor: string;
  nearColor: string;
  reachedColor: string;
  // Percent of the threshold (cart subtotal or quantity, whichever the
  // qualifying campaign's shipping reward uses) at which the bar
  // switches from startColor to nearColor. 100% (threshold met)
  // always uses reachedColor regardless of this value.
  nearThresholdPercent: number;
  // Shown while below the threshold. Three tokens, all substituted
  // client-side (the storefront script knows the shopper's live cart
  // and locale, this stored string never does): "{remaining}" — a bare
  // number, never pre-formatted with a currency symbol, so the
  // merchant fully controls placement/spacing/whether one shows at
  // all for a quantity-based threshold; "{currency_symbol}" and
  // "{currency_code}" — e.g. "$" and "USD", composed in by the
  // merchant however they like ("{currency_symbol}{remaining}" vs.
  // "{remaining} {currency_code}").
  progressMessage: string;
  // Shown once the threshold is met.
  completeMessage: string;
  // Track height, in px.
  barThickness: number;
  mobileBarThickness: number;
  // Track/fill corner radius, in px — a value >= half the thickness
  // reads as a full pill (the original hardcoded look).
  barRoundness: number;
  mobileBarRoundness: number;
  // The message paragraph's font size, in px.
  messageFontSize: number;
  mobileMessageFontSize: number;
  // Vertical space between the bar and its message, in px.
  barMessageGap: number;
  mobileBarMessageGap: number;
  // Padding around the whole widget (outside the track+message block),
  // in px per side — since it's placed inline wherever the merchant
  // pastes it, this is its only control over breathing room from
  // surrounding theme content. Applied via applyConfig on every
  // render (not a one-time inline style), so it survives a theme's
  // cart-drawer morph the same way every other style field does —
  // previously hardcoded and set only once in buildMarkup, which a
  // self-heal rebuild skipped, silently losing it after a cart update.
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  mobilePaddingTop: number;
  mobilePaddingBottom: number;
  mobilePaddingLeft: number;
  mobilePaddingRight: number;
  // Stacking order of the two rows — "top" (default) shows the bar
  // above the message, "bottom" swaps them (message above the bar).
  barPosition: "top" | "bottom";
}

export interface WidgetSettings {
  freeShippingBar: FreeShippingBarSettings;
}

const DEFAULT_FREE_SHIPPING_BAR: FreeShippingBarSettings = {
  trackColor: "#f1f2f3",
  startColor: "#8c9196",
  nearColor: "#ffc453",
  reachedColor: "#008060",
  nearThresholdPercent: 75,
  progressMessage: "Spend {currency_symbol}{remaining} more for free shipping!",
  completeMessage: "You've unlocked free shipping!",
  barThickness: 8,
  mobileBarThickness: 8,
  barRoundness: 999,
  mobileBarRoundness: 999,
  messageFontSize: 14,
  mobileMessageFontSize: 14,
  barMessageGap: 8,
  mobileBarMessageGap: 8,
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 16,
  paddingRight: 16,
  mobilePaddingTop: 8,
  mobilePaddingBottom: 8,
  mobilePaddingLeft: 16,
  mobilePaddingRight: 16,
  barPosition: "top",
};

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function normalizeHexColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_COLOR.test(raw.trim()) ? raw.trim() : fallback;
}

function normalizeMessage(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

function normalizePixels(raw: unknown, fallback: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(0, raw)) : fallback;
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
      trackColor: normalizeHexColor(barRecord.trackColor, DEFAULT_FREE_SHIPPING_BAR.trackColor),
      startColor: normalizeHexColor(barRecord.startColor, DEFAULT_FREE_SHIPPING_BAR.startColor),
      nearColor: normalizeHexColor(barRecord.nearColor, DEFAULT_FREE_SHIPPING_BAR.nearColor),
      reachedColor: normalizeHexColor(barRecord.reachedColor, DEFAULT_FREE_SHIPPING_BAR.reachedColor),
      nearThresholdPercent,
      progressMessage: normalizeMessage(barRecord.progressMessage, DEFAULT_FREE_SHIPPING_BAR.progressMessage),
      completeMessage: normalizeMessage(barRecord.completeMessage, DEFAULT_FREE_SHIPPING_BAR.completeMessage),
      barThickness: normalizePixels(barRecord.barThickness, DEFAULT_FREE_SHIPPING_BAR.barThickness, 48),
      mobileBarThickness: normalizePixels(barRecord.mobileBarThickness, DEFAULT_FREE_SHIPPING_BAR.mobileBarThickness, 48),
      barRoundness: normalizePixels(barRecord.barRoundness, DEFAULT_FREE_SHIPPING_BAR.barRoundness, 999),
      mobileBarRoundness: normalizePixels(barRecord.mobileBarRoundness, DEFAULT_FREE_SHIPPING_BAR.mobileBarRoundness, 999),
      messageFontSize: normalizePixels(barRecord.messageFontSize, DEFAULT_FREE_SHIPPING_BAR.messageFontSize, 48),
      mobileMessageFontSize: normalizePixels(barRecord.mobileMessageFontSize, DEFAULT_FREE_SHIPPING_BAR.mobileMessageFontSize, 48),
      barMessageGap: normalizePixels(barRecord.barMessageGap, DEFAULT_FREE_SHIPPING_BAR.barMessageGap, 64),
      mobileBarMessageGap: normalizePixels(barRecord.mobileBarMessageGap, DEFAULT_FREE_SHIPPING_BAR.mobileBarMessageGap, 64),
      paddingTop: normalizePixels(barRecord.paddingTop, DEFAULT_FREE_SHIPPING_BAR.paddingTop, 200),
      paddingBottom: normalizePixels(barRecord.paddingBottom, DEFAULT_FREE_SHIPPING_BAR.paddingBottom, 200),
      paddingLeft: normalizePixels(barRecord.paddingLeft, DEFAULT_FREE_SHIPPING_BAR.paddingLeft, 200),
      paddingRight: normalizePixels(barRecord.paddingRight, DEFAULT_FREE_SHIPPING_BAR.paddingRight, 200),
      mobilePaddingTop: normalizePixels(barRecord.mobilePaddingTop, DEFAULT_FREE_SHIPPING_BAR.mobilePaddingTop, 200),
      mobilePaddingBottom: normalizePixels(barRecord.mobilePaddingBottom, DEFAULT_FREE_SHIPPING_BAR.mobilePaddingBottom, 200),
      mobilePaddingLeft: normalizePixels(barRecord.mobilePaddingLeft, DEFAULT_FREE_SHIPPING_BAR.mobilePaddingLeft, 200),
      mobilePaddingRight: normalizePixels(barRecord.mobilePaddingRight, DEFAULT_FREE_SHIPPING_BAR.mobilePaddingRight, 200),
      barPosition: barRecord.barPosition === "bottom" ? "bottom" : "top",
    },
  };
}
