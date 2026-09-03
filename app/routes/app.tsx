import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, isRouteErrorResponse, useLoaderData, useNavigate, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  // tawk.to live chat, for the Overview page's "Get support" section.
  // TAWK_TO_PROPERTY_ID is a placeholder — replace with the real
  // "<propertyId>/<widgetId>" from tawk.to dashboard > Administration >
  // Channels > Chat Widget before this is meaningful. Loaded once, only
  // inside the embedded admin. Shopify's embedded-admin CSP may block
  // third-party scripts/iframes — if so this silently no-ops, which is
  // why the support section always shows working WhatsApp/email links
  // alongside the chat card.
  useEffect(() => {
    const TAWK_TO_PROPERTY_ID = "REPLACE_WITH_REAL_TAWKTO_PROPERTY_ID";

    if (
      TAWK_TO_PROPERTY_ID.startsWith("REPLACE_WITH") ||
      document.getElementById("tawk-to-script")
    ) {
      return;
    }

    try {
      const script = document.createElement("script");
      script.id = "tawk-to-script";
      script.async = true;
      script.src = `https://embed.tawk.to/${TAWK_TO_PROPERTY_ID}`;
      script.setAttribute("crossorigin", "*");
      document.body.appendChild(script);
    } catch {
      // Blocked (CSP, network, ad blocker) — the support section's
      // WhatsApp/email links still work without this.
    }
  }, []);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Overview</s-link>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/simulator">Simulator</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/plans">Plans</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  // A thrown redirect (e.g. authenticate.admin's own re-auth flow) never
  // reaches here — the router handles those transparently. Only a real
  // 404 (a bad campaign ID, a stale bookmark, any other /app/* route
  // that throws "not found") lands in this boundary, so it's safe to
  // send every one of them back to /app instead of leaving the
  // merchant stuck on a bare "404" with no way back into the app.
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    if (isNotFound) navigate("/app", { replace: true });
  }, [isNotFound, navigate]);

  if (isNotFound) return null;

  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
