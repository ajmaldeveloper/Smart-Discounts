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
    data: { widgetSettingsJson: { freeShippingBar } as unknown as object },
  });

  return { notice: "Storefront widget settings saved." } satisfies ActionData;
};

export default function StorefrontWidgets() {
  const { freeShippingBar } = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [trackColor, setTrackColor] = useState(freeShippingBar.trackColor);
  const [startColor, setStartColor] = useState(freeShippingBar.startColor);
  const [nearColor, setNearColor] = useState(freeShippingBar.nearColor);
  const [reachedColor, setReachedColor] = useState(freeShippingBar.reachedColor);
  const [nearThresholdPercent, setNearThresholdPercent] = useState(String(freeShippingBar.nearThresholdPercent));
  const [progressMessage, setProgressMessage] = useState(freeShippingBar.progressMessage);
  const [completeMessage, setCompleteMessage] = useState(freeShippingBar.completeMessage);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.error) shopify.toast.show(actionData.error, { isError: true });
    else if (actionData.notice) shopify.toast.show(actionData.notice, { duration: 2400 });
  }, [actionData, shopify]);

  const isSaving = navigation.state !== "idle";
  const isDirty =
    trackColor !== freeShippingBar.trackColor ||
    startColor !== freeShippingBar.startColor ||
    nearColor !== freeShippingBar.nearColor ||
    reachedColor !== freeShippingBar.reachedColor ||
    nearThresholdPercent !== String(freeShippingBar.nearThresholdPercent) ||
    progressMessage !== freeShippingBar.progressMessage ||
    completeMessage !== freeShippingBar.completeMessage;

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
                <s-text color="subdued">
                  Paste this snippet into your theme&apos;s code wherever you want it to show — the cart drawer, the
                  cart page, above the footer.
                </s-text>
              </s-stack>
              <s-button variant="primary" commandFor="storefront-widget-snippet-modal" command="--show">
                Copy snippet code
              </s-button>
            </s-stack>
          </s-box>

          <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
            <s-stack direction="block" gap="base">
              <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
                <s-color-field
                  label="Background color"
                  value={trackColor}
                  onInput={(event: ControlEvent) => setTrackColor(readValue(event))}
                />
                <s-color-field
                  label="Starting color"
                  value={startColor}
                  onInput={(event: ControlEvent) => setStartColor(readValue(event))}
                />
                <s-color-field
                  label="Nearly-reached color"
                  value={nearColor}
                  onInput={(event: ControlEvent) => setNearColor(readValue(event))}
                />
                <s-color-field
                  label="Reached color"
                  value={reachedColor}
                  onInput={(event: ControlEvent) => setReachedColor(readValue(event))}
                />
              </s-grid>

              <s-number-field
                label="Switch to nearly-reached color at (% of threshold)"
                min={0}
                max={100}
                suffix="%"
                value={nearThresholdPercent}
                onInput={(event: ControlEvent) => setNearThresholdPercent(readValue(event))}
              />

              <s-text-field
                label="Progress message"
                details="Shown below the threshold. {remaining} is replaced with the amount/quantity still needed."
                value={progressMessage}
                onInput={(event: ControlEvent) => setProgressMessage(readValue(event))}
              />

              <s-text-field
                label="Complete message"
                details="Shown once the threshold is met."
                value={completeMessage}
                onInput={(event: ControlEvent) => setCompleteMessage(readValue(event))}
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
                data.set("trackColor", trackColor);
                data.set("startColor", startColor);
                data.set("nearColor", nearColor);
                data.set("reachedColor", reachedColor);
                data.set("nearThresholdPercent", nearThresholdPercent);
                data.set("progressMessage", progressMessage);
                data.set("completeMessage", completeMessage);
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
            <s-text color="subdued">
              Anywhere before &lt;/body&gt;. Loads the bar&apos;s code for the whole site — you only do this once, ever.
            </s-text>
            <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="end">
              <s-text-area label="" value={buildLoaderSnippet()} readOnly rows={2} />
              <s-button onClick={() => copyToClipboard(buildLoaderSnippet(), "Loader script")}>Copy</s-button>
            </s-grid>
          </s-stack>

          <s-stack direction="block" gap="small-200">
            <s-text type="strong">2. Paste wherever you want it to show</s-text>
            <s-text color="subdued">
              The cart drawer, the cart page, above the footer — paste this again anywhere you want another copy of
              the bar. Plain HTML, no script tag, so it works even inside a cart drawer that re-renders via AJAX.
            </s-text>
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
