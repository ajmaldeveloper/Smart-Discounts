import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings, type BarSizingSettings, type BogoGiftSettings, type FreeShippingBarSettings } from "../lib/widget-settings";

type ActionData = { error?: string; notice?: string };
type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

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
function buildPlacementSnippet(tag: string, extraAttrs = ""): string {
  return `<${tag} data-proxy-root="/apps/winslet" data-currency="{{ cart.currency.iso_code }}"${extraAttrs}></${tag}>`;
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  const settings = normalizeWidgetSettings(shop?.widgetSettingsJson);

  return { freeShippingBar: settings.freeShippingBar, bogoGift: settings.bogoGift };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const widgetKey = formData.get("widgetKey") === "bogoGift" ? "bogoGift" : "freeShippingBar";

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  const current = normalizeWidgetSettings(shop?.widgetSettingsJson);

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
  } else {
    const trackColor = String(formData.get("trackColor") ?? "").trim();
    const progressColor = String(formData.get("progressColor") ?? "").trim();
    const unlockedColor = String(formData.get("unlockedColor") ?? "").trim();
    const addButtonColor = String(formData.get("addButtonColor") ?? "").trim();
    const addButtonTextColor = String(formData.get("addButtonTextColor") ?? "").trim();
    const lockedMessage = String(formData.get("lockedMessage") ?? "").trim();
    const unlockedMessage = String(formData.get("unlockedMessage") ?? "").trim();

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

    const bogoGift: BogoGiftSettings = {
      ...sizing,
      trackColor,
      progressColor,
      unlockedColor,
      addButtonColor,
      addButtonTextColor,
      lockedMessage,
      unlockedMessage,
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
  placements: Array<{ tag: string; title: string; description: string }>;
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
          const placementSnippet = buildPlacementSnippet(placement.tag);
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
              details="Shown below the threshold. Tokens: {remaining} (bare number), {currency_symbol} (e.g. $), {currency_code} (e.g. USD)."
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
              details="Shown before the shopper qualifies. Token: {remaining} (units still needed)."
              value={draft.lockedMessage}
              onInput={(event: ControlEvent) => update("lockedMessage", readValue(event))}
            />

            <s-text-field
              label="Unlocked message"
              details="Shown once they qualify for at least one free unit."
              value={draft.unlockedMessage}
              onInput={(event: ControlEvent) => update("unlockedMessage", readValue(event))}
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

type WidgetKey = "freeShippingBar" | "bogoGift";

function WidgetCard({
  icon,
  iconBackground,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: "cart-discount" | "gift-card" | "megaphone";
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
  const { freeShippingBar, bogoGift } = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState<WidgetKey | null>(null);

  if (selected === "freeShippingBar") {
    return (
      <s-page heading="Storefront" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Storefront
        </s-button>
        <FreeShippingBarSection initial={freeShippingBar} />
      </s-page>
    );
  }

  if (selected === "bogoGift") {
    return (
      <s-page heading="Storefront" inlineSize="small">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => setSelected(null)}>
          Storefront
        </s-button>
        <BogoGiftSection initial={bogoGift} />
      </s-page>
    );
  }

  return (
    <s-page heading="Storefront" inlineSize="small">
      <s-section heading="Widgets">
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
              description="Coming soon."
              disabled
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
