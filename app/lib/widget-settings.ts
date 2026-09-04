/**
 * Merchant-configured styling/copy for storefront widgets: the
 * free-shipping progress bar and the "Buy X get Y free" gift-picker.
 * Stored as Shop.widgetSettingsJson (one JSON blob, matching this
 * schema's own preference for a single Json? column over several
 * scalar ones — see discountFunctionIds/audienceJson elsewhere in
 * schema.prisma). Read by both app.storefront-widgets.tsx (the admin
 * settings page) and the apps.proxy.*.tsx App Proxy endpoints the
 * storefront scripts call — always through normalizeWidgetSettings, so
 * malformed/partial stored JSON never breaks either caller.
 *
 * The mobile-vs-desktop field pairing (mobileBarThickness vs.
 * barThickness, etc.) mirrors this developer's own product-options app
 * (see OptionSetDesignConfig) — a flat value per breakpoint rather than
 * a nested { desktop, mobile } shape, switched via a max-width:640px
 * media query on the storefront (matching that app's own breakpoint).
 */

/**
 * The sizing/layout fields shared by every progress-bar-shaped widget
 * — factored out so free-shipping and the BOGO gift-picker don't
 * duplicate the same 20 fields and their normalization.
 */
export interface BarSizingSettings {
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
  // Padding around the whole widget, in px per side — since it's
  // placed inline wherever the merchant pastes it, this is its only
  // control over breathing room from surrounding theme content.
  // Applied via applyConfig on every render (not a one-time inline
  // style), so it survives a theme's cart-drawer morph the same way
  // every other style field does — previously hardcoded and set only
  // once in buildMarkup, which a self-heal rebuild skipped, silently
  // losing it after a cart update.
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

export interface FreeShippingBarSettings extends BarSizingSettings {
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
}

/**
 * The "Buy X get Y free" gift-picker widget — a progress bar (same
 * concept as FreeShippingBarSettings, just two stages instead of
 * three: locked/unlocked, no "nearly there" midpoint) plus a product
 * list with an Add-to-cart button per eligible free gift.
 */
export interface BogoGiftSettings extends BarSizingSettings {
  trackColor: string;
  progressColor: string;
  unlockedColor: string;
  // Shown while the shopper hasn't met the campaign's buy quantity yet.
  // Same token set as FreeShippingBarSettings.progressMessage.
  lockedMessage: string;
  // Shown once they've qualified for at least one free unit.
  unlockedMessage: string;
  addButtonColor: string;
  addButtonTextColor: string;
}

export interface WidgetSettings {
  freeShippingBar: FreeShippingBarSettings;
  bogoGift: BogoGiftSettings;
}

const DEFAULT_BAR_SIZING: BarSizingSettings = {
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

const DEFAULT_FREE_SHIPPING_BAR: FreeShippingBarSettings = {
  ...DEFAULT_BAR_SIZING,
  trackColor: "#f1f2f3",
  startColor: "#8c9196",
  nearColor: "#ffc453",
  reachedColor: "#008060",
  nearThresholdPercent: 75,
  progressMessage: "Spend {currency_symbol}{remaining} more for free shipping!",
  completeMessage: "You've unlocked free shipping!",
};

const DEFAULT_BOGO_GIFT: BogoGiftSettings = {
  ...DEFAULT_BAR_SIZING,
  trackColor: "#f1f2f3",
  progressColor: "#8c9196",
  unlockedColor: "#008060",
  lockedMessage: "Add {remaining} more to unlock a free gift!",
  unlockedMessage: "Your free gift is ready — add it below!",
  addButtonColor: "#008060",
  addButtonTextColor: "#ffffff",
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

function normalizeBarSizing(record: Record<string, unknown>, defaults: BarSizingSettings): BarSizingSettings {
  return {
    barThickness: normalizePixels(record.barThickness, defaults.barThickness, 48),
    mobileBarThickness: normalizePixels(record.mobileBarThickness, defaults.mobileBarThickness, 48),
    barRoundness: normalizePixels(record.barRoundness, defaults.barRoundness, 999),
    mobileBarRoundness: normalizePixels(record.mobileBarRoundness, defaults.mobileBarRoundness, 999),
    messageFontSize: normalizePixels(record.messageFontSize, defaults.messageFontSize, 48),
    mobileMessageFontSize: normalizePixels(record.mobileMessageFontSize, defaults.mobileMessageFontSize, 48),
    barMessageGap: normalizePixels(record.barMessageGap, defaults.barMessageGap, 64),
    mobileBarMessageGap: normalizePixels(record.mobileBarMessageGap, defaults.mobileBarMessageGap, 64),
    paddingTop: normalizePixels(record.paddingTop, defaults.paddingTop, 200),
    paddingBottom: normalizePixels(record.paddingBottom, defaults.paddingBottom, 200),
    paddingLeft: normalizePixels(record.paddingLeft, defaults.paddingLeft, 200),
    paddingRight: normalizePixels(record.paddingRight, defaults.paddingRight, 200),
    mobilePaddingTop: normalizePixels(record.mobilePaddingTop, defaults.mobilePaddingTop, 200),
    mobilePaddingBottom: normalizePixels(record.mobilePaddingBottom, defaults.mobilePaddingBottom, 200),
    mobilePaddingLeft: normalizePixels(record.mobilePaddingLeft, defaults.mobilePaddingLeft, 200),
    mobilePaddingRight: normalizePixels(record.mobilePaddingRight, defaults.mobilePaddingRight, 200),
    barPosition: record.barPosition === "bottom" ? "bottom" : "top",
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Validates and repairs an arbitrary parsed-JSON value into a well-formed WidgetSettings, falling back field-by-field rather than rejecting the whole object. */
export function normalizeWidgetSettings(raw: unknown): WidgetSettings {
  const record = recordOf(raw);
  const barRecord = recordOf(record.freeShippingBar);
  const giftRecord = recordOf(record.bogoGift);

  const nearThresholdPercent =
    typeof barRecord.nearThresholdPercent === "number" && Number.isFinite(barRecord.nearThresholdPercent)
      ? Math.min(100, Math.max(0, barRecord.nearThresholdPercent))
      : DEFAULT_FREE_SHIPPING_BAR.nearThresholdPercent;

  return {
    freeShippingBar: {
      ...normalizeBarSizing(barRecord, DEFAULT_FREE_SHIPPING_BAR),
      trackColor: normalizeHexColor(barRecord.trackColor, DEFAULT_FREE_SHIPPING_BAR.trackColor),
      startColor: normalizeHexColor(barRecord.startColor, DEFAULT_FREE_SHIPPING_BAR.startColor),
      nearColor: normalizeHexColor(barRecord.nearColor, DEFAULT_FREE_SHIPPING_BAR.nearColor),
      reachedColor: normalizeHexColor(barRecord.reachedColor, DEFAULT_FREE_SHIPPING_BAR.reachedColor),
      nearThresholdPercent,
      progressMessage: normalizeMessage(barRecord.progressMessage, DEFAULT_FREE_SHIPPING_BAR.progressMessage),
      completeMessage: normalizeMessage(barRecord.completeMessage, DEFAULT_FREE_SHIPPING_BAR.completeMessage),
    },
    bogoGift: {
      ...normalizeBarSizing(giftRecord, DEFAULT_BOGO_GIFT),
      trackColor: normalizeHexColor(giftRecord.trackColor, DEFAULT_BOGO_GIFT.trackColor),
      progressColor: normalizeHexColor(giftRecord.progressColor, DEFAULT_BOGO_GIFT.progressColor),
      unlockedColor: normalizeHexColor(giftRecord.unlockedColor, DEFAULT_BOGO_GIFT.unlockedColor),
      lockedMessage: normalizeMessage(giftRecord.lockedMessage, DEFAULT_BOGO_GIFT.lockedMessage),
      unlockedMessage: normalizeMessage(giftRecord.unlockedMessage, DEFAULT_BOGO_GIFT.unlockedMessage),
      addButtonColor: normalizeHexColor(giftRecord.addButtonColor, DEFAULT_BOGO_GIFT.addButtonColor),
      addButtonTextColor: normalizeHexColor(giftRecord.addButtonTextColor, DEFAULT_BOGO_GIFT.addButtonTextColor),
    },
  };
}
