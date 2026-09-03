import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

// Catches any /app/* path that doesn't match a real route (a stale
// bookmark, an old link to a renamed/removed page, a typo) — without
// this, react-router's own bare 404 renders inside the embedded admin
// frame instead of somewhere the merchant can actually use. A
// server-side redirect() Response here confuses Shopify Admin's
// embedded iframe shell (it expects app navigation to go through App
// Bridge, not a raw HTTP 3xx), so this reloads client-side instead —
// see app.campaigns.$id.tsx's matching CampaignNotFound component.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function CatchAll() {
  useEffect(() => {
    window.location.replace("/app");
  }, []);

  return (
    <s-page heading="Page not found">
      <s-section>
        <s-stack direction="block" gap="base" alignItems="center">
          <s-text color="subdued">Taking you back to the app…</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
