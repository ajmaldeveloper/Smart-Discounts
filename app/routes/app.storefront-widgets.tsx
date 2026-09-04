import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeWidgetSettings, type FreeShippingBarSettings } from "../lib/widget-settings";

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
const SNIPPET_SCRIPT_URL = "https://winslet-smart-discounts.fly.dev/widgets/free-shipping-bar.js";

// Split in two deliberately: a cart drawer's own AJAX refresh usually
// replaces its markup via innerHTML, and browsers never execute a
// <script> tag inserted that way — only a real full-page load does.
// The loader script only ever needs to run once (it just registers
// the custom element), so it goes in theme.liquid where a real page
// load always executes it; the placement tag is pure HTML with no
// <script> of its own, so it's safe to pasted anywhere, including
// somewhere that gets AJAX-refreshed repeatedly.
function buildLoaderSnippet(): string {
  return `<script src="${SNIPPET_SCRIPT_URL}" defer></script>`;
}
function buildPlacementSnippet(): string {
  return `<winslet-free-shipping-bar data-proxy-root="/apps/winslet" data-currency="{{ cart.currency.iso_code }}"></winslet-free-shipping-bar>`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  const { freeShippingBar } = normalizeWidgetSettings(shop?.widgetSettingsJson);

  return { freeShippingBar };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const trackColor = String(formData.get("trackColor") ?? "").trim();
  const startColor = String(formData.get("startColor") ?? "").trim();
  const nearColor = String(formData.get("nearColor") ?? "").trim();
  const reachedColor = String(formData.get("reachedColor") ?? "").trim();
  const nearThresholdPercentRaw = String(formData.get("nearThresholdPercent") ?? "").trim();
  const progressMessage = String(formData.get("progressMessage") ?? "").trim();
  const completeMessage = String(formData.get("completeMessage") ?? "").trim();
  const barPosition = formData.get("barPosition") === "bottom" ? "bottom" : "top";

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

  const pixelFields = [
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

  const pixelValues: Record<string, number> = {};
  for (const [key, label, max] of pixelFields) {
    const parsed = Number(String(formData.get(key) ?? "").trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
      return { error: `${label} must be a number between 0 and ${max}.` } satisfies ActionData;
    }
    pixelValues[key] = parsed;
  }

  const freeShippingBar: FreeShippingBarSettings = {
    trackColor,
    startColor,
    nearColor,
    reachedColor,
    nearThresholdPercent,
    progressMessage,
    completeMessage,
    barThickness: pixelValues.barThickness,
    mobileBarThickness: pixelValues.mobileBarThickness,
    barRoundness: pixelValues.barRoundness,
    mobileBarRoundness: pixelValues.mobileBarRoundness,
    messageFontSize: pixelValues.messageFontSize,
    mobileMessageFontSize: pixelValues.mobileMessageFontSize,
    barMessageGap: pixelValues.barMessageGap,
    mobileBarMessageGap: pixelValues.mobileBarMessageGap,
    paddingTop: pixelValues.paddingTop,
    paddingBottom: pixelValues.paddingBottom,
    paddingLeft: pixelValues.paddingLeft,
    paddingRight: pixelValues.paddingRight,
    mobilePaddingTop: pixelValues.mobilePaddingTop,
    mobilePaddingBottom: pixelValues.mobilePaddingBottom,
    mobilePaddingLeft: pixelValues.mobilePaddingLeft,
    mobilePaddingRight: pixelValues.mobilePaddingRight,
    barPosition,
  };

  await db.shop.update({
    where: { domain: session.shop },
    data: { widgetSettingsJson: { freeShippingBar } as unknown as object },
  });

  return { notice: "Storefront widget settings saved." } satisfies ActionData;
};

type Draft = FreeShippingBarSettings;

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

export default function StorefrontWidgets() {
  const { freeShippingBar } = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState<Draft>(freeShippingBar);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (!actionData) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
  }, [actionData, shopify]);

  const isSaving = navigation.state !== "idle";
  const isDirty = JSON.stringify(draft) !== JSON.stringify(freeShippingBar);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      shopify.toast.show(`${label} copied.`, { duration: 2000 });
    } catch {
      shopify.toast.show("Couldn't copy — select and copy the code manually.", { isError: true });
    }
  };

  return (
    <s-page heading="Storefront" inlineSize="small">
      <s-section heading="Free shipping bar">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shows live progress toward whichever active campaign has a free-shipping minimum — always in sync with
            the real discount, no manual re-entry.
          </s-paragraph>

          <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-stack direction="block" gap="small-400">
                <s-text type="strong">Add to your store</s-text>
                <s-text color="subdued">Two short snippets to paste into your theme&apos;s code.</s-text>
              </s-stack>
              <s-button variant="primary" commandFor="storefront-widget-snippet-modal" command="--show">
                Copy snippet code
              </s-button>
            </s-stack>
          </s-box>

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

              <s-select
                label="Layout"
                value={draft.barPosition}
                onChange={(event: ControlEvent) => update("barPosition", readValue(event) === "bottom" ? "bottom" : "top")}
              >
                <s-option value="top">Bar on top, message below</s-option>
                <s-option value="bottom">Message on top, bar below</s-option>
              </s-select>

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

              <PixelPair
                label="Bar thickness"
                mobileLabel="Mobile bar thickness"
                value={draft.barThickness}
                mobileValue={draft.mobileBarThickness}
                max={48}
                onChange={(v) => update("barThickness", v)}
                onMobileChange={(v) => update("mobileBarThickness", v)}
              />

              <PixelPair
                label="Bar roundness"
                mobileLabel="Mobile bar roundness"
                value={draft.barRoundness}
                mobileValue={draft.mobileBarRoundness}
                max={999}
                onChange={(v) => update("barRoundness", v)}
                onMobileChange={(v) => update("mobileBarRoundness", v)}
              />

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
                label="Bar-to-message gap"
                mobileLabel="Mobile bar-to-message gap"
                value={draft.barMessageGap}
                mobileValue={draft.mobileBarMessageGap}
                max={64}
                onChange={(v) => update("barMessageGap", v)}
                onMobileChange={(v) => update("mobileBarMessageGap", v)}
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
              loading={isSaving}
              disabled={isSaving || !isDirty}
              onClick={() => {
                const data = new FormData();
                for (const [key, value] of Object.entries(draft)) data.set(key, String(value));
                submit(data, { method: "post" });
              }}
            >
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-modal id="storefront-widget-snippet-modal" heading="Free shipping bar — snippet code">
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">1. Paste once in theme.liquid</s-text>
            <s-text color="subdued">Anywhere before &lt;/body&gt; — just once, ever.</s-text>
            <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
              <s-text-area label="" value={buildLoaderSnippet()} readOnly rows={2} />
              <s-button onClick={() => copyToClipboard(buildLoaderSnippet(), "Loader script")}>Copy</s-button>
            </s-grid>
          </s-stack>

          <s-stack direction="block" gap="small-200">
            <s-text type="strong">2. Paste wherever you want it to show</s-text>
            <s-text color="subdued">Cart drawer, cart page, anywhere — paste it as many times as you like.</s-text>
            <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
              <s-text-area label="" value={buildPlacementSnippet()} readOnly rows={2} />
              <s-button onClick={() => copyToClipboard(buildPlacementSnippet(), "Placement tag")}>Copy</s-button>
            </s-grid>
          </s-stack>
        </s-stack>

        <s-button slot="secondary-actions" commandFor="storefront-widget-snippet-modal" command="--hide">
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
